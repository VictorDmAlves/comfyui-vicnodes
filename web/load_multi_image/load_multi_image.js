/**
 * Load Multi Image v1.0.7
 * A lightweight LiteGraph UI: one visible image picker + preview, with
 * explicit pairs of IMAGE and MASK output ports for the added slots.
 */
import { app, ComfyApp } from "../../../scripts/app.js";
import { api } from "../../../scripts/api.js";

const CLASS_NAME = "MultiImageLoaderV1";
const EMPTY = "(none)";
const BASE_TITLE = "Load Multi Image";
const PREVIEW_MARGIN = 12;
const PREVIEW_MIN_HEIGHT = 220; // 192 px of preview plus 28 px footer
const PREVIEW_FOOTER_HEIGHT = 28;
const IMAGE_FILE_EXTENSIONS = /\.(?:png|jpe?g|webp|bmp|gif|tiff?)$/i;
const IMAGE_MIME_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/bmp", "image/gif", "image/tiff"]);


function selected(value) {
    return typeof value === "string" && value.trim() !== "" && value !== EMPTY;
}

function uiState(node) {
    return node.__mimg;
}

function isSupportedImageFile(file) {
    if (!file) return false;
    return IMAGE_FILE_EXTENSIONS.test(String(file.name ?? "")) ||
        IMAGE_MIME_TYPES.has(String(file.type ?? "").toLowerCase());
}

// The ComfyUI frontend delegates canvas drops to a node ONLY when its
// onDragOver returns true. Use the native per-node hooks instead of global
// document listeners, so workflow drops elsewhere keep their normal behavior.
function containsDraggedImage(event) {
    const data = event?.dataTransfer;
    if (!data) return false;
    if (Array.from(data.files ?? []).some(isSupportedImageFile)) return true;
    return Array.from(data.items ?? []).some((item) =>
        item.kind === "file" && IMAGE_MIME_TYPES.has(String(item.type ?? "").toLowerCase()));
}

function markChanged(node) {
    node.setDirtyCanvas?.(true, true);
    node.graph?.setDirtyCanvas?.(true, true);
}

function getWidget(node, index) {
    return uiState(node)?.images?.[index] ?? null;
}

function setWidgetVisibility(widget, visible) {
    if (!widget) return;
    widget.hidden = !visible;
    widget.options ??= {};
    widget.options.hidden = !visible;
    // The computeSize override keeps older ComfyUI canvas renderers compact.
    // The hidden property covers current frontend widgets as well.
    widget.computeSize = visible ? widget.__mimgComputeSize : () => [0, -4];
    if (widget.element) widget.element.style.display = visible ? "" : "none";
    if (widget.inputEl) widget.inputEl.style.display = visible ? "" : "none";
}

function syncOutputs(node) {
    const state = uiState(node);
    if (!state) return;
    const target = state.count * 2;
    // Removing ONLY trailing output pairs preserves the port index of every
    // surviving wire. Never swap or re-number connected port positions.
    while ((node.outputs?.length ?? 0) > target) {
        node.removeOutput(node.outputs.length - 1);
    }
    while ((node.outputs?.length ?? 0) < target) {
        const slotNumber = Math.floor((node.outputs?.length ?? 0) / 2) + 1;
        if ((node.outputs?.length ?? 0) % 2 === 0) {
            node.addOutput(`IMAGE ${slotNumber}`, "IMAGE");
        } else {
            node.addOutput(`MASK ${slotNumber}`, "MASK");
        }
    }
    // Ensure consistent labels/types even after workflow restoration.
    (node.outputs ?? []).forEach((out, i) => {
        out.name = `${i % 2 === 0 ? "IMAGE" : "MASK"} ${Math.floor(i / 2) + 1}`;
        out.type = i % 2 === 0 ? "IMAGE" : "MASK";
    });
}

