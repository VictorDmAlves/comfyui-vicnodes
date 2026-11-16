/** Fast Groups Control manager dialog (shared by both virtual nodes). */
import {
  settings, reconcileGroups, passesFilters, sortGroups, groupState,
  bulkChange, reorder, notifyChange,
} from "./groups_core.js";

let cssInjected = false;
function ensureCSS() {
  if (cssInjected) return;
  cssInjected = true;
  const link = document.createElement("link");
  link.rel = "stylesheet";
  link.href = new URL("./fast_groups_control.css", import.meta.url).href;
  document.head.appendChild(link);
}

function el(tag, attrs = {}, ...children) {
  const e = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (key === "class") e.className = value;
    else if (key === "text") e.textContent = String(value);
    else if (key === "title") e.title = value;
    else if (key === "type") e.type = value;
    else if (key === "placeholder") e.placeholder = value;
    else if (key === "value") e.value = value;
    else if (key === "checked") e.checked = Boolean(value);
    else if (key === "disabled") e.disabled = Boolean(value);
    else if (key === "draggable") e.draggable = Boolean(value);
    else e.setAttribute(key, String(value));
  }
  for (const child of children) {
    if (child != null) e.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return e;
}

function btn(text, callback, title = "", cls = "") {
  const b = el("button", { class: `fgc-btn ${cls}`, type: "button", text, title: title || text });
  b.addEventListener("click", callback);
  return b;
}

function field(label, control) {
  return el("label", { class: "fgc-field" }, el("span", { text: label }), control);
}

function boolControl(label, value, onChange) {
  const input = el("input", { type: "checkbox", checked: value });
  input.addEventListener("change", () => onChange(input.checked));
  return el("label", { class: "fgc-bool" }, input, el("span", { text: label }));
}

function notice(message, container) {
  const note = el("div", { class: "fgc-toast", text: message });
  container.replaceChildren(note);
}

function focusGroup(item, app, feedback) {
  const canvas = app?.canvas;
  if (!canvas || !item.group) return;
  if (canvas.graph !== item.graph) {
    notice("This group is inside another graph. Open that subgraph to navigate to it.", feedback);
    return;
  }
  try {
    canvas.centerOnNode(item.group);
    const zoom = canvas.ds?.scale || 1;
    const size = item.group.size || item.group._size || [300, 200];
    const w = canvas.canvas?.width || 1000;
    const h = canvas.canvas?.height || 700;
    canvas.setZoom?.(Math.min(zoom, w / Math.max(150, size[0]) * .75, h / Math.max(150, size[1]) * .75), [w / 2, h / 2]);
    canvas.setDirty?.(true, true);
  } catch (err) {
    console.warn("[Fast Groups Control] Navigation error", err);
    notice("Couldn't navigate to this group in the current canvas.", feedback);
  }
}

