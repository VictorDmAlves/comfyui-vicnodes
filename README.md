<div align="center">

# ComfyUI VicNodes
**A custom collection of practical and useful nodes for ComfyUI.**

![VicNodes Screenshot](./images/main.png)
</div>

In simple terms, this `custom_node` is a collection of all the nodes I have created so far, with the help of ChatGPT Pro. Of course, it will still be possible to download each node individually via its dedicated page on my GitHub.

These nodes have been developed and tested across various scenarios, designed to be fast, dynamic, and easy to update and use. I even paid attention to how fast it loads when opening ComfyUI; I made a real point of optimizing it as much as possible.

Nodes that include additional settings can be accessed via the menu `ComfyUI > Settings > OTHER > VicNodes`.

This are the nodes created and compiled into this collection so far; to understand what each node does, consult the links below:
- [ComfyUI Hybrid Sampler](./modules/hybrid_sampler).
- [ComfyUI Keyword Wildcard Processor](./modules/keyword_wildcard_processor).
- [ComfyUI Load Multi Image](./modules/load_multi_image).
- [ComfyUI MOSS Smart Sampler](./modules/moss_smart_sampler).
- [ComfyUI Ollama Bridge](./modules/ollama_bridge).
- [ComfyUI Persistent Save Image](./modules/persistent_save_image).
- [ComfyUI Spatial LoRA](./modules/spatial_lora).
- [ComfyUI Flux Klein Text Encode](./modules/flux_klein_text_encode).

Standalone pages:
[ComfyUI Hybrid Sampler](https://github.com/VictorDmAlves/comfyui-hybrid-sampler) | [ComfyUI Keyword Wildcard Processor](https://github.com/VictorDmAlves/comfyui-keyword-wildcard-processor) | [ComfyUI Load Multi Image](https://github.com/VictorDmAlves/comfyui-load-multi-image) | [ComfyUI MOSS Smart Sampler](https://github.com/VictorDmAlves/comfyui-moss-smart-sampler) | [ComfyUI Ollama Bridge](https://github.com/VictorDmAlves/comfyui_ollama_bridge) | [ComfyUI Persistent Save Image](https://github.com/VictorDmAlves/comfyui-persistent-save-image) | [ComfyUI Spatial LoRA](https://github.com/VictorDmAlves/comfyui-spatial-lora) | [ComfyUI Flux Klein Text Encode](https://github.com/VictorDmAlves/comfyui-flux-klein-text-encode)

## Latest release
### 1.2
Added
- Integration with the new `custom_node` ComfyUI Flux Klein Text Encode

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

## License
See [LICENSE](LICENSE).