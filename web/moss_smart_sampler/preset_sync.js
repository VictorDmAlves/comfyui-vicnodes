import { app } from "../../../scripts/app.js";

// Only display presets are controlled here. All sampling and sigma math remains
// on the Python side. The hidden origin keeps Turbo and Standard curves distinct
// even when the visible preset is Custom.
const PRESET_VALUES = Object.freeze({
  Fast: { steps: 25, cfg: 4.0 },
  Balanced: { steps: 35, cfg: 4.0 },
  Realism: { steps: 40, cfg: 4.0 },
  Quality: { steps: 50, cfg: 4.0 },
  Turbo: { steps: 8, cfg: 1.0 },
});

const PRESET_ALIAS = { "UltraFast / Turbo": "Turbo" };
const lookup = (node, name) => node.widgets?.find((widget) => widget.name === name);
const knownProfile = (name) => Object.hasOwn(PRESET_VALUES, name);
const normalizeName = (value) => PRESET_ALIAS[value] || value;

function repaint(node) {
  node.setDirtyCanvas?.(true, true);
}

function setValue(node, widget, value) {
  if (widget && widget.value !== value) widget.value = value;
}

function hideOrigin(node) {
  const origin = lookup(node, "custom_base_preset");
  if (!origin) return;
  origin.hidden = true;
  origin.advanced = false;
  // Compatibility with older LiteGraph canvas implementations.
  origin.computeSize = () => [0, -4];
}

function atomicUpdate(node, fn) {
  if (node.__mossPresetSyncUpdating) return;
  node.__mossPresetSyncUpdating = true;
  try {
    fn();
  } finally {
    node.__mossPresetSyncUpdating = false;
    repaint(node);
  }
}

function setSelectedPreset(node, selected) {
  const preset = lookup(node, "preset");
  const steps = lookup(node, "steps");
  const cfg = lookup(node, "cfg");
  const origin = lookup(node, "custom_base_preset");
  if (!preset || !steps || !cfg || !origin) return;

  const profile = normalizeName(selected);
  if (profile === "Custom") return; // Keep the existing manual Steps and CFG.
  if (!knownProfile(profile)) return;
  atomicUpdate(node, () => {
    setValue(node, origin, profile);
    setValue(node, preset, profile);
    setValue(node, steps, PRESET_VALUES[profile].steps);
    setValue(node, cfg, PRESET_VALUES[profile].cfg);
  });
}

function setCustom(node) {
  if (node.__mossPresetSyncUpdating || node.__mossPresetSyncLoading) return;
  const preset = lookup(node, "preset");
  const origin = lookup(node, "custom_base_preset");
  if (!preset || !origin || preset.value === "Custom") return;
  const priorProfile = normalizeName(preset.value);
  atomicUpdate(node, () => {
    if (knownProfile(priorProfile)) setValue(node, origin, priorProfile);
    setValue(node, preset, "Custom");
  });
}

function restoreNode(node) {
  const preset = lookup(node, "preset");
  const steps = lookup(node, "steps");
  const cfg = lookup(node, "cfg");
  const origin = lookup(node, "custom_base_preset");
  if (!preset || !steps || !cfg || !origin) return;
  hideOrigin(node);

  let selected = normalizeName(preset.value);
  if (selected !== "Custom" && !knownProfile(selected)) selected = "Balanced";
  let profile = selected === "Custom" ? normalizeName(origin.value) : selected;
  if (!knownProfile(profile)) profile = "Balanced";
  const defaults = PRESET_VALUES[profile];

  // Old versions serialized zero as "Auto". Convert those values to their
  // displayed effective equivalents without changing the generated result.
  const finalSteps = Number(steps.value) === 0 ? defaults.steps : Number(steps.value);
  const finalCfg = Number(cfg.value) === 0 && selected !== "Custom" ? defaults.cfg : Number(cfg.value);
  const hasOverride = finalSteps !== defaults.steps || finalCfg !== defaults.cfg;
  atomicUpdate(node, () => {
    setValue(node, origin, profile);
    setValue(node, steps, finalSteps);
    setValue(node, cfg, finalCfg);
    setValue(node, preset, selected === "Custom" || hasOverride ? "Custom" : profile);
  });
}

function attachNode(node) {
  if (node.__mossPresetSyncAttached) return;
  const preset = lookup(node, "preset");
  const steps = lookup(node, "steps");
  const cfg = lookup(node, "cfg");
  const origin = lookup(node, "custom_base_preset");
  if (!preset || !steps || !cfg || !origin) return;
  node.__mossPresetSyncAttached = true;
  hideOrigin(node);

  const originalPresetCallback = preset.callback;
  preset.callback = function (value, ...args) {
    originalPresetCallback?.call(this, value, ...args);
    if (!node.__mossPresetSyncLoading && !node.__mossPresetSyncUpdating) {
      setSelectedPreset(node, value);
    }
  };
  for (const widget of [steps, cfg]) {
    const original = widget.callback;
    widget.callback = function (value, ...args) {
      original?.call(this, value, ...args);
      if (widget === steps && Number(value) === 0 && !node.__mossPresetSyncLoading && !node.__mossPresetSyncUpdating) {
        const prior = lookup(node, "custom_base_preset")?.value;
        const profile = knownProfile(prior) ? prior : "Balanced";
        atomicUpdate(node, () => setValue(node, steps, PRESET_VALUES[profile].steps));
      }
      setCustom(node);
    };
  }
  // New nodes use the backend's explicit Balanced/35/4 defaults.
}

app.registerExtension({
  name: "VicNodes.MOSSSmartSampler.PresetSync",
  beforeRegisterNodeDef(nodeType, nodeData) {
    if (nodeData.name !== "MOSSSmartSampler") return;
    const previousOnNodeCreated = nodeType.prototype.onNodeCreated;
    nodeType.prototype.onNodeCreated = function (...args) {
      const result = previousOnNodeCreated?.apply(this, args);
      attachNode(this);
      return result;
    };

    // During graph loading ComfyUI can invoke widget callbacks while restoring
    // values. Suppress the "manual edit -> Custom" behavior until configured.
    const previousConfigure = nodeType.prototype.configure;
    nodeType.prototype.configure = function (...args) {
      this.__mossPresetSyncLoading = true;
      try {
        return previousConfigure?.apply(this, args);
      } finally {
        this.__mossPresetSyncLoading = false;
        attachNode(this);
        restoreNode(this);
      }
    };
  },
  loadedGraphNode(node) {
    if (node.type === "MOSSSmartSampler" || node.comfyClass === "MOSSSmartSampler") {
      attachNode(node);
      restoreNode(node);
    }
  },
});