// The full source is used for Open / Save / Copy (no webp preview conversion).
function imageViewPath(value, preview = false) {
    let path = value.replace(/\s+\[(?:input|output|temp)\]\s*$/i, "");
    const annotation = /\[(input|output|temp)\]\s*$/i.exec(value);
    const type = annotation ? annotation[1].toLowerCase() : "input";
    path = path.replace(/\\/g, "/");
    const slash = path.lastIndexOf("/");
    const filename = slash < 0 ? path : path.substring(slash + 1);
    const subfolder = slash < 0 ? "" : path.substring(0, slash);
    const params = new URLSearchParams({ filename, type, subfolder });
    if (preview) params.set("preview", "webp;80");
    return `/view?${params.toString()}`;
}

function previewUrl(value) {
    return api.apiURL(imageViewPath(value, true));
}

function isOverPreview(node, canvas) {
    const state = uiState(node);
    if (!state || node.flags?.collapsed) return false;
    const point = canvas?.graph_mouse;
    // Older frontends may not provide mouse coordinates to this menu hook.
    // In that case leave the image actions available on the node as a fallback.
    if (!point || !Number.isFinite(point[0]) || !Number.isFinite(point[1])) return true;
    const x = point[0] - node.pos[0];
    const y = point[1] - node.pos[1];
    return x >= PREVIEW_MARGIN && x <= node.size[0] - PREVIEW_MARGIN &&
        y >= state.previewTop && y < node.size[1] - PREVIEW_MARGIN - PREVIEW_FOOTER_HEIGHT;
}

function imageBasename(value) {
    const name = value.replace(/\s+\[(?:input|output|temp)\]\s*$/i, "").replace(/\\/g, "/");
    return name.split("/").pop() || "image.png";
}

function openSourceImage(filename) {
    window.open(api.apiURL(imageViewPath(filename)), "_blank", "noopener,noreferrer");
}

function saveSourceImage(filename) {
    const link = document.createElement("a");
    link.href = api.apiURL(imageViewPath(filename));
    link.download = imageBasename(filename);
    link.style.display = "none";
    document.body.appendChild(link);
    try { link.click(); } finally { link.remove(); }
}

async function copySourceImage(filename) {
    try {
        if (!navigator.clipboard?.write || typeof ClipboardItem === "undefined") {
            throw new Error("Browser clipboard image support is unavailable.");
        }
        // Convert the original source to PNG: ClipboardItem accepts image/png
        // on Chromium/Edge even when the uploaded file is JPEG or WEBP.
        const response = await api.fetchApi(imageViewPath(filename));
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const bitmap = await createImageBitmap(await response.blob());
        let png;
        try {
            const canvas = document.createElement("canvas");
            canvas.width = bitmap.width;
            canvas.height = bitmap.height;
            const ctx = canvas.getContext("2d");
            if (!ctx) throw new Error("Canvas 2D context unavailable.");
            ctx.drawImage(bitmap, 0, 0);
            png = await new Promise((resolve, reject) => canvas.toBlob(
                (blob) => blob ? resolve(blob) : reject(new Error("Cannot encode PNG.")), "image/png"));
        } finally {
            bitmap.close?.();
        }
        await navigator.clipboard.write([new ClipboardItem({ "image/png": png })]);
    } catch (error) {
        console.error("[MIMG] Could not copy image", error);
        window.alert(`Load Multi Image: could not copy image. ${error?.message ?? error}`);
    }
}

/**
 * Open the *native* ComfyUI Mask Editor on a lightweight image-node adapter.
 *
 * The built-in editor requires a single `image` widget, a preview and a
 * writable source node. This loader has `image_1`...`image_N` instead. Never
 * attach `node.imgs` or an `image` widget to the visible multi-image node:
 * doing so would reintroduce the lost context menu from v1.0.0 and could send
 * edits to the wrong slot.
 *
 * A private adapter exposes only the selected slot. On Save, the native editor
 * uploads a painted/masked PNG and writes the image widget. Our setter stores
 * that filename in exactly the captured source slot. The existing Python
 * LoadImage implementation reads PNG alpha as the MASK output, just as on
 * ComfyUI's standard Load Image node. No separate in-memory masks are needed.
 *
 * ComfyApp.open_maskeditor is a compatibility API provided by the frontend.
 * Its use is isolated here so future ComfyUI updates can be supported easily.
 */
