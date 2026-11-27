import {
  PROPERTY_KEY, makeConfig, normalizeConfig, readPosition, graphToScreen,
  targetOnPathForAnchor, stepAlongPath,
} from './follow_engine.mjs';

// No patches to LiteGraph prototypes, other extensions or other VicNodes modules.
// A per-node onSerialize wrapper ensures that transient positions do not leak into saved Workflows.
const wrappedNodes = new WeakMap();
const states = new WeakMap();
// Runtime-only snapshots belong to a graph, never to the persisted Workflow.
// They allow a remounted node in the same graph to resume its last visible
// position without changing node.properties or the serialized node.pos.
const snapshotsByGraph = new WeakMap();

function graphSnapshots(graph) {
  if (!graph) return null;
  let snapshots = snapshotsByGraph.get(graph);
  if (!snapshots) {
    snapshots = new Map();
    snapshotsByGraph.set(graph, snapshots);
  }
  return snapshots;
}

function nodeKey(node) {
  return node?.id == null ? null : String(node.id);
}

function matchingSnapshot(node, cfg) {
  const key = nodeKey(node);
  if (key === null) return null;
  const snapshot = graphSnapshots(node?.graph)?.get(key);
  if (!snapshot) return null;
  // Do not restore a deleted node's snapshot onto another node which happens
  // to reuse the same LiteGraph id with a different path configuration.
  if (snapshot.type !== node.type || snapshot.config !== JSON.stringify(cfg)) return null;
  return snapshot;
}

function recordSnapshot(node, cfg, state) {
  const key = nodeKey(node);
  if (key === null || !node?.graph) return;
  const pos = readPosition(node);
  if (!pos) return;
  graphSnapshots(node.graph).set(key, {
    type: node.type,
    config: JSON.stringify(cfg),
    position: pos,
    anchor: [...state.anchor],
    branch: state.branch,
  });
}

export function getConfig(node) {
  const raw = node?.properties?.[PROPERTY_KEY];
  if (!raw || typeof raw !== 'object') return null;
  const pos = readPosition(node);
  if (!pos) return null;
  return normalizeConfig(raw, pos);
}

export function setConfig(node, config) {
  const pos = readPosition(node);
  if (!pos) return false;
  const next = patchConfig(node, config, { restoreToOrigin: true, resetStateAfter: true });
  return !!next;
}

export function patchConfig(node, configOrPatch, options = {}) {
  const pos = readPosition(node);
  if (!pos) return null;
  const current = getConfig(node) ?? makeConfig(pos);
  const next = normalizeConfig({ ...current, ...configOrPatch }, current.origin);
  node.properties ||= {};
  node.properties[PROPERTY_KEY] = next;
  ensureSerialization(node);
  if (options.restoreToOrigin) {
    if (typeof node.setPos === 'function') node.setPos(...next.origin);
    else node.pos = [...next.origin];
  }
  if (options.resetStateAfter !== false) resetState(node);
  node.setDirtyCanvas?.(true, true);
  return next;
}
export function ensureSerialization(node) {
  if (!node || wrappedNodes.get(node) === node.onSerialize) return;
  const prior = node.onSerialize;
  const wrapped = function (...args) {
    const ret = typeof prior === 'function' ? prior.apply(this, args) : undefined;
    const data = args[0];
    const cfg = getConfig(this);
    if (cfg?.enabled && data && typeof data === 'object') {
      // Do not mutate the node, only the outgoing serialized record.
      data.pos = [...cfg.origin];
    }
    return ret;
  };
  wrappedNodes.set(node, wrapped);
  node.onSerialize = wrapped;
}

export function resetState(node) {
  states.delete(node);
  const key = nodeKey(node);
  if (key !== null) snapshotsByGraph.get(node?.graph)?.delete(key);
}

