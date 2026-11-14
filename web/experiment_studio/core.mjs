/** Pure experiment planning helpers. No ComfyUI or DOM dependencies. */
const MAX_RUNS = 96;
export const MAX_AXES = 12;
export const SEED_AXIS_KEY = '__seed__';
const SKIP_KEYS = new Set(['images', 'image', 'filename_prefix']);
const SEED_PATTERN = /(?:^|_)(?:seed|noise_seed)(?:$|_)/i;

export function getSeedTargets(apiPrompt) {
  const out = [];
  for (const [nodeId, node] of Object.entries(apiPrompt || {})) {
    for (const [inputName, value] of Object.entries(node.inputs || {})) {
      if (SEED_PATTERN.test(inputName) && typeof value === 'number') {
        out.push({nodeId, inputName, original: value});
      }
    }
  }
  return out;
}

export function getCandidates(apiPrompt, captureId) {
  const items = [];
  for (const [nodeId, node] of Object.entries(apiPrompt || {})) {
    if (String(nodeId) === String(captureId)) continue;
    for (const [inputName, value] of Object.entries(node.inputs || {})) {
      if (SKIP_KEYS.has(inputName) || SEED_PATTERN.test(inputName)
        || /^(?:text|prompt|positive|negative|system_prompt)$/i.test(inputName)) continue;
      // Connected widgets are represented by arrays in the API prompt. They are not direct inputs.
      if (typeof value !== 'number' && (typeof value !== 'string' || value.length > 256)) continue;
      const title = node._meta?.title || node.class_type || `Node ${nodeId}`;
      items.push({key: `${nodeId}::${inputName}`, nodeId, inputName, value,
        kind: typeof value === 'number' ? 'number' : 'text',
        label: `${title} [#${nodeId}] / ${inputName}`, classType: node.class_type});
    }
  }
  // Treat all *direct* seed widgets as one logical parameter. This is consistent
  // with the original fixed-seed behavior and prevents silently divergent seeds.
  const seeds = getSeedTargets(apiPrompt);
  if (seeds.length) items.push({key: SEED_AXIS_KEY, nodeId: null, inputName: 'seed',
    value: seeds[0].original, kind: 'number', label: 'Seed / all direct seed widgets', virtual: true});
  return items.sort((a, b) => a.label.localeCompare(b.label));
}

function numeric(input, name) {
  const n = Number(input);
  if (String(input).trim() === '' || !Number.isFinite(n)) throw new Error(`${name}: enter a valid number.`);
  return n;
}

function requireValidSeed(value) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error('Seeds must be non-negative safe integers (up to 9007199254740991).');
  }
  return value;
}

export function valuesForAxis(axis, candidate) {
  if (!candidate) throw new Error('Select a valid parameter for each axis.');
  const isSeed = candidate.key === SEED_AXIS_KEY;
  const values = axis.mode === 'range'
    ? (() => {
        if (candidate.kind !== 'number') throw new Error(`${candidate.inputName} cannot use numeric range.`);
        const start = numeric(axis.start, 'Start');
        const step = numeric(axis.step, 'Step');
        const count = Number(axis.count);
        if (!Number.isInteger(count) || count < 1 || count > MAX_RUNS) throw new Error('Count must be 1–96.');
        return Array.from({length: count}, (_, i) => isSeed ? start + step * i : Number((start + step * i).toPrecision(12)));
      })()
    : String(axis.values || '').split(/[\n,]/).map(x => x.trim()).filter(Boolean).map(x => {
        if (candidate.kind === 'text') return x;
        return numeric(x, candidate.inputName);
      });
  if (!values.length) throw new Error(`No values for ${candidate.inputName}.`);
  if (values.length > MAX_RUNS) throw new Error('Maximum 96 values per axis.');
  if (isSeed) values.forEach(requireValidSeed);
  if (candidate.kind === 'number' && /^(?:steps|start_at_step|end_at_step|width|height|batch_size|samples|frame_count)$/i.test(candidate.inputName)) {
    if (values.some(v => !Number.isInteger(v))) throw new Error(`${candidate.inputName} requires whole numbers.`);
  }
  return values;
}

