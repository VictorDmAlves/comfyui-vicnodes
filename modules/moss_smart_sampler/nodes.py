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
                "preset": (["Fast", "Balanced", "Realism", "Quality", "Turbo", "Custom"],
                           {"default": "Balanced",
                            "tooltip": "Selecting a preset fills Steps and CFG: Fast 25/4, Balanced 35/4, Realism 40/4, Quality 50/4, Turbo 8/1. Editing Steps or CFG selects Custom and retains the original sigma profile."}),
                "steps": ("INT", {"default": 35, "min": 0, "max": 150,
                                 "tooltip": "Steps for the selected profile. Presets fill this field automatically; manual edits select Custom. Defaults: Fast 25, Balanced 35, Realism 40, Quality 50, Turbo 8. Legacy workflows with 0 still use preset steps. Stage Weighted needs at least 3."}),
                "cfg": ("FLOAT", {"default": 4.0, "min": 0.0, "max": 30.0, "step": 0.1,
                                  "tooltip": "Guidance strength. Presets fill CFG automatically: 4.0 for Fast/Balanced/Realism/Quality, 1.0 for Turbo. Manual edits select Custom. Legacy workflows with CFG 0 still use preset CFG. At CFG 1.0, negative guidance generally has no effect."}),
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
            "optional": {
                # Internal profile origin: needed to keep the Turbo/Standard sigma engine
                # unchanged after a user edits Steps/CFG and the preset becomes Custom.
                # The frontend hides this widget, but ComfyUI still serializes it.
                "custom_base_preset": ("STRING", {"default": "Balanced", "multiline": False,
                    "tooltip": "Internal preset origin used by Custom. Managed automatically by the MOSS Smart Sampler frontend."}),
            },
        }

    RETURN_TYPES = ("LATENT",)
    RETURN_NAMES = ("LATENT",)
    FUNCTION = "sample"
    CATEGORY = "VicNodes/MOSS Smart Sampler"
    DESCRIPTION = (
        "MOSS Smart Sampler v1.1.0: Stage Weighted / Smooth Warp with adjustable Sigma Strength. "
        "Native sampler backend, inherited model shift, Turbo 8-step preset; no custom integrators."
    )

    def sample(self, model, positive, negative, latent_image, seed, preset, steps, cfg,
               sampler_name, scheduler, sigma_strategy, refinement_bias, denoise,
               add_noise, sigma_strength=1.0, custom_base_preset="Balanced"):
        return execute(
            model=model, positive=positive, negative=negative, latent=latent_image,
            seed=seed, preset=preset, steps=steps, cfg=cfg,
            sampler_name=sampler_name, scheduler=scheduler,
            sigma_strategy=sigma_strategy, refinement_bias=refinement_bias,
            denoise=denoise, add_noise=add_noise, sigma_strength=sigma_strength,
            custom_base_preset=custom_base_preset,
        )
