const fs = require('fs');
const vm = require('vm');
const assert = require('assert');
const path = require('path');
const source = fs.readFileSync(process.env.MOSS_PRESET_SYNC_JS || path.join(__dirname, '../web/moss_smart_sampler/preset_sync.js'), 'utf8');
let extension;
const app = { registerExtension(ext) { extension = ext; } };
vm.runInNewContext(source.replace(/^import \{ app \} from .+;\s*/,'') , { app, Object, console });
assert.strictEqual(extension.name, 'VicNodes.MOSSSmartSampler.PresetSync');

function makeNode(data) {
  class MockNode {
    constructor() {
      const defaults = { preset: 'Balanced', steps: 35, cfg: 4.0, custom_base_preset: 'Balanced' };
      this.type = 'MOSSSmartSampler';
      this.widgets = Object.entries(defaults).map(([name, value]) => ({name, value, callback:null}));
      this.dirty = 0;
      this.onNodeCreated();
    }
    setDirtyCanvas() { this.dirty += 1; }
    configure(values) {
      for (const [name, value] of Object.entries(values)) {
        const w = this.widgets.find(w => w.name === name);
        if (w) { w.value = value; w.callback?.(value); }
      }
    }
  }
  extension.beforeRegisterNodeDef(MockNode, {name:'MOSSSmartSampler'});
  const node = new MockNode();
  if (data) node.configure(data);
  return node;
}
function get(n,name) {return n.widgets.find(w=>w.name===name).value;}
function edit(n,name,value) { const w = n.widgets.find(w=>w.name===name); w.value=value; w.callback?.(value); }

// Test Balanced initial state.
let n = makeNode();
assert.deepStrictEqual([get(n,'preset'),get(n,'steps'),get(n,'cfg')],['Balanced',35,4]);
assert.strictEqual(n.widgets.find(w=>w.name==='custom_base_preset').hidden,true);
// Switching presets fills Steps/CFG.
for (const [name,steps,cfg] of [['Turbo',8,1],['Fast',25,4],['Quality',50,4],['Realism',40,4],['Balanced',35,4]]) {
 edit(n,'preset',name);
 assert.deepStrictEqual([get(n,'preset'),get(n,'steps'),get(n,'cfg'),get(n,'custom_base_preset')],[name,steps,cfg,name]);
}
// User edits cause Custom without overwriting other manually selected value.
edit(n,'preset','Turbo'); edit(n,'steps',12);
assert.deepStrictEqual([get(n,'preset'),get(n,'steps'),get(n,'cfg'),get(n,'custom_base_preset')],['Custom',12,1,'Turbo']);
edit(n,'cfg',1.4);
assert.deepStrictEqual([get(n,'preset'),get(n,'steps'),get(n,'cfg'),get(n,'custom_base_preset')],['Custom',12,1.4,'Turbo']);
edit(n,'preset','Custom');
assert.deepStrictEqual([get(n,'steps'),get(n,'cfg')],[12,1.4]);
edit(n,'preset','Fast');
assert.deepStrictEqual([get(n,'preset'),get(n,'steps'),get(n,'cfg'),get(n,'custom_base_preset')],['Fast',25,4,'Fast']);

// Opening old workflows with 0/0 must resolve to previously effective values.
n = makeNode({preset:'Turbo',steps:0,cfg:0});
assert.deepStrictEqual([get(n,'preset'),get(n,'steps'),get(n,'cfg')],['Turbo',8,1]);
n = makeNode({preset:'Balanced',steps:0,cfg:0});
assert.deepStrictEqual([get(n,'preset'),get(n,'steps'),get(n,'cfg')],['Balanced',35,4]);
// Explicit old overrides become Custom and preserve parent profile.
n = makeNode({preset:'Turbo',steps:12,cfg:2});
assert.deepStrictEqual([get(n,'preset'),get(n,'steps'),get(n,'cfg'),get(n,'custom_base_preset')],['Custom',12,2,'Turbo']);
// Save/reload Custom keeps its origin.
n = makeNode({preset:'Custom',custom_base_preset:'Realism',steps:46,cfg:3.7});
assert.deepStrictEqual([get(n,'preset'),get(n,'steps'),get(n,'cfg'),get(n,'custom_base_preset')],['Custom',46,3.7,'Realism']);
// Old alias compatibility.
n = makeNode({preset:'UltraFast / Turbo',steps:0,cfg:0});
assert.deepStrictEqual([get(n,'preset'),get(n,'steps'),get(n,'cfg')],['Turbo',8,1]);
console.log('Preset-sync JS tests passed (new, choices, manual Custom, Turbo origin, saved, legacy, alias)');
