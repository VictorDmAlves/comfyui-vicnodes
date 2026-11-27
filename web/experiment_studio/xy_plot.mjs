/** Standalone XY Plot composition helpers (no ComfyUI or DOM dependencies). */

const keyOf = s => `${s.nodeId}::${s.inputName}`;
const unique = values => [...new Set(values)];
function settingsFor(run) {
  const byKey=new Map();
  for(const s of run?.dependentSettings || []) byKey.set(keyOf(s),s);
  for(const s of run?.settings || []) byKey.set(keyOf(s),s);
  return byKey;
}
export function dimensionValue(run,key) {
  if(key==='__seed__') return String(run.seed ?? 'Random');
  const s=settingsFor(run).get(key);
  if(!s) return 'Original';
  return String(s.special==='disable_lora' ? 'OFF' : s.value);
}
export function xyDimensions(results) {
  const entries=(results||[]).filter(r=>r.status==='done' && r.images?.length);
  const fields=new Map();
  for(const entry of entries) {
    for(const s of [...(entry.run?.settings||[]),...(entry.run?.dependentSettings||[])]) {
      const key=keyOf(s);
      if(!fields.has(key)) fields.set(key,{key, inputName:String(s.inputName), nodeId:s.nodeId,
        label:String(s.label||s.inputName), kind:'parameter'});
    }
  }
  const dims=[...fields.values()];
  if(unique(entries.map(r=>String(r.run.seed))).length>1) dims.push({key:'__seed__',label:'Seed',inputName:'seed',kind:'seed'});
  return dims.map(d=>({...d,values:unique(entries.map(e=>dimensionValue(e.run,d.key)))}));
}
export function resolveXYAxes(dimensions,chosenX='',chosenY='') {
  const varied=dimensions.filter(d=>d.values.length>1);
  const x=(dimensions.find(d=>d.key===chosenX) || varied[0] || dimensions[0] || null)?.key || '';
  const y=chosenY==='__none__'?'':
    (dimensions.find(d=>d.key===chosenY&&d.key!==x) || varied.find(d=>d.key!==x) || null)?.key || '';
  return {x,y};
}
export function xyMatrix(results,xKey,yKey='') {
  const entries=(results||[]).filter(r=>r.status==='done' && r.images?.length);
  if(!entries.length) throw new Error('No completed images to export.');
  const columns=unique(entries.map(e=>dimensionValue(e.run,xKey)));
  const rows=yKey?unique(entries.map(e=>dimensionValue(e.run,yKey))):[''];
  const cells=rows.map(y=>columns.map(x=>entries.filter(e=>dimensionValue(e.run,xKey)===x && (!yKey||dimensionValue(e.run,yKey)===y))));
  return {columns,rows,cells,entries};
}

function textInputs(inputs,side) {
  const exact=side==='negative'?['negative_prompt','negative','text','prompt','text_g','text_l']:
    ['positive_prompt','positive','text','prompt','text_g','text_l'];
  return exact.flatMap(k=>typeof inputs?.[k]==='string'&&inputs[k].trim()?[inputs[k].trim()]:[]);
}
function walkPrompt(apiPrompt,link,side,visited=new Set(),depth=0) {
  if(!Array.isArray(link)||depth>16) return [];
  const id=String(link[0]);
  if(visited.has(id)) return [];
  visited.add(id);
  const node=apiPrompt?.[id];
  if(!node) return [];
  const type=String(node.class_type||'');
  if(side==='negative' && /ConditioningZeroOut/i.test(type)) return [];
  const inputs=node.inputs||{};
  let strings=textInputs(inputs,side);
  for(const [k,v] of Object.entries(inputs)) {
    if(!Array.isArray(v)||v.length<2) continue;
    if(/^(image|mask|model|clip|vae|latent|samples|control_net|unet)$/i.test(k)) continue;
    strings.push(...walkPrompt(apiPrompt,v,side,visited,depth+1));
  }
  return strings;
}
export function extractPromptTexts(apiPrompt) {
  const positive=[],negative=[];
  for(const node of Object.values(apiPrompt||{})) {
    const inputs=node?.inputs||{};
    const className=String(node?.class_type||'');
    const sampler=/sampler|guider/i.test(className);
    if(!sampler) continue;
    if(Array.isArray(inputs.positive)) positive.push(...walkPrompt(apiPrompt,inputs.positive,'positive'));
    if(Array.isArray(inputs.negative)) negative.push(...walkPrompt(apiPrompt,inputs.negative,'negative'));
  }
  return {positive:unique(positive).join('\n\n'),negative:unique(negative).join('\n\n')};
}

