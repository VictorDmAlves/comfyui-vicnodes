import { app } from "../../../scripts/app.js";
import { api } from "../../../scripts/api.js";

// We only resize the widget's CONTENT. We never call node.setSize()/computeSize()
// or mutate node.size. The user controls the node's dimensions.
const TYPES = new Set(["VicVideoDuration", "VicVideoLoad", "VicVideoCombine", "VicVideoStitch"]);
// The output event is transient. ComfyUI reconstructs nodes when workflow tabs
// change, so keep only lightweight, serializable file metadata in properties.
// The actual video always remains on disk, never inside the workflow JSON.
const LAST_PREVIEW_PROPERTY = "vicvideo_last_preview";

function videoOutput(message) {
    const output = message?.output || message;
    return (output?.vic_video || output?.vic_video_input)?.[0] || null;
}

function sanitizeVideoResult(item, defaultType) {
    if (!item || typeof item.filename !== "string" || !item.filename.trim()) return null;
    // The server checks all file paths. Do not persist any arbitrary object
    // or full data URL returned from a third-party extension.
    const type = ["input", "output", "temp"].includes(item.type) ? item.type : defaultType;
    return {
        filename: item.filename,
        type,
        subfolder: typeof item.subfolder === "string" ? item.subfolder : "",
        frames: Number.isFinite(Number(item.frames)) ? Number(item.frames) : 0,
        fps: Number.isFinite(Number(item.fps)) ? Number(item.fps) : 0,
        seconds: Number.isFinite(Number(item.seconds)) ? Number(item.seconds) : 0,
        method: typeof item.method === "string" ? item.method : "",
    };
}

function saveAndShowVideo(node, item, isLoad) {
    const saved = sanitizeVideoResult(item, isLoad ? "input" : "output");
    if (!saved) return;
    if (!node.properties) node.properties = {};
    node.properties[LAST_PREVIEW_PROPERTY] = saved;
    node._vicPreview?.setResult(saved);
}

function restoreSavedVideo(node, isLoad, configuredData = null) {
    const saved = sanitizeVideoResult(
        node.properties?.[LAST_PREVIEW_PROPERTY] ||
        configuredData?.properties?.[LAST_PREVIEW_PROPERTY],
        isLoad ? "input" : "output"
    );
    if (!saved) return;
    // For Video Load, the selected input file takes precedence if the user
    // changed it without running the node again. Combine keeps its last output.
    if (isLoad && valueOf(node, "video", "") !== saved.filename) return;
    node._vicPreview?.setResult(saved);
}

function getVideoNodeById(nodeId) {
    const graph = app.rootGraphOrUndefined || app.graph;
    if (!graph) return null;
    const node = graph.getNodeById?.(nodeId) ||
        graph.getNodeById?.(Number(nodeId)) ||
        graph._nodes?.find((candidate) => String(candidate.id) === String(nodeId));
    if (!node || !["VicVideoLoad", "VicVideoCombine", "VicVideoStitch"].includes(node.type)) return null;
    return node;
}

function domBox() {
    const root = document.createElement("div");
    root.style.cssText = [
        "width:100%", "height:100%", "min-width:0", "min-height:0",
        "box-sizing:border-box", "display:flex", "flex-direction:column",
        "gap:5px", "overflow:hidden", "border-radius:7px",
        "background:rgba(0,0,0,.22)", "padding:6px",
        "font:11px/1.35 sans-serif", "color:#ddd"
    ].join(";");
    return root;
}

function addFlexibleDOMWidget(node, name, root, minHeight) {
    if (typeof node.addDOMWidget !== "function") return null;
    const widget = node.addDOMWidget(name, "vicvideo_preview", root, {
        serialize: false,
        hideOnZoom: true,
        // 100% asks the ComfyUI DOM widget layout to fill the *available* height.
        // minHeight keeps the player usable when the user makes the node compact.
        getMinHeight: () => minHeight,
        getHeight: () => "100%",
        margin: 8,
    });
    if (widget) widget.serialize = false;
    return widget;
}

function mediaURL(name, type, subfolder = "", route = "preview") {
    const params = new URLSearchParams({ filename: name, type, subfolder });
    return api.apiURL(`/vicvideo/${route}?${params.toString()}`);
}

function makeButton(title, visible = true) {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = title;
    button.style.cssText = [
        "flex:0 0 auto", "padding:4px 9px", "height:26px", "min-width:0",
        "border:1px solid #525864", "border-radius:5px",
        "color:#ddd", "background:#242933", "font:11px sans-serif", "cursor:pointer"
    ].join(";");
    button.hidden = !visible;
    button.style.display = visible ? "" : "none";
    return button;
}

