import {app} from '../../../scripts/app.js';
import {addPresetEffects} from './preset_dependencies.mjs?v=1.1.0';
import {api} from '../../../scripts/api.js';
import {getCandidates, getSeedTargets, buildPlan, planWithSeedStrategy, SEED_AXIS_KEY, MAX_AXES, makeRunPrompt, formatRun, getSelectedImage, prepareAxes, valuesForAxis, canDisableLora, parentValueKey} from './core.mjs?v=1.1.0';
import {clampExportChars, getExportLayout, percent, duration, remainingMs, flattenCompletedImages, findFrameIndex, nextCompletedFrame, clearNodeOutputPreview} from './experiment_utils.mjs?v=1.1.0';
import {modelChange, unloadBeforeModelSwitch} from './model_cache.mjs?v=1.1.0';
// ComfyUI serves extension JavaScript as native ES modules; load CSS as a stylesheet.
const styleHref = new URL('./studio.css?v=1.1.0', import.meta.url).href;
const existingStyle = document.querySelector('link[data-ves-style]');
if (existingStyle) existingStyle.href = styleHref;
else {
  const link = document.createElement('link');
  link.rel = 'stylesheet'; link.href = styleHref; link.dataset.vesStyle = '1';
  document.head.appendChild(link);
}

const PLUGIN = 'Vic.ExperimentStudio';
// Versioned browser entry point: avoid mixing a newly deployed extension with cached older modules.
const EXTENSION_VERSION = '1.1.0';
const CAPTURE_TYPE = 'VicExperimentStudio';
const PAGE_SIZE = 16;
const sessions = new WeakMap();
let currentOverlay = null;

function esc(x) { return String(x ?? '').replace(/[&<>"']/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch])); }
function wait(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }
function jsonClone(obj) { return JSON.parse(JSON.stringify(obj)); }
function newId() { return globalThis.crypto?.randomUUID?.() || `es_${Date.now()}_${Math.random().toString(36).slice(2)}`; }
function newPromptId() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  // Some users access ComfyUI over a LAN HTTP address, where crypto.randomUUID
  // is unavailable. ComfyUI validates prompt_id as a canonical UUID.
  const bytes=new Uint8Array(16);
  if(globalThis.crypto?.getRandomValues) globalThis.crypto.getRandomValues(bytes);
  else for(let i=0;i<16;i++) bytes[i]=Math.floor(Math.random()*256);
  bytes[6]=(bytes[6]&15)|64;bytes[8]=(bytes[8]&63)|128;
  const hex=Array.from(bytes,b=>b.toString(16).padStart(2,'0')).join('');
  return `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`;
}
function safeName(value) { return String(value).replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 60); }
function storeKey(ctx) { return `vic-experiment-studio:v0.1:${ctx.node.properties.studioId}`; }
function savedState(ctx) {
  try {
    const saved = JSON.parse(localStorage.getItem(storeKey(ctx)) || '{}');
    if (saved && Array.isArray(saved.results)) return saved;
  } catch (_e) { /* storage unavailable */ }
  return {};
}
function persist(ctx) {
  try {
    localStorage.setItem(storeKey(ctx), JSON.stringify({results:ctx.results, sessionPrefix:ctx.sessionPrefix, selectedImageIndices:ctx.selectedImageIndices}));
  } catch (_e) { /* keep in-memory results */ }
  ctx.node.properties.experimentSettings = {
    axes: ctx.axes, fixedSeed: ctx.fixedSeed, seedMode: ctx.seedMode, randomSamples:ctx.randomSamples, mode: ctx.mode,
    page: ctx.page, presetSync:ctx.presetSync, previewEnabled:ctx.previewEnabled, previewFrequency:ctx.previewFrequency,
    exportChars:ctx.exportChars, modelCacheMode:ctx.modelCacheMode,
  };
}
function candidateDefault(c) {
  const numeric = c?.kind === 'number';
  return {key:c?.key || '', mode:numeric?'range':'list', start:String(c?.value ?? 0),
    step:/strength|denoise|cfg|guidance/i.test(c?.inputName || '')?'0.2':'1',
    count:'4', values:String(c?.value ?? '')};
}
function newAxis(candidate) { return {...candidateDefault(candidate), id:newId(), linkedTo:'', linkedValues:{}}; }
function normalizeAxisIds(axes) {
  const used=new Set();
  for (const axis of axes) {
    if (!axis.id || used.has(axis.id)) axis.id=newId();
    used.add(axis.id);
    if (!axis.linkedValues || typeof axis.linkedValues !== 'object' || Array.isArray(axis.linkedValues)) axis.linkedValues={};
  }
}
function chooseDefault(candidates) {
  return candidates.find(c => /strength_model|lora_strength/i.test(c.inputName))
    || candidates.find(c => /sampler_name|scheduler|cfg/i.test(c.inputName))
    || candidates.find(c => !/seed/i.test(c.inputName)) || candidates[0];
}
function formatValue(value) { return typeof value === 'number' ? String(value) : value; }
function imageURL(image) {
  const query = new URLSearchParams({filename:image.filename, subfolder:image.subfolder || '', type:image.type || 'output'});
  return api.apiURL(`/view?${query.toString()}`);
}
function downloadBlob(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a'); a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2500);
}
function exportJSON(ctx) {
  const payload = {application:'ComfyUI Experiment Studio', version:EXTENSION_VERSION,
    fixed_seed:ctx.fixedSeed, model_cache_mode:ctx.modelCacheMode, seed_mode:ctx.results[0]?.run?.seedMode || 'fixed',
    random_samples:Math.max(1,...ctx.results.map(r=>r.run?.sample || 1)), combination_mode:ctx.mode, axes:ctx.axes,
    results:ctx.results.map(r => ({run:r.run, status:r.status, prompt_id:r.promptId,
      images:r.images || [], selected_image_index:ctx.selectedImageIndices[r.run.number] || 0, error:r.error || null}))};
  downloadBlob(new Blob([JSON.stringify(payload, null, 2)], {type:'application/json'}), 'experiment-studio-results.json');
}
function exportCSV(ctx) {
  const csvCell = v => {
    let s = String(v ?? '');
    if (/^[\s]*[=+@-]/.test(s)) s = `'${s}`;
    return `"${s.replace(/"/g, '""')}"`;
  };
  const rows = [['run','status','seed','parameters','prompt_id','filenames','selected_image_index','error']];
  for (const r of ctx.results) rows.push([r.run.number,r.status,r.run.seed,formatRun(r.run),r.promptId || '',
    (r.images||[]).map(i => `${i.subfolder || ''}/${i.filename}`).join(' | '),ctx.selectedImageIndices[r.run.number] || 0,r.error || '']);
  const csv = '\ufeff' + rows.map(row => row.map(csvCell).join(',')).join('\r\n');
  downloadBlob(new Blob([csv], {type:'text/csv;charset=utf-8'}), 'experiment-studio-results.csv');
}
function fitImage(ctx, image) {
  const aspect = image.width / image.height, boxAspect = ctx.w / ctx.h;
  if (aspect > boxAspect) {
    const w=ctx.w, h=w/aspect; return {x:ctx.x, y:ctx.y+(ctx.h-h)/2, w, h};
  }
  const h=ctx.h, w=h*aspect; return {x:ctx.x+(ctx.w-w)/2, y:ctx.y, w, h};
}
function loadImage(url) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image); image.onerror = () => reject(new Error('Could not load an output image.'));
    image.src = url;
  });
}
async function exportGrid(ctx) {
  const page = getResultsAll(ctx).slice(ctx.page*PAGE_SIZE,(ctx.page+1)*PAGE_SIZE).filter(r => r.status === 'done' && r.images?.length);
  if (!page.length) throw new Error('No successful images on this page.');
  const cols = Math.min(4, page.length), width=440, margin=20, top=96;
  const height=380;
  const measureCanvas=document.createElement('canvas');
  const measureCtx=measureCanvas.getContext('2d');
  if(!measureCtx) throw new Error('Canvas is unavailable.');
  measureCtx.font='13px system-ui';
  const labels=page.map(entry=>formatRun(entry.run));
  const layout=getExportLayout(labels, {columns:cols,tileWidth:width,imageHeight:height,maxChars:ctx.exportChars,
    measure:text=>measureCtx.measureText(text).width});
  const canvas=document.createElement('canvas');
  canvas.width=cols*width+margin*2;canvas.height=layout.contentHeight+top+margin;
  const g=canvas.getContext('2d');
  if(!g) throw new Error('Canvas is unavailable.');
  g.fillStyle='#11151b';g.fillRect(0,0,canvas.width,canvas.height);
  g.fillStyle='#f5f7fa';g.font='bold 27px system-ui';g.fillText('EXPERIMENT STUDIO',margin,39);
  g.fillStyle='#a3aebd';g.font='14px system-ui';
  const seeds=new Set(ctx.results.filter(r=>r.run).map(r=>r.run.seed));
  g.fillText(`${seeds.size>1?'Variable seeds':'Seed '+(page[0]?.run.seed??ctx.fixedSeed)}   •   ${ctx.mode.toUpperCase()}   •   Page ${ctx.page+1}`,margin,67);
  for(let i=0;i<page.length;i++) {
    const entry=page[i], col=i%cols,row=Math.floor(i/cols);
    const x=margin+col*width,y=top+layout.rowY[row];
    const tileHeight=layout.rows[row];
    g.fillStyle='#1e2530';g.fillRect(x,y,width-12,tileHeight-12);
    g.fillStyle='#f5f7fa';g.font='bold 16px system-ui';
    g.fillText(`RUN ${String(entry.run.number).padStart(3,'0')}`,x+14,y+28);
    const chosen=getSelectedImage(entry,ctx.selectedImageIndices[entry.run.number]||0);
    const image=await loadImage(imageURL(chosen.image));
    g.fillStyle='#0b0d12';g.fillRect(x+12,y+40,width-36,height);
    const fitted=fitImage({x:x+12,y:y+40,w:width-36,h:height},image);
    g.drawImage(image,fitted.x,fitted.y,fitted.w,fitted.h);
    g.fillStyle='#e6ebf3';g.font='13px system-ui';
    const lines=layout.lines[i];
    lines.forEach((line,n)=>g.fillText(line,x+14,y+height+64+n*19));
    g.fillStyle='#9facbf';g.font='12px system-ui';
    const seedY=y+height+64+lines.length*19+17;
    g.fillText(`Seed ${entry.run.seed}${chosen.count>1?`   ·   Image ${chosen.index+1}/${chosen.count}`:''}`,x+14,seedY);
  }
  const blob=await new Promise((resolve,reject)=>canvas.toBlob(v=>v?resolve(v):reject(new Error('PNG export failed.')),'image/png'));
  downloadBlob(blob,`experiment-studio-grid-${ctx.page+1}.png`);
}

