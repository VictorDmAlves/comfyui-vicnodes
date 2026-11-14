<div align="center">

# ComfyUI VicNodes
**A custom collection of practical and useful nodes for ComfyUI.**

![VicNodes Screenshot](./images/main.png)
</div>

In simple terms, this `custom_node` is a collection of all the nodes I have created so far, with the help of ChatGPT Pro.

These nodes have been developed and tested across various scenarios, designed to be fast, dynamic, and easy to update and use. I even paid attention to how fast it loads when opening ComfyUI; I made a real point of optimizing it as much as possible.

The goal of these nodes was to replace those created by authors who, often, do not update their projects in line with the release of new models; furthermore, since these are custom nodes, I was able to adapt them to my own Workflows, making them more optimized and useful.

Currently, this package is 60.9MB in size.

<!-- Nodes that include additional settings can be accessed via the menu `ComfyUI > Settings > OTHER > VicNodes` (none til this present moment). -->

This are the nodes created and compiled into this collection so far; to understand what each node does, consult the links below:
- [ComfyUI Hybrid Sampler](./modules/hybrid_sampler).
- [ComfyUI Keyword Wildcard Processor](./modules/keyword_wildcard_processor).
- [ComfyUI Load Multi Image](./modules/load_multi_image).
- [ComfyUI MOSS Smart Sampler](./modules/moss_smart_sampler).
- [ComfyUI Ollama Bridge](./modules/ollama_bridge).
- [ComfyUI Persistent Save Image](./modules/persistent_save_image).
- [ComfyUI Spatial LoRA](./modules/spatial_lora).
- [ComfyUI Flux Klein Text Encode](./modules/flux_klein_text_encode).
- [ComfyUI Visual Compare](./modules/visual_compare).
- [ComfyUI Krea2 Smart Sampler](./modules/krea2_smart_sampler).
- [ComfyUI Unified Model Loader](./modules/unified_model_loader).
- [ComfyUI Experiment Studio](./modules/experiment_studio).
- [ComfyUI Style String Injector](./modules/style_string_injector).
- [ComfyUI Latent Size Picker](./modules/latent_size_picker).

This package is used in all my [Workflows](https://github.com/VictorDmAlves/comfyui-workflows) that have a "+" symbol at the end of their name. These are Workflows I’ve been using for years, constantly adapted and always highly practical to use.

## Latest release
### 1.0.8
- Added the ComfyUI Latent Size Picker node.

# Installation

### ComfyUI
Open `ComfyUI Manager`, go to `Custom Node Manager`, and search for the name `ComfyUI VicNodes`; install the latest version of it.

### Git
Open a terminal inside the ComfyUI `custom_nodes` directory and clone the repository:

```bash
cd ComfyUI/custom_nodes
git clone https://github.com/VictorDmAlves/comfyui-vicnodes.git
```

### ZIP
1. Download the repository as a ZIP file.
2. Extract it into `ComfyUI/custom_nodes/`.
3. Make sure the final structure is not nested twice.

Restart ComfyUI.

You can find the nodes via the following path:
- `Nodes>Comfy Nodes>VicNodes`
- `Nodes>Extensions>VicNodes`

## License
See [LICENSE](LICENSE).