export function extractEffectiveParams(apiPrompt) {
  const relevant=/^(?:unet_name|ckpt_name|model_name|lora_name|strength_model|strength_clip|preset|quality_preset|steps|cfg|sampler_name|scheduler|denoise|sigma_strength|shift|guidance|guidance_scale|width|height)$/i;
  const collected=[];
  for(const [nodeId,node] of Object.entries(apiPrompt||{})) {
    for(const [name,raw] of Object.entries(node.inputs||{})) {
      if(!relevant.test(name) || !['string','number','boolean'].includes(typeof raw)) continue;
      if(typeof raw==='string'&&raw.length>256) continue;
      const off=name==='lora_name' && /lora/i.test(String(node.class_type||'')) && node.inputs.strength_model===0;
      collected.push({nodeId,name,value:off?'OFF':String(raw)});
    }
  }
  const counts=new Map();
  for(const f of collected) counts.set(f.name,(counts.get(f.name)||0)+1);
  return collected.map(f=>`${f.name}${counts.get(f.name)>1?` [#${f.nodeId}]`:''}=${f.value}`);
}

function effectiveLabelArray(run) {
  if (Array.isArray(run?.effectiveSettings) && run.effectiveSettings.length) return [...run.effectiveSettings];
  return [...settingsFor(run).values()].map(s=>`${s.inputName}=${s.special==='disable_lora'?'OFF':s.value}`);
}
function axisInputName(entries,key) {
  if(!key || key==='__seed__') return 'seed';
  for(const entry of entries||[]) {
    const hit=[...settingsFor(entry.run).values()].find(s=>keyOf(s)===key);
    if(hit?.inputName) return String(hit.inputName);
  }
  return '';
}
function excludedNames(entries,xKey,yKey='') {
  return new Set([axisInputName(entries,xKey), axisInputName(entries,yKey)].filter(Boolean));
}
function isLabelForNames(label,names) {
  return [...names].some(name=>label===`${name}=` || label.startsWith(`${name}=`) || label.startsWith(`${name} [#`));
}
export function xySharedSettings(entries,xKey,yKey='') {
  const all=(entries||[]).filter(Boolean);
  if(!all.length) return [];
  const excluded=excludedNames(all,xKey,yKey);
  const labelLists=all.map(entry=>unique(effectiveLabelArray(entry.run).filter(label=>!isLabelForNames(label,excluded))));
  const common=labelLists[0].filter(label=>labelLists.every(list=>list.includes(label)));
  // The seed is an effective shared setting even though it is stored outside
  // the prompt-widget parameters. Avoid repeating it in every legend entry.
  if(xKey!=='__seed__' && yKey!=='__seed__' && all.every(entry=>String(entry.run.seed)===String(all[0].run.seed))) {
    common.unshift(`seed=${all[0].run.seed}`);
  }
  return unique(common);
}
export function xyRunLegend(matrix,xKey,yKey='',selection={}) {
  const entries=[...(matrix?.entries||[])].sort((a,b)=>Number(a.run?.number||0)-Number(b.run?.number||0));
  const shared=new Set(xySharedSettings(entries,xKey,yKey));
  const excluded=excludedNames(entries,xKey,yKey);
  return entries.map(entry=>{
    const run=entry.run;
    const id=`R${String(run.number).padStart(3,'0')}`;
    const parts=[];
    parts.push(`X=${dimensionValue(run,xKey)}`);
    if(yKey) parts.push(`Y=${dimensionValue(run,yKey)}`);
    const labels=effectiveLabelArray(run).filter(label=>!shared.has(label) && !isLabelForNames(label,excluded));
    if(!shared.has(`seed=${run.seed}`) && xKey!=='__seed__' && yKey!=='__seed__') parts.push(`seed=${run.seed}`);
    parts.push(...labels);
    const imageIndex=Math.max(0,Math.min(entry.images.length-1,Number(selection[run.number]||0)));
    if(entry.images.length>1) parts.push(`image=${imageIndex+1}/${entry.images.length}`);
    return {id, text:`${id} — ${parts.join(' · ')}`};
  });
}

/** Wrap long prompts using measured pixel width rather than the 72-character
 * caption limit used by the separate detailed PNG report exporter. */
function wrapMeasured(value, maxWidth, measure, maxChars=240) {
  const cap=Math.max(16,maxChars);
  const fits=text=>text.length<=cap && measure(text)<=maxWidth;
  const lines=[];
  for(const paragraph of String(value??'').split(/\r?\n/)) {
    let current='';
    for(const word of paragraph.trim().split(/\s+/).filter(Boolean)) {
      const candidate=current?`${current} ${word}`:word;
      if(fits(candidate)) {current=candidate;continue;}
      if(current){lines.push(current);current='';}
      if(fits(word)) {current=word;continue;}
      let rest=word;
      while(rest) {
        if(fits(rest)){current=rest;break;}
        let lo=1,hi=Math.min(cap,rest.length),cut=1;
        while(lo<=hi) {
          const mid=Math.floor((lo+hi)/2);
          if(fits(rest.slice(0,mid))){cut=mid;lo=mid+1;}
          else hi=mid-1;
        }
        lines.push(rest.slice(0,cut));rest=rest.slice(cut);
      }
    }
    if(current) lines.push(current);
  }
  return lines.length?lines:[''];
}
function limitWrapped(text,maxWidth,maxChars,maxLines,measure) {
  const lines=wrapMeasured(text,maxWidth,measure,maxChars);
  if(lines.length<=maxLines) return lines;
  const out=lines.slice(0,maxLines);
  let last=out[maxLines-1].replace(/[\s.]+$/,'');
  while(last && measure(`${last}…`)>maxWidth) last=last.slice(0,-1);
  out[maxLines-1]=`${last}…`;
  return out;
}

/**
 * Compute a comparison-focused grid.  All coordinates are derived here and
 * shared with the canvas painter, keeping headings and image tiles disjoint.
 * There are no per-column labels: the R### overlay links images to the legend.
 */
export function xyCanvasLayout(matrix,{prompts={positive:'',negative:''},sharedSettings=[],runLegends=[],measure=text=>text.length*8,
  tileWidth=290,imageHeight=386,maxCanvasPixels=64000000}={}) {
  const margin=18,gap=2,lineHeight=17,legendLineHeight=17;
  const hasY=Boolean(matrix.rows.length>1 || matrix.rows[0]);
  const leftWidth=hasY?104:0;
  const width=margin*2+leftWidth+matrix.columns.length*tileWidth+Math.max(0,matrix.columns.length-1)*gap;
  const horizontal=width>=680;
  const headerTop=78;
  const gutter=20;
  const usableWidth=width-margin*2;
  const promptWidth=horizontal?Math.floor((usableWidth-gutter)*.59):usableWidth;
  const settingsWidth=horizontal?usableWidth-gutter-promptWidth:usableWidth;
  const settingsX=horizontal?margin+promptWidth+gutter:margin;
  // Allow long prompts without making the output a page of paragraphs.
  const posLines=limitWrapped(prompts.positive||'Prompt not detected in connected inputs.',promptWidth-2,220,7,measure);
  const negLines=prompts.negative?limitWrapped(prompts.negative,promptWidth-2,220,4,measure):[];
  const sharedLines=limitWrapped(sharedSettings.join('  ·  ')||'No common settings detected.',settingsWidth-2,220,8,measure);
  const promptBlockHeight=22+posLines.length*lineHeight+(negLines.length?23+negLines.length*lineHeight:0);
  const settingsBlockHeight=22+sharedLines.length*lineHeight;
  const settingsTop=horizontal?headerTop:headerTop+promptBlockHeight+14;
  const headerHeight=horizontal?Math.max(promptBlockHeight,settingsBlockHeight):promptBlockHeight+14+settingsBlockHeight;
  const separatorY=headerTop+headerHeight+12;
  const gridTop=separatorY+15;
  const rowHeights=matrix.rows.map(()=>imageHeight);
  const gridBottom=gridTop+rowHeights.reduce((sum,h)=>sum+h,0)+Math.max(0,rowHeights.length-1)*gap;
  const legendColumns=width>=1450?3:width>=650?2:1;
  const legendGap=20;
  const legendWidth=(usableWidth-(legendColumns-1)*legendGap)/legendColumns;
  const legendItems=(runLegends||[]).map(item=>({id:item.id,lines:wrapMeasured(item.text,legendWidth-6,measure,220)}));
  const legendRows=[];
  for(let i=0;i<legendItems.length;i+=legendColumns) {
    const items=legendItems.slice(i,i+legendColumns);
    legendRows.push({items,height:Math.max(...items.map(item=>item.lines.length*legendLineHeight))+7});
  }
  const legendTop=gridBottom+22;
  const legendHeight=legendRows.length?28+legendRows.reduce((sum,row)=>sum+row.height,0):0;
  const height=legendTop+legendHeight+margin;
  if(width>16384||height>16384||width*height>maxCanvasPixels) {
    throw new Error(`XY Plot would be ${width}×${height}px and too large for a reliable browser export. Reduce the number of results or select axes that spread runs across cells.`);
  }
  return {width,height,margin,gap,lineHeight,legendLineHeight,leftWidth,hasY,tileWidth,imageHeight,
    headerTop,horizontal,promptWidth,settingsWidth,settingsX,settingsTop,posLines,negLines,sharedLines,
    promptBlockHeight,settingsBlockHeight,separatorY,gridTop,rowHeights,gridBottom,
    legendColumns,legendGap,legendWidth,legendItems,legendRows,legendTop,legendHeight};
}