function element(tag, props={}) { const e=document.createElement(tag); Object.assign(e,props); return e; }
function notice(ctx, message, type='info') { ctx.notice={message,type}; render(ctx); }

function makeSession(node) {
  node.properties ||= {};
  if (!node.properties.studioId) node.properties.studioId = newId();
  const config=node.properties.experimentSettings || {};
  const ctx={node, root:null, candidates:[], axes:Array.isArray(config.axes)?jsonClone(config.axes):[],
    fixedSeed:String(config.fixedSeed ?? '123456789'), seedMode:config.seedMode==='random'?'random':'fixed',
    randomSamples:String(config.randomSamples ?? '1'), mode:config.mode || 'cross',
    presetSync:config.presetSync !== false, presetInspection:null, previewEnabled:config.previewEnabled !== false, previewFrequency:config.previewFrequency==='reduced'?'reduced':'normal',
    exportChars:clampExportChars(config.exportChars ?? 40), modelCacheMode:config.modelCacheMode==='unload'?'unload':'auto',
    results:[], selectedImageIndices:{}, page:0, status:'idle', notice:null, count:0, total:0,
    currentRun:0, lastError:'', stopRequested:false, pauseRequested:false,
    enumValues:new Map(), modalTab:'setup', sessionPrefix:'',
    working:false, preparing:false, loadingDefs:false, lightboxIndex:null, captureId:String(node.id),
    followLive:true, browseRunNumber:null, browseImageIndex:0,
    activePromptId:null, activeRunIndex:-1, runStart:0, experimentStart:0,
    durations:[], liveStep:0, liveMax:0, liveNode:'', livePhase:'idle',
    livePreviewURL:null, lastPreviewAt:0, liveTimers:null, liveListeners:[],
    liveReceiving:false, liveConfirmed:false, previewFrames:0, lastPreviewBlob:null, samplingStart:0,
    confirmResetAxes:false, advancedOpen:false};
  const stored=savedState(ctx);
  ctx.results=stored.results || []; ctx.sessionPrefix=stored.sessionPrefix || '';
  ctx.selectedImageIndices=stored.selectedImageIndices || {};
  return ctx;
}

async function snapshotWorkflow(ctx) {
  const {workflow,output}=await app.graphToPrompt();
  const capture = output[String(ctx.node.id)];
  if (!capture || capture.class_type !== CAPTURE_TYPE) {
    throw new Error('Connect an IMAGE to Experiment Studio and enable this output node before running.');
  }
  ctx.apiPrompt=output; ctx.workflow=workflow; ctx.presetInspection=null;
  ctx.candidates=getCandidates(output,ctx.node.id);
  if (!ctx.candidates.length) throw new Error('No editable widget parameters found in this workflow.');
  if (!ctx.axes.length) ctx.axes=[newAxis(chooseDefault(ctx.candidates))];
  const keys=new Set(ctx.candidates.map(c=>c.key));
  ctx.axes=ctx.axes.filter(a=>keys.has(a.key));
  if (!ctx.axes.length) ctx.axes=[newAxis(chooseDefault(ctx.candidates))];
  normalizeAxisIds(ctx.axes);
  ctx.captureId=String(ctx.node.id);
  ctx.seedTargets=getSeedTargets(output);
  persist(ctx);
}
function availableOptionsForAxis(ctx, axis) {
  const c=ctx.candidates.find(item=>item.key===axis.key);
  return c ? (ctx.enumValues.get(c.key) || []) : [];
}
async function getEnumOptions(ctx, candidate) {
  if (!candidate?.classType || ctx.enumValues.has(candidate.key)) return;
  try {
    const response=await api.fetchApi(`/object_info/${encodeURIComponent(candidate.classType)}`);
    if (!response.ok) return;
    const data=await response.json();
    const definition=data[candidate.classType] || data;
    const input=definition.input?.required?.[candidate.inputName] || definition.input?.optional?.[candidate.inputName];
    const choices=Array.isArray(input?.[0]) ? input[0].filter(v=>typeof v==='string') : [];
    ctx.enumValues.set(candidate.key,choices);
    render(ctx);
  } catch (_error) { /* optional suggestions */ }
}

function linkedParentValues(ctx, parent) {
  try {
    const independent=ctx.axes.filter(a=>!a.linkedTo);
    const group=prepareAxes(ctx.apiPrompt,ctx.captureId,independent)
      .find(p=>p.candidate.key===parent.key);
    return group?.values || [];
  } catch (_error) { return []; }
}
function ruleFor(axis, key) {
  return axis.linkedValues?.[parentValueKey(key)] || {mode:'keep',values:''};
}
function buildLinkedRows(ctx, axis, idx, candidate, enumOptions) {
  const parent=ctx.axes.find(a=>a.id===axis.linkedTo);
  if (!parent) return '<p class="ves-validation">Parent axis not found. Choose a valid independent axis.</p>';
  const values=linkedParentValues(ctx,parent);
  if (!values.length) return '<p class="ves-validation">Enter valid values in the parent axis first.</p>';
  const disable=canDisableLora(ctx.apiPrompt,candidate);
  const suggested=enumOptions.map(v=>`<option value="${esc(v)}">${esc(v)}</option>`).join('');
  const rows=values.map((parentValue, r) => {
    const key=parentValueKey(parentValue);
    const rule=ruleFor(axis,key);
    const choice=['keep','value','disable'].includes(rule.mode) ? rule.mode : 'keep';
    return `<div class="ves-linked-row">
      <div class="ves-linked-parent"><span class="ves-linked-index">${r+1}</span><span title="${esc(key)}">${esc(key)}</span></div>
      <div class="ves-linked-control">
        <select class="ves-select" data-rule-mode="${idx}" data-parent-value="${esc(key)}">
          <option value="keep" ${choice==='keep'?'selected':''}>Keep original</option>
          <option value="value" ${choice==='value'?'selected':''}>Set value(s)</option>
          ${disable?`<option value="disable" ${choice==='disable'?'selected':''}>Disable LoRA (0 strength)</option>`:''}
        </select>
        ${choice==='value'?`<textarea class="ves-textarea ves-linked-value" rows="2" data-rule-values="${idx}" data-parent-value="${esc(key)}" placeholder="One or more values, separated by commas or lines">${esc(rule.values ?? '')}</textarea>
        ${enumOptions.length?`<select class="ves-select" data-rule-enum="${idx}" data-parent-value="${esc(key)}"><option value="">Add available value...</option>${suggested}</select>`:''}`:''}
      </div>
    </div>`;
  }).join('');
  return `<div class="ves-linked-settings"><div class="ves-linked-heading"><strong>Parent choice</strong><strong>Dependent setting</strong></div>${rows}
    <small class="ves-axis-hint">Keep original preserves the workflow's current value (it does not turn off an active LoRA). ${disable?'Disable LoRA sets the native loader strengths to zero for that run.':''} Set value(s) may contain several alternatives.</small></div>`;
}
function buildAxes(ctx) {
  return ctx.axes.map((axis,idx)=> {
    const c=ctx.candidates.find(x=>x.key===axis.key);
    const opts=ctx.candidates.map(x =>
      `<option value="${esc(x.key)}" ${x.key===axis.key?'selected':''}>${esc(x.label)}</option>`).join('');
    const enumOptions=availableOptionsForAxis(ctx,axis);
    const possibleParents=ctx.axes.slice(0,idx).filter(a=>!a.linkedTo && a.key!==axis.key);
    const parentOptions=possibleParents.map(p=>`<option value="${esc(p.id)}" ${axis.linkedTo===p.id?'selected':''}>Nested under Axis ${ctx.axes.indexOf(p)+1} (${esc(ctx.candidates.find(c=>c.key===p.key)?.inputName || p.key)})</option>`).join('');
    const linked=!!axis.linkedTo;
    return `<section class="ves-axis ${linked?'ves-axis-nested':''}" data-index="${idx}">
      <div class="ves-axis-top"><strong>Axis ${idx+1}${linked?' · Nested':''}</strong><button type="button" class="ves-icon-btn" data-action="remove-axis" data-index="${idx}" title="Remove axis" ${ctx.axes.length===1?'disabled':''}>×</button></div>
      <label class="ves-label">Node / input</label><select class="ves-select" data-axis="${idx}" data-field="key">${opts}</select>
      ${idx?`<div><label class="ves-label">Relationship</label><select class="ves-select" data-axis="${idx}" data-field="linkedTo"><option value="" ${!linked?'selected':''}>Independent (cross / pair)</option>${parentOptions}</select></div>`:''}
      ${linked ? buildLinkedRows(ctx,axis,idx,c,enumOptions) : `
        <div class="ves-two"><div><label class="ves-label">Values</label><select class="ves-select" data-axis="${idx}" data-field="mode">
          ${c?.kind==='number'?`<option value="range" ${axis.mode==='range'?'selected':''}>Increment / decrement</option>`:''}
          <option value="list" ${axis.mode==='list'?'selected':''}>Custom list</option></select></div>
          <div><label class="ves-label">Current value</label><div class="ves-readout">${esc(formatValue(c?.value ?? '—'))}</div></div></div>
        ${axis.mode==='range' && c?.kind==='number'?`<div class="ves-three">
          <div><label class="ves-label">Start</label><input class="ves-input" type="number" step="any" data-axis="${idx}" data-field="start" value="${esc(axis.start)}"></div>
          <div><label class="ves-label">Step (+/−)</label><input class="ves-input" type="number" step="any" data-axis="${idx}" data-field="step" value="${esc(axis.step)}"></div>
          <div><label class="ves-label">Count</label><input class="ves-input" type="number" min="1" max="96" data-axis="${idx}" data-field="count" value="${esc(axis.count)}"></div>
        </div>`:`<div><label class="ves-label">Values separated by commas or new lines</label><textarea class="ves-textarea" rows="2" data-axis="${idx}" data-field="values" placeholder="euler, dpmpp_2m">${esc(axis.values)}</textarea></div>`}
        ${enumOptions.length?`<div class="ves-enum"><select class="ves-select" data-enum="${idx}" ${ctx.working?'disabled':''}><option value="">Select option to add (${enumOptions.length})</option>${enumOptions.map(v=>`<option value="${esc(v)}">${esc(v)}</option>`).join('')}</select></div><small class="ves-axis-hint">Selecting a file adds it to the values above. You can also edit the list manually.</small>`:''}`}
    </section>`;
  }).join('');
}

