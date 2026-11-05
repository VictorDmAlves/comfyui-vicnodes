/**
 * Visual Compare v1.0.0 — LiteGraph frontend (initial public release).
 * No Nodes 2.0, DOM widget or third-party frontend dependencies required.
 */
import { app } from "../../../scripts/app.js";
import { api } from "../../../scripts/api.js";

const EXTENSION = "vic.visual_compare";
const NODE_CLASS = "VicVisualCompare";
const MODES = [
  ["slider-x", "Slider ↔"],
  ["slider-y", "Slider ↕"],
  ["side", "Side by side"],
  ["grid", "Top / bottom"],
  ["overlay", "Overlay"],
  ["blink", "Blink"],
  ["diff", "Difference"],
];
const SELECTION_MODES = [
  ["auto", "Auto"], ["manual", "Manual"], ["sync", "Sync"],
  ["fixed-a", "Fixed A"], ["fixed-b", "Fixed B"],
];
const DEFAULTS = Object.freeze({
  mode: "slider-x", selectionMode: "auto", indexA: 0, indexB: 0,
  position: 0.5, opacity: 0.5, threshold: 0.12,
  fit: "contain", magnifier: false, magnification: 4,
  region: null, focus: false, labelA: "Original", labelB: "Refined",
  exportDifference: false, exportRegion: true,
  exportScope: "auto", exportPage: 0, manualStepSide: "B",
});
const runtime = new WeakMap();
let activeViewer = null;

