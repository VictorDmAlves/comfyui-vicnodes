/**
 * Fast Groups Control - group discovery, reconciliation and mode changes.
 * Original implementation; no imports from rgthree.
 *
 * All configuration is serialized in the controller node's properties.fgc.
 * Group membership is computed from LiteGraph's public recomputeInsideNodes when
 * available. Neither group state nor any model node is changed on Workflow load.
 */

export const CONTROL_TYPES = new Set([
  "Fast Groups Control - Bypasser",
  "Fast Groups Control - Muter",
  // v0.9 preview panels may still exist in unsaved Workflows.
  "Vic Fast Groups Bypasser",
  "Vic Fast Groups Muter",
]);


/**
 * Migrate only v0.9 controller types and their default titles in serialized
 * Workflows. Group states and all properties.fgc settings remain untouched.
 * This runs before LiteGraph creates the nodes on a Workflow load.
 */
export function migrateLegacyWorkflowNodes(graphData) {
  const rename = {
    "Vic Fast Groups Bypasser": "Fast Groups Control - Bypasser",
    "Vic Fast Groups Muter": "Fast Groups Control - Muter",
  };
  let migrated = 0;
  const seen = new Set();
  const scan = (graph) => {
    if (!graph || typeof graph !== "object" || seen.has(graph)) return;
    seen.add(graph);
    if (Array.isArray(graph.nodes)) {
      for (const node of graph.nodes) {
        if (!node || typeof node !== "object") continue;
        const oldType = node.type;
        const newType = Object.prototype.hasOwnProperty.call(rename, oldType) ? rename[oldType] : null;
        if (newType) {
          node.type = newType;
          if (node.title === oldType) node.title = newType;
          migrated++;
        }
        scan(node.subgraph);
        scan(node.graph);
      }
    }
    if (Array.isArray(graph?.definitions?.subgraphs)) {
      for (const subgraph of graph.definitions.subgraphs) scan(subgraph);
    }
  };
  scan(graphData);
  if (migrated) console.info(`[Fast Groups Control] Migrated ${migrated} preview panel(s) to 1.0`);
  return migrated;
}

export const MODE_ON = 0;
export const MODE_MUTE = 2;
export const MODE_BYPASS = 4;

export const DEFAULTS = Object.freeze({
  version: 1,
  sort: "position",
  customAlphabet: "",
  matchTitle: "",
  matchColors: "",
  showNav: true,
  showAllGraphs: true,
  compact: false,
  userSized: false,
  groups: [],
});

const own = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);
const number = (x, fallback = 0) => Number.isFinite(Number(x)) ? Number(x) : fallback;

export function settings(node) {
  if (!node.properties || typeof node.properties !== "object") node.properties = {};
  const current = node.properties.fgc;
  if (!current || typeof current !== "object" || Array.isArray(current)) {
    node.properties.fgc = structuredSettings();
  } else {
    for (const [key, value] of Object.entries(DEFAULTS)) {
      if (!own(current, key)) current[key] = Array.isArray(value) ? [] : value;
    }
    if (!Array.isArray(current.groups)) current.groups = [];
  }
  return node.properties.fgc;
}

export function structuredSettings() {
  return { ...DEFAULTS, groups: [] };
}

function stableGraphId(graph, parentPath) {
  return parentPath || "root";
}

/** Read group objects from root graph and optional nested subgraphs. */
export function discoverGroups(node) {
  const baseGraph = node.graph;
  if (!baseGraph) return [];
  const result = [];
  const visited = new Set();
  const showAll = settings(node).showAllGraphs !== false;
  const walk = (graph, graphPath) => {
    if (!graph || visited.has(graph)) return;
    visited.add(graph);
    const groups = Array.isArray(graph._groups) ? graph._groups : [];
    for (const [index, group] of groups.entries()) {
      const pos = group.pos || group._pos || [0, 0];
      const id = group.id ?? group._id ?? null;
      const title = String(group.title ?? "Untitled Group");
      result.push({
        group, graph, graphPath: stableGraphId(graph, graphPath),
        nativeId: id != null && String(id) !== "-1" ? String(id) : null,
        index, title, color: String(group.color || ""),
        x: number(pos[0]), y: number(pos[1]),
      });
    }
    if (!showAll) return;
    for (const child of (graph._nodes || [])) {
      if (child?.subgraph && child.subgraph !== graph) {
        // IDs on subgraph container nodes are persistent Workflow identifiers.
        walk(child.subgraph, `${graphPath}/node:${String(child.id ?? "unknown")}`);
      }
    }
  };
  walk(baseGraph, "root");
  return result;
}