function countCompleted(ctx) {return ctx.results.filter(entry=>entry.status==='done').length;}
function lastCompleted(ctx) {return [...ctx.results].reverse().find(entry=>entry.status==='done'&&entry.images?.length);}
function getEta(ctx) {
  const done=countCompleted(ctx);
  if(!ctx.total || done===ctx.total) return '00:00:00';
  const estimate=remainingMs(ctx.durations,ctx.total-done);
  if(estimate===null) return 'Estimating…';
  const active=ctx.working && ctx.runStart>0 ? Math.max(0,Date.now()-ctx.runStart) : 0;
  return duration(Math.max(0,estimate-active));
}
function renderMonitor(ctx) {
  const done=countCompleted(ctx),overall=percent(done,ctx.total);
  const stepPercent=percent(ctx.liveStep,ctx.liveMax);
  const current=ctx.results[ctx.activeRunIndex] || ctx.results.find(r=>r.status==='running');
  const isActive=ctx.working && ctx.activeRunIndex>=0;
  const frames=listBrowserFrames(ctx);
  const browsed=browserState(ctx,frames);
  const following=ctx.followLive!==false;
  const showLive=following && isActive;
  // The user may browse older completed results while a sampler is still running.
  // In that case new live frames must not overwrite the selected finished image.
  const displayed=following ? frames[frames.length-1] : browsed.item;
  const preview=showLive ? (ctx.previewEnabled?ctx.livePreviewURL:null) : displayed?imageURL(displayed.image):null;
  const fallback=showLive?previewHint(ctx,true):'Completed images will appear here.';
  const elapsed=ctx.experimentStart ? duration(Date.now()-ctx.experimentStart) : '00:00:00';
  const counter=showLive ? `${frames.length} saved image${frames.length===1?'':'s'} · Live run ${ctx.currentRun}` :
    displayed ? `Image ${following?frames.length:browsed.index+1} / ${frames.length} · Run #${displayed.runNumber} · ${displayed.imageIndex+1}/${displayed.entry.images.length}` : 'No saved images';
  const selectedInfo=showLive?`Current generation · ${current?formatRun(current.run):'Waiting for run'}`:
    displayed?`Run #${displayed.runNumber} · ${formatRun(displayed.entry.run)} · Seed ${displayed.entry.run.seed}`:'No completed result';
  return `<section class="ves-monitor"><div class="ves-monitor-heading"><div><h3>Execution monitor</h3><span data-live-phase>${esc(isActive?ctx.livePhase:ctx.status)}</span></div><div class="ves-monitor-settings"><label><input type="checkbox" data-live-toggle ${ctx.previewEnabled?'checked':''}> Live preview</label><select class="ves-select" data-live-frequency><option value="normal" ${ctx.previewFrequency==='normal'?'selected':''}>Normal</option><option value="reduced" ${ctx.previewFrequency==='reduced'?'selected':''}>Reduced</option></select></div></div>
    <div class="ves-monitor-grid"><div class="ves-monitor-viewer"><div class="ves-monitor-preview" ${displayed&&!showLive?`data-browser-open="true" title="Open full-resolution viewer"`:''}>
      <img data-monitor-preview-img ${showLive?'data-live-preview-img':''} src="${esc(preview||'')}" alt="${showLive?'Current sampler preview':'Completed experiment result'}" ${preview?'':'hidden'}>
      <div class="ves-monitor-placeholder" ${showLive?'data-live-empty':''} ${preview?'hidden':''}><span class="ves-monitor-icon">◈</span><small data-preview-hint>${esc(fallback)}</small></div>
      <span class="ves-monitor-indicator">${showLive?'LIVE':!following?'BROWSING':'LAST RESULT'}</span>
    </div>
    ${frames.length?`<div class="ves-monitor-navigator"><button type="button" data-browser-step="-1" aria-label="Previous experiment image" title="Previous image (←)">‹</button><div><b>${esc(counter)}</b><small>${esc(selectedInfo)}</small></div><button type="button" data-browser-step="1" aria-label="Next experiment image" title="Next image (→)">›</button></div>
      ${!following?`<button type="button" class="ves-browser-follow" data-action="follow-live">${isActive?'↻ Return to Live':'↻ Show latest result'}</button>`:''}`:''}
    </div><div class="ves-monitor-details">
      <div class="ves-monitor-row"><b>Overall progress</b><strong data-live-overall>${done} / ${ctx.total||'?'} runs · ${overall}%</strong></div>
      <div class="ves-monitor-track"><i data-live-overall-bar style="width:${overall}%"></i></div>
      <div class="ves-monitor-row"><b>Current sampler</b><strong data-live-step>${ctx.liveMax?`Step ${ctx.liveStep} / ${ctx.liveMax}`:isActive?'Waiting for sampler…':'—'}</strong></div>
      <div class="ves-monitor-track ves-monitor-step"><i data-live-step-bar style="width:${stepPercent}%"></i></div>
      <div class="ves-monitor-stats"><div><small>Elapsed</small><b data-live-elapsed>${elapsed}</b></div><div><small>Remaining (est.)</small><b data-live-eta>${getEta(ctx)}</b></div><div><small>Current run</small><b data-live-run>${isActive?`${ctx.currentRun}/${ctx.total}`:'—'}</b></div></div>
      <div class="ves-monitor-config"><small>Current configuration</small><div data-live-config>${current?esc(`${formatRun(current.run)} · Seed ${current.run.seed}`):'No active run'}</div></div>
      <div class="ves-monitor-node" data-live-node>${esc(ctx.liveNode?'Node '+ctx.liveNode:'')}</div>
      <div class="ves-monitor-node" data-live-diagnostic>${esc(previewDiagnostic(ctx))}</div>
    </div></div>
  </section>`;
}
function previewHint(ctx,isActive) {
  if(!ctx.previewEnabled) return 'Live preview disabled';
  if(!isActive) return 'The latest completed image will appear here.';
  if(ctx.previewFrames>0) return 'Preview received';
  if(ctx.samplingStart && Date.now()-ctx.samplingStart>5000)
    return 'No frames received. Check ComfyUI preview settings (Auto or Latent2RGB).';
  return 'Waiting for sampler preview…';
}
function previewDiagnostic(ctx) {
  if(!ctx.previewEnabled) return 'Preview stream: disabled';
  if(ctx.previewFrames) return `Preview stream: ${ctx.previewFrames} frame${ctx.previewFrames===1?'':'s'} received`;
  if(ctx.working && ctx.samplingStart && Date.now()-ctx.samplingStart>5000)
    return 'No preview frames yet — check ComfyUI Settings > Execution > Preview Method and --preview-method.';
  return ctx.working?'Preview stream: waiting for frames':'Preview stream: idle';
}
function setText(ctx,selector,value) {ctx.root?.querySelectorAll?.(selector)?.forEach(el=>{el.textContent=String(value);});}
function refreshLiveUI(ctx) {
  if (!ctx.root?.isConnected) return;
  const done=countCompleted(ctx);
  setText(ctx,'[data-live-overall]',`${done} / ${ctx.total||'?'} runs · ${percent(done,ctx.total)}%`);
  setText(ctx,'[data-live-step]',ctx.liveMax?`Step ${ctx.liveStep} / ${ctx.liveMax}`:ctx.working?'Waiting for sampler…':'—');
  setText(ctx,'[data-live-phase]',ctx.livePhase);
  setText(ctx,'[data-live-diagnostic]',previewDiagnostic(ctx));
  for(const el of ctx.root.querySelectorAll?.('[data-live-empty] small')||[]) el.textContent=previewHint(ctx,ctx.working);
  setText(ctx,'[data-live-node]',ctx.liveNode?'Node '+ctx.liveNode:'');
  setText(ctx,'[data-live-elapsed]',ctx.experimentStart?duration(Date.now()-ctx.experimentStart):'00:00:00');
  setText(ctx,'[data-live-eta]',getEta(ctx));
  setText(ctx,'[data-live-run]',ctx.working?`${ctx.currentRun}/${ctx.total}`:'—');
  const active=ctx.results[ctx.activeRunIndex];
  setText(ctx,'[data-live-config]',active?`${formatRun(active.run)} · Seed ${active.run.seed}`:'No active run');
  for(const el of ctx.root.querySelectorAll?.('[data-live-overall-bar]')||[]) el.style.width=`${percent(done,ctx.total)}%`;
  for(const el of ctx.root.querySelectorAll?.('[data-live-step-bar]')||[]) el.style.width=`${percent(ctx.liveStep,ctx.liveMax)}%`;
  const preview=ctx.previewEnabled&&ctx.working ? ctx.livePreviewURL : null;
  for(const el of ctx.root.querySelectorAll?.('[data-live-preview-img]')||[]) {
    if(preview){if(el.src!==preview)el.src=preview;el.hidden=false;} else el.hidden=true;
  }
  for(const el of ctx.root.querySelectorAll?.('[data-live-empty]')||[]) el.hidden=!!preview;
}
function clearLivePreview(ctx) {
  if(ctx.livePreviewURL && typeof URL.revokeObjectURL==='function') URL.revokeObjectURL(ctx.livePreviewURL);
  ctx.livePreviewURL=null;ctx.lastPreviewAt=0;
}
function acceptPreview(ctx,event,source='legacy') {
  if(!ctx.working || !ctx.activePromptId || !ctx.previewEnabled) return;
  const payload=event?.detail;
  const data=payload?.blob||payload?.image||payload?.data||payload;
  if(typeof Blob==='undefined'||!(data instanceof Blob)) return;

  // Modern ComfyUI sends {blob,jobId,nodeId,displayNodeId} first, then the
  // same blob again through the compatibility b_preview event. Only accept
  // explicit ownership from jobId. The duplicate legacy event must be ignored.
  const owner=payload?.jobId ?? payload?.prompt_id ?? payload?.metadata?.prompt_id ?? payload?.meta?.prompt_id;
  if(source==='metadata') ctx.lastPreviewBlob=data;
  if(source==='legacy' && ctx.lastPreviewBlob===data) return;
  if(owner != null && String(owner)!==String(ctx.activePromptId)) return;
  // Legacy binary frames have no prompt ID; only use them when this job has
  // actually started (not while queued behind another user's work).
  if(owner == null && (!ctx.liveConfirmed || !ctx.liveReceiving)) return;
  const elapsed=Date.now()-ctx.lastPreviewAt;
  if(elapsed<(ctx.previewFrequency==='reduced'?1000:150)) return;
  const next=URL.createObjectURL(data);
  const previous=ctx.livePreviewURL;ctx.livePreviewURL=next;
  ctx.lastPreviewAt=Date.now();ctx.previewFrames++;
  ctx.liveReceiving=true;ctx.liveConfirmed=true;
  if(!ctx.samplingStart)ctx.samplingStart=Date.now();
  if(ctx.livePhase==='Queued')ctx.livePhase='Sampling';
  refreshLiveUI(ctx);
  if(previous) URL.revokeObjectURL(previous);
}
function attachLiveEvents(ctx) {
  if(ctx.liveListeners?.length) return;
  const types=['execution_start','executing','progress','progress_state','execution_error','execution_interrupted','execution_success'];
  for(const type of types) {
    const cb=event=>{
      if(!ctx.working || !ctx.activePromptId) return;
      const data=event?.detail;
      const explicitId=data && typeof data==='object' ? data.prompt_id ?? data.jobId : null;
      if(explicitId!=null && String(explicitId)!==String(ctx.activePromptId)) return;
      // The frontend dispatches executing as a node ID string/null, not the
      // original {prompt_id,node} JSON payload. Untagged progress can also
      // occur in older backends, but only after we saw our own start event.
      if(explicitId==null && !ctx.liveConfirmed) return;
      if(type==='execution_start') {
        if(explicitId==null) return;
        ctx.liveConfirmed=true;ctx.liveReceiving=true;ctx.livePhase='Running';
      } else if(type==='executing') {
        const node=typeof data==='object' && data!==null ? (data.display_node??data.node) : data;
        if(node==null) {ctx.livePhase='Saving results';ctx.liveReceiving=false;}
        else {ctx.liveNode=String(node);ctx.livePhase='Running';ctx.liveReceiving=true;ctx.liveStep=0;ctx.liveMax=0;}
      } else if(type==='progress') {
        ctx.liveConfirmed=true;ctx.liveStep=Number(data?.value)||0;ctx.liveMax=Number(data?.max)||0;
        ctx.liveNode=String(data?.node??ctx.liveNode);ctx.livePhase='Sampling';ctx.liveReceiving=true;
        if(!ctx.samplingStart) ctx.samplingStart=Date.now();
      } else if(type==='progress_state') {
        // Newer frontend versions emit per-node progress_state with prompt ID.
        const nodes=data?.nodes||{};
        const active=Object.entries(nodes).find(([,n])=>n?.state==='running'&&Number(n.max)>0);
        if(active) {
          const [nodeId,n]=active;ctx.liveConfirmed=true;ctx.liveReceiving=true;
          ctx.liveNode=String(n.display_node_id??n.node_id??nodeId);
          ctx.liveStep=Number(n.value)||0;ctx.liveMax=Number(n.max)||0;
          ctx.livePhase='Sampling';if(!ctx.samplingStart)ctx.samplingStart=Date.now();
        }
      } else if(type==='execution_error') {ctx.livePhase='Generation failed';ctx.liveReceiving=false;}
      else if(type==='execution_interrupted') {ctx.livePhase='Interrupted';ctx.liveReceiving=false;}
      else if(type==='execution_success') {ctx.livePhase='Finishing';ctx.liveReceiving=false;}
      refreshLiveUI(ctx);
    };
    api.addEventListener?.(type,cb);ctx.liveListeners.push([type,cb]);
  }
  for(const type of ['b_preview_with_metadata','b_preview']) {
    const cb=event=>acceptPreview(ctx,event,type==='b_preview_with_metadata'?'metadata':'legacy');
    api.addEventListener?.(type,cb);ctx.liveListeners.push([type,cb]);
  }
  if(!ctx.liveTimers) ctx.liveTimers=setInterval(()=>refreshLiveUI(ctx),1000);
}
function detachLiveEvents(ctx) {
  for(const [name,cb] of ctx.liveListeners||[]) api.removeEventListener?.(name,cb);
  ctx.liveListeners=[];
  if(ctx.liveTimers) clearInterval(ctx.liveTimers);
  ctx.liveTimers=null;
  ctx.activePromptId=null;ctx.liveReceiving=false;ctx.liveConfirmed=false;
}