function makeMaskEditorAdapter(node, index, originalFilename) {
    const record = imageViewPath(originalFilename);
    const params = new URLSearchParams(record.split("?")[1] || "");
    const baseFilename = params.get("filename") || imageBasename(originalFilename);
    const subfolder = params.get("subfolder") || "";
    const type = params.get("type") || "input";
    const adapter = {
        id: `mimg-mask-editor-${node.id}-${index + 1}`,
        type: "LoadImage",
        title: `Load Multi Image - Mask ${index + 1}`,
        graph: node.graph,
        properties: { image: originalFilename },
        images: [{ filename: baseFilename, subfolder, type }],
        // Required by native editor validation. This private object is never
        // a real LiteGraph node or part of the canvas rendering pipeline.
        imgs: [{ src: api.apiURL(record) }],
        previewMediaType: "image",
        setDirtyCanvas: (...args) => node.setDirtyCanvas?.(...args),
        onWidgetChanged: () => markChanged(node),
    };
    let editorValue = originalFilename;
    const imageWidget = {
        name: "image",
        type: "combo",
        options: {},
        get value() { return editorValue; },
        set value(value) {
            if (!selected(value)) return;
            editorValue = value;
            adapter.properties.image = value;
            // Saving must never reassign a mask to another slot, even if the
            // visible selected preview has changed while the editor was open.
            if (!uiState(node) || index >= uiState(node).count) return;
            const currentValue = getWidget(node, index)?.value;
            if (currentValue !== originalFilename && currentValue !== value) {
                console.warn("[MIMG] Mask edit target changed; not overwriting slot", index + 1);
                window.alert(`Load Multi Image: slot ${index + 1} changed while editing. Mask was saved to disk but not assigned to the slot.`);
                return;
            }
            updateFile(node, index, value);
        },
    };
    adapter.widgets = [imageWidget];
    adapter.getWidgetByName = (name) => name === "image" ? imageWidget : null;
    return adapter;
}

function openSlotMaskEditor(node) {
    const state = uiState(node);
    if (!state) return;
    const index = state.current;
    const filename = getWidget(node, index)?.value;
    if (!selected(filename)) return;
    if (typeof ComfyApp?.open_maskeditor !== "function") {
        window.alert("Load Multi Image: the native Mask Editor is unavailable in this ComfyUI frontend.");
        return;
    }
    const adapter = makeMaskEditorAdapter(node, index, filename);
    const previous = ComfyApp.clipspace_return_node;
    try {
        // The frontend resolves the clipspace node synchronously when opening
        // the editor, then its own loader/saver retains the adapter directly.
        ComfyApp.clipspace_return_node = adapter;
        ComfyApp.open_maskeditor();
    } catch (error) {
        console.error("[MIMG] Could not open native Mask Editor", error);
        window.alert(`Load Multi Image: could not open Mask Editor. ${error?.message ?? error}`);
    } finally {
        // Do not leave an invisible adapter in the user's global clipspace.
        if (ComfyApp.clipspace_return_node === adapter) {
            ComfyApp.clipspace_return_node = previous ?? null;
        }
    }
}

// Use LiteGraph's existing node menu rather than registering `node.imgs`.
// `node.imgs` made the empty node's right-click menu disappear in v1.0.0.
function addImageContextMenu(node, canvas, options) {
    const state = uiState(node);
    if (!state || !isOverPreview(node, canvas)) return;
    // Capture the active filename when the menu opens, not when an action runs.
    const filename = getWidget(node, state.current)?.value;
    if (!selected(filename)) return;
    const items = [
        { content: "Open Image", callback: () => openSourceImage(filename) },
        { content: "Save Image", callback: () => saveSourceImage(filename) },
        { content: "Copy Image", callback: () => { void copySourceImage(filename); } },
        { content: "Open in Mask Editor", callback: () => openSlotMaskEditor(node) },
    ];
    // Native/other-extension menu entries take precedence if already offered.
    const extras = items.filter((item) => !options.some(
        (entry) => entry?.content === item.content));
    if (extras.length) options.unshift(...extras, null);
}

