/**
 * Frontend preset-effect capture. Works with ordinary synchronous widget
 * callbacks, including custom nodes; nothing is hard-coded for VicNodes.
 *
 * A transient state change is made to the live widget, then all captured
 * widget values / node properties are restored in finally. We intentionally
 * do not run a second callback when restoring; such a callback could override
 * the exact saved values. We cannot promise support for callbacks with network
 * effects, timers, or mutations to *other* nodes. Unsupported callbacks are
 * reported rather than silently guessing dependent values.
 */
const PRIMITIVE = value => (typeof value === 'number' && Number.isFinite(value)) || typeof value === 'string' || typeof value === 'boolean';
const PRESET_NAME = /(?:^|_)(?:preset|profile)(?:$|_)/i;

function replaceProperties(obj, copy) {
  if (!obj || !copy) return;
  for (const key of Object.keys(obj)) if (!Object.hasOwn(copy,key)) delete obj[key];
  Object.assign(obj, copy);
}

export function isPresetSetting(setting) {
  return !!setting && !setting.special && typeof setting.value === 'string'
    && PRESET_NAME.test(setting.inputName);
}

/** Return array of changes or a descriptive unsupported reason. */
export function inspectWidgetEffects(node, apiInputs, setting, {canvas=null}={}) {
  const widgets = node?.widgets;
  if (!Array.isArray(widgets)) return {changes:[], warning:'Node does not expose editable widgets.'};
  const active = widgets.find(w => w.name === setting.inputName);
  if (!active) return {changes:[], warning:`Widget ${setting.inputName} is unavailable in the active graph.`};
  const callback = typeof active.callback === 'function' ? active.callback : null;
  const changedHandler = typeof node.onWidgetChanged === 'function' ? node.onWidgetChanged : null;
  if (!callback && !changedHandler) {
    return {changes:[], warning:`${setting.inputName} has no synchronous widget callback; other fields cannot be inferred.`};
  }
  // Primitive snapshots only: callbacks sometimes update .value in place.
  const before = widgets.map(w => ({widget:w, value:w.value, disabled:w.disabled}));
  const originalProps = node.properties && typeof node.properties === 'object'
    ? {...node.properties} : null;
  const originalValue = active.value;
  try {
    active.value = setting.value;
    // Both callbacks are used by ComfyUI's standard widget setter; callbacks
    // often apply the presets, and onWidgetChanged may be the extension hook.
    const result = callback?.call(active,setting.value,canvas,node,[0,0],undefined);
    if (result && typeof result.then === 'function') {
      return {changes:[], warning:'Asynchronous widget callback is not supported for automatic preset capture.'};
    }
    const changed = changedHandler?.call(node,setting.inputName,setting.value,originalValue,active);
    if (changed && typeof changed.then === 'function') {
      return {changes:[], warning:'Asynchronous onWidgetChanged is not supported for automatic preset capture.'};
    }
    const out=[];
    for (const {widget, value:oldValue} of before) {
      const name=widget.name;
      if (!name || name === setting.inputName || !Object.hasOwn(apiInputs,name)) continue;
      // Connected inputs must never be replaced with dependent values.
      if (!PRIMITIVE(apiInputs[name]) || !PRIMITIVE(widget.value)) continue;
      if (widget.value !== oldValue && widget.value !== apiInputs[name]) {
        out.push({nodeId:setting.nodeId,inputName:name,value:widget.value,
          label:`${setting.label || setting.inputName} -> ${name}`,derivedFrom:setting.inputName});
      }
    }
    return {changes:out, warning:null};
  } catch (err) {
    return {changes:[], warning:`${setting.inputName} callback could not be inspected: ${err?.message || String(err)}`};
  } finally {
    // Roll back all the node's widgets, not only the chosen preset.
    for (const {widget,value,disabled} of before) {
      widget.value=value;
      widget.disabled=disabled;
    }
    replaceProperties(node.properties, originalProps);
  }
}

export function addPresetEffects(plan, apiPrompt, getNode, opts={}) {
  const reports=[];
  const cache=new Map();
  const enriched=plan.map(run=>{
    const dependentSettings=[];
    for (const setting of run.settings || []) {
      if (!isPresetSetting(setting)) continue;
      const key=JSON.stringify([setting.nodeId,setting.inputName,setting.value]);
      let record=cache.get(key);
      if (!record) {
        const node=getNode(setting.nodeId);
        const inputs=apiPrompt?.[setting.nodeId]?.inputs || {};
        record=inspectWidgetEffects(node,inputs,setting,opts);
        if (!record.warning && !record.changes.length &&
            setting.value !== inputs[setting.inputName] &&
            (typeof inputs.steps === 'number' || typeof inputs.cfg === 'number')) {
          record={...record, warning:'No changes to steps/CFG were captured; existing values will remain unless the node handles the preset internally.'};
        }
        cache.set(key,record);
        reports.push({key, setting, changes:record.changes, warning:record.warning});
      }
      // An explicit axis always wins over automatically learned dependencies.
      const explicitlyControlled=new Set((run.settings||[]).map(s=>`${s.nodeId}::${s.inputName}`));
      for (const change of record.changes) {
        if (!explicitlyControlled.has(`${change.nodeId}::${change.inputName}`)) {
          dependentSettings.push({...change});
        }
      }
    }
    return {...run,dependentSettings};
  });
  return {plan:enriched,reports};
}