function triggerDownload(item) {
    if (!item?.filename) return;
    // Dedicated download route supplies Content-Disposition: attachment with
    // filename_prefix + sequence, including when the output uses subfolders.
    const a = document.createElement("a");
    a.href = mediaURL(item.filename, item.type || "output", item.subfolder || "", "download");
    a.download = item.filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
}

function addVideoPreview(node, isLoad) {
    const root = domBox();
    const video = document.createElement("video");
    video.controls = true;
    video.preload = "metadata";
    video.playsInline = true;
    video.style.cssText = [
        "display:block", "width:100%", "height:100%", "flex:1 1 0",
        "min-width:0", "min-height:0", "object-fit:contain",
        "background:#080808", "border-radius:5px"
    ].join(";");

    const footer = document.createElement("div");
    footer.style.cssText = "display:flex;align-items:center;gap:6px;min-width:0;flex:0 0 26px;";
    const label = document.createElement("span");
    label.textContent = isLoad ? "Select or upload a video" : "Preview appears after generation";
    label.title = label.textContent;
    label.style.cssText = "flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;";
    const actionButton = makeButton(isLoad ? "Upload Video" : "Download", isLoad);
    footer.append(label, actionButton);
    root.append(video, footer);
    addFlexibleDOMWidget(node, "vic_video_preview", root, 188);

    let lastKey = "";
    let lastItem = null;
    const setVideo = (name, type, extra = "", subfolder = "") => {
        if (!name) return;
        const key = `${type}|${subfolder}|${name}`;
        if (key !== lastKey) {
            lastKey = key;
            video.pause();
            video.src = mediaURL(name, type, subfolder);
            video.load();
        }
        label.textContent = extra ? `${name} · ${extra}` : name;
        label.title = label.textContent;
    };
    const setResult = (item) => {
        lastItem = item;
        const info = `${item.frames} frames · ${Number(item.fps).toFixed(3)} FPS · ${Number(item.seconds).toFixed(3)}s`
            + (item.method ? ` · ${item.method}` : "");
        setVideo(item.filename, item.type || "input", info, item.subfolder || "");
        if (!isLoad) {
            actionButton.hidden = false;
            actionButton.style.display = "";
        }
    };
    actionButton.addEventListener("click", (event) => {
        event.stopPropagation();
        if (!isLoad) triggerDownload(lastItem);
    });
    const showError = (message) => {
        label.textContent = message;
        label.title = message;
    };
    return { root, actionButton, setVideo, setResult, showError, get lastItem() { return lastItem; } };
}

function valueOf(node, name, fallback) {
    return node.widgets?.find((widget) => widget.name === name)?.value ?? fallback;
}

function countFrames(seconds, fps, rule, rounding) {
    const target = seconds * fps;
    if (!Number.isFinite(target) || seconds <= 0 || fps <= 0) return 0;
    if (rule === "Any frame count") {
        const fn = rounding === "At least" ? Math.ceil : rounding === "At most" ? Math.floor : Math.round;
        return Math.max(1, fn(target));
    }
    const offset = (target - 1) / 4;
    const k = rounding === "At least" ? Math.ceil(offset - 1e-8)
        : rounding === "At most" ? Math.floor(offset + 1e-8) : Math.round(offset);
    return 4 * Math.max(0, k) + 1;
}

function addDurationStatus(node) {
    const root = domBox();
    root.style.justifyContent = "center";
    const caption = document.createElement("div");
    caption.style.cssText = "font-size:clamp(12px,1.1vw,17px);font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;";
    const small = document.createElement("div");
    small.style.cssText = "font-size:11px;opacity:.8;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;";
    root.append(caption, small);
    addFlexibleDOMWidget(node, "vic_duration_readout", root, 54);

    const recalculate = () => {
        const seconds = Number(valueOf(node, "seconds", 5));
        const fps = Number(valueOf(node, "fps", 24));
        const rule = valueOf(node, "temporal_rule", "Wan (4n+1)");
        const rounding = valueOf(node, "rounding", "Nearest");
        const frames = countFrames(seconds, fps, rule, rounding);
        caption.textContent = `${frames} frames · ${fps} FPS`;
        small.textContent = `Actual duration: ${(frames / Math.max(fps, 1)).toFixed(3)} seconds`;
    };
    for (const widget of node.widgets || []) {
        if (!["seconds", "fps", "temporal_rule", "rounding"].includes(widget.name)) continue;
        const prior = widget.callback;
        widget.callback = function (...args) {
            if (prior) prior.apply(this, args);
            recalculate();
        };
    }
    recalculate();
    return recalculate;
}

function connectInputPreview(node, preview) {
    const widget = node.widgets?.find((item) => item.name === "video");
    if (!widget) return;
    const prior = widget.callback;
    widget.callback = function (...args) {
        if (prior) prior.apply(this, args);
        if (typeof widget.value === "string" && widget.value !== "Upload a video first") {
            preview.setVideo(widget.value, "input");
        }
    };
    const refresh = () => {
        if (typeof widget.value === "string" && widget.value !== "Upload a video first") {
            preview.setVideo(widget.value, "input");
        }
    };
    refresh();
    return { widget, refresh };
}

