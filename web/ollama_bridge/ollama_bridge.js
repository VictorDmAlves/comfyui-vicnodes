import { app } from "../../../scripts/app.js";
import { api } from "../../../scripts/api.js";

// ComfyUI Edit menu command, like Impact: Refresh Wildcard.
// No refresh widgets, no automatic fetching on node creation or on R.
const NODE_TYPE = "OllamaLocalChat";
const DEFAULT_URL = "http://localhost:11434";
const COMMAND_ID = "vicnodes.ollama_bridge.refresh-models";
let nodeDefinition = null;
let refreshing = false;

function nodeWidget(node, name) {
    return node.widgets?.find((widget) => widget.name === name);
}

function bridgeNodes() {
    return (app.graph?._nodes ?? []).filter(
        (node) => node.comfyClass === NODE_TYPE || node.type === NODE_TYPE,
    );
}

function showToast(severity, summary, detail) {
    const toast = app.extensionManager?.toast;
    if (toast?.add) {
        toast.add({ severity, summary, detail, life: 5000 });
    } else if (severity === "error") {
        console.error(`[Ollama Bridge] ${summary}: ${detail}`);
    } else {
        console.info(`[Ollama Bridge] ${summary}: ${detail}`);
    }
}

// Handles workflows saved by v1.0.3, where its button was accidentally
// serialized as a null immediately after the model widget. Removing that
// value BEFORE LiteGraph.configure is essential; a post-load fix is too late.
function migrateLegacyValues(info) {
    const values = info?.widgets_values;
    if (!Array.isArray(values) || values.length !== 18 || values[2] !== null) return info;
    // Detect the v1.0.3 signature to avoid rewriting arbitrary workflows.
    if (typeof values[0] !== "string" || typeof values[1] !== "string" ||
        typeof values[3] !== "string" || typeof values[4] !== "number" ||
        !["fixed", "randomize", "increment", "decrement"].includes(values[5])) {
        return info;
    }
    const patched = { ...info, widgets_values: [...values.slice(0, 2), ...values.slice(3)] };
    if (info.widgets_values_named) {
        patched.widgets_values_named = { ...info.widgets_values_named };
        delete patched.widgets_values_named["Refresh Models"];
    }
    return patched;
}

function updateChoice(widget, models) {
    if (!widget || !Array.isArray(models) || !models.length) return;
    const selected = widget.value;
    const choices = [...new Set(models)].sort((a, b) => a.localeCompare(b));
    // Preserve the selected model in an older workflow even if it was removed.
    if (typeof selected === "string" && selected.trim() &&
        !selected.startsWith("Click Refresh") && !choices.includes(selected)) {
        choices.push(selected);
    }
    widget.options ??= {};
    widget.options.values = choices;
    if (!selected || selected.startsWith("Click Refresh")) {
        widget.value = choices[0];
        widget.callback?.(widget.value);
    }
}

function updateDefaultNodeDefinition(models) {
    if (!models?.length || !nodeDefinition?.input?.required?.model) return;
    // The node definition is also used when users add new nodes after refresh.
    nodeDefinition.input.required.model[0] = [...models];
}

async function fetchModels(url) {
    const query = new URLSearchParams({ url, force: "1" });
    const response = await api.fetchApi(`/vicnodes/ollama_bridge/models?${query.toString()}`);
    const result = await response.json();
    if (!response.ok || !Array.isArray(result.models)) {
        throw new Error(result.error || `HTTP ${response.status}`);
    }
    return result.models;
}

async function refreshModelsFromMenu() {
    if (refreshing) return;
    refreshing = true;
    try {
        const nodes = bridgeNodes();
        const urls = new Set([DEFAULT_URL]);
        for (const node of nodes) {
            urls.add(String(nodeWidget(node, "ollama_url")?.value || DEFAULT_URL).trim());
        }
        // Fetch once per distinct Ollama URL and update matching nodes.
        const results = await Promise.all([...urls].map(async (url) => {
            try { return { url, models: await fetchModels(url) }; }
            catch (error) { return { url, error }; }
        }));
        let updated = 0;
        const errors = [];
        for (const { url, models, error } of results) {
            if (error) {
                errors.push(`${url}: ${error.message || error}`);
                continue;
            }
            if (url === DEFAULT_URL) updateDefaultNodeDefinition(models);
            for (const node of nodes) {
                if (String(nodeWidget(node, "ollama_url")?.value || DEFAULT_URL).trim() === url) {
                    updateChoice(nodeWidget(node, "model"), models);
                }
            }
            updated += models.length;
        }
        app.graph?.setDirtyCanvas?.(true, true);
        app.canvas?.setDirty?.(true, true);
        if (errors.length) {
            showToast("error", "Ollama model refresh", errors.join(" | "));
        } else {
            showToast("success", "Ollama model refresh", `${updated} model(s) loaded across ${urls.size} server(s).`);
        }
    } finally {
        refreshing = false;
    }
}

app.registerExtension({
    name: "VicNodes.OllamaBridge.LocalChatUI",
    commands: [{
        id: COMMAND_ID,
        label: "Ollama: Refresh Models",
        function: refreshModelsFromMenu,
    }],
    menuCommands: [{ path: ["Edit"], commands: [COMMAND_ID] }],
    async beforeRegisterNodeDef(nodeType, nodeData) {
        if (nodeData.name !== NODE_TYPE) return;
        nodeDefinition = nodeData;
        const originalConfigure = nodeType.prototype.configure;
        if (typeof originalConfigure === "function") {
            nodeType.prototype.configure = function (info) {
                return originalConfigure.call(this, migrateLegacyValues(info));
            };
        }
    },
    async nodeCreated(node) {
        if (node.comfyClass !== NODE_TYPE && node.type !== NODE_TYPE) return;
        node.color = "#26384c";
        node.bgcolor = "#192734";
        if (node.setSize) {
            const size = node.size ?? [0, 0];
            node.setSize([Math.max(size[0], 380), size[1]]);
        }
        // No startup scan: the dropdown uses the in-memory snapshot (or
        // placeholder) until Edit > Ollama: Refresh Models is selected.
        // No per-node button exists.
    },
});
