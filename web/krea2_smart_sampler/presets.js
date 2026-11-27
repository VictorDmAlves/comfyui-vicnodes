/**
 * Krea 2 Smart Sampler v1.0.4 — preset sync and workflow widget migrations.
 *
 * The frontend changes only visible Steps/CFG when a preset is selected.
 * Old saved workflow arrays (v0.1.x through v1.0.3) are remapped by field,
 * including control_after_generate when the host persists that widget.
 */
import { app } from "../../../scripts/app.js";

const NODE_TYPE = "VicKrea2SmartSampler"; // historical ID retained for workflows
const PRESETS = Object.freeze({
    Turbo: [8, 1.0],
    Fast: [25, 4.5],
    Balanced: [32, 3.5],
    Quality: [52, 3.0],
});
const MODES = new Set(["Native Reference", "Stage Weighted", "Smooth Warp", "Refined Solver"]);
const PRESET_NAMES = new Set([...Object.keys(PRESETS), "Custom"]);
const RETIRED_PRESET_NAMES = new Set([...PRESET_NAMES, "Realism"]);
const CONTROL_CHOICES = new Set(["fixed", "increment", "decrement", "randomize"]);

const NEW_ORDER = [
    "seed", "preset", "steps", "cfg", "sampler_name", "scheduler",
    "denoise", "mode", "sigma_strength", "prompt_adherence",
    "adherence_strength", "text_scale", "add_noise",
];
const OLD_ORDER_103 = [
    "seed", "steps", "cfg", "sampler_name", "scheduler", "denoise",
    "preset", "mode", "sigma_strength", "prompt_adherence",
    "adherence_strength", "text_scale", "add_noise",
];
const OLD_ORDER_100 = [
    "seed", "steps", "cfg", "sampler_name", "scheduler", "denoise",
    "model_variant", "preset", "mode", "sigma_strength", "prompt_adherence",
    "adherence_strength", "text_scale", "add_noise",
];
const OLD_ORDER_01 = [
    "seed", "steps", "cfg", "denoise", "mode", "sigma_strength",
    "prompt_adherence", "adherence_strength", "text_scale", "add_noise",
    "sampler_name", "scheduler",
];

function widget(node, name) {
    return node.widgets?.find(w => w.name === name);
}
function markDirty(node) {
    node.setDirtyCanvas?.(true, true);
    app.graph?.setDirtyCanvas?.(true, true);
}
function applyPreset(node) {
    if (node.__kreaRestoring || node.__kreaPresetSync) return;
    const values = PRESETS[widget(node, "preset")?.value];
    if (!values) return; // Custom must leave the existing settings unchanged.
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
    const selected = widget(node, "preset");
    if (!selected || selected.value === "Custom") return;
    const expected = PRESETS[selected.value];
    if (!expected) return;
    if (Number(widget(node, "steps")?.value) !== expected[0]
            || Math.abs(Number(widget(node, "cfg")?.value) - expected[1]) > 1e-6) {
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
    addCallback(node, "preset", applyPreset);
    addCallback(node, "steps", onManualEdit);
    addCallback(node, "cfg", onManualEdit);
}
function normalizePreset(settings) {
    const expected = PRESETS[settings.preset];
    if (settings.preset !== "Custom" && (!expected
            || Number(settings.steps) !== expected[0]
            || Math.abs(Number(settings.cfg) - expected[1]) > 1e-6)) {
        settings.preset = "Custom";
    }
}

// Identify legacy layouts from data shape. Never guess on unknown layouts.
function migrateWidgets(node, original) {
    if (!Array.isArray(original) || original.length < 9) return original;
    let values = [...original];
    let afterSeedControl;
    if (CONTROL_CHOICES.has(values[1])) {
        afterSeedControl = values[1];
        values.splice(1, 1);
    }
    let order;
    if (typeof values[3] === "number" && MODES.has(values[4])) {
        order = OLD_ORDER_01;
    } else if ((values[6] === "Turbo" || values[6] === "RAW")
               && RETIRED_PRESET_NAMES.has(values[7]) && MODES.has(values[8])) {
        order = OLD_ORDER_100;
    } else if (RETIRED_PRESET_NAMES.has(values[6]) && MODES.has(values[7])
               && typeof values[1] === "number") {
        order = OLD_ORDER_103;
    } else if (PRESET_NAMES.has(values[1]) && MODES.has(values[7])) {
        order = NEW_ORDER;
    } else {
        return original;
    }
    const settings = {};
    for (let i = 0; i < order.length && i < values.length; i++) {
        settings[order[i]] = values[i];
    }
    // v0.1.x had no presets; use Custom and retain exact numeric settings.
    if (order === OLD_ORDER_01) settings.preset = "Custom";
    // v1.0.0 Turbo/Balanced represented distilled 8 steps, CFG 1.
    if (order === OLD_ORDER_100 && settings.model_variant === "Turbo"
            && settings.preset === "Balanced" && Number(settings.steps) === 8
            && Number(settings.cfg) === 1.0) {
        settings.preset = "Turbo";
    }
    normalizePreset(settings);
    const mapped = NEW_ORDER.map(name => settings[name] ?? widget(node, name)?.value);
    if (afterSeedControl !== undefined) mapped.splice(1, 0, afterSeedControl);
    // Other than the stable schema order, value equality means no migration.
    if (mapped.length === original.length && mapped.every((v, i) => v === original[i])) return original;
    return mapped;
}

app.registerExtension({
    name: "comfyui.krea2.smart_sampler.presets_v104",
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
            const migrated = migrateWidgets(this, data?.widgets_values);
            const incoming = migrated !== data?.widgets_values
                ? { ...data, widgets_values: migrated } : data;
            this.__kreaRestoring = true;
            try {
                const result = prevConfigure?.call(this, incoming, ...args);
                install(this);
                if (migrated !== data?.widgets_values) markDirty(this);
                return result;
            } finally {
                this.__kreaRestoring = false;
            }
        };
    },
});