function clamp(v, min = 0, max = 1) { return Math.min(max, Math.max(min, v)); }
function isValidRect(r) { return r && [r.x, r.y, r.w, r.h].every(Number.isFinite) && r.w > 0.002 && r.h > 0.002; }
function safeText(t) { return String(t ?? "").slice(0, 90); }
function stateFor(node) {
  node.properties ||= {};
  const saved = node.properties.vc_settings;
  if (!saved || typeof saved !== "object" || Array.isArray(saved)) node.properties.vc_settings = { ...DEFAULTS };
  const s = node.properties.vc_settings;
  if (!MODES.some(([mode]) => mode === s.mode)) s.mode = DEFAULTS.mode;
  if (!SELECTION_MODES.some(([m]) => m === s.selectionMode)) s.selectionMode = "auto";
  s.indexA = Math.max(0, Math.floor(Number(s.indexA) || 0));
  s.indexB = Math.max(0, Math.floor(Number(s.indexB) || 0));
  s.position = clamp(Number(s.position) || 0.5, 0.01, 0.99);
  s.opacity = clamp(Number.isFinite(+s.opacity) ? +s.opacity : 0.5);
  s.threshold = clamp(Number.isFinite(+s.threshold) ? +s.threshold : 0.12);
  s.magnification = [2, 4, 8].includes(+s.magnification) ? +s.magnification : 4;
  if (!["contain", "cover", "stretch"].includes(s.fit)) s.fit = "contain";
  if (!isValidRect(s.region)) s.region = null;
  if (!["auto", "current", "all-b", "all-a", "paired"].includes(s.exportScope)) s.exportScope = "auto";
  s.exportPage = Math.max(0, Math.floor(Number(s.exportPage) || 0));
  if (!["A", "B"].includes(s.manualStepSide)) s.manualStepSide = "B";
  return s;
}
function dirty(node) { node.setDirtyCanvas?.(true, true); }
function rt(node) {
  if (!runtime.has(node)) runtime.set(node, {
    a: null, b: null, imagesA: [], imagesB: [], cache: new Map(),
    thumbs: null, diff: null, diffThreshold: -1, diffFit: "", lastBounds: null,
    mouseDrag: false, blinkB: false, blinkTimer: null, loadToken: null,
  });
  return runtime.get(node);
}
function viewURL(item) {
  const query = new URLSearchParams({ filename: item.filename, subfolder: item.subfolder || "", type: item.type || "temp" });
  return api.apiURL(`/view?${query.toString()}`);
}
function loadImage(item) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`Unable to load image: ${item.filename}`));
    img.src = viewURL(item);
  });
}
function batchCounts(node) {
  const r = rt(node);
  return { a: Math.max(1, r.imagesA.length), b: Math.max(1, r.imagesB.length) };
}
function effectiveSelectionMode(node) {
  const s = stateFor(node);
  if (s.selectionMode !== "auto") return s.selectionMode;
  const { a, b } = batchCounts(node);
  if (a === 1 && b > 1) return "fixed-a";
  if (b === 1 && a > 1) return "fixed-b";
  if (a > 1 && b > 1 && a === b) return "sync";
  return "manual";
}
function clampIndices(node) {
  const s = stateFor(node), { a, b } = batchCounts(node);
  s.indexA = clamp(s.indexA, 0, a - 1);
  s.indexB = clamp(s.indexB, 0, b - 1);
  return s;
}
function indexLabel(index, count) { return `${index + 1} / ${count}`; }
function syncNativeSelection(node) {
  const r = rt(node), s = clampIndices(node), counts = batchCounts(node);
  for (const [key, widget, total] of [["indexA", r.indexAWidget, counts.a], ["indexB", r.indexBWidget, counts.b]]) {
    if (!widget) continue;
    widget.options ||= {};
    widget.options.values = Array.from({ length: total }, (_, i) => indexLabel(i, total));
    widget.value = indexLabel(s[key], total);
    widget.disabled = total < 2;
  }
}
function navigationSide(node) {
  const mode = effectiveSelectionMode(node);
  if (mode === "sync") return "both";
  if (mode === "fixed-a") return "B";
  if (mode === "fixed-b") return "A";
  return stateFor(node).manualStepSide;
}
function navigationSize(node) {
  const counts = batchCounts(node), side = navigationSide(node);
  return side === "both" ? Math.min(counts.a, counts.b) : side === "A" ? counts.a : counts.b;
}
function updateSelection(node, side, index, navigation = false) {
  const s = clampIndices(node), counts = batchCounts(node);
  if (effectiveSelectionMode(node) === "sync") {
    const limit = Math.min(counts.a, counts.b);
    const value = clamp(Math.floor(Number(index) || 0), 0, limit - 1);
    s.indexA = value;
    s.indexB = value;
  } else {
    const key = side === "A" ? "indexA" : "indexB";
    const limit = side === "A" ? counts.a : counts.b;
    if (navigation && limit <= 1) return;
    s[key] = clamp(Math.floor(Number(index) || 0), 0, limit - 1);
  }
  syncNativeSelection(node);
  loadSelectedPair(node);
}
function navigatePair(node, delta) {
  const count = navigationSize(node);
  if (count < 2) return;
  const side = navigationSide(node), s = stateFor(node);
  const current = side === "A" || side === "both" ? s.indexA : s.indexB;
  updateSelection(node, side === "both" ? "A" : side, (current + delta + count) % count, true);
}
function selectionInfo(node) {
  const s = stateFor(node), counts = batchCounts(node);
  const effective = effectiveSelectionMode(node);
  const auto = s.selectionMode === "auto" ? "Auto chose " : "";
  if (effective === "sync") {
    const available = Math.min(counts.a, counts.b);
    return available <= 1
      ? `${auto}Sync: there is only one matching A/B pair (${available}). Use Fixed A to browse B, or Fixed B to browse A.`
      : `${auto}Sync: A and B share the same index. Selecting either frame or pressing Prev/Next advances BOTH (1 to ${available}).`;
  }
  if (effective === "fixed-a") return `${auto}Fixed A: image A ${s.indexA + 1}/${counts.a} stays as the reference; Prev/Next switches B (${counts.b} available). You can choose a different A reference manually.`;
  if (effective === "fixed-b") return `${auto}Fixed B: image B ${s.indexB + 1}/${counts.b} stays as the reference; Prev/Next switches A (${counts.a} available). You can choose a different B reference manually.`;
  const side = s.manualStepSide;
  return `${auto}Manual: A and B can be selected independently. Prev/Next advances ${side} (change Step to switch sides).`;
}
function selectionBadge(node) {
  const mode = effectiveSelectionMode(node), raw = stateFor(node).selectionMode;
  const name = {"sync":"Sync pair", "fixed-a":"Fixed A", "fixed-b":"Fixed B", "manual":"Manual"}[mode];
  return raw === "auto" ? `Auto → ${name}` : name;
}
function syncBlink(node) {
  const r = rt(node);
  const enabled = stateFor(node).mode === "blink" && !!r.a && !!r.b;
  if (enabled && !r.blinkTimer) {
    r.blinkTimer = setInterval(() => {
      if (document.hidden) return;
      r.blinkB = !r.blinkB;
      dirty(node);
      if (activeViewer?.node === node) activeViewer.repaint();
    }, 550);
  } else if (!enabled && r.blinkTimer) {
    clearInterval(r.blinkTimer);
    r.blinkTimer = null;
    r.blinkB = false;
    dirty(node);
  }
}
async function cachedImage(node, item) {
  const r = rt(node), key = viewURL(item);
  if (!r.cache.has(key)) r.cache.set(key, loadImage(item));
  const task = r.cache.get(key);
  // LRU: the latest selected image stays in the cache, older frames are evicted.
  r.cache.delete(key); r.cache.set(key, task);
  while (r.cache.size > 6) r.cache.delete(r.cache.keys().next().value);
  try { return await task; }
  catch (err) { r.cache.delete(key); throw err; }
}
async function loadSelectedPair(node) {
  const r = rt(node), s = clampIndices(node);
  if (!r.imagesA.length || !r.imagesB.length) return;
  const token = Symbol();
  r.loadToken = token;
  r.error = "";
  try {
    const [a, b] = await Promise.all([
      cachedImage(node, r.imagesA[s.indexA]),
      cachedImage(node, r.imagesB[s.indexB]),
    ]);
    if (r.loadToken !== token) return;
    r.a = a; r.b = b; r.thumbs = null; r.diff = null;
    syncBlink(node); dirty(node);
    if (activeViewer?.node === node) activeViewer.refresh();
  } catch (err) {
    if (r.loadToken !== token) return;
    r.error = err.message; r.a = r.b = null; r.thumbs = null;
    syncBlink(node); dirty(node);
    if (activeViewer?.node === node) activeViewer.refresh();
  }
}
function canvas(w, h) {
  const el = document.createElement("canvas");
  el.width = Math.max(1, Math.round(w));
  el.height = Math.max(1, Math.round(h));
  return el;
}
function drawFitted(ctx, img, x, y, w, h, fit = "contain") {
  if (!img?.naturalWidth || !img?.naturalHeight) return;
  const iw = img.naturalWidth, ih = img.naturalHeight;
  if (fit === "stretch") { ctx.drawImage(img, x, y, w, h); return; }
  const ratio = fit === "cover" ? Math.max(w / iw, h / ih) : Math.min(w / iw, h / ih);
  const dw = iw * ratio, dh = ih * ratio;
  ctx.drawImage(img, x + (w - dw) / 2, y + (h - dh) / 2, dw, dh);
}
function prepareImages(a, b, fit, maxDim = 1600) {
  if (!a?.naturalWidth || !b?.naturalWidth) return null;
  const scale = Math.min(1, maxDim / Math.max(a.naturalWidth, a.naturalHeight));
  const w = Math.max(1, Math.round(a.naturalWidth * scale));
  const h = Math.max(1, Math.round(a.naturalHeight * scale));
  const ca = canvas(w, h), cb = canvas(w, h);
  const ctxA = ca.getContext("2d"), ctxB = cb.getContext("2d");
  ctxA.drawImage(a, 0, 0, w, h);
  ctxB.fillStyle = "#0a0c11"; ctxB.fillRect(0, 0, w, h);
  ctxB.save(); ctxB.beginPath(); ctxB.rect(0, 0, w, h); ctxB.clip();
  drawFitted(ctxB, b, 0, 0, w, h, fit);
  ctxB.restore();
  return { a: ca, b: cb, w, h };
}
function getPrepared(node) {
  const r = rt(node), s = stateFor(node);
  if (!r.a || !r.b) return null;
  if (!r.thumbs || r.thumbA !== r.a || r.thumbB !== r.b || r.thumbFit !== s.fit) {
    r.thumbs = prepareImages(r.a, r.b, s.fit);
    r.thumbA = r.a; r.thumbB = r.b; r.thumbFit = s.fit;
    r.diff = null;
  }
  return r.thumbs;
}
function makeHeatmap(pair, sensitivity) {
  if (!pair) return null;
  // Only compare pixels at preview resolution. No backend/GPU computations.
  const a = pair.a.getContext("2d", { willReadFrequently: true }).getImageData(0, 0, pair.w, pair.h).data;
  const b = pair.b.getContext("2d", { willReadFrequently: true }).getImageData(0, 0, pair.w, pair.h).data;
  const result = canvas(pair.w, pair.h);
  const context = result.getContext("2d");
  const out = context.createImageData(pair.w, pair.h);
  const d = out.data;
  const cutoff = sensitivity * 255;
  for (let i = 0; i < d.length; i += 4) {
    const diff = (Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2])) / 3;
    if (diff <= cutoff) continue;
    const t = clamp((diff - cutoff) / Math.max(1, 255 - cutoff));
    d[i] = 255; d[i + 1] = Math.round(220 * (1 - t)); d[i + 2] = Math.round(35 * (1 - t));
    d[i + 3] = Math.round(160 + 95 * Math.pow(t, 0.55));
  }
  context.putImageData(out, 0, 0);
  return result;
}
function getHeatmap(node) {
  const s = stateFor(node), r = rt(node), pair = getPrepared(node);
  if (!pair) return null;
  if (!r.diff || r.diffThreshold !== s.threshold || r.diffFit !== s.fit) {
    r.diff = makeHeatmap(pair, s.threshold);
    r.diffThreshold = s.threshold;
    r.diffFit = s.fit;
  }
  return r.diff;
}
function drawContain(ctx, img, dest, crop) {
  const ir = crop || { x: 0, y: 0, w: 1, h: 1 };
  const sx = ir.x * img.width, sy = ir.y * img.height;
  const sw = Math.max(1, ir.w * img.width), sh = Math.max(1, ir.h * img.height);
  const ratio = Math.min(dest.w / sw, dest.h / sh);
  const dw = sw * ratio, dh = sh * ratio;
  const box = { x: dest.x + (dest.w - dw) / 2, y: dest.y + (dest.h - dh) / 2, w: dw, h: dh };
  ctx.drawImage(img, sx, sy, sw, sh, box.x, box.y, box.w, box.h);
  return { rect: box, crop: ir };
}
function paintComparison(ctx, node, bounds, options = {}) {
  const r = rt(node), s = stateFor(node), pair = getPrepared(node);
  const fill = options.baseFill || "#101218";
  ctx.fillStyle = fill; ctx.fillRect(bounds.x, bounds.y, bounds.w, bounds.h);
  if (!pair) {
    ctx.fillStyle = "#9aa4b6"; ctx.font = "13px Arial, sans-serif";
    ctx.textAlign = "center";
    ctx.fillText(r.error || "Connect image_a + image_b and queue the workflow", bounds.x + bounds.w / 2, bounds.y + bounds.h / 2);
    return [];
  }
  const crop = s.focus && isValidRect(s.region) ? s.region : { x: 0, y: 0, w: 1, h: 1 };
  const mode = options.mode || s.mode;
  const views = [];
  const drawPanel = (img, rectangle, key, overlay = false) => {
    const view = drawContain(ctx, img, rectangle, crop);
    if (!overlay) views.push({ ...view, key });
    return view;
  };
  ctx.save();
  ctx.beginPath(); ctx.rect(bounds.x, bounds.y, bounds.w, bounds.h); ctx.clip();
  if (mode === "side" || mode === "grid") {
    const isSide = mode === "side";
    const first = isSide
      ? { x: bounds.x, y: bounds.y, w: bounds.w / 2 - 3, h: bounds.h }
      : { x: bounds.x, y: bounds.y, w: bounds.w, h: bounds.h / 2 - 3 };
    const second = isSide
      ? { x: bounds.x + bounds.w / 2 + 3, y: bounds.y, w: bounds.w / 2 - 3, h: bounds.h }
      : { x: bounds.x, y: bounds.y + bounds.h / 2 + 3, w: bounds.w, h: bounds.h / 2 - 3 };
    drawPanel(pair.a, first, "A"); drawPanel(pair.b, second, "B");
  } else {
    const mainView = drawPanel(mode === "blink" && r.blinkB ? pair.b : pair.a, bounds, "A");
    if (mode === "overlay") {
      ctx.globalAlpha = s.opacity;
      drawPanel(pair.b, bounds, "B", true);
      ctx.globalAlpha = 1;
    } else if (mode === "slider-x" || mode === "slider-y") {
      const p = clamp(s.position);
      ctx.save(); ctx.beginPath();
      if (mode === "slider-x") ctx.rect(bounds.x + bounds.w * p, bounds.y, bounds.w * (1 - p), bounds.h);
      else ctx.rect(bounds.x, bounds.y + bounds.h * p, bounds.w, bounds.h * (1 - p));
      ctx.clip(); drawPanel(pair.b, bounds, "B", true); ctx.restore();
      ctx.strokeStyle = "#fff"; ctx.lineWidth = 2;
      ctx.beginPath();
      if (mode === "slider-x") { const x = bounds.x + bounds.w * p; ctx.moveTo(x, bounds.y); ctx.lineTo(x, bounds.y + bounds.h); }
      else { const y = bounds.y + bounds.h * p; ctx.moveTo(bounds.x, y); ctx.lineTo(bounds.x + bounds.w, y); }
      ctx.stroke();
      const hx = mode === "slider-x" ? bounds.x + bounds.w * p : bounds.x + bounds.w / 2;
      const hy = mode === "slider-y" ? bounds.y + bounds.h * p : bounds.y + bounds.h / 2;
      ctx.fillStyle = "white"; ctx.beginPath(); ctx.arc(hx, hy, 10, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = "#252a36"; ctx.font = "bold 10px sans-serif"; ctx.textAlign = "center";
      ctx.fillText("↔", hx, hy + 4);
    } else if (mode === "diff") {
      const heat = getHeatmap(node);
      if (heat) drawPanel(heat, bounds, "heat", true);
    }
    if (mode === "blink") mainView.key = r.blinkB ? "B" : "A";
  }
  if (isValidRect(s.region) && !s.focus) {
    const selection = s.region;
    for (const v of views) {
      const box = v.rect, c = v.crop;
      const x = box.x + ((selection.x - c.x) / c.w) * box.w;
      const y = box.y + ((selection.y - c.y) / c.h) * box.h;
      const w = selection.w / c.w * box.w, h = selection.h / c.h * box.h;
      ctx.fillStyle = "#70b9fb1a"; ctx.fillRect(x, y, w, h);
      ctx.strokeStyle = "#80c7ff"; ctx.lineWidth = 2;
      ctx.setLineDash([5, 4]); ctx.strokeRect(x, y, w, h); ctx.setLineDash([]);
    }
  }
  ctx.restore();
  return views;
}
function hit(rect, x, y) { return !!rect && x >= rect.x && x <= rect.x + rect.w && y >= rect.y && y <= rect.y + rect.h; }
function pointWorld(views, x, y) {
  for (const v of views) {
    if (!hit(v.rect, x, y)) continue;
    return {
      x: clamp(v.crop.x + (x - v.rect.x) / v.rect.w * v.crop.w),
      y: clamp(v.crop.y + (y - v.rect.y) / v.rect.h * v.crop.h),
    };
  }
  return null;
}
function normalizeRegion(start, end) {
  if (!start || !end) return null;
  const x = clamp(Math.min(start.x, end.x)), y = clamp(Math.min(start.y, end.y));
  const w = clamp(Math.abs(start.x - end.x), 0, 1 - x), h = clamp(Math.abs(start.y - end.y), 0, 1 - y);
  return w >= 0.01 && h >= 0.01 ? { x, y, w, h } : null;
}
function modeLabel(mode) { return MODES.find(([k]) => k === mode)?.[1] || "Slider"; }

function drawNodeWidget(ctx, node, width, y, widgetHeight) {
  const r = rt(node);
  // Respect the actual height allocated by LiteGraph; do not paint over native controls.
  // Stretch to the actual LiteGraph node height, rather than fixing a 308px preview.
  // Newer frontends allocate the full widget layout height; the explicit node-size
  // fallback also works in older classic LiteGraph builds after manual resizing.
  const available = Math.max(170, node.size[1] - y - 9);
  const height = Math.max(available, Number(widgetHeight) || 0);
  const preview = { x: 8, y: y + 4, w: Math.max(120, width - 16), h: height - 6 };
  r.lastBounds = { preview };
  // Keep the native mode combo synchronized when settings change in the modal.
  if (r.modeWidget) r.modeWidget.value = modeLabel(stateFor(node).mode);
  ctx.save();
  ctx.fillStyle = "#0d1016";
  ctx.fillRect(preview.x, preview.y, preview.w, preview.h);
  r.nodeViews = paintComparison(ctx, node, preview);
  ctx.font = "bold 11px Arial"; ctx.fillStyle = "#ffffff";
  ctx.textAlign = "left"; ctx.textBaseline = "top";
  ctx.fillText("A", preview.x + 9, preview.y + 8);
  ctx.textAlign = "right";
  ctx.fillText("B", preview.x + preview.w - 9, preview.y + 8);
  const s = stateFor(node), counts = batchCounts(node);
  ctx.textAlign = "center";
  ctx.textBaseline = "bottom";
  ctx.fillStyle = "#fff";
  ctx.shadowColor = "#000";
  ctx.shadowBlur = 4;
  ctx.font = "11px Arial";
  ctx.fillText(`A ${indexLabel(s.indexA, counts.a)}    •    B ${indexLabel(s.indexB, counts.b)}`,
    preview.x + preview.w / 2, preview.y + preview.h - 9);
  ctx.restore();
}

function updateNodeDivider(node, pos) {
  const b = rt(node).lastBounds?.preview;
  const s = stateFor(node);
  if (!b || !["slider-x", "slider-y"].includes(s.mode)) return false;
  s.position = clamp(s.mode === "slider-x"
    ? (pos[0] - b.x) / b.w : (pos[1] - b.y) / b.h, 0.01, 0.99);
  dirty(node);
  return true;
}

function localPointerPos(e, node) {
  if (Number.isFinite(e?.canvasX) && Number.isFinite(e?.canvasY))
    return [e.canvasX - node.pos[0], e.canvasY - node.pos[1]];
  return null;
}

function syncNativeMode(node) {
  const r = rt(node);
  if (r.modeWidget) r.modeWidget.value = modeLabel(stateFor(node).mode);
  syncNativeSelection(node);
  if (r.viewerWidget) r.viewerWidget.value = "Open Viewer";
}

function registerNode(nodeType) {
  const proto = nodeType.prototype;
  const oldCreated = proto.onNodeCreated;
  proto.onNodeCreated = function (...args) {
    const result = oldCreated?.apply(this, args);
    this.serialize_widgets = true;
    const node = this;
    const r = rt(node), s = stateFor(node);

    // Built-in LiteGraph widgets are handled by the frontend's widget event system.
    // The previous v1.0 painted buttons directly into the custom widget and relied on
    // node.onMouseDown; recent ComfyUI frontends can dispatch those clicks only to
    // widget callbacks, making the controls appear non-interactive.
    r.modeWidget = this.addWidget(
      "combo", "Compare mode", modeLabel(s.mode), (chosen) => {
        const option = MODES.find(([, label]) => label === chosen);
        if (option) stateFor(node).mode = option[0];
        syncBlink(node);
        dirty(node);
        if (activeViewer?.node === node) activeViewer.refresh();
      },
      { values: MODES.map(([, label]) => label) },
    );
    // Advanced Selection policies are configured exclusively in the Viewer.
    // Keep selectionMode in vc_settings for workflow persistence and batch export.
    r.indexAWidget = this.addWidget("combo", "A image", "1 / 1", chosen => {
      updateSelection(node, "A", parseInt(chosen, 10) - 1);
    }, { values: ["1 / 1"] });
    r.indexBWidget = this.addWidget("combo", "B image", "1 / 1", chosen => {
      updateSelection(node, "B", parseInt(chosen, 10) - 1);
    }, { values: ["1 / 1"] });
    r.viewerWidget = this.addWidget("button", "Open Viewer", "Open Viewer", () => openViewer(node));

    this.addCustomWidget({
      name: "visual_compare_preview", type: "custom", value: null,
      draw: (ctx, widgetNode, width, y, h) => drawNodeWidget(ctx, widgetNode, width, y, h),
      computeSize: width => [width, 220],
      computeLayoutSize: () => ({ minHeight: 220, minWidth: 320 }),
      serializeValue: () => null,
      // Legacy LiteGraph: some ComfyUI builds send pointer events to the widget
      // instead of invoking the node's onMouseDown handler.
      mouse: (event, offset, widgetNode) => {
        const r = rt(widgetNode), b = r.lastBounds?.preview;
        if (!b || !Array.isArray(offset)) return false;
        if (event.type === "pointerdown" || event.type === "mousedown") {
          if (event.button !== 0 || !hit(b, offset[0], offset[1])) return false;
          r.mouseDrag = updateNodeDivider(widgetNode, offset);
          return r.mouseDrag;
        }
        if (event.type === "pointermove" || event.type === "mousemove") {
          if (!r.mouseDrag) return false;
          if (event.buttons === 0) { r.mouseDrag = false; return true; }
          return updateNodeDivider(widgetNode, offset);
        }
        if (event.type === "pointerup" || event.type === "mouseup" || event.type === "pointercancel") {
          if (!r.mouseDrag) return false;
          r.mouseDrag = false;
          return true;
        }
        return false;
      },
      // Modern LiteGraph (CanvasPointer API) explicitly exposes widget interaction.
      onPointerDown: (pointer, widgetNode) => {
        const down = pointer?.eDown;
        const pos = localPointerPos(down, widgetNode);
        const b = rt(widgetNode).lastBounds?.preview;
        if (!pos || !b || down.button !== 0 || !hit(b, pos[0], pos[1])) return false;
        if (!["slider-x", "slider-y"].includes(stateFor(widgetNode).mode)) return false;
        updateNodeDivider(widgetNode, pos);
        pointer.onClick = (e) => {
          const p = localPointerPos(e, widgetNode);
          if (p) updateNodeDivider(widgetNode, p);
        };
        pointer.onDragStart = () => { rt(widgetNode).mouseDrag = true; };
        pointer.onDrag = (e) => {
          const p = localPointerPos(e, widgetNode);
          if (p) updateNodeDivider(widgetNode, p);
        };
        pointer.onDragEnd = () => { rt(widgetNode).mouseDrag = false; };
        pointer.finally = () => { rt(widgetNode).mouseDrag = false; };
        return true;
      },
    });
    const target = this.computeSize();
    const desired = [Math.max(430, target[0] || 0), Math.max(480, target[1] || 0)];
    if (this.size[0] < desired[0] || this.size[1] < desired[1]) this.setSize(desired);
    dirty(this);
    return result;
  };
  const oldConfigure = proto.onConfigure;
  proto.onConfigure = function (...args) {
    const result = oldConfigure?.apply(this, args);
    syncNativeMode(this);
    syncBlink(this);
    return result;
  };
  const oldExecuted = proto.onExecuted;
  proto.onExecuted = async function (data) {
    oldExecuted?.call(this, data);
    if (!data?.a_images?.length || !data?.b_images?.length) return;
    const r = rt(this);
    r.imagesA = data.a_images.slice();
    r.imagesB = data.b_images.slice();
    r.cache.clear();
    r.a = r.b = null;
    r.thumbs = null; r.diff = null;
    const s = clampIndices(this);
    // A new equally sized pair of batches in Auto/Sync mode should start paired.
    if (effectiveSelectionMode(this) === "sync") {
      s.indexA = clamp(s.indexA, 0, Math.min(batchCounts(this).a,batchCounts(this).b)-1);
      s.indexB = s.indexA;
    }
    syncNativeSelection(this);
    syncBlink(this);
    await loadSelectedPair(this);
  };
  // Fallback for older LiteGraph versions that route preview drags to the node.
  const oldDown = proto.onMouseDown;
  proto.onMouseDown = function (event, pos, graphCanvas) {
    const preview = rt(this).lastBounds?.preview;
    if (event.button === 0 && preview && hit(preview, pos[0], pos[1])
        && ["slider-x", "slider-y"].includes(stateFor(this).mode)) {
      rt(this).mouseDrag = true;
      updateNodeDivider(this, pos);
      return true;
    }
    return oldDown?.call(this, event, pos, graphCanvas) || false;
  };
  const oldMove = proto.onMouseMove;
  proto.onMouseMove = function (event, pos, graphCanvas) {
    const r = rt(this);
    if (r.mouseDrag) {
      if (event.buttons === 0) { r.mouseDrag = false; return; }
      updateNodeDivider(this, pos);
      return;
    }
    oldMove?.call(this, event, pos, graphCanvas);
  };
  const oldUp = proto.onMouseUp;
  proto.onMouseUp = function (...args) { rt(this).mouseDrag = false; return oldUp?.apply(this, args); };
  const oldRemoved = proto.onRemoved;
  proto.onRemoved = function (...args) {
    const r = rt(this);
    r.loadToken = null;
    if (r.blinkTimer) { clearInterval(r.blinkTimer); r.blinkTimer = null; }
    r.cache.clear();
    if (activeViewer?.node === this) activeViewer.close();
    return oldRemoved?.apply(this, args);
  };
}

function createViewerHTML() {
  const backdrop = document.createElement("div");
  backdrop.className = "vc-backdrop";
  backdrop.innerHTML = `
    <section class="vc-dialog" role="dialog" aria-modal="true" aria-label="Visual Compare image viewer">
      <header class="vc-header">
        <div class="vc-heading"><strong>Visual Compare</strong><span class="vc-version">v1.0</span></div>
        <div class="vc-actions">
          <button type="button" data-action="export" class="vc-primary">↓ Export PNG</button>
          <button type="button" data-action="close" title="Close viewer (Esc)" class="vc-icon">✕</button>
        </div>
      </header>
      <div class="vc-toolbar">
        <label>Compare <select data-field="mode">
          <option value="slider-x">Slider ↔</option><option value="slider-y">Slider ↕</option>
          <option value="side">Side by side</option><option value="grid">Top / bottom</option>
          <option value="overlay">Overlay</option><option value="blink">Blink</option>
          <option value="diff">Difference heatmap</option>
        </select></label>
        <label>Fit <select data-field="fit">
          <option value="contain">Contain</option><option value="cover">Cover</option>
          <option value="stretch">Stretch</option>
        </select></label>
        <span class="vc-separator"></span>
        <button type="button" data-action="region">▱ Select region</button>
        <button type="button" data-action="focus" title="Toggle enlarged view of the selected region">Focus region</button>
        <button type="button" data-action="clear">Clear region</button>
        <span class="vc-separator"></span>
        <label class="vc-check"><input type="checkbox" data-field="magnifier"> Smart magnifier</label>
        <label>Zoom <select data-field="magnification">
          <option value="2">2×</option><option value="4">4×</option><option value="8">8×</option>
        </select></label>
      </div>
      <div class="vc-batchbar">
        <label>Selection <select data-field="selectionMode">
          <option value="auto">Auto</option><option value="manual">Manual</option>
          <option value="sync">Sync</option><option value="fixed-a">Fixed A</option>
          <option value="fixed-b">Fixed B</option>
        </select></label>
        <label>A <select data-field="indexA" aria-label="Image index A"></select></label>
        <label>B <select data-field="indexB" aria-label="Image index B"></select></label>
        <label data-control="stepSide">Step <select data-field="manualStepSide" aria-label="Side controlled by Prev/Next"><option value="A">A</option><option value="B">B</option></select></label>
        <button type="button" data-action="prev" title="Previous comparison">◀ Prev</button>
        <button type="button" data-action="next" title="Next comparison">Next ▶</button>
        <span class="vc-batch-info" data-role="batch-info"></span>
      </div>
      <div class="vc-stage">
        <canvas class="vc-main-canvas" aria-label="Image comparison canvas"></canvas>
        <div class="vc-loupes" hidden>
          <div class="vc-loupe-box"><span>A</span><canvas width="148" height="148"></canvas></div>
          <div class="vc-loupe-box"><span>B</span><canvas width="148" height="148"></canvas></div>
        </div>
        <div class="vc-stage-notice">Run the node with two IMAGE inputs to load the preview.</div>
      </div>
      <div class="vc-controls">
        <label data-control="position">Divider <input data-field="position" type="range" min="1" max="99" step="1"></label>
        <label data-control="opacity">Opacity <input data-field="opacity" type="range" min="0" max="100" step="1"></label>
        <label data-control="threshold">Diff sensitivity <input data-field="threshold" type="range" min="0" max="80" step="1"></label>
        <span data-role="dimension" class="vc-dimension"></span>
        <span data-role="status" class="vc-status" aria-live="polite">Tip: choose a comparison mode above.</span>
      </div>
      <div class="vc-export-backdrop" hidden>
        <div class="vc-export-dialog" role="dialog" aria-label="Export comparison image">
          <h3>Export comparison</h3>
          <p>Export the current pair or a batch contact sheet: each row compares an A/B pair. Large batches are split into selectable pages (12 pairs per page).</p>
          <div class="vc-export-fields">
            <label>Images to export <select data-field="exportScope">
              <option value="auto">Auto (based on Selection)</option>
              <option value="current">Current A/B pair only</option>
              <option value="all-b">Every B vs selected A</option>
              <option value="all-a">Every A vs selected B</option>
              <option value="paired">Matching pairs A1/B1, A2/B2...</option>
            </select></label>
            <label data-control="exportPage">Sheet page <select data-field="exportPage"></select></label>
            <div data-role="export-summary" class="vc-export-summary" aria-live="polite"></div>
            <label>Image A label <input type="text" data-field="labelA" maxlength="90"></label>
            <label>Image B label <input type="text" data-field="labelB" maxlength="90"></label>
            <label class="vc-check"><input type="checkbox" data-field="exportDifference"> Include difference heatmap</label>
            <label class="vc-check"><input type="checkbox" data-field="exportRegion"> Mark region and include close-ups</label>
          </div>
          <div data-role="export-status" class="vc-export-status"></div>
          <div class="vc-export-actions">
            <button type="button" data-action="cancel-export">Cancel</button>
            <button type="button" data-action="save-export" class="vc-primary">Save PNG</button>
          </div>
        </div>
      </div>
    </section>`;
  return backdrop;
}

function cropAndPaint(ctx, image, rect, region) {
  const source = region || { x: 0, y: 0, w: 1, h: 1 };
  const sx = Math.round(source.x * image.width), sy = Math.round(source.y * image.height);
  const sw = Math.max(1, Math.round(source.w * image.width));
  const sh = Math.max(1, Math.round(source.h * image.height));
  const scale = Math.min(rect.w / sw, rect.h / sh);
  const w = sw * scale, h = sh * scale;
  ctx.drawImage(image, sx, sy, Math.min(sw, image.width - sx), Math.min(sh, image.height - sy),
    rect.x + (rect.w - w) / 2, rect.y + (rect.h - h) / 2, w, h);
}
function drawExportPanel(ctx, label, image, x, y, w, h, options = {}) {
  ctx.fillStyle = "#10141d"; ctx.fillRect(x, y, w, h);
  if (options.fit) {
    ctx.save(); ctx.beginPath(); ctx.rect(x, y, w, h); ctx.clip();
    drawFitted(ctx, image, x, y, w, h, options.fit); ctx.restore();
  } else cropAndPaint(ctx, image, { x, y, w, h }, options.crop);
  if (options.region) {
    const region = options.region;
    ctx.lineWidth = Math.max(2, Math.round(w / 450));
    ctx.strokeStyle = "#6bc5ff";
    ctx.strokeRect(x + region.x * w, y + region.y * h, region.w * w, region.h * h);
  }
  return label;
}
const EXPORT_PAGE_SIZE = 12;
function resolvedExportScope(node) {
  const s = stateFor(node);
  if (s.exportScope !== "auto") return s.exportScope;
  const { a, b } = batchCounts(node), mode = effectiveSelectionMode(node);
  if (a === 1 && b === 1) return "current";
  if (mode === "fixed-a") return "all-b";
  if (mode === "fixed-b") return "all-a";
  if (mode === "sync") return "paired";
  return "current";
}
function exportScopeLabel(scope) {
  return {"current":"Current pair", "all-b":"All B vs A", "all-a":"All A vs B", "paired":"Matched pairs"}[scope] || "Current pair";
}
function exportPairs(node) {
  const s = clampIndices(node), { a, b } = batchCounts(node);
  const scope = resolvedExportScope(node);
  if (scope === "all-b") return Array.from({length:b}, (_, indexB) => ({indexA:s.indexA,indexB}));
  if (scope === "all-a") return Array.from({length:a}, (_, indexA) => ({indexA,indexB:s.indexB}));
  if (scope === "paired") return Array.from({length:Math.min(a,b)}, (_, i) => ({indexA:i,indexB:i}));
  return [{indexA:s.indexA,indexB:s.indexB}];
}
async function exportCanvas(node) {
  const r = rt(node), s = stateFor(node);
  if (!r.imagesA.length || !r.imagesB.length) throw new Error("No images loaded. Run the node first.");
  const pairs = exportPairs(node);
  const pageCount = Math.ceil(pairs.length / EXPORT_PAGE_SIZE);
  const page = clamp(s.exportPage, 0, pageCount - 1);
  const rows = pairs.slice(page * EXPORT_PAGE_SIZE, (page + 1) * EXPORT_PAGE_SIZE);
  const hasRegion = !!s.exportRegion && isValidRect(s.region);
  const cols = s.exportDifference ? 3 : 2;
  const ref = await cachedImage(node, r.imagesA[rows[0].indexA]);
  const refW = ref.naturalWidth, refH = ref.naturalHeight;
  const baseLabelH = Math.max(40, Math.round(refW * .052));
  const baseHeaderH = Math.max(58, Math.round(refW * .08));
  const baseGapH = Math.max(12, Math.round(refW * .018));
  const extraRatio = hasRegion ? .4 : 0;
  const baseExtraH = Math.round(refH * extraRatio);
  const rawW = cols * refW;
  const rawH = baseHeaderH + rows.length * (baseLabelH + refH + baseExtraH + baseGapH);
  const scale = Math.min(1, 13000/rawW, 13000/rawH, Math.sqrt(48000000/(rawW*rawH)));
  const pW = Math.max(1, Math.round(refW * scale)), pH = Math.max(1, Math.round(refH * scale));
  const labelH = Math.max(20, Math.round(baseLabelH * scale));
  const headerH = Math.max(30, Math.round(baseHeaderH * scale));
  const gapH = Math.max(5, Math.round(baseGapH * scale));
  const extraH = hasRegion ? Math.max(1, Math.round(baseExtraH * scale)) : 0;
  const rowH = labelH + pH + extraH + gapH;
  const output = canvas(cols * pW, headerH + rows.length * rowH);
  const ctx = output.getContext("2d", {alpha:false});
  ctx.fillStyle = "#10141d"; ctx.fillRect(0,0,output.width,output.height);
  const font = Math.max(12, Math.min(38, Math.round(pW*.035)));
  ctx.fillStyle = "#e9f0fb";ctx.textBaseline = "middle";ctx.textAlign = "left";
  ctx.font = `bold ${Math.max(15,Math.min(42,Math.round(font*1.2)))}px sans-serif`;
  const scope = exportScopeLabel(resolvedExportScope(node));
  ctx.fillText(`Visual Compare  ·  ${scope}  ·  Page ${page+1}/${pageCount}  ·  ${pairs.length} comparisons`,
    Math.max(10,Math.round(pW*.018)),headerH/2, output.width-20);
  const allCounts = batchCounts(node);
  for(let rowIndex=0;rowIndex<rows.length;rowIndex++) {
    const indices = rows[rowIndex];
    const [a,b] = await Promise.all([
      cachedImage(node,r.imagesA[indices.indexA]),
      cachedImage(node,r.imagesB[indices.indexB]),
    ]);
    const y = headerH + rowIndex*rowH;
    ctx.fillStyle = "#1d2635"; ctx.fillRect(0,y,output.width,labelH);
    const titles=[
      `A ${indexLabel(indices.indexA,allCounts.a)} · ${safeText(s.labelA)||"Original"}`,
      `B ${indexLabel(indices.indexB,allCounts.b)} · ${safeText(s.labelB)||"Refined"}`,
    ];
    if(s.exportDifference)titles.push("Difference heatmap");
    ctx.font = `600 ${font}px sans-serif`;ctx.fillStyle="#ecf3fc";
    titles.forEach((title,i)=>ctx.fillText(title,i*pW+Math.max(6,Math.round(pW*.014)),y+labelH/2,pW-16));
    const imgY = y+labelH;
    drawExportPanel(ctx,titles[0],a,0,imgY,pW,pH,{region:hasRegion?s.region:null});
    drawExportPanel(ctx,titles[1],b,pW,imgY,pW,pH,{fit:s.fit,region:hasRegion?s.region:null});
    let heat = null;
    if(s.exportDifference) {
      const prepared = prepareImages(a,b,s.fit,Math.min(1600,Math.max(480,Math.round(pW))));
      heat=makeHeatmap(prepared,s.threshold);
      drawExportPanel(ctx,titles[2],prepared.a,2*pW,imgY,pW,pH);
      if(heat)ctx.drawImage(heat,2*pW,imgY,pW,pH);
      if(hasRegion) {
        ctx.strokeStyle="#6bc5ff";ctx.lineWidth=Math.max(2,pW/450);
        ctx.strokeRect(2*pW+s.region.x*pW,imgY+s.region.y*pH,s.region.w*pW,s.region.h*pH);
      }
    }
    if(hasRegion) {
      const ey=imgY+pH;
      const crop=s.region;
      cropAndPaint(ctx,a,{x:0,y:ey,w:pW,h:extraH},crop);
      const fb=canvas(refW,refH),fctx=fb.getContext("2d");
      fctx.fillStyle="#10141d";fctx.fillRect(0,0,refW,refH);
      drawFitted(fctx,b,0,0,refW,refH,s.fit);
      cropAndPaint(ctx,fb,{x:pW,y:ey,w:pW,h:extraH},crop);
      if(s.exportDifference && heat)cropAndPaint(ctx,heat,{x:2*pW,y:ey,w:pW,h:extraH},crop);
    }
  }
  return { output, downscaled: scale < .999, width:output.width,height:output.height,
    totalPairs:pairs.length,shownPairs:rows.length,page:page+1,pageCount };
}
async function downloadPNG(node, statusElement, button) {
  if(button?.disabled)return;
  if(button)button.disabled=true;
  statusElement.textContent="Preparing comparison sheet...";
  try {
    const report=await exportCanvas(node);
    statusElement.textContent=`${report.shownPairs} comparisons (page ${report.page}/${report.pageCount}) · ${report.width} × ${report.height} PNG${report.downscaled?' · scaled to safe canvas size':''}.`;
    const blob=await new Promise(resolve=>report.output.toBlob(resolve,"image/png"));
    if(!blob)throw new Error("Browser could not encode the PNG");
    const url=URL.createObjectURL(blob),anchor=document.createElement("a");
    anchor.href=url;anchor.download=`visual_compare_${report.totalPairs}_comparisons_page_${report.page}_${Date.now()}.png`;
    document.body.appendChild(anchor);anchor.click();anchor.remove();
    setTimeout(()=>URL.revokeObjectURL(url),1200);
  } catch(err) {statusElement.textContent=`Export error: ${err.message}`;}
  finally{if(button)button.disabled=false;}
}

function openViewer(node) {
  if (activeViewer) activeViewer.close();
  const backdrop = createViewerHTML();
  document.body.appendChild(backdrop);
  const root = backdrop.querySelector(".vc-dialog");
  const canvasEl = root.querySelector(".vc-main-canvas");
  const stage = root.querySelector(".vc-stage");
  const notice = root.querySelector(".vc-stage-notice");
  const loupes = root.querySelector(".vc-loupes");
  const exportDialog = root.querySelector(".vc-export-backdrop");
  const dimension = root.querySelector('[data-role="dimension"]');
  const status = root.querySelector('[data-role="status"]');
  const exportStatus = root.querySelector('[data-role="export-status"]');
  const exportSummary = root.querySelector('[data-role="export-summary"]');
  const fields = Object.fromEntries([...root.querySelectorAll("[data-field]")].map(el => [el.dataset.field, el]));
  const controls = Object.fromEntries([...root.querySelectorAll("[data-control]")].map(el => [el.dataset.control, el]));
  const actions = Object.fromEntries([...root.querySelectorAll("[data-action]")].map(el => [el.dataset.action, el]));
  let isSelecting = false, selectionStart = null, draggingDivider = false;
  let hintTopic = "selection";
  const modeHints = {
    "slider-x":"Slider ↔: drag the vertical dividing line to reveal A or B.",
    "slider-y":"Slider ↕: drag the horizontal divider to reveal A or B.",
    "side":"Side by side: inspect A on the left and B on the right.",
    "grid":"Top/bottom: inspect A above and B below.",
    "overlay":"Overlay: adjust opacity below to blend B over A.",
    "blink":"Blink: A and B alternate automatically here AND inside the node.",
    "diff":"Difference: brighter regions indicate larger pixel changes; adjust sensitivity below. Click to focus.",
  };
  const updateHint = (topic=hintTopic) => {
    hintTopic=topic;
    const s=stateFor(node);
    const hints={
      selection:selectionInfo(node),
      mode:modeHints[s.mode],
      indexA:`A ${s.indexA+1}/${batchCounts(node).a}: selected image A. ${selectionInfo(node)}`,
      indexB:`B ${s.indexB+1}/${batchCounts(node).b}: selected image B. ${selectionInfo(node)}`,
      step:`Step ${s.manualStepSide}: Prev/Next moves that side in Manual mode. ${selectionInfo(node)}`,
      fit:`Fit ${s.fit}: Contain preserves the whole image; Cover fills the area and may crop; Stretch may distort.`,
      magnifier:s.magnifier?`Magnifier: hover over the image to inspect matching coordinates at ${s.magnification}×.`:"Magnifier off: enable it to inspect A and B at the same coordinates.",
      region:isSelecting?"Region: drag a rectangle on the image, then choose Focus region.":isValidRect(s.region)?"Region selected: choose Focus region for a close-up or Clear region to remove it.":"Region: choose Select region, then drag on the image to mark a comparison area.",
      export:"Export: choose current pair or an entire batch in a labeled PNG contact sheet. Each row is an A/B comparison.",
    };
    status.textContent=`Tip: ${hints[topic]||hints.selection}`;
  };
  let lastMouse = null, views = [], raf = 0, closed = false;
  const state = () => stateFor(node);
  const mark = () => { syncNativeMode(node); dirty(node); requestRender(); };
  const requestRender = () => {
    if (!closed && !raf) raf = requestAnimationFrame(() => { raf = 0; render(); });
  };
  const sync = () => {
    syncNativeMode(node);
    const s = state();
    syncNativeSelection(node);
    const counts = batchCounts(node);
    for (const key of ["mode", "fit", "magnification", "labelA", "labelB", "magnifier", "exportDifference", "exportRegion", "selectionMode"]) {
      if (!fields[key]) continue;
      if (fields[key].type === "checkbox") fields[key].checked = !!s[key];
      else fields[key].value = String(s[key]);
    }
    for (const [key, count] of [["indexA", counts.a], ["indexB", counts.b]]) {
      const picker = fields[key];
      const choices = Array.from({ length: count }, (_, i) => indexLabel(i, count));
      if (picker.options.length !== count || picker.options[0]?.value !== choices[0]) {
        picker.replaceChildren(...choices.map((label, i) => new Option(label, String(i))));
      }
      picker.value = String(s[key]);
      picker.disabled = count < 2;
    }
    controls.stepSide.hidden = effectiveSelectionMode(node) !== "manual";
    fields.manualStepSide.value = s.manualStepSide;
    actions.prev.disabled = navigationSize(node) < 2;
    actions.next.disabled = actions.prev.disabled;
    const batchInfo=root.querySelector('[data-role="batch-info"]');
    batchInfo.textContent=`A ${s.indexA + 1}/${counts.a} · B ${s.indexB + 1}/${counts.b} · ${selectionBadge(node)}`;
    batchInfo.title=selectionInfo(node);
    updateHint();
    fields.position.value = String(Math.round(s.position * 100));
    fields.opacity.value = String(Math.round(s.opacity * 100));
    fields.threshold.value = String(Math.round(s.threshold * 100));
    controls.position.hidden = !["slider-x", "slider-y"].includes(s.mode);
    controls.opacity.hidden = s.mode !== "overlay";
    controls.threshold.hidden = s.mode !== "diff";
    actions.region.classList.toggle("vc-active", isSelecting);
    actions.focus.classList.toggle("vc-active", !!s.focus);
    actions.focus.disabled = !isValidRect(s.region);
    actions.clear.disabled = !isValidRect(s.region);
    loupes.hidden = !s.magnifier || !lastMouse || !rt(node).a;
    syncBlink(node);
  };
  const resize = () => {
    const cssW = Math.max(1, stage.clientWidth), cssH = Math.max(1, stage.clientHeight);
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    canvasEl.width = Math.round(cssW * dpr);
    canvasEl.height = Math.round(cssH * dpr);
    canvasEl.style.width = `${cssW}px`; canvasEl.style.height = `${cssH}px`;
    requestRender();
  };
  const toLocal = e => {
    const b = canvasEl.getBoundingClientRect();
    return { x: e.clientX - b.left, y: e.clientY - b.top };
  };
  const updateLoupe = (point) => {
    const s = state(), pair = getPrepared(node);
    if (!point || !pair || !s.magnifier) { loupes.hidden = true; return; }
    loupes.hidden = false;
    const panels = [pair.a, pair.b];
    const lenses = loupes.querySelectorAll("canvas");
    panels.forEach((source, index) => {
      const target = lenses[index], ctx = target.getContext("2d");
      const side = target.width;
      ctx.fillStyle = "#141923"; ctx.fillRect(0, 0, side, side);
      const patchSize = side / s.magnification;
      const sx = point.x * source.width - patchSize / 2;
      const sy = point.y * source.height - patchSize / 2;
      // Draw via an enlarged source rectangle so both lenses share identical coordinates.
      ctx.save(); ctx.beginPath(); ctx.arc(side / 2, side / 2, side / 2 - 2, 0, Math.PI * 2); ctx.clip();
      ctx.drawImage(source, sx, sy, patchSize, patchSize, 0, 0, side, side);
      ctx.strokeStyle = "#ffffffaa"; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(side / 2 - 8, side / 2); ctx.lineTo(side / 2 + 8, side / 2);
      ctx.moveTo(side / 2, side / 2 - 8); ctx.lineTo(side / 2, side / 2 + 8); ctx.stroke();
      ctx.restore();
    });
  };
  const render = () => {
    if (closed) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const ctx = canvasEl.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const w = canvasEl.width / dpr, h = canvasEl.height / dpr;
    ctx.clearRect(0, 0, w, h);
    const r = rt(node), s = state();
    const margin = 12;
    views = paintComparison(ctx, node, { x: margin, y: margin, w: Math.max(2, w - margin * 2), h: Math.max(2, h - margin * 2) });
    notice.hidden = !!(r.a && r.b);
    dimension.textContent = r.a && r.b
      ? `A ${r.a.naturalWidth}×${r.a.naturalHeight} · B ${r.b.naturalWidth}×${r.b.naturalHeight}` : "";
    if (lastMouse && s.magnifier) updateLoupe(pointWorld(views, lastMouse.x, lastMouse.y));
  };
  const modeChanged = () => { sync(); updateHint("mode"); mark(); };
  fields.selectionMode.addEventListener("change", () => {
    state().selectionMode = fields.selectionMode.value;
    if (effectiveSelectionMode(node) === "sync") {
      const matching=Math.min(batchCounts(node).a,batchCounts(node).b);
      state().indexA=clamp(state().indexA,0,matching-1);
      state().indexB=state().indexA;
    }
    sync(); updateHint("selection"); loadSelectedPair(node); mark();
  });
  for (const key of ["indexA", "indexB"]) {
    fields[key].addEventListener("change", () => {
      updateSelection(node, key === "indexA" ? "A" : "B", Number(fields[key].value));
      sync(); updateHint(key); mark();
    });
  }
  fields.manualStepSide.addEventListener("change",()=>{ state().manualStepSide=fields.manualStepSide.value; sync(); updateHint("step"); mark(); });
  for (const action of ["prev", "next"]) {
    actions[action].addEventListener("click", () => {
      navigatePair(node, action === "prev" ? -1 : 1); sync(); updateHint("selection"); mark();
    });
  }
  fields.mode.addEventListener("change", () => { state().mode = fields.mode.value; modeChanged(); });
  fields.fit.addEventListener("change", () => { state().fit = fields.fit.value; rt(node).thumbs = null; updateHint("fit"); mark(); });
  fields.magnifier.addEventListener("change", () => { state().magnifier = fields.magnifier.checked; sync();updateHint("magnifier"); mark(); });
  fields.magnification.addEventListener("change", () => { state().magnification = Number(fields.magnification.value); updateHint("magnifier"); mark(); });
  for (const key of ["position", "opacity", "threshold"]) {
    fields[key].addEventListener("input", () => {
      state()[key] = Number(fields[key].value) / 100;
      if (key === "threshold") rt(node).diff = null;
      updateHint("mode");mark();
    });
  }
  actions.region.addEventListener("click", () => { isSelecting = !isSelecting; state().focus = false; sync(); updateHint("region"); mark(); });
  actions.focus.addEventListener("click", () => { if (isValidRect(state().region)) { state().focus = !state().focus; sync(); updateHint("region"); mark(); } });
  actions.clear.addEventListener("click", () => { state().region = null; state().focus = false; isSelecting = false; sync(); updateHint("region"); mark(); });
  const syncExportUI = () => {
    const s=state();
    fields.exportScope.value=s.exportScope;
    const pairs=exportPairs(node),pages=Math.ceil(pairs.length/EXPORT_PAGE_SIZE);
    s.exportPage=clamp(s.exportPage,0,pages-1);
    fields.exportPage.replaceChildren(...Array.from({length:pages},(_,i)=>new Option(`${i+1} / ${pages}`,String(i))));
    fields.exportPage.value=String(s.exportPage);
    controls.exportPage.hidden=pages<=1;
    exportSummary.textContent=`${pairs.length} comparison${pairs.length===1?'':'s'} · ${exportScopeLabel(resolvedExportScope(node))} · ${pages} PNG page${pages===1?'':'s'}${pages>1?' (choose a page to export)':''}. Each pair is a labeled row.`;
  };
  actions.export.addEventListener("click", () => { exportStatus.textContent = ""; syncExportUI(); exportDialog.hidden = false; updateHint("export"); fields.exportScope.focus(); });
  fields.exportScope.addEventListener("change",()=>{state().exportScope=fields.exportScope.value;state().exportPage=0;syncExportUI();dirty(node);});
  fields.exportPage.addEventListener("change",()=>{state().exportPage=Number(fields.exportPage.value);syncExportUI();dirty(node);});
  actions["cancel-export"].addEventListener("click", () => { exportDialog.hidden = true; });
  actions["save-export"].addEventListener("click", () => downloadPNG(node, exportStatus, actions["save-export"]));
  for (const key of ["labelA", "labelB"]) fields[key].addEventListener("input", () => { state()[key] = safeText(fields[key].value); dirty(node); });
  for (const key of ["exportDifference", "exportRegion"]) fields[key].addEventListener("change", () => { state()[key] = fields[key].checked; dirty(node); });
  canvasEl.addEventListener("pointerdown", e => {
    if (e.button !== 0) return;
    const local = toLocal(e), p = pointWorld(views, local.x, local.y);
    if (!p) return;
    canvasEl.setPointerCapture(e.pointerId);
    if (isSelecting) {
      selectionStart = p; state().region = null; state().focus = false;
    } else if (["slider-x", "slider-y"].includes(state().mode)) {
      draggingDivider = true;
      const rect = { x: 12, y: 12, w: canvasEl.clientWidth - 24, h: canvasEl.clientHeight - 24 };
      state().position = clamp(state().mode === "slider-x" ? (local.x - rect.x) / rect.w : (local.y - rect.y) / rect.h, 0.01, 0.99);
      fields.position.value = String(Math.round(state().position * 100));
    } else if (state().mode === "diff") {
      // Click on a difference to zoom into the matching location.
      state().region = { x: clamp(p.x - 0.075, 0, 0.85), y: clamp(p.y - 0.075, 0, 0.85), w: 0.15, h: 0.15 };
      state().focus = true;
      sync(); updateHint("region");
    }
    mark();
    e.preventDefault();
  });
  canvasEl.addEventListener("pointermove", e => {
    const local = toLocal(e); lastMouse = local;
    const p = pointWorld(views, local.x, local.y);
    if (selectionStart && p) {
      state().region = normalizeRegion(selectionStart, p);
      mark();
    } else if (draggingDivider) {
      const rect = { x: 12, y: 12, w: canvasEl.clientWidth - 24, h: canvasEl.clientHeight - 24 };
      state().position = clamp(state().mode === "slider-x" ? (local.x - rect.x) / rect.w : (local.y - rect.y) / rect.h, 0.01, 0.99);
      fields.position.value = String(Math.round(state().position * 100));
      mark();
    } else if (state().magnifier) updateLoupe(p);
  });
  const endDrag = () => {
    if (selectionStart) {
      selectionStart = null;
      if (isValidRect(state().region)) {
        isSelecting = false;
      } else state().region = null;
      sync();updateHint("region"); mark();
    }
    draggingDivider = false;
  };
  canvasEl.addEventListener("pointerup", endDrag);
  canvasEl.addEventListener("pointercancel", endDrag);
  canvasEl.addEventListener("pointerleave", () => { if (!selectionStart) { lastMouse = null; loupes.hidden = true; } });
  const onKey = e => {
    if (e.key === "Escape") {
      if (!exportDialog.hidden) exportDialog.hidden = true;
      else viewer.close();
    }
  };
  backdrop.addEventListener("pointerdown", e => { if (e.target === backdrop) viewer.close(); });
  actions.close.addEventListener("click", () => viewer.close());
  document.addEventListener("keydown", onKey);
  const resizeObserver = new ResizeObserver(resize);
  resizeObserver.observe(stage);
  const viewer = {
    node, refresh: () => { sync(); requestRender(); }, repaint: requestRender,
    close: () => {
      if (closed) return;
      closed = true;
      if (raf) cancelAnimationFrame(raf);
      resizeObserver.disconnect();
      document.removeEventListener("keydown", onKey);
      backdrop.remove();
      if (activeViewer === viewer) activeViewer = null;
    },
  };
  activeViewer = viewer;
  sync(); resize();
}

function addStylesheet() {
  if (document.querySelector('[data-vc-style="true"]')) return;
  const link = document.createElement("link");
  link.rel = "stylesheet";
  link.href = new URL("./visual_compare.css", import.meta.url).href;
  link.dataset.vcStyle = "true";
  document.head.appendChild(link);
}

app.registerExtension({
  name: EXTENSION,
  async setup() { addStylesheet(); },
  async beforeRegisterNodeDef(nodeType, nodeData) {
    if (nodeData.name === NODE_CLASS) registerNode(nodeType);
  },
});