function renderGallery(ctx) {
  const completed=ctx.results.filter(r=>r.status==='done' && r.images?.length);
  const other=ctx.results.filter(r=>r.status!=='done');
  const all=[...completed,...other];
  const pages=Math.max(1,Math.ceil(all.length/PAGE_SIZE));
  ctx.page=Math.min(ctx.page,pages-1);
  const shown=all.slice(ctx.page*PAGE_SIZE,(ctx.page+1)*PAGE_SIZE);
  const content=shown.map((r,index)=>{
    const chosen=getSelectedImage(r,ctx.selectedImageIndices[r.run.number] || 0);
    const img=chosen.image;
    return `<article class="ves-result"><div class="ves-result-media" ${img?`data-open-image="${ctx.page*PAGE_SIZE+index}"`:''}>
      ${img?`<img loading="lazy" src="${esc(imageURL(img))}" alt="Run ${r.run.number}, image ${chosen.index+1} of ${chosen.count}">`:
      r.status==='running'?`<img class="ves-live-result" data-live-preview-img src="${esc(ctx.livePreviewURL||'')}" alt="Live KSampler preview" ${ctx.livePreviewURL?'':'hidden'}><div class="ves-noimage" data-live-empty ${ctx.livePreviewURL?'hidden':''}>Waiting for preview…</div>`:
      `<div class="ves-noimage">${esc(r.status)}</div>`}
      <span class="ves-run-label">#${String(r.run.number).padStart(3,'0')}</span>
      ${chosen.count>1?`<span class="ves-image-count">${chosen.index+1} / ${chosen.count}</span><div class="ves-image-stepper"><button type="button" data-image-step="-1" data-run-index="${ctx.page*PAGE_SIZE+index}" title="Previous image">‹</button><button type="button" data-image-step="1" data-run-index="${ctx.page*PAGE_SIZE+index}" title="Next image">›</button></div>`:''}</div>
      <div class="ves-result-meta"><strong>${esc(formatRun(r.run))}</strong><small>Seed ${r.run.seed} ${r.images?.length>1?`· ${r.images.length} images`:''}</small>
      ${r.error?`<small class="ves-error-text">${esc(r.error)}</small>`:''}</div></article>`;
  }).join('');
  return `<section class="ves-gallery-head"><div><h3>Results</h3><span>${completed.length} completed · ${ctx.results.length} recorded</span></div>
    <div class="ves-actions"><label class="ves-export-label" title="Maximum characters on each PNG caption line">PNG chars / line <select class="ves-select" data-config="exportChars"><option value="28" ${ctx.exportChars===28?'selected':''}>28</option><option value="36" ${ctx.exportChars===36?'selected':''}>36</option><option value="40" ${ctx.exportChars===40?'selected':''}>40</option><option value="48" ${ctx.exportChars===48?'selected':''}>48</option><option value="56" ${ctx.exportChars===56?'selected':''}>56</option></select></label><button type="button" class="ves-btn" data-action="export-grid" ${shown.some(x=>x.status==='done')?'':'disabled'}>Export selected PNG</button>
    <button type="button" class="ves-btn" data-action="export-json" ${ctx.results.length?'':'disabled'}>JSON</button>
    <button type="button" class="ves-btn" data-action="export-csv" ${ctx.results.length?'':'disabled'}>CSV</button></div></section>
    ${ctx.total||all.length?renderMonitor(ctx):''}
    ${all.length?`<div class="ves-gallery">${content}</div><nav class="ves-pages"><button class="ves-btn small" data-action="prev-page" ${ctx.page===0?'disabled':''}>‹ Previous</button><span>Page ${ctx.page+1} / ${pages}</span><button class="ves-btn small" data-action="next-page" ${ctx.page>=pages-1?'disabled':''}>Next ›</button></nav>`:
    '<div class="ves-empty"><strong>No results yet</strong><p>Configure an experiment and start generating. Results will appear here automatically.</p></div>'}`;
}
function renderSetup(ctx) {
  let preview='', count=0, error='';
  if (ctx.apiPrompt) {
    try {
      const p=buildPlan(ctx.apiPrompt,ctx.captureId,ctx.axes,ctx.mode,ctx.fixedSeed);
      const planned=planWithSeedStrategy(p.plan,{seedMode:ctx.seedMode,randomSamples:ctx.randomSamples,
        preview:true,hasSeedAxis:ctx.axes.some(a=>a.key===SEED_AXIS_KEY),seedTargets:ctx.seedTargets?.length ?? 0});
      count=planned.length;
      preview=planned.slice(0,5).map(run=>`<div><b>#${String(run.number).padStart(3,'0')}</b><span>${esc(formatRun(run))} · Seed ${run.seed===null?'RANDOM':run.seed}</span></div>`).join('');
    } catch(e) { error=e.message; }
  }
  const locked=ctx.working || ctx.preparing;
  return `<div class="ves-layout"><div class="ves-config">
    <h3>Configuration <span class="ves-tag">v1.1.0</span></h3>
    <div class="ves-two ves-fields"><div><label class="ves-label">Seed mode</label><select class="ves-select" data-config="seedMode" ${locked?'disabled':''}>
      <option value="fixed" ${ctx.seedMode==='fixed'?'selected':''}>Fixed / Seed axis</option>
      <option value="random" ${ctx.seedMode==='random'?'selected':''}>Random per run</option></select></div>
    <div><label class="ves-label">Combination mode</label><select class="ves-select" data-config="mode" ${locked?'disabled':''}>
      <option value="cross" ${ctx.mode==='cross'?'selected':''}>Cross all combinations</option><option value="pair" ${ctx.mode==='pair'?'selected':''}>Pair by position</option></select></div></div>
    <div class="ves-seed-control"><div class="ves-two"><div><label class="ves-label">Default seed</label><input class="ves-input" type="text" inputmode="numeric" data-config="fixedSeed" value="${esc(ctx.fixedSeed)}" ${locked||ctx.seedMode==='random'?'disabled':''}></div>
      ${ctx.seedMode==='random'?`<div><label class="ves-label">Samples per configuration</label><input class="ves-input" type="number" min="1" max="96" step="1" data-config="randomSamples" value="${esc(ctx.randomSamples)}" ${locked?'disabled':''}></div>`:
      `<div class="ves-seed-explain">The same seed is reused for each configuration, unless you add a Seed axis to vary it manually.</div>`}</div>
      <small class="ves-axis-hint">${ctx.seedMode==='random'?'Every run gets its own unique random seed. Values are drawn once on Start and saved with the results for reproducibility. Do not add a Seed axis in this mode.':'Use a Seed axis for a custom list or stepped seed sequence. Random mode can instead create repeated samples automatically.'}</small></div>
    <section class="ves-advanced">
      <button type="button" class="ves-advanced-toggle" data-action="toggle-advanced" aria-controls="ves-advanced-options" aria-expanded="${ctx.advancedOpen?'true':'false'}">
        <span class="ves-advanced-title"><span class="ves-advanced-chevron" aria-hidden="true">▸</span> Advanced settings</span>
        <span class="ves-advanced-caption">${ctx.advancedOpen?'Hide options':'Show options'}</span>
      </button>
      ${ctx.advancedOpen?`<div id="ves-advanced-options" class="ves-advanced-body">
    <div class="ves-monitor-settings ves-setup-settings"><label><input type="checkbox" data-preset-sync ${ctx.presetSync?'checked':''}> Auto-sync preset/profile dependent widgets</label>
      <small class="ves-axis-hint">Captures synchronous widget callbacks, then restores your workflow. Inspect before starting if presets also update steps, CFG or other fields. Third-party callbacks with delayed or external side effects are not guaranteed.</small></div>
    <div class="ves-monitor-settings ves-setup-settings"><label><input type="checkbox" data-live-toggle ${ctx.previewEnabled?'checked':''}> Enable live previews during generation</label>
      <label>Update frequency <select class="ves-select" data-live-frequency><option value="normal" ${ctx.previewFrequency==='normal'?'selected':''}>Normal</option><option value="reduced" ${ctx.previewFrequency==='reduced'?'selected':''}>Reduced</option></select></label></div>
    <div class="ves-monitor-settings ves-setup-settings ves-cache-settings">
      <label for="ves-model-cache">Model cache management</label>
      <select id="ves-model-cache" class="ves-select" data-config="modelCacheMode" ${locked?'disabled':''}>
        <option value="auto" ${ctx.modelCacheMode==='auto'?'selected':''}>Auto (ComfyUI managed)</option>
        <option value="unload" ${ctx.modelCacheMode==='unload'?'selected':''}>Unload on model change</option>
      </select>
      <small class="ves-axis-hint">Unload requests ComfyUI to release loaded models only when an identifiable UNET/checkpoint filename changes between runs. It affects all loaded models, not just the previous UNET; it does not clear execution results. The next run may take longer. Runs are queued only after the unload request and a short settling period.</small>
    </div>
      </div>`:''}
    </section>
    <div class="ves-axis-list">${buildAxes(ctx)}</div>
    <div class="ves-axis-toolbar"><button type="button" class="ves-btn ves-add-axis" data-action="add-axis" ${ctx.axes.length>=MAX_AXES||locked?'disabled':''}>+ Add axis</button>
    ${ctx.confirmResetAxes?`<button type="button" class="ves-btn ves-reset-axes ves-reset-confirm" data-action="reset-axes" ${locked?'disabled':''}>Confirm reset</button><button type="button" class="ves-btn ves-reset-axes" data-action="cancel-reset-axes">Cancel</button>`:`<button type="button" class="ves-btn ves-reset-axes" data-action="reset-axes" ${locked||!ctx.candidates.length?'disabled':''} title="Restore one default axis without changing seeds or results">Reset Axes</button>`}</div>
    <p class="ves-axis-cap">${ctx.axes.length} / ${MAX_AXES} axes · Maximum 96 planned generations</p>
    <p class="ves-hint">Fixed mode preserves the previous behavior: the seed stays fixed, or a Seed axis can override it. Random mode draws a unique seed per run and optionally repeats each configuration. Repeated independent axes merge their alternatives, and Nested Axes still restrict child values to the selected parent. Connected widget inputs cannot be changed directly.</p>
  </div><div class="ves-preview"><h3>Experiment preview</h3>
    <div class="ves-stat"><span>Planned generations</span><strong>${error?'—':count}</strong></div>
    <div class="ves-stat"><span>Seed targets</span><strong>${ctx.seedTargets?.length ?? 0}</strong></div>
    <div class="ves-stat"><span>Selected axes</span><strong>${ctx.axes.length}</strong></div>
    ${error?`<p class="ves-validation">${esc(error)}</p>`:`<div class="ves-plan">${preview}</div>${count>5?`<small>…and ${count-5} more combinations</small>`:''}`}
    ${ctx.presetInspection?`<div class="ves-inspect-results"><strong>Preset effects</strong>${ctx.presetInspection.reports.map(r=>`<div class="ves-inspect-row">${esc(r.setting.inputName)}=${esc(r.setting.value)} ${r.changes.length?`→ ${esc(r.changes.map(c=>c.inputName+'='+c.value).join(' · '))}`:r.warning?`· ${esc(r.warning)}`:'· no dependent widget changes'}</div>`).join('')}</div>`:''}
    <div class="ves-cta"><button type="button" class="ves-btn primary" data-action="run" ${error||locked?'disabled':''}>▶ Start experiment</button>
    <button type="button" class="ves-btn" data-action="inspect-presets" ${error||locked||!ctx.presetSync?'disabled':''}>Inspect preset effects</button>
    <button type="button" class="ves-btn" data-action="refresh" ${locked?'disabled':''}>↻ Refresh workflow</button></div>
    <div class="ves-tip"><b>TIP</b> Select Random per run with 4 samples to test the same configuration with four different seeds. To compare models with exactly the same seed, select Fixed. A single pipeline must be connected to this node.</div>
  </div></div>`;
}
function render(ctx) {
  if (!ctx.root || !ctx.root.isConnected) return;
  const previousViewport=ctx.root.querySelector?.('.ves-content');
  const scrollTop=previousViewport?.scrollTop||0,scrollLeft=previousViewport?.scrollLeft||0;
  const done=ctx.results.filter(r=>r.status==='done').length;
  const isBusy=ctx.working;
  const statusLabel=ctx.preparing?'Preparing…':isBusy?`Running ${ctx.currentRun}/${ctx.total}`:
    ctx.status==='paused'?'Paused':ctx.status==='stopped'?'Stopped':ctx.status==='error'?'Error':ctx.status==='done'?'Completed':'Ready';
  ctx.root.innerHTML=`<div class="ves-window" role="dialog" aria-modal="true" aria-label="Experiment Studio">
    <header class="ves-header"><div class="ves-brand"><span class="ves-logo">◈</span><div><h2>EXPERIMENT <em>STUDIO</em></h2><small>ComfyUI parameter testing workspace</small></div></div>
      <div class="ves-header-right"><span class="ves-status ${ctx.status}"><i></i>${esc(statusLabel)}</span><button class="ves-close" data-action="close" aria-label="Close">×</button></div></header>
    <div class="ves-main"><nav class="ves-tabs"><button type="button" data-action="tab-setup" class="${ctx.modalTab==='setup'?'active':''}">Configuration</button>
      <button type="button" data-action="tab-results" class="${ctx.modalTab==='results'?'active':''}">Results <span>${ctx.results.length}</span></button></nav>
      ${ctx.notice?`<div class="ves-notice ${ctx.notice.type}">${esc(ctx.notice.message)}<button data-action="dismiss">×</button></div>`:''}
      <div class="ves-content">${ctx.modalTab==='setup'?renderSetup(ctx):renderGallery(ctx)}</div>
    </div><footer class="ves-footer"><div class="ves-progress"><div class="ves-progress-track"><i style="width:${ctx.total?Math.min(100,Math.round((done/ctx.total)*100)):0}%"></i></div>
      <span>${done}${ctx.total?' / '+ctx.total:''} complete${ctx.working?' · Run '+ctx.currentRun:''}</span></div><div class="ves-footer-right">
      ${isBusy?`<button class="ves-btn" data-action="pause" ${ctx.pauseRequested?'disabled':''}>Pause after current</button><button class="ves-btn danger" data-action="stop">Stop after current</button>`:''}
      ${!isBusy && (ctx.status==='paused'||ctx.status==='stopped'||ctx.status==='error')?`<button class="ves-btn primary" data-action="resume">Resume / retry</button>`:''}
      <button class="ves-btn" data-action="clear-results" ${isBusy||!ctx.results.length?'disabled':''}>Clear results</button></div></footer>
    </div>`;
  const viewport=ctx.root.querySelector?.('.ves-content');
  if(viewport){viewport.scrollTop=scrollTop;viewport.scrollLeft=scrollLeft;}
  ctx.root.querySelectorAll('[data-axis][data-field], [data-rule-mode], [data-rule-values], [data-rule-enum], [data-enum]').forEach(control => control.disabled=ctx.working || ctx.preparing);
}
function getResultsAll(ctx) {
  const completed=ctx.results.filter(r=>r.status==='done' && r.images?.length);
  return [...completed,...ctx.results.filter(r=>r.status!=='done')];
}
function selectedForRun(ctx, entry) {
  return getSelectedImage(entry, ctx.selectedImageIndices[entry.run.number] || 0);
}
function navigateImages(ctx, runIndex, deltaOrIndex, absolute=false) {
  const entry=getResultsAll(ctx)[runIndex];
  if (!entry?.images?.length) return;
  const current=selectedForRun(ctx,entry).index;
  const count=entry.images.length;
  const next=absolute ? Math.min(count-1,Math.max(0,deltaOrIndex)) : (current+deltaOrIndex+count)%count;
  ctx.selectedImageIndices[entry.run.number]=next;
  persist(ctx);
  render(ctx);
}
// One ordered sequence across every completed run and every image in its batch.
// Error/pending runs never create dead spots in the navigation.
function listBrowserFrames(ctx) { return flattenCompletedImages(ctx.results); }
function browserState(ctx,frames=listBrowserFrames(ctx)) {
  const index=findFrameIndex(frames,ctx.browseRunNumber,ctx.browseImageIndex);
  return {frames,index:index<0?frames.length-1:index,item:frames[index<0?frames.length-1:index]||null};
}
function setBrowserFrame(ctx,frame,{repaint=true}={}) {
  if(!frame) return;
  ctx.followLive=false;
  ctx.browseRunNumber=frame.runNumber;
  ctx.browseImageIndex=frame.imageIndex;
  ctx.selectedImageIndices[frame.runNumber]=frame.imageIndex;
  persist(ctx);
  if(repaint) {render(ctx);ctx.root?.focus?.({preventScroll:true});}
}
function stepBrowser(ctx,delta,{repaint=true}={}) {
  const frames=listBrowserFrames(ctx);
  if(!frames.length) return null;
  // When switching from Live to Browse, begin at the latest completed image.
  const current=ctx.followLive?frames[frames.length-1]:browserState(ctx,frames).item;
  const next=nextCompletedFrame(frames,current?.runNumber,current?.imageIndex,delta);
  setBrowserFrame(ctx,next,{repaint});
  return next;
}
function selectBrowserRun(ctx,runNumber) {
  const frames=listBrowserFrames(ctx);
  const chosen=frames.find(frame=>String(frame.runNumber)===String(runNumber) &&
    frame.imageIndex===(ctx.selectedImageIndices[frame.runNumber]||0)) ||
    frames.find(frame=>String(frame.runNumber)===String(runNumber));
  setBrowserFrame(ctx,chosen);
}
function openLightbox(ctx,runIndex,{fromBrowser=false}={}) {
  const entry=fromBrowser ? browserState(ctx).item?.entry : getResultsAll(ctx)[runIndex];
  if(!entry?.images?.length) return;
  const frames=listBrowserFrames(ctx);
  let selected=fromBrowser?browserState(ctx).item:
    frames.find(frame=>String(frame.runNumber)===String(entry.run.number) &&
      frame.imageIndex===(ctx.selectedImageIndices[entry.run.number]||0));
  selected ||= frames.find(frame=>String(frame.runNumber)===String(entry.run.number));
  if(!selected) return;
  document.querySelector('.ves-lightbox')?.remove();
  const overlay=element('div',{className:'ves-lightbox'});
  overlay.tabIndex=-1;
  function paint() {
    const available=listBrowserFrames(ctx);
    const pos=findFrameIndex(available,selected.runNumber,selected.imageIndex);
    if(pos<0){overlay.remove();return;}
    selected=available[pos];
    const run=selected.entry;
    const count=run.images.length;
    overlay.innerHTML=`<div class="ves-lightbox-body"><button class="ves-close" type="button" data-close-lightbox="true" aria-label="Close image viewer">×</button>
      <div class="ves-lightbox-main">
        <button class="ves-lightbox-nav" data-lightbox-step="-1" type="button" aria-label="Previous experiment image">‹</button>
        <img src="${esc(imageURL(selected.image))}" alt="Run ${run.run.number}, image ${selected.imageIndex+1} of ${count}">
        <button class="ves-lightbox-nav" data-lightbox-step="1" type="button" aria-label="Next experiment image">›</button>
      </div>
      <div class="ves-lightbox-caption"><b>Run ${run.run.number}</b> · ${esc(formatRun(run.run))} · Seed ${run.run.seed} · Image ${selected.imageIndex+1}/${count} · ${pos+1}/${available.length} total
      <a href="${esc(imageURL(selected.image))}" target="_blank" rel="noopener">Open full resolution</a></div>
      ${count>1?`<div class="ves-lightbox-thumbnails">${run.images.map((img,i)=>`<button type="button" class="${i===selected.imageIndex?'active':''}" data-lightbox-image="${i}" title="Image ${i+1}"><img src="${esc(imageURL(img))}" alt="Image ${i+1}"><span>${i+1}</span></button>`).join('')}</div>`:''}
    </div>`;
  }
  function choose(item) {if(item){selected=item;setBrowserFrame(ctx,item);paint();overlay.focus?.({preventScroll:true});}}
  overlay.addEventListener('click',event=>{
    if(event.target===overlay||event.target.closest('[data-close-lightbox]')) {overlay.remove();return;}
    const dir=event.target.closest('[data-lightbox-step]');
    const thumb=event.target.closest('[data-lightbox-image]');
    if(dir) choose(nextCompletedFrame(listBrowserFrames(ctx),selected.runNumber,selected.imageIndex,Number(dir.dataset.lightboxStep)));
    else if(thumb) choose(listBrowserFrames(ctx).find(frame=>String(frame.runNumber)===String(selected.runNumber) && frame.imageIndex===Number(thumb.dataset.lightboxImage)));
  });
  overlay.addEventListener('keydown',event=>{
    if(event.key==='Escape') {overlay.remove();return;}
    if(event.key==='ArrowLeft'||event.key==='ArrowRight') {
      event.preventDefault();event.stopPropagation();
      choose(nextCompletedFrame(listBrowserFrames(ctx),selected.runNumber,selected.imageIndex,event.key==='ArrowLeft'?-1:1));
    }
  });
  document.body.appendChild(overlay);
  paint();overlay.focus?.({preventScroll:true});
}
async function historyFor(promptId,captureId) {
  // A submitted prompt might sit behind other user's jobs. This poll never interrupts them.
  for (let attempt=0;attempt<2400;attempt++) {
    await wait(1500);
    const response=await api.fetchApi(`/history/${encodeURIComponent(promptId)}`);
    if (!response.ok) throw new Error(`History HTTP ${response.status}`);
    const histories=await response.json();
    const entry=histories[promptId];
    if (!entry) continue;
    const status=entry.status || {};
    if (status.status_str==='error' || status.status_str==='interrupted' || status.completed===false) {
      const messages=(status.messages || []).filter(x=>x[0]==='execution_error');
      const detail=messages[0]?.[1]?.exception_message || status.status_str || 'Unknown execution error';
      throw new Error(`ComfyUI execution failed: ${detail}`);
    }
    const images=entry.outputs?.[captureId]?.images || [];
    if (!images.length) throw new Error('The run finished but the Experiment Studio capture did not return images.');
    return images;
  }
  throw new Error('Timed out waiting for ComfyUI history (60 minutes).');
}
function previousCompletedRun(ctx, index) {
  for(let i=index-1;i>=0;i--) if(ctx.results[i]?.status==='done') return ctx.results[i].run;
  return null;
}