/** A linked LoRA choice can turn off a native LoRA loader without an invalid filename. */
export function canDisableLora(apiPrompt, candidate) {
  if (candidate?.inputName !== 'lora_name') return false;
  const node = apiPrompt?.[candidate.nodeId];
  if (!node || !/^(LoraLoader|LoraLoaderModelOnly|LoraLoaderBypass|LoraLoaderBypassModelOnly)$/.test(node.class_type)) return false;
  return typeof node.inputs?.strength_model === 'number'
    && (node.inputs.strength_clip === undefined || typeof node.inputs.strength_clip === 'number');
}

/** A string key works for text and numeric parent values, without serializing arbitrary objects. */
export function parentValueKey(value) { return String(value); }

/** Repeated axes address the same widget. Merge their alternatives rather than overwriting it. */
export function prepareAxes(apiPrompt, captureId, axes) {
  const candidates = getCandidates(apiPrompt, captureId);
  if (!Array.isArray(axes) || axes.length === 0 || axes.length > MAX_AXES) throw new Error(`Use 1–${MAX_AXES} axes.`);
  const prepared = [];
  const byKey = new Map();
  for (const axis of axes) {
    const candidate = candidates.find(c => c.key === axis.key);
    if (!candidate) throw new Error(`Missing parameter: ${axis.key}`);
    const values = valuesForAxis(axis, candidate);
    let group = byKey.get(candidate.key);
    if (!group) {
      group = {candidate, values: []};
      byKey.set(candidate.key, group);
      prepared.push(group);
    }
    for (const value of values) {
      if (!group.values.includes(value)) group.values.push(value);
    }
  }
  return prepared;
}

/** Independent axes use the original cross/pair modes. Linked axes expand only the
 * branch chosen by their parent, never a Cartesian product across unrelated UNETs. */