/**
 * Draw the selected input image inside this node, independently of the global
 * ComfyUI `node.imgs` preview mechanism. That global mechanism is also used by
 * unrelated extensions when constructing node context menus; advertising an
 * input-only thumbnail as `node.imgs` can cause those menu hooks to fail.
 * A purely drawn preview leaves LiteGraph's native right-click menu untouched.
 */
function drawPreview(node, ctx) {
    const state = uiState(node);
    if (!state || node.flags?.collapsed || !ctx) return;
    const x = PREVIEW_MARGIN;
    const y = state.previewTop;
    const width = Math.max(1, node.size[0] - PREVIEW_MARGIN * 2);
    const height = Math.max(1, node.size[1] - y - PREVIEW_MARGIN);
    const pictureHeight = Math.max(1, height - PREVIEW_FOOTER_HEIGHT);
    const footerTop = y + pictureHeight;
    const name = getWidget(node, state.current)?.value;
    const dimensions = state.dimensions[state.current];
    const hasDimensions = dimensions?.filename === name &&
        dimensions.width > 0 && dimensions.height > 0;

    ctx.save();
    try {
        ctx.beginPath();
        ctx.rect(x, y, width, height);
        ctx.clip();
        ctx.fillStyle = "#171717";
        ctx.fillRect(x, y, width, height);

        const img = state.previewImage;
        if (img?.complete && img.naturalWidth > 0 && img.naturalHeight > 0) {
            const scale = Math.min(width / img.naturalWidth, pictureHeight / img.naturalHeight);
            const drawWidth = img.naturalWidth * scale;
            const drawHeight = img.naturalHeight * scale;
            ctx.drawImage(img, x + (width - drawWidth) / 2,
                y + (pictureHeight - drawHeight) / 2, drawWidth, drawHeight);
        } else {
            ctx.font = "13px sans-serif";
            ctx.fillStyle = "#aaaaaa";
            ctx.textAlign = "center";
            ctx.textBaseline = "middle";
            ctx.fillText(selected(name) ? "Loading preview..." : "Drop an image here",
                x + width / 2, y + pictureHeight / 2, Math.max(1, width - 16));
        }

        // The dimensions are from the image itself (not the on-canvas zoom).
        // Every slot keeps its own filename/dimensions to avoid stale readouts.
        ctx.fillStyle = "#282828";
        ctx.fillRect(x, footerTop, width, PREVIEW_FOOTER_HEIGHT);
        ctx.font = "12px sans-serif";
        ctx.textBaseline = "middle";
        ctx.fillStyle = "#dddddd";
        ctx.textAlign = "left";
        ctx.fillText(`Image ${state.current + 1}/${state.count}`,
            x + 8, footerTop + PREVIEW_FOOTER_HEIGHT / 2, Math.max(1, width * 0.38));
        ctx.textAlign = "right";
        ctx.fillText(hasDimensions
            ? `${dimensions.width} × ${dimensions.height} px`
            : selected(name) ? "Reading size..." : "No image",
            x + width - 8, footerTop + PREVIEW_FOOTER_HEIGHT / 2,
            Math.max(1, width * 0.57));
    } finally {
        ctx.restore();
    }
}

function updatePreview(node) {
    const state = uiState(node);
    if (!state) return;
    const index = state.current;
    const name = getWidget(node, index)?.value;
    const nonce = ++state.previewRequest;

    state.previewImage = null;
    if (state.dimensions[index]?.filename !== name) state.dimensions[index] = null;
    markChanged(node);
    if (!selected(name)) return;

    const img = new Image();
    img.onload = () => {
        if (!uiState(node) || state.previewRequest !== nonce) return;
        state.previewImage = img;
        state.dimensions[index] = {
            filename: name, width: img.naturalWidth, height: img.naturalHeight,
        };
        markChanged(node);
    };
    img.onerror = () => {
        if (state.previewRequest !== nonce) return;
        state.previewImage = null;
        state.dimensions[index] = null;
        markChanged(node);
        console.warn("[MIMG] Could not preview image:", name);
    };
    img.src = previewUrl(name);
}