export function ensureState(node, ds, canvas) {
  const cfg = getConfig(node);
  const pos = readPosition(node);
  if (!cfg?.enabled || !pos) return null;
  ensureSerialization(node);
  let state = states.get(node);
  // A tab may reuse the same node with a different canvas instance.
  // Its reference point must survive: it is NOT a new Follow Path session.
  if (state) {
    state.canvas = canvas;
    return state;
  }

  // The saved origin is authoritative. Restore only a runtime position from
  // this SAME graph (if the node was recreated during tab switching/Undo).
  // Otherwise start with the existing node.position.
  const snapshot = matchingSnapshot(node, cfg);
  if (snapshot && Math.hypot(pos[0] - cfg.origin[0], pos[1] - cfg.origin[1]) < 2) {
    if (typeof node.setPos === 'function') node.setPos(...snapshot.position);
    else node.pos = [...snapshot.position];
  }
  const current = readPosition(node);
  const anchor = snapshot?.anchor ?? graphToScreen(current, ds);
  if (!anchor) return null;
  state = {
    canvas, anchor: [...anchor], lastWritten: [...current],
    lastTime: null, paused: false, branch: snapshot?.branch ?? null,
  };
  states.set(node, state);
  recordSnapshot(node, cfg, state);
  return state;
}

// Called only when a Workflow tab becomes visible. Neither node.pos nor the
// path's saved origin is reset. Start following the camera FROM the node's last
// position on the path, so switching tabs at high zoom never teleports it.
export function resumeGraphTracking(graph, ds, canvas) {
  for (const node of graph?._nodes ?? []) {
    if (!getConfig(node)?.enabled) continue;
    const state = ensureState(node, ds, canvas);
    const pos = readPosition(node);
    if (!state || !pos) continue;
    const anchor = graphToScreen(pos, ds);
    if (!anchor) continue;
    state.anchor = anchor;
    state.lastWritten = [...pos];
    state.lastTime = null;
    state.paused = false;
    recordSnapshot(node, getConfig(node), state);
  }
}

export function updateNode(node, ds, canvas, now) {
  const cfg = getConfig(node);
  if (!cfg?.enabled) { states.delete(node); return false; }
  const state = ensureState(node, ds, canvas);
  if (!state) return false;
  const pos = readPosition(node);
  if (!pos) return false;

  // Do not fight a manual node drag. The user's final drop becomes the new origin.
  if (node.selected && canvas?.pointer?.isDown) {
    state.paused = true;
    return false;
  }
  if (state.paused) {
    state.paused = false;
    const manuallyMoved = Math.hypot(pos[0] - state.lastWritten[0], pos[1] - state.lastWritten[1]) > 2;
    if (manuallyMoved) {
      const next = { ...cfg, origin: [...pos] };
      node.properties[PROPERTY_KEY] = next;
      state.anchor = graphToScreen(pos, ds);
      state.lastWritten = [...pos];
      state.branch = null;
      state.lastTime = now;
      recordSnapshot(node, next, state);
      return true;
    }
  }

  const currentCfg = getConfig(node);
  const preferredAxis = state.branch;
  const requested = targetOnPathForAnchor(currentCfg, state.anchor, ds, preferredAxis);
  // Only change branches through the shared origin, never by cutting diagonally.
  let activeAxis = state.branch ?? requested.axis;
  const dt = state.lastTime == null ? 16 : now - state.lastTime;
  const step = stepAlongPath(pos, currentCfg, requested, activeAxis, dt);
  state.branch = step.axis;
  state.lastTime = now;
  const next = step.position;
  if (Math.hypot(next[0] - pos[0], next[1] - pos[1]) < 0.15) {
    recordSnapshot(node, currentCfg, state);
    return false;
  }
  if (typeof node.setPos === 'function') node.setPos(next[0], next[1]);
  else node.pos = next;
  state.lastWritten = [...next];
  recordSnapshot(node, currentCfg, state);
  return true;
}

export function restoreOriginal(node, disable = true) {
  const cfg = getConfig(node);
  if (!cfg) return;
  if (disable) {
    node.properties[PROPERTY_KEY] = { ...cfg, enabled: false };
  }
  if (typeof node.setPos === 'function') node.setPos(...cfg.origin);
  else node.pos = [...cfg.origin];
  resetState(node);
  node.setDirtyCanvas?.(true, true);
}