/**
 * Match serialized config to live groups: prefer stable LiteGraph IDs; otherwise
 * match titles and nearby positions, then position (supports renamed groups).
 * Matching never mutates the group or rewrites its own serialized state.
 */
export function reconcileGroups(node) {
  const cfg = settings(node);
  const found = discoverGroups(node);
  const old = cfg.groups.filter(x => x && typeof x === "object");
  const claimed = new Set();
  let changed = old.length !== cfg.groups.length;
  let maxOrder = Math.max(-1, ...old.map(x => number(x.order, -1)));
  const items = found.map(item => {
    const fingerprint = item.nativeId == null ? null : `${item.graphPath}/g:${item.nativeId}`;
    const candidates = old.map((record, i) => ({ record, i })).filter(x => !claimed.has(x.i) &&
      String(x.record.path || "root") === item.graphPath);
    const exact = fingerprint && candidates.find(x => x.record.nativeKey === fingerprint);
    // Keep a generous window for minor group rearrangements.
    const dist = x => Math.hypot(number(x.record.x) - item.x, number(x.record.y) - item.y);
    const matchingTitle = candidates.filter(x => String(x.record.title || "") === item.title)
      .sort((a, b) => dist(a) - dist(b));
    // Rename fallback is spatial, not just the title.
    const nearest = candidates.slice().sort((a, b) => dist(a) - dist(b))[0];
    const chosen = exact || matchingTitle[0] || (nearest && dist(nearest) < 80 ? nearest : null);
    let record;
    if (chosen) {
      claimed.add(chosen.i);
      record = chosen.record;
    } else {
      record = {
        key: `fgc:${node.id ?? "node"}:${Math.random().toString(36).slice(2, 11)}`,
        visible: true, pinned: false, locked: false, alias: "", order: ++maxOrder,
      };
      old.push(record);
      claimed.add(old.length - 1);
      changed = true;
    }
    // Prevent transient changes in position/name from breaking reconciliation.
    if (record.path !== item.graphPath || record.title !== item.title || record.x !== item.x ||
      record.y !== item.y || record.nativeKey !== fingerprint) changed = true;
    record.path = item.graphPath;
    record.title = item.title;
    record.x = item.x;
    record.y = item.y;
    record.nativeKey = fingerprint;
    if (typeof record.visible !== "boolean") record.visible = true;
    if (typeof record.pinned !== "boolean") record.pinned = false;
    if (typeof record.locked !== "boolean") record.locked = false;
    if (typeof record.alias !== "string") record.alias = "";
    if (!Number.isFinite(Number(record.order))) record.order = ++maxOrder;
    return { ...item, record };
  });
  // Keep records of temporarily missing groups, so restoring them keeps settings.
  if (changed) cfg.groups = old;
  return items;
}

function matchesTitle(name, query) {
  const q = String(query || "").trim();
  if (!q) return true;
  if (q.startsWith("/") && q.lastIndexOf("/") > 0) {
    try {
      const end = q.lastIndexOf("/");
      return new RegExp(q.slice(1, end), q.slice(end + 1) || "i").test(name);
    } catch { /* Fall back to literal. */ }
  }
  return name.toLocaleLowerCase().includes(q.toLocaleLowerCase());
}

export function passesFilters(item, cfg) {
  if (!matchesTitle(item.title, cfg.matchTitle)) return false;
  const colors = String(cfg.matchColors || "").split(",").map(x => x.trim().toLowerCase()).filter(Boolean);
  if (colors.length && !colors.includes(String(item.color || "").toLowerCase())) return false;
  return true;
}

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

function alphaPriority(title, alphabet) {
  const tokens = String(alphabet || "").includes(",")
    ? alphabet.split(",").map(x => x.trim().toLowerCase()).filter(Boolean)
    : alphabet.toLowerCase().split("").filter(Boolean);
  const t = title.toLowerCase();
  const index = tokens.findIndex(p => t.startsWith(p));
  return index === -1 ? 99999 : index;
}