async function unloadForNewModel(ctx, previousRun, run) {
  if(ctx.modelCacheMode!=='unload' || !previousRun) return false;
  const previousPrompt=makeRunPrompt(ctx.basePrompt,previousRun,ctx.seedTargets,ctx.captureId,ctx.sessionPrefix);
  const nextPrompt=makeRunPrompt(ctx.basePrompt,run,ctx.seedTargets,ctx.captureId,ctx.sessionPrefix);
  const change=modelChange(previousPrompt,nextPrompt);
  if(!change.changed) return false;
  ctx.livePhase='Unloading models';
  render(ctx);
  await unloadBeforeModelSwitch(api,wait);
  return true;
}

async function submitRun(ctx,run,index) {
  const prompt=makeRunPrompt(ctx.basePrompt,run,ctx.seedTargets,ctx.captureId,ctx.sessionPrefix);
  // Use our own prompt_id from the beginning; fast Turbo models may emit their
  // first preview before the /prompt HTTP response reaches the browser.
  const desiredPromptId=newPromptId();ctx.activePromptId=desiredPromptId;
  const response=await api.fetchApi('/prompt',{method:'POST', headers:{'Content-Type':'application/json'},
    body:JSON.stringify({prompt, client_id:api.clientId || globalThis.window?.name || '', prompt_id:desiredPromptId,
      extra_data:{extra_pnginfo:{workflow:ctx.baseWorkflow},
        ...(ctx.previewEnabled?{preview_method:'auto'}:{})}})});
  const payload=await response.json().catch(()=>({}));
  if (!response.ok || !payload.prompt_id) {
    const detail=payload.error?.message || payload.error || `HTTP ${response.status}`;
    const nodes=Object.keys(payload.node_errors || {}).join(', ');
    throw new Error(`Queue rejected the run: ${detail}${nodes?` (nodes: ${nodes})`:''}`);
  }
  ctx.results[index].promptId=payload.prompt_id;
  ctx.activePromptId=payload.prompt_id;ctx.livePhase='Queued';
  persist(ctx);render(ctx);
  return historyFor(payload.prompt_id,ctx.captureId);
}
async function execute(ctx, startIndex=0) {
  if (ctx.working) return;
  ctx.working=true;ctx.stopRequested=false;ctx.pauseRequested=false;ctx.status='running';
  ctx.modalTab='results';ctx.experimentStart ||= Date.now();
  attachLiveEvents(ctx);render(ctx);
  for(let i=startIndex;i<ctx.plan.length;i++) {
    const run=ctx.plan[i];ctx.currentRun=i+1;ctx.activeRunIndex=i;
    ctx.runStart=Date.now();ctx.liveStep=0;ctx.liveMax=0;ctx.liveNode='';ctx.livePhase='Queued';
    ctx.liveReceiving=false;ctx.liveConfirmed=false;ctx.previewFrames=0;ctx.lastPreviewBlob=null;
    ctx.samplingStart=0;ctx.activePromptId=null;clearLivePreview(ctx);
    if (!ctx.results[i] || ctx.results[i].status!=='done') {
      ctx.results[i]={run,status:'running',images:[],promptId:null};persist(ctx);render(ctx);
      try {
        await unloadForNewModel(ctx,previousCompletedRun(ctx,i),run);
        const images=await submitRun(ctx,run,i);
        ctx.results[i]={run,status:'done',images,promptId:ctx.results[i].promptId};
        ctx.durations.push(Date.now()-ctx.runStart);ctx.livePhase='Completed';
      } catch(e) {
        ctx.results[i].status='error';ctx.results[i].error=e.message;
        ctx.lastError=e.message;ctx.status='error';ctx.working=false;
        detachLiveEvents(ctx);clearLivePreview(ctx);
        persist(ctx);notice(ctx,`Run ${i+1}: ${e.message}`,'error');return;
      }
    }
    ctx.activePromptId=null;ctx.liveReceiving=false;ctx.liveConfirmed=false;clearLivePreview(ctx);
    persist(ctx);render(ctx);
    if (ctx.stopRequested || ctx.pauseRequested) {
      ctx.working=false;ctx.status=ctx.pauseRequested?'paused':'stopped';
      detachLiveEvents(ctx);ctx.activeRunIndex=-1;
      persist(ctx);render(ctx);return;
    }
  }
  ctx.working=false;ctx.status='done';ctx.activeRunIndex=-1;
  detachLiveEvents(ctx);clearLivePreview(ctx);persist(ctx);render(ctx);
}
function inspectPresets(ctx,plan) {
  if (!ctx.presetSync) return {plan,reports:[]};
  const graph=app.graph;
  const getNode=id=>graph?.getNodeById?.(Number(id)) || graph?._nodes_by_id?.[String(id)] || null;
  return addPresetEffects(plan,ctx.apiPrompt,getNode,{canvas:app.canvas});
}
async function inspectBeforeRun(ctx) {
  if (ctx.working || ctx.preparing) return;
  ctx.preparing=true;render(ctx);
  try {
    await snapshotWorkflow(ctx);
    const raw=buildPlan(ctx.apiPrompt,ctx.captureId,ctx.axes,ctx.mode,ctx.fixedSeed);
    const result=inspectPresets(ctx,raw.plan);
    ctx.presetInspection=result;
    const unsupported=result.reports.filter(r=>r.warning);
    ctx.notice={message:unsupported.length
      ? `${unsupported.length} preset choice(s) could not be inspected. Check the details below; manual axes may be needed.`
      : 'Preset effects inspected. Confirm the derived steps/CFG shown below before starting.',
      type:unsupported.length?'warning':'info'};
  } catch(e) {ctx.notice={message:e.message,type:'error'};}
  finally {ctx.preparing=false;render(ctx);}
}
async function begin(ctx) {
  if (ctx.working || ctx.preparing) return;
  ctx.preparing=true;render(ctx);
  try {
    await snapshotWorkflow(ctx);
    const planData=buildPlan(ctx.apiPrompt,ctx.captureId,ctx.axes,ctx.mode,ctx.fixedSeed);
    const generatedPlan=planWithSeedStrategy(planData.plan,{seedMode:ctx.seedMode,randomSamples:ctx.randomSamples,
      hasSeedAxis:ctx.axes.some(a=>a.key===SEED_AXIS_KEY),seedTargets:ctx.seedTargets.length});
    const inspected=inspectPresets(ctx,generatedPlan);
    const resolvedPlan=inspected.plan;
    const unsupported=inspected.reports.filter(r=>r.warning);
    const today=new Date();
    const stamp=`${today.getFullYear()}${String(today.getMonth()+1).padStart(2,'0')}${String(today.getDate()).padStart(2,'0')}_${String(today.getHours()).padStart(2,'0')}${String(today.getMinutes()).padStart(2,'0')}${String(today.getSeconds()).padStart(2,'0')}`;
    ctx.sessionPrefix=`ExperimentStudio/ES_${stamp}_${safeName(ctx.node.properties.studioId).slice(0,8)}`;
    ctx.basePrompt=jsonClone(ctx.apiPrompt);ctx.baseWorkflow=jsonClone(ctx.workflow);
    ctx.plan=resolvedPlan;ctx.total=resolvedPlan.length;ctx.currentRun=0;
    ctx.results=[];ctx.selectedImageIndices={};ctx.page=0;ctx.durations=[];ctx.experimentStart=0;
    ctx.followLive=true;ctx.browseRunNumber=null;ctx.browseImageIndex=0;
    ctx.notice=unsupported.length ? {message:`Preset inspection warning: ${unsupported.map(r=>r.setting.value+' ('+r.warning+')').join('; ')}. If this node updates settings asynchronously, set the additional fields with separate axes.`,type:'warning'} :
      (!ctx.seedTargets.length ? {message:'No direct seed widget was found. Verify any seed supplied by a connected node is fixed.',type:'warning'} : null);
    ctx.preparing=false;
    persist(ctx);
    await execute(ctx);
  } catch(e) { ctx.preparing=false;notice(ctx,e.message,'error'); }
}
function resume(ctx) {
  if(!ctx.plan?.length || !ctx.basePrompt) {notice(ctx,'This execution was interrupted by a page reload. Start a new experiment.','warning');return;}
  const idx=ctx.results.findIndex(r=>r.status!=='done');
  execute(ctx,idx<0?ctx.results.length:idx);
}
async function handleAction(ctx,button) {
  const action=button.dataset.action,idx=Number(button.dataset.index);
  if (action!=='reset-axes' && action!=='cancel-reset-axes') ctx.confirmResetAxes=false;
  switch(action) {
    case 'close':ctx.root?.remove();ctx.root=null;currentOverlay=null;return;
    case 'dismiss':ctx.notice=null;break;
    case 'tab-setup':ctx.modalTab='setup';break;
    case 'tab-results':ctx.modalTab='results';break;
    case 'toggle-advanced':ctx.advancedOpen=!ctx.advancedOpen;break;
    case 'add-axis': {
      if (ctx.axes.length>=MAX_AXES || ctx.working)break;
      const used=new Set(ctx.axes.map(a=>a.key));
      const free=ctx.candidates.find(c=>!used.has(c.key));
      const chosen=free || ctx.candidates.find(c=>c.key===ctx.axes[ctx.axes.length-1].key);
      if(chosen) {ctx.axes.push(free ? newAxis(chosen) : {...newAxis(chosen),values:'',mode:'list'});getEnumOptions(ctx,chosen);}
      else ctx.notice={message:'No more available parameters.',type:'warning'};
      break;
    }
    case 'remove-axis':if(!ctx.working&&ctx.axes.length>1) {const removed=ctx.axes.splice(idx,1)[0];for(const a of ctx.axes)if(a.linkedTo===removed.id)a.linkedTo='';}break;
    case 'reset-axes': {
      if(ctx.working||ctx.preparing) break;
      if(!ctx.confirmResetAxes) {ctx.confirmResetAxes=true;break;}
      const candidate=chooseDefault(ctx.candidates);
      if(!candidate) {ctx.notice={message:'Refresh workflow to discover the available parameters.',type:'warning'};break;}
      ctx.axes=[newAxis(candidate)];
      ctx.presetInspection=null;
      ctx.confirmResetAxes=false;
      ctx.notice={message:'Axes reset to one default axis. Other settings and results were kept.',type:'info'};
      getEnumOptions(ctx,candidate);
      break;
    }
    case 'cancel-reset-axes':ctx.confirmResetAxes=false;break;
    case 'refresh':try{await snapshotWorkflow(ctx);}catch(e){ctx.notice={message:e.message,type:'error'};}break;
    case 'run':await begin(ctx);return;
    case 'inspect-presets':await inspectBeforeRun(ctx);return;
    case 'pause':ctx.pauseRequested=true;ctx.notice={message:'The current run will finish before pausing.',type:'info'};break;
    case 'stop':ctx.stopRequested=true;ctx.notice={message:'The current run will finish before stopping. Other queue jobs are untouched.',type:'info'};break;
    case 'resume':resume(ctx);return;
    case 'clear-results':
      if(ctx.working||ctx.preparing) break;
      clearNodeOutputPreview(ctx.node,app);
      clearLivePreview(ctx);
      ctx.results=[];ctx.selectedImageIndices={};ctx.page=0;ctx.total=0;ctx.status='idle';
      ctx.plan=[];ctx.basePrompt=null;ctx.currentRun=0;ctx.activeRunIndex=-1;
      ctx.activePromptId=null;ctx.liveStep=0;ctx.liveMax=0;ctx.livePhase='idle';
      ctx.experimentStart=0;ctx.durations=[];ctx.followLive=true;
      ctx.browseRunNumber=null;ctx.browseImageIndex=0;break;
    case 'follow-live':ctx.followLive=true;ctx.browseRunNumber=null;break;
    case 'prev-page':ctx.page=Math.max(0,ctx.page-1);break;
    case 'next-page':ctx.page+=1;break;
    case 'export-json':exportJSON(ctx);return;
    case 'export-csv':exportCSV(ctx);return;
    case 'export-grid':try {await exportGrid(ctx);} catch(e) {notice(ctx,e.message,'error');}return;
  }
  persist(ctx);render(ctx);
}
async function openStudio(node) {
  let ctx=sessions.get(node);
  if(!ctx){ctx=makeSession(node);sessions.set(node,ctx);}
  ctx.advancedOpen=false; // Start collapsed whenever the Studio is opened.
  if(currentOverlay)currentOverlay.remove();
  const overlay=element('div',{className:'ves-overlay'});
  overlay.addEventListener('click',async e=> {
    if(e.target===overlay) { overlay.remove();ctx.root=null;currentOverlay=null;return; }
    const browserStep=e.target.closest('[data-browser-step]');
    if(browserStep){stepBrowser(ctx,Number(browserStep.dataset.browserStep));return;}
    const browserSelect=e.target.closest('[data-browser-select]');
    if(browserSelect){selectBrowserRun(ctx,browserSelect.dataset.browserSelect);return;}
    if(e.target.closest('[data-browser-open]')){
      openLightbox(ctx,-1,{fromBrowser:true});return;
    }
    const imageStep=e.target.closest('[data-image-step]');
    if(imageStep) {navigateImages(ctx,Number(imageStep.dataset.runIndex),Number(imageStep.dataset.imageStep));return;}
    const gallery=e.target.closest('[data-open-image]');
    if(gallery) {openLightbox(ctx,Number(gallery.dataset.openImage));return;}
    const btn=e.target.closest('[data-action]');if(btn && !btn.disabled)await handleAction(ctx,btn);
  });
  overlay.addEventListener('change',e=>{
    const c=e.target;
    ctx.confirmResetAxes=false;
    if(c.dataset.liveToggle!==undefined) {ctx.previewEnabled=!!c.checked;persist(ctx);if(!ctx.previewEnabled)clearLivePreview(ctx);render(ctx);return;}
    if(c.dataset.liveFrequency!==undefined) {ctx.previewFrequency=c.value==='reduced'?'reduced':'normal';persist(ctx);return;}
    if (c.dataset.enum!==undefined) {
      const axis=ctx.axes[Number(c.dataset.enum)];
      if(axis && c.value && !ctx.working) {
        axis.mode='list';
        const values=String(axis.values||'').split(/[\n,]/).map(x=>x.trim()).filter(Boolean);
        if (!values.includes(c.value)) values.push(c.value);
        axis.values=values.join('\n');
        persist(ctx);render(ctx);
      }
      return;
    }
    if (c.dataset.ruleMode!==undefined || c.dataset.ruleValues!==undefined || c.dataset.ruleEnum!==undefined) {
      const i=Number(c.dataset.ruleMode ?? c.dataset.ruleValues ?? c.dataset.ruleEnum);
      const axis=ctx.axes[i], key=c.dataset.parentValue;
      if (axis && key!==undefined && !ctx.working) {
        axis.linkedValues ||= {};
        const candidate=ctx.candidates.find(x=>x.key===axis.key);
        const rule=axis.linkedValues[key] ||= {mode:'keep',values:''};
        if(c.dataset.ruleMode!==undefined) {
          rule.mode=c.value;
          if(rule.mode==='value' && !rule.values) rule.values=String(candidate?.value ?? '');
        } else if(c.dataset.ruleValues!==undefined) rule.values=c.value;
        else if(c.value) {
          rule.mode='value';
          const values=String(rule.values||'').split(/[\n,]/).map(x=>x.trim()).filter(Boolean);
          if(!values.includes(c.value)) values.push(c.value);
          rule.values=values.join('\n');
        }
        persist(ctx);render(ctx);
      }
      return;
    }
    if (c.dataset.presetSync !== undefined) { ctx.presetSync=c.checked;ctx.presetInspection=null;persist(ctx);render(ctx);return;}
    if (c.dataset.config) ctx[c.dataset.config]=c.dataset.config==='exportChars'?clampExportChars(c.value):c.value;
    if (c.dataset.axis!==undefined || c.dataset.ruleMode!==undefined || c.dataset.ruleValues!==undefined || c.dataset.ruleEnum!==undefined) ctx.presetInspection=null;
    if (c.dataset.axis!==undefined) {
      const axis=ctx.axes[Number(c.dataset.axis)];
      if(c.dataset.field==='key') {
        const candidate=ctx.candidates.find(x=>x.key===c.value);
        const id=axis.id, linkedTo=axis.linkedTo;
        Object.assign(axis,newAxis(candidate),{id,linkedTo,linkedValues:{}});
        if (axis.linkedTo && ctx.axes.find(a=>a.id===axis.linkedTo)?.key===axis.key) axis.linkedTo='';
        // Children cannot target the same input as their parent.
        for (const child of ctx.axes) if (child.linkedTo===id && child.key===axis.key) child.linkedTo='';
        getEnumOptions(ctx,candidate);
      } else if(axis) {
        axis[c.dataset.field]=c.value;
        if (c.dataset.field==='linkedTo') {
          axis.linkedValues={};
          if (axis.linkedTo) for (const child of ctx.axes) if (child.linkedTo===axis.id) child.linkedTo='';
        }
      }
    }
    persist(ctx);render(ctx);
  });
  overlay.tabIndex=-1;
  overlay.addEventListener('keydown',e=>{
    if(ctx.modalTab!=='results' || !['ArrowLeft','ArrowRight'].includes(e.key)) return;
    if(e.target?.closest?.('input,textarea,select,[contenteditable="true"]')) return;
    if(document.querySelector('.ves-lightbox')) return;
    e.preventDefault();e.stopPropagation();
    stepBrowser(ctx,e.key==='ArrowLeft'?-1:1);
  });
  ctx.root=overlay;currentOverlay=overlay;document.body.appendChild(overlay);
  overlay.focus?.({preventScroll:true});
  render(ctx);
  try {if (!ctx.working && !ctx.preparing) await snapshotWorkflow(ctx);for (const axis of ctx.axes) getEnumOptions(ctx,ctx.candidates.find(c=>c.key===axis.key));}
  catch(e) {notice(ctx,e.message,'error');}
  render(ctx);
}