export function buildPlan(apiPrompt, captureId, axes, mode, seedText, maxRuns = MAX_RUNS) {
  if (!Array.isArray(axes) || !axes.length || axes.length > MAX_AXES) throw new Error(`Use 1–${MAX_AXES} axes.`);
  if (mode !== 'cross' && mode !== 'pair') throw new Error('Unsupported combination mode.');
  const fixedSeed = requireValidSeed(numeric(seedText, 'Default seed'));
  const allCandidates = getCandidates(apiPrompt, captureId);
  const byId = new Map();
  const linked = [];
  const roots = [];
  const indexed = axes.map((axis, i) => ({...axis, id: axis.id || `legacy-${i}`}));
  for (let i = 0; i < indexed.length; i++) {
    const axis = indexed[i];
    if (byId.has(axis.id)) throw new Error('Duplicate axis identifier; recreate the duplicated axis.');
    const candidate = allCandidates.find(c => c.key === axis.key);
    if (!candidate) throw new Error(`Missing parameter: ${axis.key}`);
    if (axis.linkedTo) {
      const parentIndex = indexed.findIndex(a => a.id === axis.linkedTo);
      if (parentIndex < 0 || parentIndex >= i) throw new Error(`Axis ${i+1}: choose an earlier parent axis.`);
      const parent = indexed[parentIndex];
      if (parent.key === axis.key) throw new Error(`Axis ${i+1}: a linked axis must target a different parameter from its parent.`);
      if (parent.linkedTo) throw new Error(`Axis ${i+1}: nested parents are not supported yet. Choose an independent parent.`);
      linked.push({axis, candidate, parentKey: parent.key});
    } else roots.push(axis);
    byId.set(axis.id, axis);
  }
  if (!roots.length) throw new Error('At least one independent axis is required.');
  // Repeated independent axes are still combined into a single list of alternatives.
  const prepared = prepareAxes(apiPrompt, captureId, roots);
  const rootKeys = new Set(prepared.map(p => p.candidate.key));
  const linkedKeys = new Set();
  for (const child of linked) {
    if (!rootKeys.has(child.parentKey)) throw new Error('Linked parent is not a valid independent axis.');
    if (rootKeys.has(child.candidate.key) || linkedKeys.has(child.candidate.key)) {
      throw new Error(`Linked parameter ${child.candidate.inputName} is already controlled by another axis.`);
    }
    linkedKeys.add(child.candidate.key);
  }
  const count = mode === 'cross'
    ? prepared.reduce((n,p) => n*p.values.length,1)
    : Math.max(...prepared.map(p => p.values.length));
  if (count > maxRuns) throw new Error(`This experiment would generate ${count} runs. Maximum is ${maxRuns}. Reduce the axes.`);
  if (mode === 'pair' && prepared.some(p => p.values.length !== count && p.values.length !== 1)) {
    throw new Error('Pair by position requires the same number of values per parameter (or one constant value).');
  }
  const plan = [];
  for (let n = 0; n < count; n++) {
    let subIndex = n;
    const rootValues = new Map();
    let seed = fixedSeed;
    const settings = [];
    for (let j = prepared.length - 1; j >= 0; j--) {
      const group = prepared[j];
      const idx = mode === 'cross' ? subIndex % group.values.length : (group.values.length === 1 ? 0 : n);
      if (mode === 'cross') subIndex = Math.floor(subIndex / group.values.length);
      rootValues.set(group.candidate.key, group.values[idx]);
    }
    for (const group of prepared) {
      const value = rootValues.get(group.candidate.key);
      if (group.candidate.key === SEED_AXIS_KEY) seed = requireValidSeed(value);
      else settings.push({nodeId:group.candidate.nodeId,inputName:group.candidate.inputName,
        value,label:group.candidate.label});
    }
    // One parent choice may have several child alternatives, e.g. one UNET with
    // two LoRAs; expand within that branch. Independent axes still cross normally.
    let branches = [{seed,settings}];
    for (const {axis,candidate,parentKey} of linked) {
      const parentValue = rootValues.get(parentKey);
      const rule = axis.linkedValues?.[parentValueKey(parentValue)];
      if (!rule || rule.mode === 'keep') continue;
      let extra;
      if (rule.mode === 'disable') {
        if (!canDisableLora(apiPrompt,candidate)) throw new Error(`Cannot disable LoRA for ${candidate.label}. Use a native LoRA Loader.`);
        extra = [{nodeId:candidate.nodeId,inputName:candidate.inputName,
          value:'OFF',special:'disable_lora',label:candidate.label}];
      } else if (rule.mode === 'value') {
        const values = valuesForAxis({mode:'list',values:rule.values},candidate);
        extra = values.map(value => ({nodeId:candidate.nodeId,inputName:candidate.inputName,
          value,label:candidate.label}));
      } else throw new Error(`Unsupported linked axis rule: ${rule.mode}`);
      branches = branches.flatMap(b => extra.map(setting => ({seed:b.seed,settings:[...b.settings,setting]})));
      if (plan.length + branches.length > maxRuns) {
        throw new Error(`This experiment exceeds ${maxRuns} runs after linked-axis expansion. Reduce the child values.`);
      }
    }
    for (const branch of branches) {
      if (plan.length >= maxRuns) throw new Error(`This experiment exceeds ${maxRuns} runs. Reduce the axes.`);
      plan.push({number:plan.length+1,seed:branch.seed,settings:branch.settings});
    }
  }
  return {plan,seeds:getSeedTargets(apiPrompt),total:plan.length,uniqueAxes:prepared.length+linked.length};
}

/** Browser-side seed draw. Keep the seed inside JavaScript's exact integer range. */
export function randomSafeSeed() {
  const words = new Uint32Array(2);
  if (globalThis.crypto?.getRandomValues) {
    globalThis.crypto.getRandomValues(words);
  } else {
    // LAN HTTP frontends may have no Web Crypto; this is a generation seed,
    // not a security token, so Math.random is an acceptable fallback.
    words[0] = Math.floor(Math.random() * 0x100000000);
    words[1] = Math.floor(Math.random() * 0x100000000);
  }
  return (words[0] & 0x1fffff) * 0x100000000 + words[1];
}

/** Expand a completed plan *once*, when Start is pressed. Preview mode never
 * draws a random seed; the actual values are frozen in ctx.plan before queuing
 * and survive Pause/Resume and export as part of each run. */