// Each paired row is one LiteGraph custom widget, so the two independent
// actions occupy only one widget height. We use native widget hit-testing and
// do not intercept node/global mouse events (right-click still opens the menu).
const PAIR_MARGIN = 12;
const PAIR_GAP = 6;
const PAIR_HEIGHT = 20;

function pairRects(width, y, height = PAIR_HEIGHT) {
    const innerWidth = Math.max(40, width - PAIR_MARGIN * 2 - PAIR_GAP);
    const half = innerWidth / 2;
    return [
        [PAIR_MARGIN, y, half, height],
        [PAIR_MARGIN + half + PAIR_GAP, y, half, height],
    ];
}

function addPairedButtons(node, name, left, right) {
    const widget = {
        type: "custom", name, value: "", y: 0,
        serialize: false, options: { serialize: false },
        computeSize: (width) => [Math.max(180, width || node.size?.[0] || 290), PAIR_HEIGHT],
        draw(ctx, currentNode, width, y, H) {
            const rectangles = pairRects(width, y, Number.isFinite(H) ? H : PAIR_HEIGHT);
            const controls = [left, right];
            const state = uiState(currentNode);
            if (!state) return;
            ctx.save();
            try {
                ctx.font = "12px Arial, sans-serif";
                ctx.textAlign = "center";
                ctx.textBaseline = "middle";
                rectangles.forEach(([x, top, w, h], i) => {
                    const enabled = controls[i].enabled(state);
                    ctx.fillStyle = "#131820";
                    ctx.fillRect(x, top, w, h);
                    ctx.strokeStyle = enabled ? "#343b45" : "#272c33";
                    ctx.strokeRect(x + 0.5, top + 0.5, w - 1, h - 1);
                    ctx.fillStyle = enabled ? "#cbd0d9" : "#70747c";
                    ctx.fillText(controls[i].text(state), x + w / 2,
                        top + h / 2, Math.max(10, w - 8));
                });
            } finally {
                ctx.restore();
            }
        },
        mouse(event, localPos, currentNode) {
            // Only act on the left mouse button being pressed. Ignore releases,
            // movements and right-clicks, preserving native context menus.
            if (event?.type !== "pointerdown" && event?.type !== "mousedown") return false;
            if (event?.button != null && event.button !== 0) return false;
            const state = uiState(currentNode);
            if (!state) return false;
            const rects = pairRects(currentNode.size?.[0] || 290,
                Number.isFinite(widget.y) ? widget.y : 0);
            const [x, y] = localPos || [];
            const i = rects.findIndex(([rx, ry, rw, rh]) =>
                x >= rx && x <= rx + rw && y >= ry && y <= ry + rh);
            if (i < 0) return false;
            const control = i === 0 ? left : right;
            if (control.enabled(state)) control.action(currentNode);
            markChanged(currentNode);
            return true;
        },
    };
    node.addCustomWidget(widget);
    return widget;
}