// Keep the button independent of the viewer's runtime state, and reinstall its
// callback if a previously-created widget already exists. `nodeCreated` covers
// loaded workflow nodes; `onNodeCreated` is a fallback for frontend versions
// that invoke lifecycle hooks in a different order.
function ensureStudioButton(node) {
  if (node?.comfyClass !== CAPTURE_TYPE && node?.type !== CAPTURE_TYPE) return;
  node.properties ||= {};
  if (!node.properties.studioId) node.properties.studioId = newId();
  const existing = node.widgets?.find(w => w.name === 'Open Experiment Studio');
  if (existing) {
    existing.callback = () => openStudio(node);
    return;
  }
  if (typeof node.addWidget !== 'function') return;
  const widget = node.addWidget('button', 'Open Experiment Studio', '', () => openStudio(node));
  // Keep this UI-only button out of API inputs and widget serialization.
  if (widget) widget.serialize = false;
  const size = node.computeSize?.();
  if (size) node.setSize?.([Math.max(265, size[0]), Math.max(125, size[1])]);
}

app.registerExtension({
  name: PLUGIN,
  beforeRegisterNodeDef(nodeType, nodeData) {
    if (nodeData?.name !== CAPTURE_TYPE) return;
    if (nodeType.prototype.__vicExperimentStudioButtonInstalled) return;
    nodeType.prototype.__vicExperimentStudioButtonInstalled = true;
    const previous = nodeType.prototype.onNodeCreated;
    nodeType.prototype.onNodeCreated = function(...args) {
      const result = previous?.apply(this, args);
      ensureStudioButton(this);
      return result;
    };
  },
  nodeCreated(node) { ensureStudioButton(node); },
});