/** Open the only modal for a given controller node. No global settings are changed. */
export function openGroupManager(node, app) {
  ensureCSS();
  document.querySelector(".fgc-backdrop")?.remove();
  const cfg = settings(node);
  let search = "";
  let draggedKey = null;
  const overlay = el("div", { class: "fgc-backdrop", role: "presentation" });
  const dialog = el("section", { class: "fgc-dialog", role: "dialog", "aria-modal": "true", "aria-label": "Fast Groups Control Manager" });
  const close = () => {
    document.removeEventListener("keydown", keyHandler, true);
    overlay.remove();
    node.graph?.setDirtyCanvas?.(true, true);
  };
  const keyHandler = event => {
    if (event.key === "Escape") { event.stopPropagation(); close(); }
  };
  document.addEventListener("keydown", keyHandler, true);
  overlay.addEventListener("pointerdown", event => { if (event.target === overlay) close(); });

  const heading = el("header", { class: "fgc-header" },
    el("div", {}, el("div", { class: "fgc-eyebrow", text: "FAST GROUPS CONTROL" }),
      el("h2", { text: "Group Manager" }),
      el("div", { class: "fgc-subtitle", text: node.fgcOffMode === 4 ? "Bypasser · instance-specific configuration" : "Muter · instance-specific configuration" })),
    btn("✕", close, "Close manager", "fgc-close"),
  );
  const body = el("div", { class: "fgc-body" });
  const footer = el("footer", { class: "fgc-footer" });
  dialog.append(heading, body, footer);
  overlay.appendChild(dialog);
  document.body.appendChild(overlay);

  function update() {
    notifyChange(node);
    node.fgcRefresh?.();
  }

  function render() {
    const config = settings(node);
    const items = sortGroups(reconcileGroups(node), config);
    const filtered = items.filter(it => !search ||
      [it.title, it.record.alias, it.graphPath].some(s => String(s || "").toLowerCase().includes(search.toLowerCase())));
    const previousScroll = body.querySelector(".fgc-list")?.scrollTop || 0;
    body.replaceChildren();
    const toolbar = el("div", { class: "fgc-toolbar" });
    const searchField = el("input", { type: "search", class: "fgc-input fgc-search", placeholder: "Search groups by name...", value: search, "aria-label": "Search groups" });
    searchField.addEventListener("input", () => {
      search = searchField.value;
      // Only replace the list; preserve focus and cursor in search.
      drawList();
    });
    const badge = el("span", { class: "fgc-count", text: `${items.length} groups · ${items.filter(it => it.record.visible && passesFilters(it, config)).length} shown` });
    toolbar.append(searchField, badge);
    body.appendChild(toolbar);

    const advanced = el("details", { class: "fgc-advanced" });
    advanced.open = render.openAdvanced ?? false;
    advanced.addEventListener("toggle", () => { render.openAdvanced = advanced.open; });
    advanced.appendChild(el("summary", { text: "Panel options & filters" }));
    const advGrid = el("div", { class: "fgc-options" });
    const sort = el("select", { class: "fgc-input", "aria-label": "Sort order" });
    for (const [value, label] of [["position", "Canvas position"], ["alphanumeric", "Alphanumeric"], ["manual", "Manual"], ["custom", "Custom prefix order"]]) {
      const opt = el("option", { value, text: label }); opt.selected = config.sort === value;
      sort.appendChild(opt);
    }
    sort.addEventListener("change", () => { config.sort = sort.value; update(); render(); });
    advGrid.appendChild(field("Order", sort));
    const custom = el("input", { class: "fgc-input", value: config.customAlphabet, placeholder: "e.g. sam,model,output" });
    custom.addEventListener("change", () => { config.customAlphabet = custom.value; update(); render(); });
    advGrid.appendChild(field("Custom prefixes", custom));
    const titleMatch = el("input", { class: "fgc-input", value: config.matchTitle, placeholder: "Name or /regex/i" });
    titleMatch.addEventListener("change", () => { config.matchTitle = titleMatch.value; update(); render(); });
    advGrid.appendChild(field("Only show titles matching", titleMatch));
    const colorMatch = el("input", { class: "fgc-input", value: config.matchColors, placeholder: "e.g. #3b4c65,red" });
    colorMatch.addEventListener("change", () => { config.matchColors = colorMatch.value; update(); render(); });
    advGrid.appendChild(field("Only show colors (comma-separated)", colorMatch));
    advGrid.appendChild(boolControl("Navigation arrows", config.showNav, v => { config.showNav = v; update(); }));
    advGrid.appendChild(boolControl("Include nested subgraphs", config.showAllGraphs, v => { config.showAllGraphs = v; update(); render(); }));
    advGrid.appendChild(boolControl("Compact rows", config.compact, v => { config.compact = v; update(); }));
    advanced.appendChild(advGrid);
    body.appendChild(advanced);

    const actions = el("div", { class: "fgc-actions" },
      btn("Enable all", () => { const result = bulkChange(node, "enable", reconcileGroups(node)); update(); notice(`${result.groups} groups · ${result.nodes} nodes updated${result.conflicts ? ` · ${result.conflicts} overlapping requests resolved (enable wins)` : ""}`, feedback); }, "Enable visible, unlocked and matching groups"),
      btn(node.fgcOffMode === 4 ? "Bypass all" : "Mute all", () => { const result = bulkChange(node, "disable", reconcileGroups(node)); update(); notice(`${result.groups} groups · ${result.nodes} nodes updated${result.conflicts ? ` · ${result.conflicts} overlapping requests resolved (enable wins)` : ""}`, feedback); }, "Disable visible, unlocked and matching groups"),
      btn("Invert", () => { const result = bulkChange(node, "invert", reconcileGroups(node)); update(); notice(`${result.groups} groups · ${result.nodes} nodes updated${result.conflicts ? ` · ${result.conflicts} overlapping requests resolved (enable wins)` : ""}`, feedback); }, "Invert visible, unlocked and matching groups"),
      btn("Show all", () => { for (const it of reconcileGroups(node)) it.record.visible = true; config.matchTitle = ""; config.matchColors = ""; update(); render(); }, "Make all groups visible and clear filters"),
    );
    body.appendChild(actions);
    const feedback = el("div", { class: "fgc-feedback", "aria-live": "polite" });
    body.appendChild(feedback);
    const columnHeader = el("div", { class: "fgc-column-header" },
      el("span", { text: "GROUP / CUSTOM LABEL" }),
      el("span", { text: "SHOW" }), el("span", { text: "PIN" }), el("span", { text: "LOCK" }),
      el("span", { text: "ORDER" }),
    );
    body.appendChild(columnHeader);
    const list = el("div", { class: "fgc-list", role: "list" });
    body.appendChild(list);

    function drawList() {
      const latestCfg = settings(node);
      const sorted = sortGroups(reconcileGroups(node), latestCfg);
      const visibleRows = sorted.filter(it => !search ||
        [it.title, it.record.alias, it.graphPath].some(s => String(s || "").toLowerCase().includes(search.toLowerCase())));
      const listScroll = list.scrollTop;
      list.replaceChildren();
      if (!visibleRows.length) list.appendChild(el("div", { class: "fgc-empty", text: "No groups found. Try a different search or add a group to the canvas." }));
      for (const it of visibleRows) {
        const record = it.record;
        const state = groupState(it, node.fgcOffMode);
        const matched = passesFilters(it, latestCfg);
        const row = el("div", { class: `fgc-group-row${record.visible ? "" : " fgc-row-hidden"}`, role: "listitem", draggable: true });
        row.dataset.key = record.key;
        row.addEventListener("dragstart", e => {
          draggedKey = record.key; e.dataTransfer.effectAllowed = "move";
          e.dataTransfer.setData("text/plain", record.key);
        });
        row.addEventListener("dragover", e => { e.preventDefault(); row.classList.add("fgc-dragover"); });
        row.addEventListener("dragleave", () => row.classList.remove("fgc-dragover"));
        row.addEventListener("drop", e => {
          e.preventDefault(); row.classList.remove("fgc-dragover");
          if (draggedKey) { reorder(node, draggedKey, record.key); update(); drawList(); }
          draggedKey = null;
        });
        row.addEventListener("dragend", () => { draggedKey = null; row.classList.remove("fgc-dragover"); });
        const name = el("div", { class: "fgc-group-name" });
        const labelLine = el("div", { class: "fgc-label-line" });
        const dot = el("span", { class: `fgc-state-dot fgc-${state.state}`, title: `${state.active} active / ${state.disabled} disabled / ${state.total} nodes` });
        const nameText = el("span", { class: "fgc-real-name", text: it.title, title: it.title });
        labelLine.append(dot, nameText);
        if (it.graphPath !== "root") labelLine.appendChild(el("span", { class: "fgc-tag", text: "Subgraph" }));
        if (!matched) labelLine.appendChild(el("span", { class: "fgc-tag", text: "Filtered" }));
        const alias = el("input", { class: "fgc-input fgc-alias", placeholder: "Optional display label", value: record.alias, "aria-label": `Custom label for ${it.title}` });
        alias.draggable = false;
        alias.addEventListener("dragstart", e => e.stopPropagation());
        alias.addEventListener("input", () => { record.alias = alias.value; update(); });
        name.append(labelLine, alias);
        const vis = el("input", { type: "checkbox", checked: record.visible, "aria-label": `Show ${it.title}` });
        vis.addEventListener("change", () => { record.visible = vis.checked; update(); drawList(); });
        const pin = btn(record.pinned ? "◆" : "◇", () => { record.pinned = !record.pinned; update(); drawList(); }, `Pin ${it.title} to top`, `fgc-icon-btn${record.pinned ? " fgc-selected" : ""}`);
        const lock = btn(record.locked ? "🔒" : "🔓", () => { record.locked = !record.locked; update(); drawList(); }, `Lock ${it.title} against panel mode changes`, `fgc-icon-btn${record.locked ? " fgc-selected" : ""}`);
        const order = el("div", { class: "fgc-order" });
        const sortedKeys = sorted.map(x => x.record.key);
        const idx = sortedKeys.indexOf(record.key);
        const up = btn("↑", () => { if (idx > 0) { reorder(node, record.key, sortedKeys[idx - 1]); update(); drawList(); } }, "Move up", "fgc-icon-btn");
        const down = btn("↓", () => { if (idx < sortedKeys.length - 1) { reorder(node, record.key, sortedKeys[idx + 1]); update(); drawList(); } }, "Move down", "fgc-icon-btn");
        up.disabled = idx <= 0; down.disabled = idx >= sortedKeys.length - 1;
        order.append(up, down);
        row.append(name, el("label", { class: "fgc-checkbox-cell" }, vis), pin, lock, order);
        list.appendChild(row);
      }
      list.scrollTop = listScroll;
      const count = body.querySelector(".fgc-count");
      if (count) count.textContent = `${sorted.length} groups · ${sorted.filter(it => it.record.visible && passesFilters(it, latestCfg)).length} shown`;
    }
    drawList();
    list.scrollTop = previousScroll;
    footer.replaceChildren(
      el("div", { class: "fgc-footnote", text: "Visibility, labels and ordering affect only this controller. Locked groups also protect overlapping nodes from panel actions; direct canvas edits remain possible." }),
      btn("Reset panel settings", () => {
        if (!window.confirm("Reset this panel's filters, labels, visibility, locks and ordering? Group node modes will NOT change.")) return;
        node.properties.fgc = { ...settings(node), sort: "position", customAlphabet: "", matchTitle: "", matchColors: "", showNav: true, showAllGraphs: true, compact: false, groups: [] };
        update(); render();
      }, "Clear custom panel settings without touching any group states"),
      btn("Done", close, "Close and save with Workflow", "fgc-primary"),
    );
  }
  render();
  requestAnimationFrame(() => dialog.querySelector(".fgc-search")?.focus());
}
