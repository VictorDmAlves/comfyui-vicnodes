/**
 * Fast Groups Control v1.0.1 (VicNodes module)
 * Two client-only LiteGraph nodes for independent Bypass and Mute control.
 * No rgthree dependency and no Python execution.
 */
import { app } from "../../../scripts/app.js";
import {
  CONTROL_TYPES, MODE_BYPASS, MODE_MUTE, migrateLegacyWorkflowNodes,
  settings, reconcileGroups, sortGroups, passesFilters, groupState,
  changeGroup, notifyChange, bulkChange, lockedMembers,
} from "./groups_core.js";
import { openGroupManager } from "./groups_manager.js";

const EXTENSION_NAME = "FastGroupsControl.Core";
const TITLE_BYPASS = "Fast Groups Control - Bypasser";
const TITLE_MUTE = "Fast Groups Control - Muter";
const liveControllers = new Set();
let pollTimer = null;

function updateAll() {
  if (document.hidden || app?.configuringGraph) return;
  for (const node of [...liveControllers]) {
    try {
      if (node.graph) node.fgcRefresh();
    } catch (err) {
      console.error("[Fast Groups Control] Failed to refresh", err);
    }
  }
}
function addLive(node) {
  liveControllers.add(node);
  if (!pollTimer) pollTimer = setInterval(updateAll, 900);
}
function removeLive(node) {
  liveControllers.delete(node);
  if (!liveControllers.size && pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}
function rr(ctx, x, y, w, h, radius) {
  const r = Math.min(radius, w/2, h/2);
  ctx.beginPath();
  ctx.moveTo(x+r, y);
  ctx.lineTo(x+w-r, y);
  ctx.quadraticCurveTo(x+w, y, x+w, y+r);
  ctx.lineTo(x+w, y+h-r);
  ctx.quadraticCurveTo(x+w, y+h, x+w-r, y+h);
  ctx.lineTo(x+r, y+h);
  ctx.quadraticCurveTo(x, y+h, x, y+h-r);
  ctx.lineTo(x, y+r);
  ctx.quadraticCurveTo(x, y, x+r, y);
  ctx.closePath();
}
function fitText(ctx, value, maxWidth) {
  const s = String(value || "");
  if (ctx.measureText(s).width <= maxWidth) return s;
  let lo = 0, hi = s.length;
  while (lo < hi) {
    const mid = Math.floor((lo + hi + 1) / 2);
    if (ctx.measureText(`${s.slice(0, mid)}…`).width <= maxWidth) lo = mid;
    else hi = mid - 1;
  }
  return `${s.slice(0, lo)}…`;
}

function navigateTo(item) {
  const canvas = app?.canvas;
  if (!canvas || canvas.graph !== item.graph) {
    console.info("[Fast Groups Control] Open the group's subgraph to navigate to it.");
    return;
  }
  try {
    canvas.centerOnNode(item.group);
    const size = item.group.size || item.group._size || [200, 200];
    const cw = canvas.canvas?.width || 1200;
    const ch = canvas.canvas?.height || 700;
    const maxZoom = Math.min(canvas.ds?.scale || 1, (cw * .78) / Math.max(size[0], 100), (ch * .78) / Math.max(size[1], 100));
    canvas.setZoom?.(maxZoom, [cw/2, ch/2]);
    canvas.setDirty?.(true, true);
  } catch (err) { console.warn("[Fast Groups Control] Navigation failed", err); }
}

function buildControllerClass(OffMode, defaultTitle) {
  // ComfyUI exposes LiteGraph's LGraphNode constructor as a global. Prefer the
  // exported constructor when supplied by a frontend version.
  const Base = globalThis.LGraphNode || globalThis.LiteGraph?.LGraphNode;
  if (!Base) throw new Error("LiteGraph.LGraphNode is unavailable in this ComfyUI frontend.");

  class Controller extends Base {
    static title = defaultTitle;
    static type = defaultTitle;
    static category = "VicNodes/Fast Groups Control";
    static collapsable = true;

    constructor(title = defaultTitle) {
      super(title);
      this.title = defaultTitle;
      this.isVirtualNode = true;
      this.serialize_widgets = false;
      this.fgcOffMode = OffMode;
      this.color = "#212830";
      this.bgcolor = "#15191e";
      this.boxcolor = "#778ba0";
      this.size = [324, 115];
      this._fgcItems = [];
      this._fgcSignature = "";
      this._fgcInternalResize = false;
      this._fgcRestore = false;
      this._fgcClickArea = null;
      settings(this);
    }

    onAdded() {
      addLive(this);
      // A fresh node may be added while no groups exist: update on next frame.
      requestAnimationFrame(() => this.fgcRefresh());
    }
    onRemoved() { removeLive(this); }
    onConfigure(config) {
      this._fgcRestore = true;
      settings(this);
      // Layout sizes in saved Workflows take precedence when userSized=true.
      // Do not automatically resize in this configure pass.
      if (config?.properties?.fgc?.userSized) {
        this._fgcManualSize = true;
      }
      requestAnimationFrame(() => {
        this._fgcRestore = false;
        this.fgcRefresh();
      });
    }
    onResize() {
      if (this._fgcInternalResize || this._fgcRestore) return;
      const cfg = settings(this);
      cfg.userSized = true;
      this._fgcManualSize = true;
      this.graph?.setDirtyCanvas?.(true, true);
    }
    computeSize() {
      // Return the actual MINIMUM, not the current size. The canvas resize
      // controller uses this as its lower bound; returning the current size
      // would make it impossible for users to shrink their custom panel.
      return [250, 90];
    }
    fgcRefresh() {
      if (!this.graph) return;
      const cfg = settings(this);
      const items = sortGroups(reconcileGroups(this), cfg)
        .filter(it => it.record.visible && passesFilters(it, cfg));
      // Compute membership/state only during the timed refresh. Canvas drawing
      // must stay cheap even while users drag or zoom a large graph.
      for (const item of items) item.fgcStatus = groupState(item, OffMode);
      this._fgcItems = items;
      const h = cfg.compact ? 19 : 23;
      // New nodes grow with the group list, but will not shrink or override a
      // size the user deliberately set. Saved manual sizes are preserved.
      const preferred = Math.min(600, 37 + items.length * h + 31);
      if (!cfg.userSized && this.size[1] !== preferred) {
        this._fgcInternalResize = true;
        try { this.setSize([this.size[0], preferred]); }
        finally { this._fgcInternalResize = false; }
      }
      const signature = JSON.stringify({
        size: this.size, compact: cfg.compact, nav: cfg.showNav,
        data: items.map(it => [it.record.key, it.record.alias, it.record.locked,
          it.title, it.fgcStatus.state]),
      });
      if (this._fgcSignature !== signature) {
        this._fgcSignature = signature;
        this.graph?.setDirtyCanvas?.(true, true);
      }
    }
    onDrawForeground(ctx) {
      if (this.flags?.collapsed) return;
      const cfg = settings(this);
      const width = this.size[0];
      const height = this.size[1];
      const rowH = cfg.compact ? 19 : 23;
      const firstY = 35;
      const footerH = 24;
      const maxRows = Math.max(0, Math.floor((height - firstY - footerH) / rowH));
      const shown = this._fgcItems.slice(0, maxRows);
      const scale = app?.canvas?.ds?.scale || 1;
      ctx.save();
      ctx.font = "12px Inter, Arial, sans-serif";
      // Small overline and integrated manager button.
      ctx.fillStyle = "#8492a0";
      ctx.textAlign = "left";
      ctx.font = "10px Inter, Arial, sans-serif";
      ctx.fillText("GROUPS", 15, 18);
      ctx.fillStyle = "#728598";
      ctx.fillText(`${this._fgcItems.length} visible`, 60, 18);
      rr(ctx, width - 91, 5, 77, 23, 9);
      ctx.fillStyle = "#28313b";
      ctx.fill();
      ctx.strokeStyle = "#3b4653";
      ctx.stroke();
      ctx.fillStyle = "#cedbe5";
      ctx.font = "11px Inter, Arial, sans-serif";
      ctx.textAlign = "center";
      ctx.fillText("⚙ Manage", width - 52, 20.5);
      ctx.textAlign = "left";
      ctx.font = "12px Inter, Arial, sans-serif";
      this._fgcClickArea = { header: [width - 92, 2, 80, 29], firstY, rowH, footerH, maxRows };

      shown.forEach((item, i) => {
        const y = firstY + i * rowH;
        const boxY = y + (cfg.compact ? 1 : 2);
        const boxH = rowH - (cfg.compact ? 2 : 3);
        const status = item.fgcStatus || { state: "empty" };
        const active = status.state === "on";
        const mixed = status.state === "mixed";
        rr(ctx, 13, boxY, width - 26, boxH, boxH/2);
        ctx.fillStyle = active ? "#252e37" : "#1f252c";
        ctx.fill();
        ctx.strokeStyle = "#394551";
        ctx.lineWidth = .8;
        ctx.stroke();
        const xToggle = width - (cfg.showNav ? 55 : 30);
        if (cfg.showNav) {
          ctx.beginPath();
          ctx.moveTo(width - 40, boxY + 4);
          ctx.lineTo(width - 40, boxY + boxH - 4);
          ctx.strokeStyle = "#38434e";
          ctx.stroke();
          ctx.fillStyle = "#9ab0c2";
          ctx.textAlign = "center";
          ctx.font = "14px Arial, sans-serif";
          ctx.fillText("➜", width - 26, boxY + boxH/2 + 5);
          ctx.textAlign = "left";
        }
        ctx.beginPath();
        ctx.arc(xToggle, boxY + boxH/2, boxH*.33, 0, Math.PI * 2);
        ctx.fillStyle = mixed ? "#d1ac74" : (active ? "#96acbf" : "#47525f");
        ctx.fill();
        if (item.record.locked) {
          const lx = xToggle - 16, ly = boxY + boxH / 2 - 4;
          ctx.strokeStyle = "#aab8c5";
          ctx.lineWidth = 1;
          ctx.beginPath(); ctx.arc(lx + 3, ly + 1, 2.5, Math.PI, 0);
          ctx.stroke();
          ctx.strokeRect(lx, ly + 1, 6, 5);
        }
        ctx.fillStyle = active ? "#c1ccd6" : (mixed ? "#d7b985" : "#7e8b99");
        ctx.textAlign = "right";
        ctx.font = "11px Inter, Arial, sans-serif";
        ctx.fillText(mixed ? "mix" : (active ? "yes" : "no"), xToggle - 18, boxY + boxH/2 + 4);
        const available = xToggle - 18 - 25;
        ctx.textAlign = "left";
        ctx.fillStyle = item.record.locked ? "#97a2ad" : (active ? "#cbd5df" : "#8b97a3");
        ctx.font = "12px Inter, Arial, sans-serif";
        ctx.fillText(fitText(ctx, item.record.alias || item.title, Math.max(24, available)), 23, boxY + boxH/2 + 4);
      });
      ctx.fillStyle = "#788796";
      ctx.font = "10px Inter, Arial, sans-serif";
      ctx.textAlign = "left";
      const count = this._fgcItems.length - shown.length;
      if (count > 0) ctx.fillText(`+${count} more · Resize node or Manage`, 15, height - 9);
      else ctx.fillText(this.fgcOffMode === MODE_BYPASS ? "BYPASS CONTROL" : "MUTE CONTROL", 15, height - 9);
      ctx.textAlign = "right";
      ctx.fillText("FGC 1.0", width - 14, height - 9);
      ctx.restore();
    }
    onMouseDown(event, pos) {
      if (this.flags?.collapsed || !Array.isArray(pos)) return false;
      if (event.button != null && event.button !== 0) return false;
      const x = pos[0], y = pos[1];
      const a = this._fgcClickArea;
      if (!a) return false;
      if (x >= a.header[0] && x <= a.header[0]+a.header[2] && y >= a.header[1] && y <= a.header[1]+a.header[3]) {
        openGroupManager(this, app);
        return true;
      }
      const index = Math.floor((y - a.firstY) / a.rowH);
      if (index < 0 || index >= Math.min(a.maxRows, this._fgcItems.length) || x < 13 || x > this.size[0]-13) return false;
      const item = this._fgcItems[index];
      if (settings(this).showNav && x > this.size[0]-43) {
        navigateTo(item);
      } else if (!item.record.locked) {
        const status = groupState(item, OffMode);
        changeGroup(item, OffMode, status.state !== "on", new Set(), lockedMembers(this));
        notifyChange(this);
        updateAll();
      }
      return true;
    }
    getExtraMenuOptions(canvas, options) {
      const parent = typeof super.getExtraMenuOptions === "function" ? super.getExtraMenuOptions(canvas, options) : undefined;
      options.push(null,
        { content: "⚙ Manage Groups...", callback: () => openGroupManager(this, app) },
        { content: "Enable all visible groups", callback: () => { bulkChange(this, "enable", reconcileGroups(this)); notifyChange(this); updateAll(); } },
        { content: OffMode === MODE_BYPASS ? "Bypass all visible groups" : "Mute all visible groups", callback: () => { bulkChange(this, "disable", reconcileGroups(this)); notifyChange(this); updateAll(); } },
        { content: "Invert visible groups", callback: () => { bulkChange(this, "invert", reconcileGroups(this)); notifyChange(this); updateAll(); } },
      );
      return parent;
    }
  }
  return Controller;
}

app.registerExtension({
  name: EXTENSION_NAME,
  registerCustomNodes() {
    if (!globalThis.LiteGraph) {
      console.error("[Fast Groups Control] LiteGraph not available");
      return;
    }
    for (const [type, mode] of [[TITLE_BYPASS, MODE_BYPASS], [TITLE_MUTE, MODE_MUTE]]) {
      if (LiteGraph.registered_node_types?.[type]) continue;
      const Klass = buildControllerClass(mode, type);
      LiteGraph.registerNodeType(type, Klass);
      // LiteGraph derives (and may overwrite) the category from the registered
      // type string. Our stable Workflow types deliberately have no slash, so
      // assign the category AFTER registration, as ComfyUI does for its own
      // frontend-only utility nodes (e.g. PrimitiveNode).
      Klass.category = "VicNodes/Fast Groups Control";
    }
    console.info("[Fast Groups Control] Independent Bypasser and Muter registered");
  },
  beforeConfigureGraph(graphData) {
    // Upgrade panels saved by the v0.9 preview without changing target node modes.
    migrateLegacyWorkflowNodes(graphData);
  },
  afterConfigureGraph() {
    // Waiting until the Workflow is configured avoids accidentally reverting
    // previously saved bypass/mute modes while the graph is still loading.
    requestAnimationFrame(() => updateAll());
  },
});