function refreshUI(node, layoutMode = "update") {
    const state = uiState(node);
    if (!state) return;
    state.count = Math.min(state.max, Math.max(1, state.count));
    state.current = Math.min(state.count - 1, Math.max(0, state.current));
    node.properties ??= {};
    node.properties.mimg_count = state.count;
    node.properties.mimg_current = state.current;

    state.images.forEach((widget, i) => setWidgetVisibility(widget, i === state.current));
    const chosen = getWidget(node, state.current)?.value;
    const fileLabel = selected(chosen) ? String(chosen).split(/[\\/]/).pop() : "empty";
    node.title = `${BASE_TITLE}  [${state.current + 1}/${state.count}]`;
    node.__mimgTooltip = fileLabel;
    const minimum = node.computeSize?.() ?? [290, 245];
    // Keep the preview strictly below widgets/ports, so it cannot hide inputs.
    state.previewTop = Math.max(210, Math.ceil(minimum[1] + 8));
    const neededHeight = state.previewTop + PREVIEW_MIN_HEIGHT + PREVIEW_MARGIN;
    // v1.0.5: A newly created node is compact, but a manually resized node
    // must keep its saved height just like the built-in Load Image node.
    // LiteGraph's resize drag does not reliably invoke onResize on all
    // frontend versions. Detect a user override by comparing the current
    // actual height against the last height that *we* auto-fitted.
    const priorAutoHeight = state.autoHeight;
    const stillAutoSized = state.autoSize && Number.isFinite(priorAutoHeight) &&
        Math.abs(node.size[1] - priorAutoHeight) <= 1;

    if (layoutMode === "restore") {
        // During onConfigure, do not overwrite `size` from the workflow.
        // Remember whether it matches the compact size for future slot edits.
        state.autoSize = Math.abs(node.size[1] - neededHeight) <= 1;
    } else {
        const fitAutomatically = layoutMode === "initial" || stillAutoSized;
        state.autoSize = fitAutomatically;
        const targetHeight = fitAutomatically
            ? neededHeight
            : Math.max(node.size[1], neededHeight);
        const targetWidth = Math.max(node.size[0], 290);
        if (Math.abs(node.size[1] - targetHeight) > 1 ||
            Math.abs(node.size[0] - targetWidth) > 1) {
            node.setSize?.([targetWidth, targetHeight]);
        }
    }
    state.autoHeight = neededHeight;
    markChanged(node);
    updatePreview(node);
}

function selectSlot(node, next) {
    const state = uiState(node);
    if (!state || next < 0 || next >= state.count) return;
    state.current = next;
    refreshUI(node);
}

function addSlot(node, focus = true) {
    const state = uiState(node);
    if (!state || state.count >= state.max) return false;
    state.count++;
    syncOutputs(node);
    if (focus) state.current = state.count - 1;
    refreshUI(node);
    return true;
}

function removeLast(node) {
    const state = uiState(node);
    if (!state) return;
    if (state.count === 1) {
        updateFile(node, 0, EMPTY);
        return;
    }
    const end = state.count * 2;
    const outputs = (node.outputs ?? []).slice(end - 2, end);
    if (outputs.some((out) => (out.links?.length ?? 0) > 0)) {
        if (!window.confirm("Remove the last image slot and disconnect its IMAGE/MASK wires?")) return;
    }
    updateFile(node, state.count - 1, EMPTY, false);
    state.count--;
    state.current = Math.min(state.current, state.count - 1);
    syncOutputs(node);
    refreshUI(node);
}

function updateFile(node, index, value, refresh = true) {
    const widget = getWidget(node, index);
    if (!widget) return;
    const available = widget.options?.values;
    if (Array.isArray(available) && !available.includes(value)) available.push(value);
    const previous = widget.value;
    if (previous !== value) uiState(node).dimensions[index] = null;
    widget.value = value;
    widget.callback?.(value);
    node.onWidgetChanged?.(widget.name, value, previous, widget);
    if (refresh) refreshUI(node);
}

function pickFiles(node) {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "image/png,image/jpeg,image/webp,image/bmp,image/gif,image/tiff";
    input.multiple = true;
    input.style.display = "none";
    document.body.appendChild(input);
    input.addEventListener("cancel", () => input.remove(), { once: true });
    input.addEventListener("change", () => {
        const files = [...(input.files ?? [])];
        input.remove();
        if (files.length) void uploadImages(node, files);
    }, { once: true });
    input.click();
}

