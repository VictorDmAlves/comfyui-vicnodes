/**
 * Node Follow Path v1.0 - VicNodes frontend-only module.
 * This is the ONLY .js file of this module, so ComfyUI auto-imports it once.
 * All helpers are .mjs to avoid the /extensions recursive *.js auto-import.
 */
import { app } from '../../../scripts/app.js';
import { makeConfig, readPosition } from './follow_engine.mjs';
import { getConfig, setConfig, ensureSerialization, restoreOriginal } from './follow_position.mjs';
import { initCamera, refreshCamera, onWorkflowChanged } from './follow_camera.mjs';
import { openEditor } from './follow_editor.mjs';

const cssId = 'vic-node-follow-path-style';
if (!document.getElementById(cssId)) {
  const css = document.createElement('link');
  css.id = cssId;
  css.rel = 'stylesheet';
  css.href = new URL('./follow_style.css', import.meta.url).href;
  document.head.append(css);
}

function togglePreview(node) {
  const pos = readPosition(node);
  if (!pos) return;
  const cfg = getConfig(node) ?? makeConfig(pos);
  // Preview-only change must not re-anchor or reposition a moving node.
  node.properties ||= {};
  node.properties.vic_follow_path = { ...cfg, showPath: !cfg.showPath };
  ensureSerialization(node);
  node.graph?.change?.();
  refreshCamera();
}

function changeConfig(node, edit) {
  const pos = readPosition(node);
  if (!pos) return;
  const cfg = getConfig(node) ?? makeConfig(pos);
  setConfig(node, { ...cfg, ...edit });
  node.graph?.change?.();
  refreshCamera();
}

app.registerExtension({
  name: 'VicNodes.NodeFollowPath',

  setup(appInstance) {
    initCamera(appInstance);
    console.info('[VicNodes] Node Follow Path v1.0 initialized (classic canvas)');
  },

  nodeCreated(node) {
    if (getConfig(node)) ensureSerialization(node);
  },

  loadedGraphNode(node) {
    if (getConfig(node)) {
      ensureSerialization(node);
      refreshCamera();
    }
  },

  afterConfigureGraph() {
    refreshCamera();
  },

  afterLoadGraph() {
    onWorkflowChanged();
  },

  getNodeMenuItems(node) {
    if (!readPosition(node) || !node?.graph) return [];
    const cfg = getConfig(node);
    const active = cfg?.enabled === true;
    return [
      null,
      {
        content: 'Follow Path: Configure...',
        callback: () => openEditor(node),
      },
      {
        content: active ? 'Follow Path: Disable' : 'Follow Path: Enable',
        callback: () => changeConfig(node, { enabled: !active }),
      },
      {
        content: cfg?.showPath ? 'Follow Path: Hide Path Preview' : 'Follow Path: Show Path Preview',
        callback: () => togglePreview(node),
      },
      {
        content: 'Follow Path: Restore Original Position',
        callback: () => {
          restoreOriginal(node, true);
          node.graph?.change?.();
          refreshCamera();
        },
      },
    ];
  },

});
