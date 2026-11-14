// Pure, browser-independent helpers for the export layout and run monitor.
export function clampExportChars(value) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.max(20, Math.min(72, Math.round(n))) : 40;
}

// Canvas's fillText() never wraps on its own. Respect BOTH a character limit
// and the measured pixel width. A long filename with no spaces is split too.
export function wrapExportText(value, maxChars=40, maxWidth=400, measure=txt=>txt.length*7) {
  const cap=clampExportChars(maxChars);
  const width=Number(maxWidth)>0 ? Number(maxWidth) : 400;
  const fits=s=>s.length<=cap && measure(s)<=width;
  const out=[];
  let line='';
  const appendLine=()=>{if(line){out.push(line);line='';}};
  for (const raw of String(value??'').split(/\n/)) {
    for(const word of raw.split(/\s+/).filter(Boolean)) {
      if(line && fits(`${line} ${word}`)) {line=`${line} ${word}`;continue;}
      if(line) appendLine();
      if(fits(word)) {line=word;continue;}
      let remainder=word;
      while(remainder) {
        if(fits(remainder)) {line=remainder;break;}
        let hi=Math.min(cap,remainder.length),lo=1,best=1;
        while(lo<=hi) {
          const mid=Math.floor((lo+hi)/2);
          if(fits(remainder.slice(0,mid))) {best=mid;lo=mid+1;}
          else hi=mid-1;
        }
        // Prefer an existing filename/path separator, but never create tiny lines.
        const first=remainder.slice(0,best);
        const pivot=Math.max(first.lastIndexOf('\\'),first.lastIndexOf('/'),first.lastIndexOf('_'),first.lastIndexOf('-'),first.lastIndexOf('.'));
        const cut=pivot>=Math.floor(best*.60) && pivot<best-1 ? pivot+1 : best;
        out.push(remainder.slice(0,cut));
        remainder=remainder.slice(cut);
      }
    }
    appendLine();
  }
  return out.length ? out : [''];
}

export function getExportLayout(labels, {columns=4, tileWidth=440, imageHeight=380, maxChars=40, measure=txt=>txt.length*7}={}) {
  const width=tileWidth-32;
  const lines=labels.map(text=>wrapExportText(text,maxChars,width,measure));
  const colCount=Math.max(1,Math.min(columns,Math.max(1,labels.length)));
  const rowHeights=[];
  for(let row=0;row<Math.ceil(labels.length/colCount);row++) {
    const rowLines=lines.slice(row*colCount,(row+1)*colCount);
    // image top y=40, caption starts y=imageHeight+64 (444 for default),
    // seed gets its own row, plus bottom padding.
    rowHeights.push(Math.max(510,imageHeight+64+Math.max(...rowLines.map(l=>l.length))*19+53));
  }
  const rowY=[];
  let offset=0;
  for(const h of rowHeights) {rowY.push(offset);offset+=h;}
  return {lines, rows:rowHeights, rowY, contentHeight:offset, columns:colCount, tileWidth, imageHeight};
}

export function percent(value,max) {
  const v=Number(value),m=Number(max);
  return Number.isFinite(v)&&Number.isFinite(m)&&m>0 ? Math.max(0,Math.min(100,Math.round(v/m*100))) : 0;
}
export function duration(ms) {
  if(!Number.isFinite(ms)||ms<0) return '—';
  const s=Math.floor(ms/1000);
  return `${String(Math.floor(s/3600)).padStart(2,'0')}:${String(Math.floor(s%3600/60)).padStart(2,'0')}:${String(s%60).padStart(2,'0')}`;
}
export function remainingMs(durations, remainingRuns) {
  const completed=durations.filter(ms=>Number.isFinite(ms) && ms>0);
  if(!completed.length || remainingRuns<=0) return null;
  // Full-run average avoids claiming that a single sampler step is the whole job.
  const recent=completed.slice(-5);
  const avg=recent.reduce((sum,ms)=>sum+ms,0)/recent.length;
  return Math.max(0,avg*remainingRuns);
}


// v0.5.2: flatten all completed outputs into a stable, chronological image list.
// Each frame carries its parent run and batch position; no image URL is synthesized.
export function flattenCompletedImages(results) {
  const out=[];
  for (const entry of results||[]) {
    if(entry?.status!=='done' || !Array.isArray(entry.images) || !entry.run)continue;
    for(let i=0;i<entry.images.length;i++) {
      if(!entry.images[i])continue;
      out.push({entry,image:entry.images[i],imageIndex:i,runNumber:entry.run.number});
    }
  }
  return out;
}
export function findFrameIndex(frames,runNumber,imageIndex) {
  if(runNumber==null)return -1;
  return (frames||[]).findIndex(item=>String(item.runNumber)===String(runNumber) && item.imageIndex===Number(imageIndex));
}
export function nextCompletedFrame(frames,runNumber,imageIndex,delta) {
  if(!frames?.length)return null;
  const index=findFrameIndex(frames,runNumber,imageIndex);
  // If a previously selected run is unavailable, start at the newest image.
  const base=index<0?frames.length-1:index;
  const d=Number.isFinite(Number(delta))?Math.trunc(Number(delta)):0;
  return frames[((base+d)%frames.length+frames.length)%frames.length];
}

// Clear only the Experiment Studio node's visual result. ComfyUI uses both
// legacy LiteGraph node image fields and a newer nodeOutputs-backed store.
// Removing the relevant output entry also notifies the modern frontend store.
// Images already written to disk are intentionally not deleted.
export function clearNodeOutputPreview(node, app) {
  if (!node) return;
  const nodeId=String(node.id);
  if(app?.nodeOutputs && Object.prototype.hasOwnProperty.call(app.nodeOutputs,nodeId)) {
    delete app.nodeOutputs[nodeId];
  }
  if(app?.nodePreviewImages && Object.prototype.hasOwnProperty.call(app.nodePreviewImages,nodeId)) {
    delete app.nodePreviewImages[nodeId];
  }
  // The node can retain a legacy image even after its output store is cleared.
  node.imgs=null;
  node.imageIndex=0;
  if ('preview' in node) node.preview=null;
  if ('images' in node) node.images=[];
  node.setDirtyCanvas?.(true,true);
  app?.graph?.setDirtyCanvas?.(true,true);
}
