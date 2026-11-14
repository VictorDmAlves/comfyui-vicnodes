import { app } from "../../../scripts/app.js";
import { api } from "../../../scripts/api.js";

const NODE_TYPE = "VicStyleStringInjector";
const API_PATH = "/vic_style_injector";
const STYLESHEET_ID = "vic-style-injector-css";

function installCss() {
  if (document.getElementById(STYLESHEET_ID)) return;
  const link = document.createElement("link");
  link.id = STYLESHEET_ID;
  link.rel = "stylesheet";
  link.href = new URL("./style_injector.css", import.meta.url).href;
  document.head.appendChild(link);
}

function normalizeName(value) {
  return String(value || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLocaleLowerCase();
}

function getWidget(node, name) {
  return node.widgets?.find((w) => w.name === name);
}

function isOurNode(node) {
  return node?.comfyClass === NODE_TYPE || node?.type === NODE_TYPE;
}

function combinedText(styleName, injectPosition, positiveText, library) {
  const base = String(positiveText || "").trim();
  const style = library.find((s) => s.name === styleName);
  const injected = styleName === "None" ? "" : String(style?.text || "").trim();
  if (!injected) return base;
  if (!base) return injected;
  return injectPosition === "After" ? `${base}\n\n${injected}` : `${injected}\n\n${base}`;
}

function markNodeDirty(node) {
  node.setDirtyCanvas?.(true, true);
  app.graph?.setDirtyCanvas?.(true, true);
}

function protectPreview(node) {
  const widget = getWidget(node, "preview");
  if (!widget) return;
  widget.serialize = false; // UI-only: never persist the generated text.
  widget.options ??= {};
  widget.options.serialize = false; // UI-only: never send it to the backend.
  widget.options.readonly = true;
  widget.options.readOnly = true;
  const element = widget.element || widget.inputEl;
  if (!element) return;
  const inputs = element.matches?.("textarea,input") ? [element] : Array.from(element.querySelectorAll?.("textarea,input") || []);
  for (const input of inputs) {
    input.readOnly = true;
    input.setAttribute("readonly", "");
    input.setAttribute("aria-label", "Preview (read only)");
    input.classList.add("vic-si-readonly");
  }
}

function syncPreview(node, force = false) {
  const style = getWidget(node, "style");
  const position = getWidget(node, "inject_position");
  const positive = getWidget(node, "positive");
  const preview = getWidget(node, "preview");
  if (!style || !position || !positive || !preview) return;
  protectPreview(node);
  const selectedStyle = String(style.value || "None");
  const state = node.__vicStyleInjector;
  const library = state?.styles || [];
  const next = combinedText(selectedStyle, position.value, positive.value, library);
  if (force || preview.value !== next) {
    preview.value = next;
    // The legacy frontend can retain a separate textarea DOM value.
    const element = preview.element || preview.inputEl;
    const textarea = element?.matches?.("textarea") ? element : element?.querySelector?.("textarea");
    if (textarea && textarea.value !== next) textarea.value = next;
    markNodeDirty(node);
  }
}

async function fetchStyles() {
  const response = await api.fetchApi(`${API_PATH}/styles`, { cache: "no-store" });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const payload = await response.json();
  if (!Array.isArray(payload.styles)) throw new Error("Unexpected style library response");
  return payload.styles.filter((s) => s && typeof s.name === "string" && typeof s.text === "string" && typeof s.image_url === "string");
}

async function updateLibrary(node) {
  const styles = await fetchStyles();
  if (!isOurNode(node)) return styles;
  node.__vicStyleInjector ??= { styles: [] };
  node.__vicStyleInjector.styles = styles;
  const styleWidget = getWidget(node, "style");
  if (styleWidget) {
    styleWidget.options ??= {};
    styleWidget.options.values = ["None", ...styles.map((s) => s.name)];
  }
  syncPreview(node, true);
  return styles;
}

function setSelectedStyle(node, name) {
  const widget = getWidget(node, "style");
  if (!widget) return;
  widget.value = name;
  widget.callback?.(name);
  syncPreview(node, true);
  markNodeDirty(node);
}

function iconButton(label, title, className = "") {
  const button = document.createElement("button");
  button.type = "button";
  button.className = `vic-si-button ${className}`.trim();
  button.textContent = label;
  if (title) button.title = title;
  return button;
}

function el(tag, cls, text) {
  const element = document.createElement(tag);
  if (cls) element.className = cls;
  if (text != null) element.textContent = text;
  return element;
}

async function openStyleBrowser(node) {
  installCss();
  // Don't add more than one window for the same node.
  if (node.__vicStyleInjector?.modal?.isConnected) return;
  let styles = node.__vicStyleInjector?.styles || [];
  const backdrop = el("div", "vic-si-backdrop");
  backdrop.setAttribute("role", "presentation");
  const dialog = el("section", "vic-si-dialog");
  dialog.setAttribute("role", "dialog");
  dialog.setAttribute("aria-modal", "true");
  dialog.setAttribute("aria-label", "Select Style");
  backdrop.append(dialog);

  const header = el("header", "vic-si-header");
  const headings = el("div", "vic-si-headings");
  headings.append(el("div", "vic-si-eyebrow", "STYLE LIBRARY"), el("h2", "", "Select Style"));
  const closeButton = iconButton("Close", "Close style browser", "vic-si-close");
  header.append(headings, closeButton);

  const toolbar = el("div", "vic-si-toolbar");
  const search = el("input", "vic-si-search");
  search.type = "search";
  search.placeholder = "Filter styles...";
  search.setAttribute("aria-label", "Filter styles");
  const refresh = iconButton("Refresh Styles", "Reload text and image pairs from styles/");
  toolbar.append(search, refresh);

  const main = el("div", "vic-si-main");
  const detail = el("section", "vic-si-detail");
  const visual = el("div", "vic-si-visual");
  const photo = el("img", "vic-si-photo");
  photo.alt = "Selected style preview";
  const placeholder = el("div", "vic-si-empty-photo", "No preview image");
  visual.append(photo, placeholder);
  const copy = el("div", "vic-si-copy");
  const detailHeading = el("div", "vic-si-detail-heading");
  const styleTitle = el("h3", "", "None");
  const status = el("span", "vic-si-status", "Preview only");
  detailHeading.append(styleTitle, status);
  const textHeading = el("div", "vic-si-text-heading", "STYLE PROMPT / TEXT TO INJECT");
  const prompt = el("pre", "vic-si-prompt");
  prompt.textContent = "No style will be injected.";
  copy.append(detailHeading, textHeading, prompt);
  detail.append(visual, copy);

  const rightPanel = el("aside", "vic-si-panel");
  const count = el("div", "vic-si-count", "Loading styles...");
  const list = el("div", "vic-si-list");
  list.setAttribute("role", "listbox");
  list.setAttribute("aria-label", "Available styles");
  rightPanel.append(count, list);
  main.append(detail, rightPanel);

  const footer = el("footer", "vic-si-footer");
  const hint = el("span", "", "Hover to preview. Click a style to apply it.");
  const footerButtons = el("div", "vic-si-footer-buttons");
  const choose = iconButton("Apply Style", "Apply the previewed style", "vic-si-primary");
  const cancel = iconButton("Cancel", "Close without changing the style");
  footerButtons.append(cancel, choose);
  footer.append(hint, footerButtons);
  dialog.append(header, toolbar, main, footer);
  document.body.append(backdrop);
  node.__vicStyleInjector ??= { styles: [] };
  node.__vicStyleInjector.modal = backdrop;

  const initiallySelected = String(getWidget(node, "style")?.value || "None");
  let hoveredName = null;
  let previewedName = initiallySelected;
  let currentName = initiallySelected;
  let closed = false;
  const allStyles = () => [{ name: "None", text: "", image_url: "" }, ...styles];
  const findStyle = (name) => allStyles().find((s) => s.name === name) || allStyles()[0];

  function showStyle(name) {
    const item = findStyle(name);
    previewedName = item.name;
    styleTitle.textContent = item.name;
    prompt.textContent = item.name === "None" ? "No style will be injected. Your positive prompt will remain unchanged." : (item.text.trim() || "This style has an empty text prompt.");
    if (item.image_url) {
      photo.src = api.apiURL(item.image_url);
      photo.alt = `${item.name} preview`;
      photo.style.display = "block";
      placeholder.style.display = "none";
    } else {
      photo.removeAttribute("src");
      photo.style.display = "none";
      placeholder.style.display = "grid";
    }
    status.textContent = item.name === currentName ? "CURRENT STYLE" : "PREVIEW ONLY";
    for (const button of list.querySelectorAll("button[data-style]")) {
      button.classList.toggle("vic-si-active", button.dataset.style === currentName);
      button.classList.toggle("vic-si-hovered", button.dataset.style === previewedName);
      button.setAttribute("aria-selected", button.dataset.style === currentName ? "true" : "false");
    }
  }

  function renderList() {
    const filterText = normalizeName(search.value.trim());
    list.replaceChildren();
    const filtered = allStyles().filter((s) => normalizeName(s.name).includes(filterText));
    count.textContent = `${filtered.length} of ${allStyles().length} styles`;
    if (!filtered.length) {
      list.append(el("p", "vic-si-empty-list", "No styles match your search."));
      return;
    }
    for (const item of filtered) {
      const entry = iconButton(item.name, `Preview ${item.name}`, "vic-si-entry");
      entry.dataset.style = item.name;
      entry.setAttribute("role", "option");
      entry.setAttribute("aria-selected", item.name === currentName ? "true" : "false");
      if (item.name === currentName) entry.classList.add("vic-si-active");
      entry.addEventListener("mouseenter", () => { hoveredName = item.name; showStyle(item.name); });
      entry.addEventListener("focus", () => { hoveredName = item.name; showStyle(item.name); });
      entry.addEventListener("click", () => { currentName = item.name; applyAndClose(); });
      list.append(entry);
    }
    showStyle(hoveredName || currentName);
  }

  function onKeyDown(event) {
    if (event.key === "Escape") { event.preventDefault(); close(); }
  }

  function close() {
    if (closed) return;
    closed = true;
    document.removeEventListener("keydown", onKeyDown, true);
    backdrop.remove();
    if (node.__vicStyleInjector?.modal === backdrop) node.__vicStyleInjector.modal = null;
  }

  function applyAndClose() {
    setSelectedStyle(node, currentName);
    close();
  }

  photo.addEventListener("error", () => {
    photo.style.display = "none";
    placeholder.textContent = "Preview image unavailable";
    placeholder.style.display = "grid";
  });
  list.addEventListener("mouseleave", () => { hoveredName = null; showStyle(currentName); });
  search.addEventListener("input", renderList);
  closeButton.addEventListener("click", close);
  cancel.addEventListener("click", close);
  choose.addEventListener("click", () => { currentName = previewedName; applyAndClose(); });
  backdrop.addEventListener("mousedown", (event) => { if (event.target === backdrop) close(); });
  document.addEventListener("keydown", onKeyDown, true);
  refresh.addEventListener("click", async () => {
    refresh.disabled = true;
    refresh.textContent = "Refreshing...";
    try {
      styles = await updateLibrary(node);
      if (!styles.some((s) => s.name === currentName) && currentName !== "None") currentName = "None";
      hoveredName = null;
      renderList();
    } catch (error) {
      count.textContent = `Could not refresh: ${error.message}`;
    } finally {
      refresh.disabled = false;
      refresh.textContent = "Refresh Styles";
    }
  });

  showStyle(currentName);
  renderList();
  search.focus();
  try {
    styles = await updateLibrary(node);
    if (!closed) renderList();
  } catch (error) {
    if (!closed) count.textContent = `Could not load styles: ${error.message}`;
    console.warn("[Style String Injector]", error);
  }
}

/**
 * A trailing non-serializable action widget is intentional. In certain ComfyUI
 * frontend versions, moving it before a serialized prompt widget can shift
 * `widgets_values` on workflow reload. Instead, keep the action at the end and
 * let the usual LiteGraph resize corners win over its canvas widget hit area.
 *
 * In DOM mode, the widget is inset by 12px on every side; the actual clickable
 * bar occupies only the middle 24px of a 48px row. That leaves real pointer
 * space for the lower corner grips. The widget hit test also needs to yield to
 * the resize grips, because LiteGraph suppresses them while hovering a widget.
 */
function protectBottomResizeCorners(node) {
  if (node.__vicStyleResizeCornersProtected || typeof node.getWidgetOnPos !== "function") return;
  node.__vicStyleResizeCornersProtected = true;
  const originalGetWidgetOnPos = node.getWidgetOnPos;
  node.getWidgetOnPos = function (x, y, ...rest) {
    const pos = this.pos;
    const size = this.size;
    if (pos && size && typeof this.findResizeDirection === "function") {
      const insideBottomCorner = y >= pos[1] + size[1] - 20 && y <= pos[1] + size[1] + 6 &&
        (x <= pos[0] + 20 || x >= pos[0] + size[0] - 20);
      if (insideBottomCorner) {
        const direction = this.findResizeDirection(x, y);
        if (direction === "SE" || direction === "SW" || direction === "S") return null;
      }
    }
    return originalGetWidgetOnPos.call(this, x, y, ...rest);
  };
}

/**
 * Shared VicNodes button standard: dark inset fill, fine outline and a small
 * corner radius, like the Persistent Save Image gallery actions. The button
 * uses the entire available node width and follows manual node resizing.
 *
 * Prefer an actual HTML button in supported ComfyUI frontends. Older legacy
 * frontends can use the same look drawn directly on the LiteGraph canvas.
 */
function installNodeStyleButton(node) {
  if (node.__vicStyleButtonInstalled) return;
  node.__vicStyleButtonInstalled = true;
  const action = () => void openStyleBrowser(node);

  if (typeof node.addDOMWidget === "function") {
    const bar = document.createElement("div");
    bar.className = "vic-si-node-action-bar";
    const button = document.createElement("button");
    button.type = "button";
    button.className = "vic-si-node-action-button";
    button.textContent = "Select Style";
    button.title = "Browse your style library";
    button.setAttribute("aria-label", "Select Style");
    // Clicking a DOM widget must not drag the parent graph node.
    button.addEventListener("pointerdown", (event) => event.stopPropagation());
    button.addEventListener("mousedown", (event) => event.stopPropagation());
    button.addEventListener("click", (event) => {
      event.stopPropagation();
      action();
    });
    bar.append(button);

    const widget = node.addDOMWidget("vic_si_select_style", "vic_si_action", bar, {
      serialize: false,
      // 48px row: 12px click-through margin + 24px button + 12px margin.
      getMinHeight: () => 48,
      getMaxHeight: () => 48,
      getHeight: () => 48,
      margin: 12,
      hideOnZoom: false,
    });
    if (widget) {
      widget.serialize = false;
      widget.options ??= {};
      widget.options.serialize = false;
      // Some versions snapshot DOM widget width at creation, then resist a
      // manually resized node. Let the native positioner use node width.
      if (Object.getOwnPropertyDescriptor(widget, "width")?.configurable !== false) {
        try {
          Object.defineProperty(widget, "width", {
            configurable: true,
            get: () => undefined,
            set: () => {},
          });
        } catch (_) { /* no-op on immutable widgets */ }
      }
      return;
    }
    bar.remove();
  }

  // Canvas fallback with the SAME 1px border and background as the DOM button.
  if (typeof node.addCustomWidget === "function") {
    const custom = {
      name: "Select Style",
      type: "vic_si_action",
      value: null,
      serialize: false,
      options: { serialize: false },
      computeSize(width) { return [width, 48]; },
      draw(ctx, _node, width, y, height) {
        const x = 12;
        const top = y + 12;
        const w = Math.max(24, width - 24);
        const h = 24;
        ctx.save();
        ctx.beginPath();
        if (typeof ctx.roundRect === "function") {
          ctx.roundRect(x, top, w, h, 6);
        } else {
          const r = 6;
          ctx.moveTo(x + r, top);
          ctx.lineTo(x + w - r, top);
          ctx.quadraticCurveTo(x + w, top, x + w, top + r);
          ctx.lineTo(x + w, top + h - r);
          ctx.quadraticCurveTo(x + w, top + h, x + w - r, top + h);
          ctx.lineTo(x + r, top + h);
          ctx.quadraticCurveTo(x, top + h, x, top + h - r);
          ctx.lineTo(x, top + r);
          ctx.quadraticCurveTo(x, top, x + r, top);
          ctx.closePath();
        }
        ctx.fillStyle = "#171d23";
        ctx.strokeStyle = "#313a45";
        ctx.lineWidth = 1;
        ctx.fill();
        ctx.stroke();
        ctx.font = "12px Inter, sans-serif";
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillStyle = "#d5dde5";
        ctx.fillText("Select Style", x + w / 2, top + h / 2);
        ctx.restore();
      },
      mouse(event) {
        if (event.type === "pointerdown" || event.type === "mousedown") {
          action();
          return true;
        }
        return false;
      },
    };
    node.addCustomWidget(custom);
    return;
  }

  // Last resort for very old LiteGraph builds. Functionality still works.
  const legacy = node.addWidget?.("button", "Select Style", "Select Style", action, { serialize: false });
  if (legacy) {
    legacy.serialize = false;
    legacy.options ??= {};
    legacy.options.serialize = false;
  }
}

function wireNode(node) {
  if (node.__vicStyleInjector) return;
  installCss();
  node.__vicStyleInjector = { styles: [], modal: null };
  protectPreview(node);

  // Keep the action widget last to preserve widgets_values order when older
  // ComfyUI frontends serialize a saved workflow. The button is UI-only.
  installNodeStyleButton(node);
  protectBottomResizeCorners(node);

  for (const name of ["style", "inject_position", "positive"]) {
    const widget = getWidget(node, name);
    if (!widget) continue;
    const priorCallback = widget.callback;
    widget.callback = function (...args) {
      const result = priorCallback?.apply(this, args);
      queueMicrotask(() => syncPreview(node));
      return result;
    };
    const element = widget.element || widget.inputEl;
    if (element?.addEventListener && name === "positive") {
      element.addEventListener("input", () => queueMicrotask(() => syncPreview(node)));
    }
  }

  const originalConfigured = node.onConfigure;
  node.onConfigure = function (...args) {
    const result = originalConfigured?.apply(this, args);
    queueMicrotask(() => { protectPreview(this); syncPreview(this, true); });
    return result;
  };

  const originalWidgetChanged = node.onWidgetChanged;
  node.onWidgetChanged = function (...args) {
    const result = originalWidgetChanged?.apply(this, args);
    queueMicrotask(() => syncPreview(this));
    return result;
  };

  const originalDrawForeground = node.onDrawForeground;
  node.onDrawForeground = function (...args) {
    const result = originalDrawForeground?.apply(this, args);
    // Cheap check also catches edits in older/newer DOM-based text widgets.
    syncPreview(this);
    return result;
  };

  syncPreview(node, true);
  void updateLibrary(node).catch((err) => console.warn("[Style String Injector] Library initialization:", err));
}

app.registerExtension({
  name: "vicnodes.style-string-injector",
  nodeCreated(node) {
    if (isOurNode(node)) wireNode(node);
  },
});
