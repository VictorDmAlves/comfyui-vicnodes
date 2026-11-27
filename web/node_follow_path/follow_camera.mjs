import { getConfig, updateNode, resumeGraphTracking, ensureSerialization } from './follow_position.mjs';
import { hideOverlay, updateOverlay } from './follow_overlay.mjs';

let appRef;
let running = false;
let activeGraph = null;
let lastCanvas = null;
let previousSignature = '';
let lastOverlayUpdate = 0;

export function initCamera(app) {
  appRef = app;
  refreshCamera();
}

function visibleGraph(app) {
  return app?.canvas?.graph ?? app?.graph;
}

function activeNodes(graph) {
  return (graph?._nodes ?? []).filter((node) => getConfig(node)?.enabled);
}

function signature(ds, canvas) {
  return `${ds.offset[0]},${ds.offset[1]},${ds.scale},${canvas?.canvas?.clientWidth},${canvas?.canvas?.clientHeight}`;
}

export function refreshCamera() {
  if (!appRef || running) return;
  if (!activeNodes(visibleGraph(appRef)).length) return;
  running = true;
  requestAnimationFrame(tick);
}

function tick(now) {
  if (!appRef) { running = false; return; }
  const canvas = appRef.canvas;
  const graph = visibleGraph(appRef);
  if (!canvas?.ds || !graph) {
    // No graph is visible. Never move nodes owned by an inactive Workflow.
    activeGraph = null;
    lastCanvas = null;
    running = false;
    hideOverlay();
    return;
  }

  if (activeGraph !== graph || lastCanvas !== canvas) {
    // Per-Workflow graphs retain their nodes when tabs are hidden. Do NOT
    // restore their positions to origin. Resume from the visible last position
    // and reanchor against the now-active camera to avoid jumps on zoom/pan.
    activeGraph = graph;
    lastCanvas = canvas;
    previousSignature = '';
    resumeGraphTracking(graph, canvas.ds, canvas);
  }

  const nodes = activeNodes(graph);
  if (!nodes.length) {
    hideOverlay();
    running = false;
    previousSignature = '';
    return;
  }

  const nextSignature = signature(canvas.ds, canvas);
  const cameraChanged = nextSignature !== previousSignature;
  previousSignature = nextSignature;
  let moved = false;
  for (const node of nodes) {
    ensureSerialization(node);
    moved = updateNode(node, canvas.ds, canvas, now) || moved;
  }
  if (moved) canvas.setDirty?.(true, true);
  // Overlay is lightweight. Refresh at most ~30Hz if nothing else changed.
  if (cameraChanged || moved || now - lastOverlayUpdate > 35) {
    updateOverlay(canvas, nodes);
    lastOverlayUpdate = now;
  }
  requestAnimationFrame(tick);
}

export function onWorkflowChanged() {
  // The inactive tab owns its graph; moving it here would lose the user's
  // last node position. The next animation frame resumes the active tab.
  hideOverlay();
  refreshCamera();
}
