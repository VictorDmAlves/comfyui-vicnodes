/**
 * Node Follow Path v1.0 - pure geometry helpers.
 * All path distances are LiteGraph world units, never screen pixels.
 */
export const PROPERTY_KEY = 'vic_follow_path';
export const VERSION = 1;
export const MODES = Object.freeze(['horizontal', 'vertical', 'both']);
export const MAX_DISTANCE = 100000;

export function finite(value, fallback = 0) {
  const result = Number(value);
  return Number.isFinite(result) ? result : fallback;
}

export function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

export function readPosition(node) {
  const pos = node?.pos;
  if (!pos || pos.length < 2) return null;
  const x = Number(pos[0]);
  const y = Number(pos[1]);
  return Number.isFinite(x) && Number.isFinite(y) ? [x, y] : null;
}

export function makeConfig(origin) {
  return {
    version: VERSION,
    enabled: true,
    mode: 'horizontal',
    origin: [...origin],
    distanceX: 2000,
    distanceY: 1200,
    directionX: 1,
    directionY: 1,
    showPath: false,
  };
}

export function normalizeConfig(raw, fallbackOrigin) {
  const base = makeConfig(fallbackOrigin);
  if (!raw || typeof raw !== 'object') return base;
  const origin = Array.isArray(raw.origin) && raw.origin.length >= 2
    ? [finite(raw.origin[0], base.origin[0]), finite(raw.origin[1], base.origin[1])]
    : base.origin;
  return {
    version: VERSION,
    enabled: raw.enabled !== false,
    mode: MODES.includes(raw.mode) ? raw.mode : base.mode,
    origin,
    distanceX: clamp(Math.abs(finite(raw.distanceX, base.distanceX)), 0, MAX_DISTANCE),
    distanceY: clamp(Math.abs(finite(raw.distanceY, base.distanceY)), 0, MAX_DISTANCE),
    directionX: Number(raw.directionX) === -1 ? -1 : 1,
    directionY: Number(raw.directionY) === -1 ? -1 : 1,
    showPath: raw.showPath === true,
  };
}

export function limits(config) {
  const [x, y] = config.origin;
  const endX = x + config.directionX * config.distanceX;
  const endY = y + config.directionY * config.distanceY;
  return {
    minX: Math.min(x, endX), maxX: Math.max(x, endX),
    minY: Math.min(y, endY), maxY: Math.max(y, endY),
    endX, endY,
  };
}


export function nodeSize(node) {
  const width = finite(node?.size?.[0], 0);
  const height = finite(node?.size?.[1], 0);
  return [Math.max(0, width), Math.max(0, height)];
}

// The visual end handle is placed at the OUTER edge of the node when it
// reaches the end of its travel. The node's top-left corner itself stays
// exactly on the configured X or Y path.
export function displayEndForAxis(config, node, axis) {
  const b = limits(config);
  const [width, height] = nodeSize(node);
  if (axis === 'vertical') {
    return [config.origin[0], b.endY + (config.directionY > 0 ? height : 0)];
  }
  return [b.endX + (config.directionX > 0 ? width : 0), config.origin[1]];
}

// Kept for callers from v0.1.3. For Both Axes each branch has its own
// endpoint: call displayEndForAxis() individually instead.
export function displayEndWorld(config, node) {
  return displayEndForAxis(config, node, config.mode === 'vertical' ? 'vertical' : 'horizontal');
}

// Convert a dragged endpoint handle into the corresponding branch's distance.
// The other branch remains untouched when editing Both Axes.
export function distancesFromDisplayPoint(config, node, graphPoint, axis = null) {
  const [width, height] = nodeSize(node);
  const result = {
    directionX: config.directionX,
    directionY: config.directionY,
    distanceX: config.distanceX,
    distanceY: config.distanceY,
  };
  const editX = axis === 'horizontal' || (axis == null && config.mode !== 'vertical');
  const editY = axis === 'vertical' || (axis == null && config.mode !== 'horizontal');
  if (editX) {
    result.directionX = graphPoint[0] >= config.origin[0] ? 1 : -1;
    const rawX = result.directionX > 0
      ? graphPoint[0] - config.origin[0] - width
      : config.origin[0] - graphPoint[0];
    result.distanceX = clamp(Math.round(rawX), 0, MAX_DISTANCE);
  }
  if (editY) {
    result.directionY = graphPoint[1] >= config.origin[1] ? 1 : -1;
    const rawY = result.directionY > 0
      ? graphPoint[1] - config.origin[1] - height
      : config.origin[1] - graphPoint[1];
    result.distanceY = clamp(Math.round(rawY), 0, MAX_DISTANCE);
  }
  return result;
}