async function uploadImages(node, files) {
    const state = uiState(node);
    if (!state || state.uploading) return;
    state.uploading = true;
    if (state.upload) state.upload.label = "Uploading images...";
    const originalSlot = state.current;
    let uploaded = 0;
    try {
        const available = [originalSlot];
        for (let i = originalSlot + 1; i < state.count; i++) {
            if (!selected(getWidget(node, i)?.value)) available.push(i);
        }
        for (let index = 0; index < files.length; index++) {
            if (!available.length) {
                if (!addSlot(node, false)) break;
                available.push(state.count - 1);
            }
            const target = available.shift();
            const form = new FormData();
            form.append("image", files[index]);
            form.append("type", "input");
            const response = await api.fetchApi("/upload/image", { method: "POST", body: form });
            if (!response.ok) throw new Error(`HTTP ${response.status}: ${response.statusText}`);
            const record = await response.json();
            const path = record.subfolder ? `${record.subfolder}/${record.name}` : record.name;
            updateFile(node, target, path, false);
            state.current = target;
            uploaded++;
        }
        if (uploaded < files.length) {
            window.alert(`Uploaded ${uploaded} of ${files.length} images (configured maximum: ${state.max}).`);
        }
    } catch (err) {
        console.error("[MIMG] Image upload failed", err);
        window.alert(`Load Multi Image: upload failed. ${err.message ?? err}`);
    } finally {
        state.uploading = false;
        if (state.upload) state.upload.label = "Upload / Replace";
        refreshUI(node);
    }
}

function attachUI(node, maximum) {
    if (node.__mimg) return;
    const max = Math.max(1, maximum);
    node.properties ??= {};
    const images = Array.from({ length: max }, (_, i) =>
        node.widgets?.find((w) => w.name === `image_${i + 1}`)
    );
    if (images.some((w) => !w)) {
        console.warn("[MIMG] Image widgets not available; UI extension not attached.");
        return;
    }
    const state = node.__mimg = {
        max,
        count: 1,
        current: 0,
        images,
        previewRequest: 0,
        previewImage: null,
        previewTop: 210,
        dimensions: Array(max).fill(null),
        uploading: false,
        autoSize: true,
        autoHeight: null,
    };
    // Native image previews and their context-menu extensions must not be
    // attached to this custom input thumbnail. Keep previews in private state.
    node.imgs = undefined;
    node.imageIndex = undefined;
    const originalDragOver = node.onDragOver;
    node.onDragOver = function (event) {
        if (containsDraggedImage(event)) {
            event.preventDefault?.();
            if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
            return true;
        }
        return originalDragOver?.call(this, event) ?? false;
    };
    const originalDragDrop = node.onDragDrop;
    node.onDragDrop = function (event) {
        const files = Array.from(event?.dataTransfer?.files ?? []).filter(isSupportedImageFile);
        if (files.length) {
            // Return true immediately. ComfyUI's own document drop handler
            // awaits this result and must NOT interpret a PNG as a workflow.
            void uploadImages(this, files);
            return true;
        }
        return originalDragDrop?.call(this, event) ?? false;
    };
    const originalDrawForeground = node.onDrawForeground;
    node.onDrawForeground = function (...args) {
        originalDrawForeground?.apply(this, args);
        drawPreview(this, args[0]);
    };

    images.forEach((widget) => {
        widget.__mimgComputeSize = widget.computeSize;
        const original = widget.callback;
        widget.callback = function (...args) {
            original?.apply(this, args);
            // Switching a native combo changes only that slot's output file.
            // The image displayed is always the active combo's value.
            updatePreview(node);
        };
    });
    const options = { serialize: false };
    state.navigation = addPairedButtons(node, "Image navigation",
        { text: () => "◀ Previous", enabled: (s) => s.current > 0,
          action: (n) => selectSlot(n, uiState(n).current - 1) },
        { text: () => "Next ▶", enabled: (s) => s.current < s.count - 1,
          action: (n) => selectSlot(n, uiState(n).current + 1) });
    state.upload = node.addWidget("button", "Upload / Replace", "Upload", () => pickFiles(node), options);
    state.slotActions = addPairedButtons(node, "Image slot actions",
        { text: () => "+ Add", enabled: (s) => s.count < s.max,
          action: (n) => addSlot(n) },
        { text: (s) => s.count > 1 ? "− Remove" : "− Clear",
          enabled: () => true, action: (n) => removeLast(n) });
    // Trim the backend's full set of ports BEFORE computing the initial
    // preview position. Otherwise the first one-image node reserves vertical
    // space for five image/mask pairs until a second slot is added.
    syncOutputs(node);
    refreshUI(node, "initial");
}

