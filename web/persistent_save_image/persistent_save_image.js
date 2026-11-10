import { app } from "../../../scripts/app.js";
import { api } from "../../../scripts/api.js";
import { applyTextReplacements } from "../../../scripts/utils.js";

const NODE_NAME = "PersistentSaveImage";
const GALLERY_WIDGET = "gallery_id";
const GALLERY_PROPERTY = "persistent_save_image_gallery_id";
// Reserve space for the buttons, DOM widget margins and the image preview gap.
const GALLERY_ACTION_BUTTON_HEIGHT = 28;
const GALLERY_ACTION_WIDGET_HEIGHT = 56;
const REFRESH_INTERVAL_MS = 1500;
const MIN_NODE_REFRESH_MS = 500;

function createGalleryId() {
    if (globalThis.crypto?.randomUUID) {
        return globalThis.crypto.randomUUID();
    }
    return `psi-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
}

function getGalleryWidget(node) {
    return node.widgets?.find((widget) => widget.name === GALLERY_WIDGET);
}

function setGalleryId(node, value) {
    const galleryId = String(value ?? "").trim();
    if (!galleryId) return "";

    const widget = getGalleryWidget(node);
    if (widget) widget.value = galleryId;

    node.properties ??= {};
    node.properties[GALLERY_PROPERTY] = galleryId;
    return galleryId;
}

function getGalleryId(node) {
    const widget = getGalleryWidget(node);
    if (!widget) return "";

    const widgetValue = String(widget.value ?? "").trim();
    if (widgetValue) return setGalleryId(node, widgetValue);

    const propertyValue = String(node.properties?.[GALLERY_PROPERTY] ?? "").trim();
    if (propertyValue) return setGalleryId(node, propertyValue);

    return setGalleryId(node, createGalleryId());
}

function hideGalleryWidget(node) {
    const widget = getGalleryWidget(node);
    if (!widget) return;

    widget.hidden = true;
    widget.type = "hidden";
    widget.computeSize = () => [0, -4];
}

function installFilenameFormatting(node) {
    const widget = node.widgets?.find((item) => item.name === "filename_prefix");
    if (!widget || widget.__persistentSaveImageFormatting) return;

    widget.__persistentSaveImageFormatting = true;
    widget.serializeValue = () => {
        try {
            return applyTextReplacements(app, String(widget.value ?? ""));
        } catch (error) {
            console.warn("Persistent Save Image: filename formatting fallback", error);
            return widget.value;
        }
    };
}

function isPersistentNode(node) {
    return node?.comfyClass === NODE_NAME || node?.type === NODE_NAME;
}

function activeGraphNodes() {
    const graph = app.rootGraph ?? app.graph;
    if (!graph) return [];
    return graph.nodes ?? graph._nodes ?? [];
}

function publishImages(node, images) {
    const output = { images: Array.isArray(images) ? images : [] };

    // Use the same event path as a real server execution. This updates both
    // the current Vue node renderer and the legacy LiteGraph image preview.
    try {
        api.dispatchEvent(
            new CustomEvent("executed", {
                detail: {
                    node: String(node.id),
                    display_node: String(node.id),
                    output,
                },
            }),
        );
        node.images = output.images;
        app.nodeOutputs[String(node.id)] = output;
        app.canvas?.setDirty(true, true);
    } catch (error) {
        console.warn("Persistent Save Image: executed event fallback", error);
        app.nodeOutputs[String(node.id)] = output;
        node.images = output.images;
        node.onExecuted?.(output);
        app.canvas?.setDirty(true, true);
    }
}

async function restoreGallery(node, force = false) {
    if (!isPersistentNode(node) || !node.graph) return;

    const now = Date.now();
    if (!force && now - (node.__persistentGalleryLastRefresh ?? 0) < MIN_NODE_REFRESH_MS) {
        return;
    }
    node.__persistentGalleryLastRefresh = now;

    const galleryId = getGalleryId(node);
    if (!galleryId) return;

    const requestVersion = node.__persistentGalleryExecutionVersion ?? 0;
    const requestId = (node.__persistentGalleryRequestId ?? 0) + 1;
    node.__persistentGalleryRequestId = requestId;

    try {
        const response = await api.fetchApi(
            `/persistent-save-image/gallery?gallery_id=${encodeURIComponent(galleryId)}`,
        );
        if (!response.ok) return;
        const data = await response.json();

        if (node.__persistentGalleryRequestId !== requestId) return;
        if ((node.__persistentGalleryExecutionVersion ?? 0) !== requestVersion) return;
        if (getGalleryId(node) !== galleryId) return;
        if (!Array.isArray(data.images)) return;

        publishImages(node, data.images);
    } catch (error) {
        console.warn("Persistent Save Image: could not restore gallery", error);
    }
}

async function resetGallery(node) {
    const galleryId = getGalleryId(node);
    if (!galleryId) return;

    try {
        const response = await api.fetchApi("/persistent-save-image/reset", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ gallery_id: galleryId }),
        });
        if (!response.ok) {
            throw new Error(`HTTP ${response.status}`);
        }

        node.__persistentGalleryExecutionVersion =
            (node.__persistentGalleryExecutionVersion ?? 0) + 1;
        publishImages(node, []);
        node.images = [];
        node.imgs = [];
        node.imageIndex = null;
        app.canvas?.setDirty(true, true);
    } catch (error) {
        console.error("Persistent Save Image: reset failed", error);
        globalThis.alert?.("Não foi possível resetar a galeria do Persistent Save Image.");
    }
}


async function downloadGallery(node) {
    const galleryId = getGalleryId(node);
    if (!galleryId || node.__persistentGalleryDownloading) return;
    node.__persistentGalleryDownloading = true;
    try {
        // Check the manifest first so an empty gallery does not open an error page.
        const response = await api.fetchApi(
            `/persistent-save-image/gallery?gallery_id=${encodeURIComponent(galleryId)}`,
        );
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const gallery = await response.json();
        if (!Array.isArray(gallery.images) || gallery.images.length === 0) {
            globalThis.alert?.("The gallery is empty.");
            return;
        }

        // Download the original output files individually. The HTML download
        // attribute saves each basename directly, without reproducing subfolders.
        // Browsers control whether to allow multiple automatic downloads.
        const candidates = gallery.images.filter(
            (image) => image && typeof image.filename === "string" &&
                image.filename.length > 0 && image.type === "output",
        );
        const available = await Promise.all(candidates.map(async (image) => {
            const query = new URLSearchParams({
                filename: image.filename,
                subfolder: typeof image.subfolder === "string" ? image.subfolder : "",
                type: "output",
            });
            const route = `/view?${query.toString()}`;
            try {
                // Checking the existing file with HEAD avoids downloading an
                // HTML error page if an old gallery reference is now missing.
                const check = await api.fetchApi(route, { method: "HEAD" });
                if (!check.ok) return null;
            } catch (error) {
                console.warn("Persistent Save Image: image unavailable for download", error);
                return null;
            }
            return {
                url: typeof api.apiURL === "function" ? api.apiURL(route) : route,
                filename: image.filename,
            };
        }));

        const downloads = available.filter(Boolean);
        if (downloads.length === 0) {
            globalThis.alert?.("No existing images were found in this gallery.");
            return;
        }

        // Trigger all downloads from the current gallery snapshot. The browser
        // may request permission to download several files from this site.
        for (const { url, filename } of downloads) {
            const link = document.createElement("a");
            link.href = url;
            link.download = filename;
            link.style.display = "none";
            document.body.appendChild(link);
            link.click();
            link.remove();
        }
    } catch (error) {
        console.error("Persistent Save Image: download failed", error);
        globalThis.alert?.("Could not download the Persistent Save Image gallery.");
    } finally {
        node.__persistentGalleryDownloading = false;
    }
}

function addGalleryActions(node) {
    // A single DOM widget keeps both buttons on the same row in canvas and
    // Vue renderers, even when the node is resized.
    const row = document.createElement("div");
    Object.assign(row.style, {
        display: "flex",
        gap: "4px",
        width: "100%",
        height: `${GALLERY_ACTION_BUTTON_HEIGHT}px`,
        boxSizing: "border-box",
        alignItems: "stretch",
    });

    function makeButton(label, handler) {
        const button = document.createElement("button");
        button.type = "button";
        button.textContent = label;
        Object.assign(button.style, {
            flex: "1 1 0",
            minWidth: "0",
            height: `${GALLERY_ACTION_BUTTON_HEIGHT}px`,
            padding: "0 5px",
            border: "1px solid var(--border-color, #444)",
            borderRadius: "5px",
            background: "var(--comfy-input-bg, #242424)",
            color: "var(--fg-color, #ddd)",
            font: "inherit",
            fontSize: "12px",
            cursor: "pointer",
            boxSizing: "border-box",
        });
        button.addEventListener("pointerdown", (event) => event.stopPropagation());
        button.addEventListener("click", (event) => {
            event.stopPropagation();
            handler();
        });
        return button;
    }

    row.append(
        makeButton("Reset Gallery", () => resetGallery(node)),
        makeButton("Download All", () => downloadGallery(node)),
    );
    node.addDOMWidget("gallery_actions", "custom", row, {
        serialize: false,
        margin: 10,
        // The DOM row remains 28px high. The taller widget allocation keeps
        // the preview below the buttons instead of drawing behind them.
        getHeight: () => GALLERY_ACTION_WIDGET_HEIGHT,
        getMinHeight: () => GALLERY_ACTION_WIDGET_HEIGHT,
        getMaxHeight: () => GALLERY_ACTION_WIDGET_HEIGHT,
    });
}

function initialiseNode(node) {
    if (node.__persistentSaveImageInitialised) return;
    node.__persistentSaveImageInitialised = true;

    getGalleryId(node);
    hideGalleryWidget(node);
    installFilenameFormatting(node);

    addGalleryActions(node);

    const originalOnExecuted = node.onExecuted;
    node.onExecuted = function (message) {
        this.__persistentGalleryExecutionVersion =
            (this.__persistentGalleryExecutionVersion ?? 0) + 1;
        return originalOnExecuted?.apply(this, arguments);
    };

    queueMicrotask(() => restoreGallery(node, true));
}

function refreshActiveGraph(force = false) {
    for (const node of activeGraphNodes()) {
        if (isPersistentNode(node)) {
            initialiseNode(node);
            restoreGallery(node, force);
        }
    }
}

let lastGraph = null;

app.registerExtension({
    name: "VicNodes.PersistentSaveImage.Gallery",

    beforeRegisterNodeDef(nodeType, nodeData) {
        if (nodeData.name !== NODE_NAME) return;

        const originalOnNodeCreated = nodeType.prototype.onNodeCreated;
        nodeType.prototype.onNodeCreated = function () {
            const result = originalOnNodeCreated?.apply(this, arguments);
            initialiseNode(this);
            return result;
        };

        const originalOnSerialize = nodeType.prototype.onSerialize;
        nodeType.prototype.onSerialize = function (data) {
            const result = originalOnSerialize?.apply(this, arguments);
            const galleryId = getGalleryId(this);
            data.properties ??= {};
            data.properties[GALLERY_PROPERTY] = galleryId;
            return result;
        };

        const originalOnConfigure = nodeType.prototype.onConfigure;
        nodeType.prototype.onConfigure = function (data) {
            // Read the redundant node property before normal configuration.
            // This survives workflow embedding in PNG metadata more reliably
            // than depending on a presentation-hidden widget alone.
            const configuredGalleryId = String(
                data?.properties?.[GALLERY_PROPERTY] ?? "",
            ).trim();

            const result = originalOnConfigure?.apply(this, arguments);
            if (configuredGalleryId) {
                setGalleryId(this, configuredGalleryId);
            } else {
                getGalleryId(this);
            }
            hideGalleryWidget(this);
            queueMicrotask(() => restoreGallery(this, true));
            return result;
        };
    },

    setup() {
        lastGraph = app.rootGraph ?? app.graph;
        refreshActiveGraph(true);

        globalThis.setInterval(() => {
            const graph = app.rootGraph ?? app.graph;
            if (graph !== lastGraph) {
                lastGraph = graph;
                refreshActiveGraph(true);
            }
        }, REFRESH_INTERVAL_MS);

        globalThis.addEventListener("focus", () => refreshActiveGraph(true));
        document.addEventListener("visibilitychange", () => {
            if (!document.hidden) refreshActiveGraph(true);
        });
    },
});
