/**
 * ComfyUI-Krea2-Smart-Sampler v1.0.2 — VicNodes integration quality preset widget sync.
 *
 * Presets affect ONLY the visible steps and cfg fields; there are no implicit
 * backend overrides or checkpoint switching. Loaded from the VicNodes web directory.
 *
 * Old workflow widget-array migrations preserve the user's actual settings.
 */
import { app } from "../../../scripts/app.js";

// Internal identifier intentionally retained so old workflows remain recognized.
const NODE_TYPE = "VicKrea2SmartSampler";

const PRESETS = Object.freeze({
    Turbo: [8, 1.0],
    Fast: [25, 4.5],
    Balanced: [32, 3.5],
    Quality: [52, 3.0],
});
const SAMPLING_MODES = new Set([
    "Native Reference", "Stage Weighted", "Smooth Warp", "Refined Solver",
]);
const PRESET_NAMES = new Set([...Object.keys(PRESETS), "Custom"]);
// Older workflows might contain the retired Realism preset.
const LEGACY_PRESET_NAMES = new Set([...PRESET_NAMES, "Realism"]);

function widget(node, name) {
    return node.widgets?.find((item) => item.name === name);
}
function markDirty(node) {
    node.setDirtyCanvas?.(true, true);
    app.graph?.setDirtyCanvas?.(true, true);
}
function applyPreset(node) {
    if (node.__kreaRestoring || node.__kreaPresetSync) return;
    const preset = widget(node, "quality_preset")?.value;
    const values = PRESETS[preset];
    if (!values) return; // Custom: never silently modify visible steps/CFG.

    node.__kreaPresetSync = true;
    try {
        for (const [name, value] of [["steps", values[0]], ["cfg", values[1]]]) {
            const w = widget(node, name);
            if (!w || Number(w.value) === value) continue;
            w.value = value;
            w.callback?.(value);
        }
    } finally {
        node.__kreaPresetSync = false;
    }
    markDirty(node);
}
function onManualEdit(node) {
    if (node.__kreaRestoring || node.__kreaPresetSync) return;
    const selected = widget(node, "quality_preset");
    if (!selected || selected.value === "Custom") return;
    const expected = PRESETS[selected.value];
    if (!expected) return;
    const steps = Number(widget(node, "steps")?.value);
    const cfg = Number(widget(node, "cfg")?.value);
    if (steps !== expected[0] || Math.abs(cfg - expected[1]) > 1e-6) {
        selected.value = "Custom";
        markDirty(node);
    }
}
function addCallback(node, name, handler) {
    const w = widget(node, name);
    if (!w || w.__kreaBound) return;
    w.__kreaBound = true;
    const previous = w.callback;
    w.callback = function (...args) {
        const result = previous?.apply(this, args);
        handler(node);
        return result;
    };
}
function install(node) {
    addCallback(node, "quality_preset", applyPreset);
    addCallback(node, "steps", onManualEdit);
    addCallback(node, "cfg", onManualEdit);
}

// Pre-v1.0.0 (v0.1.x) widget layout.
const LEGACY_NAMES = [
    "seed", "steps", "cfg", "denoise", "sampling_mode", "sigma_strength",
    "prompt_adherence", "adherence_strength", "text_scale",
    "add_noise", "sampler_name", "scheduler",
];
function isLegacy(data) {
    const v = data?.widgets_values;
    return Array.isArray(v) && v.length >= 9 && v.length <= LEGACY_NAMES.length
        && typeof v[3] === "number" && SAMPLING_MODES.has(v[4]);
}

// v1.0.0 had model_variant immediately BEFORE quality_preset.
// The new widget layout removes exactly that single field.
function isV100(data) {
    const v = data?.widgets_values;
    return Array.isArray(v) && v.length >= 13
        && (v[6] === "Turbo" || v[6] === "RAW")
        && LEGACY_PRESET_NAMES.has(v[7]) && SAMPLING_MODES.has(v[8]);
}
function migrateLegacy(node, saved) {
    const values = Object.fromEntries(LEGACY_NAMES.map((name, index) => [name, saved[index]]));
    for (const [name, value] of Object.entries(values)) {
        if (value === undefined) continue;
        const w = widget(node, name);
        if (w) w.value = value;
    }
    const preset = widget(node, "quality_preset");
    if (preset) preset.value = "Custom";
    markDirty(node);
}
// The old v1.0.0 model_variant existed only in that release.
// Preserve the actual sampling parameters from every prior workflow.
function migrateV100(saved) {
    const newValues = [...saved];
    const previousVariant = newValues.splice(6, 1)[0];
    const oldPreset = newValues[6];
    const actualSteps = Number(newValues[1]);
    const actualCFG = Number(newValues[2]);

    // Special case: Turbo/Balanced in v1.0.0 meant Turbo 8 / CFG 1.
    if (previousVariant === "Turbo" && oldPreset === "Balanced"
        && actualSteps === PRESETS.Turbo[0]
        && Math.abs(actualCFG - PRESETS.Turbo[1]) <= 1e-6) {
        newValues[6] = "Turbo";
    }
    return newValues;
}
function normalizeSavedPreset(saved) {
    if (!Array.isArray(saved) || saved.length < 7) return saved;
    const result = [...saved];
    const name = result[6];
    if (typeof name !== "string") return result;
    if (name === "Custom") return result;
    const values = PRESETS[name];
    const steps = Number(result[1]);
    const cfg = Number(result[2]);
    // A changed/retired preset must never silently overwrite existing values.
    if (!values || steps !== values[0] || Math.abs(cfg - values[1]) > 1e-6) {
        result[6] = "Custom";
    }
    return result;
}

app.registerExtension({
    name: "comfyui.vicnodes.krea2.smart_sampler.presets",
    beforeRegisterNodeDef(nodeType, nodeData) {
        if (nodeData.name !== NODE_TYPE) return;

        const prevCreated = nodeType.prototype.onNodeCreated;
        nodeType.prototype.onNodeCreated = function (...args) {
            const result = prevCreated?.apply(this, args);
            install(this);
            return result;
        };

        const prevConfigure = nodeType.prototype.onConfigure;
        nodeType.prototype.onConfigure = function (data, ...args) {
            const legacy = isLegacy(data) ? [...data.widgets_values] : null;
            const oldV1 = !legacy && isV100(data);
            const converted = oldV1 ? migrateV100(data.widgets_values) : data?.widgets_values;
            const normalized = legacy ? converted : normalizeSavedPreset(converted);
            const incoming = normalized && normalized !== data?.widgets_values
                ? { ...data, widgets_values: normalized }
                : data;
            this.__kreaRestoring = true;
            try {
                const result = prevConfigure?.call(this, incoming, ...args);
                install(this);
                if (legacy) migrateLegacy(this, legacy);
                if (oldV1 || (!legacy && normalized?.[6] !== data?.widgets_values?.[6])) markDirty(this);
                return result;
            } finally {
                this.__kreaRestoring = false;
            }
        };
    },
});