app.registerExtension({
    name: "VicNodes.LoadMultiImage.V1",
    beforeRegisterNodeDef(nodeType, nodeData) {
        if (nodeData.name !== CLASS_NAME) return;
        // Each output pair is independently typed in the backend. JS just
        // chooses how many of the available pairs appear on the canvas.
        const max = Math.floor((nodeData.output?.length ?? 2) / 2);
        const originalCreated = nodeType.prototype.onNodeCreated;
        nodeType.prototype.onNodeCreated = function (...args) {
            const result = originalCreated?.apply(this, args);
            attachUI(this, max);
            syncOutputs(this);
            return result;
        };
        const originalConfigure = nodeType.prototype.onConfigure;
        nodeType.prototype.onConfigure = function (...args) {
            // The workflow's `size` is authoritative. onNodeCreated runs first
            // and temporarily auto-fits a fresh node; never let that temporary
            // size replace the one serialized in an existing workflow.
            const incomingSize = args[0]?.size;
            const savedSize = incomingSize && Number.isFinite(Number(incomingSize[0])) &&
                Number.isFinite(Number(incomingSize[1])) &&
                Number(incomingSize[0]) > 0 && Number(incomingSize[1]) > 0
                ? [Number(incomingSize[0]), Number(incomingSize[1])]
                : null;
            const result = originalConfigure?.apply(this, args);
            if (!uiState(this)) attachUI(this, max);
            const state = uiState(this);
            if (state) {
                const persisted = Number(this.properties?.mimg_count);
                const outputCount = Math.floor((this.outputs?.length ?? 2) / 2);
                state.count = Number.isFinite(persisted) && persisted >= 1
                    ? Math.max(1, Math.min(max, Math.floor(persisted)))
                    : Math.max(1, Math.min(max, outputCount));
                const current = Number(this.properties?.mimg_current ?? 0);
                state.current = Number.isFinite(current) ? Math.floor(current) : 0;
                syncOutputs(this);
                if (savedSize && (Math.abs(this.size[0] - savedSize[0]) > 1 ||
                    Math.abs(this.size[1] - savedSize[1]) > 1)) {
                    this.setSize?.(savedSize);
                }
                refreshUI(this, savedSize ? "restore" : "update");
                // Rebuild canvas preview after the graph finishes configuring,
                // without resetting the dimensions to a hardcoded default.
                requestAnimationFrame(() => {
                    if (!uiState(this)) return;
                    if (savedSize && (Math.abs(this.size[0] - savedSize[0]) > 1 ||
                        Math.abs(this.size[1] - savedSize[1]) > 1)) {
                        this.setSize?.(savedSize);
                    }
                    refreshUI(this, savedSize ? "restore" : "update");
                });
            }
            return result;
        };
        const originalMenu = nodeType.prototype.getExtraMenuOptions;
        nodeType.prototype.getExtraMenuOptions = function (canvas, options, ...args) {
            const result = originalMenu?.call(this, canvas, options, ...args);
            if (Array.isArray(options)) addImageContextMenu(this, canvas, options);
            return result;
        };
        const originalSerialize = nodeType.prototype.onSerialize;
        nodeType.prototype.onSerialize = function (data, ...args) {
            const result = originalSerialize?.call(this, data, ...args);
            const state = uiState(this);
            if (state) {
                data.properties ??= {};
                data.properties.mimg_count = state.count;
                data.properties.mimg_current = state.current;
            }
            return result;
        };
    },
});
