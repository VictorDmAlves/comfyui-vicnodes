import { app } from "../../../scripts/app.js";

const NODE_ID = "VicUnifiedModelLoader";

function widget(node, name) {
    return node.widgets?.find((w) => w.name === name);
}

function setWidgetHidden(node, name, hidden) {
    const w = widget(node, name);
    if (!w) return;
    if (!w._unifiedOriginal) {
        w._unifiedOriginal = {
            hidden: !!w.hidden,
            optionsHidden: !!w.options?.hidden,
            computeSize: w.computeSize,
        };
    }
    const original = w._unifiedOriginal;
    w.hidden = hidden || original.hidden;
    w.options ??= {};
    w.options.hidden = hidden || original.optionsHidden;
    w.computeSize = hidden ? () => [0, -4] : original.computeSize;
}

function refresh(node) {
    const isDual = widget(node, "clip_mode")?.value === "Dual";
    setWidgetHidden(node, "clip_name_2", !isDual);
    setWidgetHidden(node, "clip_type_single", isDual);
    setWidgetHidden(node, "clip_type_dual", !isDual);

    // Never call setSize() or computeSize() here. ComfyUI restores the node's
    // serialized size when loading a workflow; changing it during onConfigure
    // would overwrite the dimensions explicitly set by the user.
    node.setDirtyCanvas?.(true, true);
}

app.registerExtension({
    name: "VicNodes.UnifiedModelLoader",
    nodeCreated(node) {
        if (node.comfyClass !== NODE_ID && node.type !== NODE_ID) return;
        const mode = widget(node, "clip_mode");
        if (!mode || mode._unifiedWrapped) return;
        mode._unifiedWrapped = true;
        const oldCallback = mode.callback;
        mode.callback = function (...args) {
            const result = oldCallback?.apply(this, args);
            refresh(node);
            return result;
        };
        const oldConfigure = node.onConfigure;
        node.onConfigure = function (...args) {
            const result = oldConfigure?.apply(this, args);
            queueMicrotask(() => refresh(this));
            return result;
        };
        refresh(node);
    },
});