export function planWithSeedStrategy(basePlan, {
  seedMode = 'fixed', randomSamples = 1, preview = false,
  hasSeedAxis = false, seedTargets = 1, randomSeed = randomSafeSeed,
  maxRuns = MAX_RUNS,
} = {}) {
  if (!Array.isArray(basePlan)) throw new Error('Invalid experiment plan.');
  if (seedMode !== 'fixed' && seedMode !== 'random') throw new Error('Invalid seed mode.');
  if (seedMode === 'fixed') return basePlan;
  if (hasSeedAxis) {
    throw new Error('Random seed mode cannot be combined with a Seed axis. Remove the Seed axis, or select Fixed / Seed axis.');
  }
  if (seedTargets < 1) {
    throw new Error('Random seed mode needs at least one directly editable seed widget (unlinked numeric seed input).');
  }
  const samples = Number(randomSamples);
  if (!Number.isInteger(samples) || samples < 1 || samples > maxRuns) {
    throw new Error(`Random samples must be a whole number from 1 to ${maxRuns}.`);
  }
  if (basePlan.length * samples > maxRuns) {
    throw new Error(`This experiment would generate ${basePlan.length * samples} runs. Maximum is ${maxRuns}. Reduce the samples or axes.`);
  }
  const used = new Set();
  const plan = [];
  for (const config of basePlan) {
    for (let sample = 1; sample <= samples; sample++) {
      let seed = null;
      if (!preview) {
        let attempts = 0;
        do {
          seed = requireValidSeed(randomSeed());
          if (++attempts > 1000) throw new Error('Could not draw unique random seeds.');
        } while (used.has(seed));
        used.add(seed);
      }
      plan.push({...config, number:plan.length + 1, seed, seedMode:'random', sample});
    }
  }
  return plan;
}

export function makeRunPrompt(snapshot, run, seedTargets, captureId, prefix) {
  const cloned = JSON.parse(JSON.stringify(snapshot));
  // Frontend callbacks for presets are not run by the API queue. Apply their
  // captured dependent fields, then allow explicit axes to override them.
  for (const derived of run.dependentSettings || []) {
    const inputs=cloned[derived.nodeId]?.inputs;
    if (inputs && Object.hasOwn(inputs,derived.inputName) &&
        (typeof inputs[derived.inputName] === 'number' || typeof inputs[derived.inputName] === 'string' || typeof inputs[derived.inputName] === 'boolean')) {
      inputs[derived.inputName]=derived.value;
    }
  }
  for (const setting of run.settings) {
    if (setting.special === 'disable_lora') {
      const node = cloned[setting.nodeId];
      if (!node?.inputs || !canDisableLora(cloned,setting)) throw new Error(`Cannot disable LoRA: ${setting.label}`);
      node.inputs.strength_model = 0;
      if (typeof node.inputs.strength_clip === 'number') node.inputs.strength_clip = 0;
      continue;
    }
    if (!cloned[setting.nodeId]?.inputs || !Object.hasOwn(cloned[setting.nodeId].inputs, setting.inputName)) {
      throw new Error(`Missing runtime field: ${setting.label}`);
    }
    cloned[setting.nodeId].inputs[setting.inputName] = setting.value;
  }
  // A preset callback must never change a fixed/random/manual seed sweep.
  for (const {nodeId, inputName} of seedTargets) {
    if (cloned[nodeId]?.inputs && typeof cloned[nodeId].inputs[inputName] === 'number') {
      cloned[nodeId].inputs[inputName] = run.seed;
    }
  }
  if (!cloned[captureId]?.inputs) throw new Error('The Experiment Studio capture node is missing from the workflow API.');
  cloned[captureId].inputs.filename_prefix = `${prefix}/run_${String(run.number).padStart(3, '0')}`;
  return cloned;
}

export function formatRun(run) {
  const all=[...(run.settings || []),...(run.dependentSettings || [])];
  return all.length ? all.map(s => `${s.inputName}=${s.special === 'disable_lora' ? 'OFF' : s.value}`).join(' · ') : `seed=${run.seed}`;
}

export function getSelectedImage(entry, requestedIndex = 0) {
  if (!entry?.images?.length) return {image: null, index: 0, count: 0};
  const count = entry.images.length;
  const index = Math.min(count - 1, Math.max(0, Number.isInteger(requestedIndex) ? requestedIndex : 0));
  return {image: entry.images[index], index, count};
}