export function graphToScreen(world, ds) {
  const scale = finite(ds?.scale, 1);
  if (scale <= 0) return null;
  const offset = ds?.offset;
  if (!offset) return null;
  return [(world[0] + offset[0]) * scale, (world[1] + offset[1]) * scale];
}

export function screenToGraph(screen, ds) {
  const scale = finite(ds?.scale, 1);
  if (scale <= 0) return null;
  const offset = ds?.offset;
  if (!offset) return null;
  return [screen[0] / scale - offset[0], screen[1] / scale - offset[1]];
}

// Both Axes is a pair of finite perpendicular SEGMENTS meeting at origin,
// never a rectangular roaming area. The camera's desired point is projected
// onto the closest segment. A small hysteresis favors the current branch.
export function targetOnPathForAnchor(config, screenAnchor, ds, preferredAxis = null) {
  const desired = screenToGraph(screenAnchor, ds);
  if (!desired) return { position: [...config.origin], axis: 'horizontal' };
  const b = limits(config);
  const horizontal = [clamp(desired[0], b.minX, b.maxX), config.origin[1]];
  const vertical = [config.origin[0], clamp(desired[1], b.minY, b.maxY)];
  if (config.mode === 'horizontal') return { position: horizontal, axis: 'horizontal' };
  if (config.mode === 'vertical') return { position: vertical, axis: 'vertical' };

  // With a zero-length branch, only the other branch can be selected.
  if (config.distanceX === 0 && config.distanceY > 0) {
    return { position: vertical, axis: 'vertical' };
  }
  if (config.distanceY === 0 && config.distanceX > 0) {
    return { position: horizontal, axis: 'horizontal' };
  }
  const distanceH = Math.hypot(desired[0] - horizontal[0], desired[1] - horizontal[1]);
  const distanceV = Math.hypot(desired[0] - vertical[0], desired[1] - vertical[1]);
  const deadband = 10; // Workflow units; prevents branch chatter near diagonal panning.
  if (preferredAxis === 'horizontal' && distanceH <= distanceV + deadband) {
    return { position: horizontal, axis: 'horizontal' };
  }
  if (preferredAxis === 'vertical' && distanceV <= distanceH + deadband) {
    return { position: vertical, axis: 'vertical' };
  }
  return distanceH <= distanceV
    ? { position: horizontal, axis: 'horizontal' }
    : { position: vertical, axis: 'vertical' };
}

export function targetForAnchor(config, screenAnchor, ds) {
  return targetOnPathForAnchor(config, screenAnchor, ds).position;
}

// Explicitly walk back to the shared corner before entering another branch.
// Each output coordinate is constrained to one segment, including the smooth
// intermediate frames (not just its final target).
export function stepAlongPath(current, config, requested, activeAxis, dtMilliseconds) {
  const origin = config.origin;
  let axis = activeAxis === 'vertical' ? 'vertical' : 'horizontal';
  const needsSwitch = config.mode === 'both' && axis !== requested.axis;
  const axisDistance = axis === 'horizontal'
    ? Math.abs(current[0] - origin[0])
    : Math.abs(current[1] - origin[1]);
  if (needsSwitch && axisDistance <= 0.7) axis = requested.axis;
  const goal = needsSwitch && axis !== requested.axis ? origin : requested.position;
  const axisIndex = axis === 'horizontal' ? 0 : 1;
  const remaining = Math.abs(current[axisIndex] - goal[axisIndex]);
  let nextValue = goal[axisIndex];
  if (remaining >= 0.7) {
    nextValue = smoothedPosition(
      [current[axisIndex], 0], [goal[axisIndex], 0], dtMilliseconds,
    )[0];
  }
  const bounds = limits(config);
  nextValue = axis === 'horizontal'
    ? clamp(nextValue, bounds.minX, bounds.maxX)
    : clamp(nextValue, bounds.minY, bounds.maxY);
  const position = axis === 'horizontal'
    ? [nextValue, origin[1]]
    : [origin[0], nextValue];
  return { position, axis };
}

export function smoothedPosition(current, target, dtMilliseconds, timeConstant = 28) {
  const delta = Math.max(0, Math.min(100, finite(dtMilliseconds, 16)));
  const alpha = 1 - Math.exp(-delta / Math.max(1, timeConstant));
  return [
    current[0] + (target[0] - current[0]) * alpha,
    current[1] + (target[1] - current[1]) * alpha,
  ];
}