function attachUploader(node, preview, fileState) {
    preview.actionButton.addEventListener("click", () => {
        const picker = document.createElement("input");
        picker.type = "file";
        picker.accept = "video/*,.mkv,.webm,.m4v,.avi,.gif";
        picker.style.display = "none";
        picker.addEventListener("cancel", () => picker.remove(), { once: true });
        picker.addEventListener("change", async () => {
            const file = picker.files?.[0];
            if (!file) { picker.remove(); return; }
            preview.showError("Uploading video...");
            const data = new FormData();
            data.append("video", file, file.name);
            try {
                const response = await api.fetchApi("/vicvideo/upload", { method: "POST", body: data });
                if (!response.ok) throw new Error(await response.text());
                const result = await response.json();
                const widget = fileState?.widget;
                if (widget) {
                    widget.options = widget.options || {};
                    const values = widget.options.values || [];
                    if (!values.includes(result.name)) values.push(result.name);
                    widget.options.values = values;
                    widget.value = result.name;
                    widget.callback?.(result.name);
                }
                preview.setVideo(result.name, "input");
                app.graph?.setDirtyCanvas(true, true);
            } catch (error) {
                console.error("[Vic Video Tools] Upload error", error);
                preview.showError(`Upload failed: ${error.message}`);
            } finally {
                picker.remove();
            }
        }, { once: true });
        document.body.appendChild(picker);
        picker.click();
    });
}


// Video Stitch: dynamic video_3..video_16 STRING sockets. The first two
// sockets are registered in Python; the rest are accepted as optional inputs.
const STITCH_SLOT_PROPERTY = "vicvideo_stitch_slot_count";
function videoSlotCount(node) {
    const numbers = (node.inputs || []).map((input) => /^video_(\d+)$/.exec(input.name || ""))
        .filter(Boolean).map((match) => Number(match[1]));
    return Math.max(2, ...numbers);
}
function restoreStitchSockets(node, savedData = null) {
    const stored = Number(node.properties?.[STITCH_SLOT_PROPERTY]
        ?? savedData?.properties?.[STITCH_SLOT_PROPERTY] ?? 2);
    const serialized = (savedData?.inputs || []).map((item) => /^video_(\d+)$/.exec(item.name || ""))
        .filter(Boolean).map((match) => Number(match[1]));
    const count = Math.min(16, Math.max(2, Number.isFinite(stored) ? stored : 2, ...serialized));
    for (let i = 3; i <= count; i++) {
        if (!(node.inputs || []).some((item) => item.name === `video_${i}`)) {
            node.addInput?.(`video_${i}`, "STRING");
        }
    }
    node.properties ||= {};
    node.properties[STITCH_SLOT_PROPERTY] = videoSlotCount(node);
}
function addStitchControls(node, preview) {
    const bar = document.createElement("div");
    bar.style.cssText = "display:flex;align-items:center;gap:5px;min-width:0;flex:0 0 26px;";
    const add = makeButton("+ Add Video");
    const remove = makeButton("- Remove");
    const upload = makeButton("Upload Clips");
    add.style.flex = remove.style.flex = upload.style.flex = "1 1 auto";
    bar.append(add, remove, upload);
    preview.root.append(bar);
    const repaint = () => app.graph?.setDirtyCanvas?.(true, true);
    add.addEventListener("click", (event) => {
        event.stopPropagation();
        const n = videoSlotCount(node);
        if (n >= 16) { preview.showError("Maximum: 16 video inputs"); return; }
        node.addInput?.(`video_${n+1}`, "STRING");
        node.properties ||= {};
        node.properties[STITCH_SLOT_PROPERTY] = n+1;
        repaint();
    });
    remove.addEventListener("click", (event) => {
        event.stopPropagation();
        const n = videoSlotCount(node);
        if (n <= 2) return;
        const index = node.inputs?.findIndex((slot) => slot.name === `video_${n}`) ?? -1;
        if (index < 0) return;
        if (node.inputs[index].link != null) {
            preview.showError(`Disconnect video_${n} first`);
            return;
        }
        node.removeInput?.(index);
        node.properties ||= {};
        node.properties[STITCH_SLOT_PROPERTY] = videoSlotCount(node);
        repaint();
    });
    upload.addEventListener("click", (event) => {
        event.stopPropagation();
        const picker = document.createElement("input");
        picker.type = "file";
        picker.multiple = true;
        picker.accept = "video/*,.mkv,.webm,.m4v,.avi,.gif";
        picker.style.display = "none";
        picker.addEventListener("change", async () => {
            const clips = Array.from(picker.files || []);
            const widget = node.widgets?.find((item) => item.name === "manual_files");
            if (!clips.length || !widget) { picker.remove(); return; }
            let count = 0;
            for (const clip of clips) {
                const data = new FormData();
                data.append("video", clip, clip.name);
                try {
                    const response = await api.fetchApi("/vicvideo/upload", { method: "POST", body: data });
                    if (!response.ok) throw new Error(await response.text());
                    const result = await response.json();
                    widget.value = [String(widget.value || "").trim(), `input:${result.name}`]
                        .filter(Boolean).join("\n");
                    widget.callback?.(widget.value);
                    count++;
                } catch (error) {
                    console.error("[Vic Video Tools] Upload failed", error);
                    preview.showError(`Upload failed: ${error.message}`);
                    break;
                }
            }
            if (count) preview.showError(`${count} clip(s) added to manual_files`);
            repaint();
            picker.remove();
        }, { once: true });
        picker.addEventListener("cancel", () => picker.remove(), { once: true });
        document.body.appendChild(picker);
        picker.click();
    });
}

