/** Model switching detection + ComfyUI native model unload. No dependency on ComfyUI internals. */
const KNOWN_MODEL_FIELDS = new Set([
  'unet_name','ckpt_name','checkpoint_name','diffusion_model_name','diffusion_model',
  'unet_file','model_file','checkpoint_file',
]);
const MODEL_LOADER_CLASS = /(?:unet|checkpoint|diffusion).*(?:load|gguf)|(?:load|gguf).*(?:unet|checkpoint|diffusion)|(?:^|[_-])(?:model(?:loader)?|ggufloader)(?:$|[_-])/i;
const EXCLUDE_CLASSES = /(?:lora|vae|clip|controlnet|upscale|ipadapter|vision|text.encoder|embedding)/i;

/** Only examine file inputs on model-loading nodes. Changes to a sampler, seed,
 * LoRA or VAE do not count as a UNET switch. The same nodeId stays associated
 * with the same input throughout the snapshots. */
export function modelSelections(prompt) {
  const result=new Map();
  for (const [nodeId, node] of Object.entries(prompt || {})) {
    const classType=String(node?.class_type || '');
    if(EXCLUDE_CLASSES.test(classType)) continue;
    for(const [key, value] of Object.entries(node?.inputs || {})) {
      if(typeof value!=='string') continue;
      const normalized=key.toLowerCase();
      const recognized=KNOWN_MODEL_FIELDS.has(normalized) ||
        (normalized==='model_name' && MODEL_LOADER_CLASS.test(classType));
      if(recognized) result.set(`${nodeId}::${normalized}`,value);
    }
  }
  return result;
}

export function modelChange(previousPrompt,nextPrompt) {
  const prev=modelSelections(previousPrompt), next=modelSelections(nextPrompt);
  const keys=[...new Set([...prev.keys(),...next.keys()])].sort();
  const changes=keys.filter(key=>prev.get(key)!==next.get(key));
  return {changed:changes.length>0, detectable:keys.length>0,
    changes:changes.map(key=>({key,previous:prev.get(key),next:next.get(key)}))};
}

/** ComfyUI's /free handler sets a queue flag; it is not a synchronous unload
 * completion notification. Never submit a new experiment run straight after it.
 * Ensure the global queue is idle first, and allow a settling interval for
 * the worker to consume the flag. If another client owns queued work, fail
 * clearly rather than attempting a global unload during their generation. */
export async function unloadBeforeModelSwitch(api,wait,settleMs=1500) {
  const queueResponse=await api.fetchApi('/queue');
  if (!queueResponse.ok) throw new Error(`Cannot check ComfyUI queue before unloading (HTTP ${queueResponse.status}).`);
  const state=await queueResponse.json();
  if(!Array.isArray(state.queue_running) || !Array.isArray(state.queue_pending))
    throw new Error('Unexpected ComfyUI queue response; refusing to unload models while queue status is unknown.');
  if(state.queue_running.length || state.queue_pending.length)
    throw new Error('Model unload postponed: ComfyUI has other queued/running jobs. Let the queue finish or choose Auto.');
  const response=await api.fetchApi('/free', {
    method:'POST',headers:{'Content-Type':'application/json'},
    body:JSON.stringify({unload_models:true,free_memory:false}),
  });
  if(!response.ok) throw new Error(`ComfyUI model unload request failed (HTTP ${response.status}).`);
  await wait(settleMs);
}
