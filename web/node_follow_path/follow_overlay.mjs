import {
  displayEndForAxis, distancesFromDisplayPoint, graphToScreen, screenToGraph,
} from './follow_engine.mjs';
import { getConfig, patchConfig } from './follow_position.mjs';

let host;
let svg;
let dragState = null;

const SVG_NS = 'http://www.w3.org/2000/svg';

function create(tag, attrs = {}) {
  const element = document.createElementNS(SVG_NS, tag);
  for (const [key, value] of Object.entries(attrs)) element.setAttribute(key, String(value));
  return element;
}

function createOverlay() {
  if (host) return;
  host = document.createElement('div');
  host.className = 'vfp-path-overlay';
  svg = create('svg', { xmlns: SVG_NS });
  svg.classList.add('vfp-path-svg');
  host.append(svg);
  document.body.append(host);
}

function stopDrag() {
  if (!dragState) return;
  dragState.node.graph?.change?.(); // One graph change after an edit, not every pointer frame.
  dragState.node.setDirtyCanvas?.(true, true);
  window.removeEventListener('pointermove', onDragMove);
  window.removeEventListener('pointerup', stopDrag);
  window.removeEventListener('pointercancel', stopDrag);
  dragState = null;
}

function onDragMove(event) {
  if (!dragState?.canvas?.canvas || !dragState.canvas.ds) return;
  if (event.pointerId !== dragState.pointerId) return;
  const rect = dragState.canvas.canvas.getBoundingClientRect();
  const point = screenToGraph(
    [event.clientX - rect.left, event.clientY - rect.top],
    dragState.canvas.ds,
  );
  if (!point) return;
  if (dragState.axis === 'origin') {
    // The origin is both the path corner and the node's saved position.
    // Moving it reanchors the follow camera at the new point.
    patchConfig(dragState.node, { origin: point }, {
      restoreToOrigin: true, resetStateAfter: true,
    });
  } else {
    const cfg = getConfig(dragState.node);
    if (!cfg) return;
    const edit = distancesFromDisplayPoint(cfg, dragState.node, point, dragState.axis);
    // Keep the current screen anchor. Changing an endpoint should not reanchor
    // or pull the moving node back to the origin.
    patchConfig(dragState.node, edit, {
      restoreToOrigin: false, resetStateAfter: false,
    });
  }
  event.preventDefault();
  event.stopPropagation();
}

function startDrag(event, node, canvas, axis) {
  if (dragState) stopDrag();
  event.preventDefault();
  event.stopPropagation();
  dragState = { node, canvas, axis, pointerId: event.pointerId };
  window.addEventListener('pointermove', onDragMove, { passive: false });
  window.addEventListener('pointerup', stopDrag);
  window.addEventListener('pointercancel', stopDrag);
}

function addHandle(center, node, canvas, axis) {
  const isOrigin = axis === 'origin';
  const color = isOrigin ? '#49cfb0' : axis === 'vertical' ? '#e0b86e' : '#f0a85f';
  const group = create('g', {
    class: `vfp-path-handle ${isOrigin ? 'vfp-origin-handle' : 'vfp-end-handle'}`,
    'data-vfp-axis': axis,
    transform: `translate(${center[0]} ${center[1]})`,
  });
  group.style.cursor = isOrigin ? 'move' : axis === 'horizontal' ? 'ew-resize' : 'ns-resize';
  const halo = create('circle', {
    cx: 0, cy: 0, r: 14, class: 'vfp-handle-halo',
  });
  const core = create('circle', {
    cx: 0, cy: 0, r: 6,
    class: 'vfp-handle-core', fill: color,
    stroke: '#16232b', 'stroke-width': 2,
  });
  const title = create('title');
  title.textContent = isOrigin
    ? 'Drag to move the start of the path (and the node origin)'
    : `Drag to resize ${axis === 'horizontal' ? 'X' : 'Y'} path`;
  group.append(halo, core, title);
  group.addEventListener('pointerdown', (event) => startDrag(event, node, canvas, axis));
  group.addEventListener('mousedown', (event) => { event.preventDefault(); event.stopPropagation(); });
  group.addEventListener('click', (event) => { event.preventDefault(); event.stopPropagation(); });
  svg.append(group);
}

export function hideOverlay() {
  if (host) host.style.display = 'none';
  if (dragState) stopDrag();
}

export function updateOverlay(canvas, nodes) {
  const active = nodes.filter((node) => {
    const cfg = getConfig(node);
    return cfg?.enabled && cfg.showPath;
  });
  if (!active.length || !canvas?.canvas || !canvas.ds) {
    hideOverlay();
    return;
  }
  createOverlay();
  const rect = canvas.canvas.getBoundingClientRect();
  if (!rect.width || !rect.height) { hideOverlay(); return; }
  host.style.display = 'block';
  host.style.left = `${rect.left}px`;
  host.style.top = `${rect.top}px`;
  host.style.width = `${rect.width}px`;
  host.style.height = `${rect.height}px`;
  svg.setAttribute('viewBox', `0 0 ${rect.width} ${rect.height}`);
  svg.replaceChildren();

  for (const node of active) {
    const cfg = getConfig(node);
    const start = graphToScreen(cfg.origin, canvas.ds);
    if (!start) continue;
    const axes = cfg.mode === 'both' ? ['horizontal', 'vertical'] : [cfg.mode];
    const endpoints = [];
    for (const axis of axes) {
      const endWorld = displayEndForAxis(cfg, node, axis);
      const end = graphToScreen(endWorld, canvas.ds);
      if (!end) continue;
      svg.append(create('line', {
        x1: start[0], y1: start[1], x2: end[0], y2: end[1],
        class: `vfp-path-line vfp-path-line-${axis}`,
      }));
      endpoints.push([axis, end]);
    }
    // Draw handles above lines; a green origin and amber endpoints.
    addHandle(start, node, canvas, 'origin');
    for (const [axis, end] of endpoints) addHandle(end, node, canvas, axis);
  }
}