export function sortGroups(items, cfg) {
  const result = [...items];
  const sort = cfg.sort;
  result.sort((a, b) => {
    if (a.record.pinned !== b.record.pinned) return a.record.pinned ? -1 : 1;
    if (sort === "manual") return number(a.record.order) - number(b.record.order);
    if (sort === "alphanumeric") return collator.compare(a.title, b.title);
    if (sort === "custom") {
      const aa = alphaPriority(a.title, cfg.customAlphabet);
      const bb = alphaPriority(b.title, cfg.customAlphabet);
      if (aa !== bb) return aa - bb;
      return collator.compare(a.title, b.title);
    }
    return (a.y - b.y) || (a.x - b.x) || collator.compare(a.title, b.title);
  });
  return result;
}

/** Group nodes rely on LiteGraph's own group-membership computation. */
export function members(item) {
  const group = item.group;
  try { group.recomputeInsideNodes?.(); } catch (err) {
    console.warn("[Fast Groups Control] Could not recompute group nodes", err);
  }
  const groupNodes = Array.isArray(group._nodes) ? group._nodes : [];
  return [...new Set(groupNodes)].filter(n =>
    n && typeof n.mode === "number" && !CONTROL_TYPES.has(n.type) &&
    n !== group && n.graph === item.graph
  );
}

export function groupState(item, offMode) {
  const nodes = members(item);
  if (!nodes.length) return { state: "empty", total: 0, active: 0, disabled: 0 };
  const active = nodes.filter(n => n.mode === MODE_ON).length;
  const disabled = nodes.filter(n => n.mode === offMode).length;
  const state = active === nodes.length ? "on" : disabled === nodes.length ? "off" : "mixed";
  return { state, total: nodes.length, active, disabled };
}

/** Apply mode with an explicit pointer to the changed graph, without resetting prompt widgets. */
export function lockedMembers(node) {
  const protectedNodes = new Set();
  for (const it of reconcileGroups(node)) {
    if (it.record.locked) for (const n of members(it)) protectedNodes.add(n);
  }
  return protectedNodes;
}

export function changeGroup(item, offMode, enable, changedNodes = new Set(), protectedNodes = new Set()) {
  const nextMode = enable ? MODE_ON : offMode;
  for (const n of members(item)) {
    if (protectedNodes.has(n) || n.mode === nextMode) continue;
    if (typeof n.changeMode === "function") n.changeMode(nextMode);
    else n.mode = nextMode;
    changedNodes.add(n);
  }
  item.graph?.setDirtyCanvas?.(true, true);
  return changedNodes;
}

export function bulkChange(node, action, items) {
  const cfg = settings(node);
  const changedNodes = new Set();
  // Resolve each group first, so inversions don't depend on group traversal
  // order. A locked group protects its member nodes even when groups overlap.
  const protectedNodes = lockedMembers(node);
  const ops = items.filter(it => it.record.visible && !it.record.locked && passesFilters(it, cfg))
    .map(it => ({ it, enable: action === "enable" ? true : action === "disable" ? false : groupState(it, node.fgcOffMode).state !== "on" }));
  const plan = new Map();
  let conflicts = 0;
  for (const op of ops) {
    for (const n of members(op.it)) {
      if (protectedNodes.has(n)) continue;
      const prev = plan.get(n);
      if (prev != null && prev !== op.enable) conflicts++;
      // If overlapping groups disagree during Invert, enabling wins: don't
      // silently disable a node requested active by another group.
      plan.set(n, prev === true || op.enable === true);
    }
  }
  for (const [n, enable] of plan) {
    const nextMode = enable ? MODE_ON : node.fgcOffMode;
    if (n.mode === nextMode) continue;
    if (typeof n.changeMode === "function") n.changeMode(nextMode);
    else n.mode = nextMode;
    changedNodes.add(n);
  }
  node.graph?.setDirtyCanvas?.(true, true);
  return { groups: ops.length, nodes: changedNodes.size, conflicts };
}

export function reorder(node, sourceKey, targetKey) {
  const cfg = settings(node);
  const items = sortGroups(reconcileGroups(node), cfg);
  const from = items.findIndex(it => it.record.key === sourceKey);
  const to = items.findIndex(it => it.record.key === targetKey);
  if (from < 0 || to < 0 || from === to) return;
  const [it] = items.splice(from, 1);
  items.splice(to, 0, it);
  items.forEach((x, index) => { x.record.order = index; });
  cfg.sort = "manual";
}

export function notifyChange(node) {
  node.graph?.setDirtyCanvas?.(true, true);
  // Graph UI mutates live objects and those changes are stored by Workflow serialization.
  // change() marks the graph as modified for undo/state tracking when available.
  node.graph?.change?.();
}
