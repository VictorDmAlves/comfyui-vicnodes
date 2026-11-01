const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const source = fs.readFileSync(path.join(__dirname, '..', '..', '..', 'web', 'ollama_bridge', 'ollama_bridge.js'), 'utf8')
  .replace(/^import .*?;\s*$/gm, '');
let extension;
let fetchCount = 0;
const notices = [];
const currentNodes = [];
const app = {
  registerExtension: (e) => { extension = e; },
  graph: { _nodes: currentNodes, setDirtyCanvas: () => {} },
  canvas: { setDirty: () => {} },
  extensionManager: { toast: { add: (msg) => notices.push(msg) } },
};
const api = {
  fetchApi: async (url) => {
    fetchCount++;
    const parsed = new URL(url, 'http://localhost:8188');
    assert.equal(parsed.pathname, '/vicnodes/ollama_bridge/models');
    assert.equal(parsed.searchParams.get('force'), '1');
    return { ok: true, json: async () => ({ models: ['vision:new', 'plain:new'] }) };
  },
};
vm.runInNewContext(source, { app, api, URL, URLSearchParams, console });
assert.ok(extension, 'registerExtension was invoked');
assert.equal(extension.menuCommands[0].path[0], 'Edit');
assert.equal(extension.commands[0].label, 'Ollama: Refresh Models');

class FakeNode {
  configure(info) { this.configured = info; return info; }
}
const nodeDef = {
  name: 'OllamaLocalChat',
  input: { required: { model: [['Click Refresh Models'], {}] } },
};
(async () => {
  await extension.beforeRegisterNodeDef(FakeNode, nodeDef);
  const old = [
    'http://localhost:11434', 'vision:old', null, 'A cat portrait',
    300, 'fixed', 0.3, 1024, 4096, 'Be precise', 'Model Default',
    '5m', 'JPEG', 1024, 90, 8, 300, 'Cache Identical Inputs',
  ];
  const n = new FakeNode();
  n.configure({ widgets_values: old, widgets_values_named: {
    model: 'vision:old', 'Refresh Models': null, prompt: 'A cat portrait',
  } });
  assert.equal(n.configured.widgets_values.length, 17);
  assert.equal(n.configured.widgets_values[2], 'A cat portrait');
  assert.equal(n.configured.widgets_values[3], 300);
  assert.equal(n.configured.widgets_values[5], 0.3);
  assert.equal(n.configured.widgets_values[16], 'Cache Identical Inputs');
  assert.equal(n.configured.widgets_values_named.model, 'vision:old');
  assert.equal(n.configured.widgets_values_named['Refresh Models'], undefined);

  const fresh = new FakeNode();
  const newValues = [...old.slice(0, 2), ...old.slice(3)];
  fresh.configure({ widgets_values: newValues });
  assert.equal(fresh.configured.widgets_values.length, 17);
  assert.equal(fresh.configured.widgets_values[2], 'A cat portrait');

  const widget = (name, value) => ({ name, value, options: {} });
  const currentModel = widget('model', 'vision:old');
  const node = {
    comfyClass: 'OllamaLocalChat',
    widgets: [widget('ollama_url', 'http://localhost:11434'), currentModel],
    size: [300, 200],
    setSize(x) { this.size = x; },
    addWidget() { throw new Error('No button widgets should be added'); },
  };
  currentNodes.push(node);
  await extension.nodeCreated(node);
  assert.equal(fetchCount, 0, 'nodeCreated must not fetch models');
  assert.equal(node.widgets.length, 2, 'nodeCreated must not add widgets');
  assert.equal(node.size[0], 380);
  await extension.commands[0].function();
  assert.equal(fetchCount, 1, 'Menu command should query models once');
  assert.equal(currentModel.value, 'vision:old', 'Preserve existing selected model');
  assert.deepEqual(Array.from(currentModel.options.values), ['plain:new', 'vision:new', 'vision:old']);
  assert.deepEqual(Array.from(nodeDef.input.required.model[0]), ['vision:new', 'plain:new']);
  assert.equal(notices.at(-1).severity, 'success');

  // Placeholder nodes should pick the first real model after manual refresh.
  const blankModel = widget('model', 'Click Refresh Models');
  currentNodes.push({ comfyClass: 'OllamaLocalChat', widgets: [
    widget('ollama_url', 'http://localhost:11434'), blankModel,
  ] });
  await extension.commands[0].function();
  assert.equal(blankModel.value, 'plain:new');
  console.log('Frontend regression checks passed.');
})().catch(err => { console.error(err); process.exitCode = 1; });