app.registerExtension({
    name: "vic.video_tools.persistent_preview",
    async beforeRegisterNodeDef(nodeType, nodeData) {
        if (!TYPES.has(nodeData.name)) return;
        const originalCreated = nodeType.prototype.onNodeCreated;
        const originalExecuted = nodeType.prototype.onExecuted;
        const originalConfigure = nodeType.prototype.onConfigure;
        const originalSerialize = nodeType.prototype.onSerialize;
        const originalGetExtraMenuOptions = nodeType.prototype.getExtraMenuOptions;

        nodeType.prototype.onNodeCreated = function (...args) {
            const result = originalCreated?.apply(this, args);
            if (nodeData.name === "VicVideoDuration") {
                this._vicRefresh = addDurationStatus(this);
            } else {
                this._vicPreview = addVideoPreview(this, nodeData.name === "VicVideoLoad");
                if (nodeData.name === "VicVideoLoad") {
                    this._vicInput = connectInputPreview(this, this._vicPreview);
                    attachUploader(this, this._vicPreview, this._vicInput);
                } else if (nodeData.name === "VicVideoStitch") {
                    restoreStitchSockets(this);
                    addStitchControls(this, this._vicPreview);
                }
            }
            return result;
        };

        nodeType.prototype.onExecuted = function (message) {
            originalExecuted?.apply(this, arguments);
            if (nodeData.name === "VicVideoDuration") {
                this._vicRefresh?.();
                return;
            }
            const item = videoOutput(message);
            if (item) saveAndShowVideo(this, item, nodeData.name === "VicVideoLoad");
        };

        nodeType.prototype.onConfigure = function (...args) {
            const result = originalConfigure?.apply(this, args);
            this._vicInput?.refresh?.();
            this._vicRefresh?.();
            if (nodeData.name === "VicVideoStitch") restoreStitchSockets(this, args[0]);
            if (nodeData.name !== "VicVideoDuration") {
                restoreSavedVideo(this, nodeData.name === "VicVideoLoad", args[0]);
            }
            return result;
        };

        nodeType.prototype.onSerialize = function (data) {
            const result = originalSerialize?.apply(this, arguments);
            // Keep the preview across save/reopen even in frontend versions
            // whose node serializer only forwards the properties in `data`.
            const saved = this.properties?.[LAST_PREVIEW_PROPERTY];
            if (saved && data && typeof data === "object") {
                if (!data.properties) data.properties = {};
                data.properties[LAST_PREVIEW_PROPERTY] = saved;
            }
            return result;
        };

        if (nodeData.name === "VicVideoCombine" || nodeData.name === "VicVideoStitch") {
            nodeType.prototype.getExtraMenuOptions = function (canvas, options) {
                const result = originalGetExtraMenuOptions?.apply(this, arguments);
                const item = this._vicPreview?.lastItem;
                if (item?.filename && Array.isArray(options)) {
                    options.push({ content: "Download Video", callback: () => triggerDownload(item) });
                }
                return result;
            };
        }
    },
    // The ComfyUI frontend invokes this when outputs are restored from queue
    // history or workflow tabs. Unlike `onExecuted`, it does not require a new
    // generation. This also recovers v0.1.1 results without saved properties
    // when the frontend still has the output in its cache.
    onNodeOutputsUpdated(nodeOutputs) {
        if (!nodeOutputs || typeof nodeOutputs !== "object") return;
        for (const [nodeId, output] of Object.entries(nodeOutputs)) {
            const item = videoOutput(output);
            if (!item) continue;
            const node = getVideoNodeById(nodeId);
            if (node) saveAndShowVideo(node, item, node.type === "VicVideoLoad");
        }
    },
});
