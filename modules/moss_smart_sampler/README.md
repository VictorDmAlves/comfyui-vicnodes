<div align="center">

# ComfyUI MOSS Smart Sampler
**Custom node for MOSS Sampler Base, SFT and Turbo.**

![ComfyUI MOSS Smart Sampler Screenshot](./images/main.png)
</div>

A focused sampler node for **MOSS-Image Base, SFT and Turbo(LoRA)** in ComfyUI. It can reproduce a native ComfyUI sigma schedule or redistribute sampling positions using **Stage Weighted** or **Smooth Warp**. An adjustable **Sigma Strength** lets you blend either experimental curve back toward the native schedule.

> **Quality notice:** Sampling schedules produce different results, not guaranteed improvements. Tests have shown some aesthetically appealing variations and some regressions. Compare fixed prompts and seeds before using a strategy as your default.

## Features
- Single node; no additional helper nodes, subgraphs or Nodes 2.0 required.
- Five presets with editable step count and CFG: **Fast, Balanced, Realism, Quality, Turbo**.
- Three sigma strategies: **Native Reference, Stage Weighted, Smooth Warp**.
- **Sigma Strength** (`0.00`–`1.00`) directly below Sigma Strategy in the node UI.
- Native sampler choices (best one cases): **euler**, **er_sde**, **sa_solver**.
- Native scheduler choices (best one cases): **simple**, **sgm_uniform**, **beta**.
- Respects the incoming MODEL's sampling shift; does not reapply shift or modify ComfyUI internals.
- Works with LoRA-patched MOSS models; uses the ComfyUI sampling, noise, masks and preview callbacks (including global **Preview Method: Auto**).

# Installation

### Git
Open a terminal inside the ComfyUI `custom_nodes` directory and clone the repository:

```bash
cd ComfyUI/custom_nodes
git clone https://github.com/VictorDmAlves/comfyui-ollama-bridge
```

### ZIP
1. Download the repository as a ZIP file.
2. Extract it into `ComfyUI/custom_nodes/`.
3. Make sure the final structure is not nested twice.

Restart ComfyUI and add **MOSS Smart Sampler** from `extensions/VicNodes/MOSS Smart Sampler`.

Use a sufficiently recent ComfyUI build with native MOSS-Image support and the selected samplers available. No extra Python packages are installed by this node beyond ComfyUI's own dependencies.

## Quick start
**Turbo (MOSS SFT + compatible 8-step Turbo LoRA):** choose `Turbo`, `steps=0`, `cfg=0`, `sampler_name=euler`, `scheduler=simple`, `sigma_strategy=Native Reference`, `denoise=1.0`, `add_noise=true`. This resolves to **8 steps** and **CFG 1.0**. Switch to Smooth Warp or Stage Weighted with Sigma Strength at `0.50`, `0.75` or `1.00` to explore variations using the **same seed**.

**Standard (MOSS Base/SFT without a Turbo LoRA):** begin with `Balanced`, `steps=0`, `cfg=0` (resolves to **35 steps, CFG 4.0**). You can use your preferred native sampler/scheduler combination, such as `sa_solver + sgm_uniform`, then compare the three sigma strategies while keeping other settings fixed.

**Preset names are targets, not quality guarantees.** The four Standard presets differ in their default steps and in the experimental sigma-curves they generate; the default CFG is 4.0 for all four. Turbo has a separate eight-step curve and default CFG 1.0. Changing the preset does **not** overwrite an explicitly entered positive Steps or CFG value.

## Controls and tooltips
| Control | Actual behavior |
|---|---|
| `MODEL` | MOSS-Image Base or SFT MODEL, already patched with any applicable LoRAs; existing shift is inherited |
| `positive` / `negative` | ComfyUI conditioning inputs; at CFG 1.0, negative prompt guidance generally has no effect |
| `latent_image` | Empty or encoded latent; carries size and optional batch/mask information |
| `seed` | Starting-noise seed; use a fixed value to compare schedules |
| `preset` | Fast / Balanced / Realism / Quality / Turbo |
| `steps` | `0` = preset automatic steps; positive value = explicit override |
| `cfg` | `0.0` = preset automatic CFG; positive value = explicit override |
| `sampler_name` | `euler`, `er_sde`, `sa_solver`; user-selected, not secretly changed |
| `scheduler` | `simple`, `sgm_uniform`, `beta`; determines the native reference curve |
| `sigma_strategy` | Native Reference = unchanged curve; Stage Weighted = three stages; Smooth Warp = continuous redistribution |
| `sigma_strength` | `0.0` Native → `1.0` original experimental curve; ignored for Native Reference |
| `refinement_bias` | `-1.0` to `+1.0`, shifts experimental emphasis earlier/later; `0.0` is original; ignored for Native Reference |
| `denoise` | `1.0` full schedule; values under `1.0` partial schedule; `0.0` returns input unchanged |
| `add_noise` | `true`: seeded noise; `false`: zero starting noise |
| Output | `LATENT` |

Preset defaults:
| Preset | Auto steps | Auto CFG |
|---|---:|---:|
| Fast | 25 | 4.0 |
| Balanced | 35 | 4.0 |
| Realism | 40 | 4.0 |
| Quality | 50 | 4.0 |
| Turbo | 8 | 1.0 |

## Sigma algorithms
The node starts from the selected native ComfyUI scheduler for the model's own `model_sampling`. For Stage Weighted and Smooth Warp, it generates an alternative curve from the native sigma values. It does **not** calculate an independent Flow shift.

```python
sigma_out = native_sigmas + sigma_strength * (candidate_sigmas - native_sigmas)
```

- `Native Reference` always uses the native sigmas, regardless of Sigma Strength or Refinement Bias.
- `Sigma Strength = 0.0` uses the native sigmas exactly.
- `Sigma Strength = 1.0` uses the **original** Stage Weighted or Smooth Warp formula retained from v0.1.x–v0.5.x.
- Intermediate strengths interpolate **sigma values**, not image pixels or generated details.
- No additional denoiser evaluations or speed improvements are claimed.

`refinement_bias` changes the candidate experimental curve; leave it at `0.0` when comparing Sigma Strength values. The chosen `sampler_name` and `scheduler` remain independent user controls.

## Tests and limitations
Run offline tests in the plugin directory:

```bash
python run_tests.py
```

The tests mock ComfyUI and validate sigma formulas, native schedule parity, UI choices, preview callback integration and tooltip metadata. **Offline tests do not replace actual ComfyUI execution on a GPU.** The node has been tested by me with both Turbo and Standard presets, but improvement over the native baseline has not been established systematically.

`examples/` contains API-format JSON examples (not draggable UI workflow exports). Replace model, text encoder, VAE and LoRA filenames for your installation.

## Acknowledgements
- **ComfyUI** and its contributors for the native sampling infrastructure and MOSS-Image support.
- **MOSS-Image** developers for the base architecture and weights.
- **Martin Rizzo's [ComfyUI-ZImagePowerNodes](https://github.com/martin-rizzo/ComfyUI-ZImagePowerNodes)** for inspiring exploration of multi-stage schedules. This plugin does not copy Z-Sampler sigmas or require ZImagePowerNodes.

## License
See [LICENSE](LICENSE).