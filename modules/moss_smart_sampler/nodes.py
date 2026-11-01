"""Single legacy ComfyUI node (no Nodes 2.0 or frontend dependencies)."""

from __future__ import annotations

from .core.sampling_engine import execute


class MOSSSmartSampler:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "model": ("MODEL", {"tooltip": "Connect a MOSS-Image Base/SFT MODEL (with any LoRAs already applied). The model's existing flow shift is respected."}),
                "positive": ("CONDITIONING", {"tooltip": "Positive prompt conditioning from your text encoder; guides the requested content."}),
                "negative": ("CONDITIONING", {"tooltip": "Negative prompt conditioning. At CFG 1.0 (Turbo Auto), negative guidance generally has no effect."}),
                "latent_image": ("LATENT", {"tooltip": "Input latent: an empty latent for TXT2IMG or an encoded latent for IMG2IMG. Sets image size and batch."}),
                "seed": ("INT", {"default": 0, "min": 0, "max": 0xffffffffffffffff,
                                "control_after_generate": True,
                                "tooltip": "Random seed for starting noise when Add Noise is enabled. Keep it fixed to compare settings fairly."}),
                "preset": (["Fast", "Balanced", "Realism", "Quality", "Turbo"],
                           {"default": "Balanced",
                            "tooltip": "Starting profiles: Fast 25, Balanced 35, Realism 40, Quality 50, Turbo 8 steps. Standard Auto CFG is 4.0; Turbo Auto CFG is 1.0. Names describe goals, not guaranteed quality."}),
                "steps": ("INT", {"default": 0, "min": 0, "max": 150,
                                 "tooltip": "0 = Auto steps: Fast 25, Balanced 35, Realism 40, Quality 50, Turbo 8. Enter 1-150 to override. Stage Weighted needs at least 3 steps."}),
                "cfg": ("FLOAT", {"default": 0.0, "min": 0.0, "max": 30.0, "step": 0.1,
                                  "tooltip": "0.0 = Auto CFG: Fast, Balanced, Realism, Quality use 4.0; Turbo uses 1.0. Any positive value overrides the preset. At CFG 1.0, negative guidance generally has no effect."}),
                "sampler_name": (["euler", "er_sde", "sa_solver"],
                                 {"default": "euler",
                                  "tooltip": "ComfyUI sampling solver: euler, er_sde or sa_solver. Euler is the tested 8-step Turbo baseline; try sa_solver for Standard. Your choice is never changed by a preset."}),
                "scheduler": (["simple", "sgm_uniform", "beta"],
                              {"default": "simple",
                               "tooltip": "Native ComfyUI sigma schedule: simple, sgm_uniform or beta. Sets the baseline noise levels before any Stage Weighted / Smooth Warp adjustment."}),
                "sigma_strategy": (["Native Reference", "Stage Weighted", "Smooth Warp"],
                                   {"default": "Native Reference",
                                    "tooltip": "Native Reference uses the selected scheduler unchanged. Stage Weighted redistributes steps across three stages; Smooth Warp smoothly shifts sigma positions. Both are experimental."}),
                "sigma_strength": ("FLOAT", {"default": 1.0, "min": 0.0, "max": 1.0,
                                           "step": 0.05,
                                           "tooltip": "0.0 = Native sigmas; 1.0 = full Stage Weighted / Smooth Warp formula; between = blend of the two sigma schedules. Ignored by Native Reference. Does not add steps."}),
                "refinement_bias": ("FLOAT", {"default": 0.0, "min": -1.0, "max": 1.0,
                                            "step": 0.05,
                                            "tooltip": "Fine-tunes the experimental sigma curve: negative favors earlier stages, positive favors later stages. 0.0 keeps the original formula. Ignored by Native Reference."}),
                "denoise": ("FLOAT", {"default": 1.0, "min": 0.0, "max": 1.0,
                                    "step": 0.01,
                                    "tooltip": "1.0 = full sampling (usual TXT2IMG). Below 1.0 = partial native schedule (useful for IMG2IMG). 0.0 returns the input latent unchanged."}),
                "add_noise": ("BOOLEAN", {"default": True,
                                         "tooltip": "Enabled: start from seed-based noise. Disabled: use zero starting noise, useful for some continuation workflows; this does not automatically preserve a source image."}),
            },
        }

    RETURN_TYPES = ("LATENT",)
    RETURN_NAMES = ("LATENT",)
    FUNCTION = "sample"
    CATEGORY = "VicNodes/MOSS Smart Sampler"
    DESCRIPTION = (
        "MOSS Smart Sampler v1.0.0: Stage Weighted / Smooth Warp with adjustable Sigma Strength. "
        "Native sampler backend, inherited model shift, Turbo 8-step preset; no custom integrators."
    )

    def sample(self, model, positive, negative, latent_image, seed, preset, steps, cfg,
               sampler_name, scheduler, sigma_strategy, refinement_bias, denoise,
               add_noise, sigma_strength=1.0):
        return execute(
            model=model, positive=positive, negative=negative, latent=latent_image,
            seed=seed, preset=preset, steps=steps, cfg=cfg,
            sampler_name=sampler_name, scheduler=scheduler,
            sigma_strategy=sigma_strategy, refinement_bias=refinement_bias,
            denoise=denoise, add_noise=add_noise, sigma_strength=sigma_strength,
        )
