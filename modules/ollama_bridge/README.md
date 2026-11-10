<div align="center">

# ComfyUI Ollama Bridge
**Custom node for Ollama integration.**

![Ollama Screenshot](./images/main.png)
</div>

A lightweight, **one-node** ComfyUI extension that sends prompts and optional images directly to a local Ollama model and outputs a regular `STRING` named **Response**.

No API keys, cloud account, or extra Python packages are required beyond the dependencies already used by a standard ComfyUI installation (`aiohttp`, `Pillow`, and PyTorch).

## Latest release
### 1.3
Update
- Removed the `get_models(DEFAULT_URL)` every time the custom_node is initialize in ComfyUI; you will need to use the `Edit > Ollama: Refresh Models` option to update the list with the models installed in your Ollama.

## Utilization
1. Make sure [Ollama](https://ollama.com/) is installed and running on the computer running the **ComfyUI backend**.
2. Download a model, for example `ollama pull gemma3:4b` (choose a model that supports images if you want vision input).
3. Add **Ollama > Local LLM > Ollama Chat (Local)** node.
4. The default URL is `http://localhost:11434`. Installed models are detected once when the plugin starts. To update the list after downloading or removing a model, use **ComfyUI menu > Edit > Ollama: Refresh Models**. There is **no Refresh Models button inside the node**.
5. Connect **Response** to any ComfyUI input accepting `STRING` (such as a text-display node or a string-capable CLIP text-encode input).

There is a [Workflow](./workflow/) avaible in this repository.

## Refreshing Ollama models (new)
To update the model dropdown **without restarting ComfyUI**:

1. Start Ollama and download your models (for example, `ollama pull gemma3:4b`).
2. Open the ComfyUI menu at the upper left, choose **Edit**.
3. Click **Ollama: Refresh Models** (the new entry below the other Edit commands).
4. The dropdowns in existing **Ollama Chat (Local)** nodes are updated; newly created nodes will also use the refreshed default list.

**Important:** The ComfyUI **R** shortcut / **Refresh Node Definitions** does **not** contact Ollama. It only reads the last cached model list, so it will not wait for Ollama responses. Model discovery occurs once at plugin startup and subsequently **only through the Edit-menu command**. The node itself has no refresh button.

The Edit command checks the default Ollama server and any additional Ollama URLs already configured in open Ollama nodes. It preserves the currently selected model in existing workflows, even if that model is absent from the new list.

## Text-to-text
```
Ollama Chat (Local)  -- Response (STRING) --> text display / CLIP Text Encode
```

The model receives the exact text in **Prompt**, preceded by **System Prompt** when set.

## Image-to-text
```
Load Image -- IMAGE --> images [Ollama Chat (Local)] -- Response --> text display
```

Use a **vision-capable Ollama model**. A text-only Ollama model cannot understand attached images. Leave the prompt blank to ask the model to describe the images, or provide your own instructions.

## Multiple images
The `images` socket accepts:
- One `Load Image` node (single-image batch).
- A batch containing multiple images.
- A ComfyUI `IMAGE` list produced by a list-capable upstream node, including lists of batches.

**One Ollama chat request** contains all attached images together, so you can ask the model to compare them. This extension does not automatically create a multi-input fan-in socket: to connect several independent `Load Image` nodes, first combine them with a batch/list node.

## Controls
The main view shows URL, model, prompt, seed, temperature, Max Tokens, and Cache Mode. Additional settings are marked **Advanced** on frontends that support this feature.

| Control | Purpose |
|---|---|
| Ollama URL | `http://localhost:11434` by default; address is resolved on the ComfyUI backend machine. |
| Model | Dropdown of installed Ollama models. |
| Refresh Models | Use **Edit > Ollama: Refresh Models** to reload installed models for all open Ollama nodes; no ComfyUI restart required. |
| Prompt | The user message sent to Ollama. |
| Seed | Sent as Ollama `options.seed`. Supports ComfyUI's built-in `control_after_generate` modes: fixed, increment, decrement, randomize. |
| Temperature | Sampling randomness. |
| Max Tokens | Ollama `num_predict` limit. |
| Context Size | Ollama `num_ctx` (higher values use more memory). |
| System Prompt | Optional independent system instruction. |
| Thinking | Use model default, explicitly enable, or explicitly disable, for supported models. |
| Keep Alive | `5m`, `30m`, `1h`, `0` (unload), or `-1` (keep loaded). |
| Image Format | JPEG for smaller requests or PNG for lossless image content. |
| Image Max Side | Resize images before sending; preserves aspect ratio. |
| JPEG Quality | Compression quality (JPEG only). |
| Max Images | Refuse unexpectedly large batches, rather than silently dropping images. |
| Timeout Seconds | Wait time for model generation; default 300 seconds. |
| Cache Mode | Cache identical inputs or call Ollama every time a queued workflow executes this node. |
| images | Optional ComfyUI `IMAGE` input, with batch/list support. |

## Understanding Prompt vs. System Prompt
The Ollama Chat (Local) node provides two separate text fields: Prompt and System Prompt. Although both send instructions to the AI model, they serve different purposes.

### System prompt (Defines the Model's Behavior)
The System Prompt establishes the model's role, behavior, response style, and general instructions.

Think of it as a set of persistent guidelines that the model should follow whenever the node executes.

It is especially useful for:
- Defining the model's expertise or role.
- Specifying the desired language, tone, and output format.
- Establishing rules and restrictions for generated responses.
- Maintaining consistent behavior across different requests.
- Instructing the model to return only the final result, without explanations or additional commentary.

Example — System Prompt:
- You are an expert image analyst specializing in photorealistic image generation. Analyze visual content accurately, paying close attention to subjects, composition, lighting, textures, and environmental details. Generate detailed, natural-language image prompts in English. Output only the final prompt without explanations, introductions, or additional commentary.

This instruction establishes how the model should behave, regardless of which image or text is provided.

### Prompt (Defines the Current Task)
The Prompt contains the actual request sent to the model during execution.

It tells the model what to do with the supplied text, attached images, or other available context.

It is typically used for:
- Asking questions or requesting specific information.
- Providing text to rewrite, improve, summarize, or translate.
- Requesting an analysis of an attached image.
- Generating descriptions, captions, or creative content.
- Giving task-specific instructions that may change between executions.

Example — Prompt (with an attached image):
- Analyze the attached image and generate a detailed, visually accurate prompt suitable for MOSS Image. Preserve the original composition, subjects, lighting, colors, and distinctive visual characteristics.

Example — Prompt (text only):
- Improve the following image generation prompt by adding realistic photographic details, natural lighting, and precise visual descriptions while preserving the original concept: A woman standing in a garden during sunset.

### How they work together
When both fields are provided, Ollama sends them as different message roles to the selected model:
1. System Prompt: Establishes the general instructions and expected behavior.
2. Prompt: Provides the specific task or content to process.
3. Images (optional): Supply visual information for compatible vision-language models.

The model generates a response based on these inputs, generally following the System Prompt's instructions while completing the task described in the Prompt.

Important Notes:
- The System Prompt is optional. For simple tasks, using only the Prompt is often sufficient.
- The Prompt can be left empty, but providing an explicit request is recommended, especially when working with images.
- A well-defined System Prompt helps produce more consistent results across different inputs.
- You can reuse the same System Prompt while changing the Prompt for each execution.
- Actual instruction-following behavior depends on the selected Ollama model. Some models may not consistently follow every instruction.

In short: Use the System Prompt to tell the AI how to behave, and the Prompt to tell it what to do.

## Speed tips
- **Cache Identical Inputs** is the default, so unchanged workflows do not repeat costly Ollama calls. Use **Always Run** if you want a new response each time you queue a graph.
- Keep **Keep Alive** at `5m` or longer to avoid reloading the model on repeated requests.
- Choose **JPEG** and lower **Image Max Side** for faster encoding and transfer. Choose PNG for screenshots with small text.
- Lower **Max Tokens** for short captions or prompt suggestions.
- Setting a seed increases repeatability but does not guarantee bit-for-bit identical output across Ollama/model/hardware versions.

## Troubleshooting
- **Edit > Ollama: Refresh Models fails**: Check `ollama list`, make sure Ollama is running and available at the configured URL, and check the notification/browser developer console for details.
- **Model not found**: Run `ollama pull MODEL_NAME`, then choose **Edit > Ollama: Refresh Models**.
- **Model cannot process images**: Choose a vision-capable model. The node does not convert text-only models to vision models.
- **Output looks unchanged**: Set Cache Mode to **Always Run**, vary the seed, or modify the prompt. ComfyUI caches unchanged inputs.
- **ComfyUI in Docker/WSL**: `localhost` refers to the ComfyUI backend/container, not necessarily your Windows host. To access Ollama on a different trusted host, configure its network listener carefully and set `OLLAMA_BRIDGE_ALLOW_REMOTE=1` in the ComfyUI backend environment. This is opt-in for security; it must be configured **before** starting ComfyUI.
- **The Edit-menu refresh command doesn't appear**: Ensure the `web/` directory is installed, restart ComfyUI, and hard-reload the browser (`Ctrl+F5`). There is intentionally no button in the node.
- **The model selector is empty or says `Click Refresh Models`**: Start Ollama and use **Edit > Ollama: Refresh Models** to load the models without restarting ComfyUI.

## Network safety
This extension communicates directly from the **ComfyUI Python backend** to Ollama using `/api/tags` and `/api/chat`. By default, it permits only `localhost`, `127.0.0.1`, and `::1`, and blocks HTTP redirects. This prevents the refresh endpoint from becoming a general-purpose server-side URL fetcher.

For Ollama running on a *trusted* different host, set `OLLAMA_BRIDGE_ALLOW_REMOTE=1`; do not enable this if you expose ComfyUI to untrusted users. Ollama's default local API is unauthenticated. Do not publicly expose Ollama or ComfyUI without appropriate access controls.

## Architecture
- `node.py`: one ComfyUI custom node using the compatible V1 node interface.
- `ollama.py`: local HTTP client, model-list cache and network-free cache snapshot, image conversion/encoding.
- `__init__.py`: ComfyUI registration, one-time startup scan, and safe route for manual model updates.
- `web/ollama_bridge.js`: **Edit > Ollama: Refresh Models** command, dynamic model choices, migration of older workflow widget values, node coloring.
- `tests/`: Python backend, image, HTTP, cache, and JavaScript frontend tests.

## Acknowledgements
This project utilizes Ollama, an open-source platform that enables running large language models and vision-language models locally.

Special thanks to the Ollama development team and community for making local AI inference accessible and providing the API that enables this integration.

## License
See [LICENSE](LICENSE).