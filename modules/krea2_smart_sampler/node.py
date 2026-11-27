"""Krea 2 Smart Sampler: native/custom paths plus optional SAMPLER and SIGMAS.

Presets are a frontend aid: the backend always samples with the visible Steps/CFG.
Native Reference retains the official ComfyUI KSampler path when no external
SAMPLER or SIGMAS are connected.
"""

from __future__ import annotations

import torch

from .schedule import make_sigmas
from .solver import sample_refined
from .adherence import attach_adherence
from .presets import MODES, PRESET_NAMES, get_preset


class Krea2SmartSampler:
    @classmethod
    def INPUT_TYPES(cls):
        import comfy.samplers

        return {
            "required": {
                "model": ("MODEL",),
                "positive": ("CONDITIONING",),
                "negative": ("CONDITIONING",),
                "latent_image": ("LATENT",),
                # Control-after-generate is ComfyUI's native seed companion.
                "seed": ("INT", {"default": 0, "min": 0, "max": 0xffffffffffffffff,
                                "control_after_generate": True}),
                "preset": (list(PRESET_NAMES), {
                    "default": "Balanced",
                    "tooltip": "Turbo uses 8 steps / CFG 1.0. Fast, Balanced and Quality target RAW. Selecting a preset fills Steps and CFG; editing either switches to Custom."}),
                "steps": ("INT", {"default": 32, "min": 1, "max": 1000,
                                 "tooltip": "Sampling steps (ignored for schedule construction when external SIGMAS are connected). Manual edits select Custom."}),
                "cfg": ("FLOAT", {"default": 3.5, "min": 0.0, "max": 20.0, "step": 0.1,
                                 "tooltip": "CFG guidance. Turbo reference: 1.0; RAW Balanced: 3.5. Manual edits select Custom."}),
                "sampler_name": (comfy.samplers.KSampler.SAMPLERS, {
                    "default": "euler", "tooltip": "Internal sampler, ignored when an external SAMPLER is connected. Refined Solver requires Euler only when no external sampler/sigmas are connected."}),
                "scheduler": (comfy.samplers.KSampler.SCHEDULERS, {
                    "default": "simple", "tooltip": "Internal sigma schedule. Ignored when external SIGMAS are connected."}),
                "denoise": ("FLOAT", {"default": 1.0, "min": 0.0, "max": 1.0, "step": 0.01,
                                     "tooltip": "Denoising strength when generating internal sigmas; ignored when external SIGMAS are connected."}),
                "mode": (list(MODES), {
                    "default": "Native Reference",
                    "tooltip": "Native Reference, Stage Weighted, Smooth Warp, Refined Solver. With external SIGMAS, all mode modifications are bypassed; an external SAMPLER supersedes the Refined Solver integration."}),
                "sigma_strength": ("FLOAT", {"default": 0.5, "min": 0.0, "max": 1.0, "step": 0.05,
                    "tooltip": "Intensity of Stage/Smooth sigma warps or Refined Solver correction. Ignored by Native Reference and when external SIGMAS are provided."}),
                "prompt_adherence": ("BOOLEAN", {"default": False,
                    "tooltip": "Optional experimental Krea 2 text conditioning adjustment. OFF for exact Native KSampler comparisons."}),
                "adherence_strength": ("FLOAT", {"default": 0.5, "min": 0.0, "max": 2.0, "step": 0.05,
                    "tooltip": "Strength of the optional text-fusion adjustment."}),
                "text_scale": ("FLOAT", {"default": 1.0, "min": 0.25, "max": 4.0, "step": 0.05,
                    "tooltip": "Internal txtmlp output multiplier when Prompt Adherence is enabled. 1.00 = neutral."}),
                "add_noise": ("BOOLEAN", {"default": True,
                    "tooltip": "Whether to add initial noise. Disable for workflows that already provide a noisy latent."}),
            },
            "optional": {
                "sampler_opt": ("SAMPLER", {"tooltip": "Overrides sampler_name and any Refined Solver integration when connected."}),
                "sigmas_opt": ("SIGMAS", {"tooltip": "Use these sigmas exactly as supplied. Bypasses internal steps/scheduler/denoise sigma construction and mode/sigma_strength modifications."}),
            },
        }

    RETURN_TYPES = ("LATENT",)
    RETURN_NAMES = ("samples",)
    FUNCTION = "sample"
    CATEGORY = "VicNodes/Krea 2 Smart Sampler"
    DESCRIPTION = (
        "Krea 2 Turbo/RAW sampler with quality presets, four sampling modes, "
        "optional external SAMPLER/SIGMAS, and prompt adherence."
    )

    def sample(self, model, positive, negative, latent_image, seed, preset="Balanced",
               steps=32, cfg=3.5, sampler_name="euler", scheduler="simple",
               denoise=1.0, mode="Native Reference", sigma_strength=0.5,
               prompt_adherence=False, adherence_strength=0.5, text_scale=1.0,
               add_noise=True, sampler_opt=None, sigmas_opt=None):
        import comfy.sample
        import comfy.samplers
        import comfy.utils
        import latent_preview

        if type(model.model).__name__ != "Krea2":
            raise TypeError("Krea 2 Smart Sampler supports ComfyUI's Krea2 model only.")
        # The selected preset never changes actual Steps/CFG behind the scenes.
        get_preset(preset)
        if mode not in MODES:
            raise ValueError(f"Unknown Krea 2 Smart Sampler mode: {mode}")
        has_external_sampler = sampler_opt is not None
        has_external_sigmas = sigmas_opt is not None

        if not has_external_sampler and sampler_name not in comfy.samplers.KSampler.SAMPLERS:
            raise ValueError(f"Unknown ComfyUI sampler: {sampler_name}")
        if not has_external_sigmas and scheduler not in comfy.samplers.KSampler.SCHEDULERS:
            raise ValueError(f"Unknown ComfyUI scheduler: {scheduler}")
        # Refined uses its own Euler-family integration. An external sampler takes
        # precedence; external SIGMAS explicitly bypass all mode modifications.
        if not has_external_sampler and not has_external_sigmas and mode == "Refined Solver" and sampler_name != "euler":
            raise ValueError("Refined Solver is an Euler-family solver. Select sampler_name='euler', "
                             "or use another mode with the chosen sampler.")
        if not has_external_sigmas and not (0.0 <= float(sigma_strength) <= 1.0):
            raise ValueError("sigma_strength must be between 0 and 1")

        samples = latent_image["samples"]
        if not torch.is_tensor(samples) or samples.ndim not in (4, 5):
            raise TypeError(
                "Krea 2 Smart Sampler requires a 4D or 5D LATENT "
                "([batch, channels, height, width] or "
                "[batch, channels, frames, height, width])"
            )
        # External sigmas are authoritative; internal denoise must not truncate
        # or disable them, even if the denoise widget is 0.
        if not has_external_sigmas and denoise <= 0:
            return (latent_image.copy(),)
        if has_external_sigmas:
            if not torch.is_tensor(sigmas_opt) or sigmas_opt.ndim != 1 or sigmas_opt.numel() < 2:
                raise TypeError("External SIGMAS must be a 1D torch.Tensor containing at least two values.")
            # No warp, sorting, casting, truncation, or cloning of external SIGMAS.
            sigmas = sigmas_opt
        else:
            sigmas = None

        sampling_model = attach_adherence(
            model, bool(prompt_adherence), float(adherence_strength), float(text_scale)
        )
        fixed = comfy.sample.fix_empty_latent_channels(
            sampling_model, samples,
            latent_image.get("downscale_ratio_spacial"),
            latent_image.get("downscale_ratio_temporal"),
        )
        batch_inds = latent_image.get("batch_index")
        noise = (comfy.sample.prepare_noise(fixed, int(seed), batch_inds)
                 if add_noise else comfy.sample.prepare_empty_noise(fixed))
        noise_mask = latent_image.get("noise_mask")
        disable_pbar = not comfy.utils.PROGRESS_BAR_ENABLED

        # This path is intentionally unchanged: exact KSampler behavior when
        # using the native reference with no external overrides.
        if mode == "Native Reference" and not has_external_sampler and not has_external_sigmas:
            callback = latent_preview.prepare_callback(sampling_model, int(steps))
            result = comfy.sample.sample(
                sampling_model, noise, int(steps), float(cfg), sampler_name, scheduler,
                positive, negative, fixed,
                denoise=float(denoise), disable_noise=not add_noise,
                noise_mask=noise_mask, callback=callback,
                disable_pbar=disable_pbar, seed=int(seed),
            )
        else:
            if sigmas is None:
                # If an external sampler is connected, sampler_name must truly
                # be ignored. Euler is a neutral schedule-construction fallback.
                # Samplers requiring a special penultimate sigma should be paired
                # with external SIGMAS for exact schedule control.
                schedule_sampler_name = "euler" if has_external_sampler else sampler_name
                schedule_mode = ("Native Reference" if has_external_sampler and mode == "Refined Solver"
                                 else mode)
                sigmas = make_sigmas(
                    sampling_model, int(steps), float(denoise), schedule_mode,
                    float(sigma_strength), sampler_name=schedule_sampler_name,
                    scheduler=scheduler,
                )
                if sigmas.numel() < 2:
                    return (latent_image.copy(),)

            if has_external_sampler:
                sampler = sampler_opt
            elif has_external_sigmas:
                # External sigmas bypass even the Refined Solver mode, by design.
                sampler = comfy.samplers.sampler_object(sampler_name)
            elif mode == "Refined Solver":
                sampler = comfy.samplers.KSAMPLER(sample_refined, {"correction": float(sigma_strength)})
            else:
                sampler = comfy.samplers.sampler_object(sampler_name)

            callback = latent_preview.prepare_callback(sampling_model, len(sigmas) - 1)
            result = comfy.sample.sample_custom(
                sampling_model, noise, float(cfg), sampler, sigmas,
                positive, negative, fixed,
                noise_mask=noise_mask, callback=callback,
                disable_pbar=disable_pbar, seed=int(seed),
            )

        out = latent_image.copy()
        out.pop("downscale_ratio_spacial", None)
        out.pop("downscale_ratio_temporal", None)
        out["samples"] = result
        return (out,)
