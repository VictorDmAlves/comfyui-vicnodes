import { getConfig, setConfig, restoreOriginal } from './follow_position.mjs';
import { makeConfig, normalizeConfig, readPosition, MAX_DISTANCE } from './follow_engine.mjs';
import { refreshCamera } from './follow_camera.mjs';

let currentDialog = null;

function el(tag, className, text) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text != null) element.textContent = text;
  return element;
}
function field(label, input, parent) {
  const wrapper = el('label', 'vfp-field');
  wrapper.append(el('span', 'vfp-label', label), input);
  parent.append(wrapper);
  return input;
}
function numberInput(value) {
  const input = el('input', 'vfp-input');
  input.type = 'number';
  input.min = '0';
  input.max = String(MAX_DISTANCE);
  input.step = '100';
  input.value = String(value);
  return input;
}
function selectInput(items, value) {
  const select = el('select', 'vfp-input');
  for (const [key, label] of items) {
    const option = el('option', null, label);
    option.value = key;
    option.selected = key === String(value);
    select.append(option);
  }
  return select;
}
function closeDialog() {
  currentDialog?.remove();
  currentDialog = null;
}
export function openEditor(node) {
  const origin = readPosition(node);
  if (!origin) return;
  closeDialog();
  const cfg = getConfig(node) ?? makeConfig(origin);
  const backdrop = el('div', 'vfp-backdrop');
  const dialog = el('section', 'vfp-dialog');
  dialog.setAttribute('role', 'dialog');
  dialog.setAttribute('aria-modal', 'true');
  dialog.setAttribute('aria-label', 'Node Follow Path settings');
  const title = el('div', 'vfp-title-row');
  title.append(el('h2', null, 'Node Follow Path'), el('span', 'vfp-version', 'v1.0'));
  dialog.append(title);
  dialog.append(el('p', 'vfp-subtitle', node.title || node.type || 'Selected node'));

  const enabledRow = el('label', 'vfp-checkline');
  const enabled = el('input'); enabled.type = 'checkbox'; enabled.checked = cfg.enabled;
  enabledRow.append(enabled, el('span', null, 'Enable movement'));
  dialog.append(enabledRow);

  const mode = selectInput([
    ['horizontal', 'Horizontal (X)'], ['vertical', 'Vertical (Y)'], ['both', 'Both Axes (L Path)'],
  ], cfg.mode);
  field('Movement mode', mode, dialog);

  const rowX = el('div', 'vfp-grid-two');
  const distanceX = numberInput(cfg.distanceX);
  const directionX = selectInput([['1', 'Right (+X)'], ['-1', 'Left (-X)']], cfg.directionX);
  field('Horizontal distance', distanceX, rowX);
  field('Direction X', directionX, rowX);
  dialog.append(rowX);

  const rowY = el('div', 'vfp-grid-two');
  const distanceY = numberInput(cfg.distanceY);
  const directionY = selectInput([['1', 'Down (+Y)'], ['-1', 'Up (-Y)']], cfg.directionY);
  field('Vertical distance', distanceY, rowY);
  field('Direction Y', directionY, rowY);
  dialog.append(rowY);

  const showRow = el('label', 'vfp-checkline');
  const showPath = el('input'); showPath.type = 'checkbox'; showPath.checked = cfg.showPath;
  showRow.append(showPath, el('span', null, 'Show path preview on canvas'));
  dialog.append(showRow);

  dialog.append(el('p', 'vfp-hint',
    'Distances are in Workflow units at 100% zoom. Right/down starts from the original position. ' +
    'In Both Axes, the node stays on the X/Y lines and returns through their shared origin when changing axes. The preview has draggable start and end handles; nothing is filled over the Workflow.'));

  const error = el('p', 'vfp-error');
  error.hidden = true;
  dialog.append(error);

  function syncMode() {
    rowX.style.display = mode.value === 'vertical' ? 'none' : '';
    rowY.style.display = mode.value === 'horizontal' ? 'none' : '';
  }
  mode.addEventListener('change', syncMode); syncMode();

  const actions = el('div', 'vfp-actions');
  const reset = el('button', 'vfp-button vfp-button-quiet', 'Restore origin');
  reset.type = 'button';
  reset.title = 'Return to the saved origin and disable Follow Path';
  reset.addEventListener('click', () => {
    restoreOriginal(node, true);
    refreshCamera();
    closeDialog();
  });
  const cancel = el('button', 'vfp-button vfp-button-quiet', 'Cancel');
  cancel.type = 'button'; cancel.addEventListener('click', closeDialog);
  const save = el('button', 'vfp-button vfp-button-primary', 'Apply');
  save.type = 'button';
  save.addEventListener('click', () => {
    const dx = Number(distanceX.value), dy = Number(distanceY.value);
    if (![dx, dy].every((v) => Number.isFinite(v) && v >= 0 && v <= MAX_DISTANCE)) {
      error.hidden = false;
      error.textContent = `Distances must be between 0 and ${MAX_DISTANCE.toLocaleString()}.`;
      return;
    }
    const next = normalizeConfig({
      ...cfg,
      enabled: enabled.checked,
      mode: mode.value,
      distanceX: dx,
      distanceY: dy,
      directionX: Number(directionX.value),
      directionY: Number(directionY.value),
      showPath: showPath.checked,
    }, cfg.origin);
    setConfig(node, next);
    if (!next.enabled) restoreOriginal(node, false);
    node.graph?.change?.();
    refreshCamera();
    closeDialog();
  });
  actions.append(reset, cancel, save);
  dialog.append(actions);
  backdrop.append(dialog);
  backdrop.addEventListener('mousedown', (e) => { if (e.target === backdrop) closeDialog(); });
  backdrop.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeDialog(); });
  document.body.append(backdrop);
  currentDialog = backdrop;
  save.focus();
}
