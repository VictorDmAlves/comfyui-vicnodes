"""One-node standalone Krea 2 Smart Sampler for both RAW and Turbo.

Native Reference delegates to ComfyUI's original KSampler entry point.
The quality_preset is a UI hint; the frontend writes actual Steps/CFG and
this backend always executes the displayed numbers without hidden overrides.
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
                # Base sampling: identical controls/semantics to ComfyUI KSampler.
                "seed": ("INT", {"default": 0, "min": 0, "max": 0xffffffffffffffff,
                                 "control_after_generate": True}),
                "steps": ("INT", {"default": 32, "min": 1, "max": 1000,
                                  "tooltip": "Actual executed steps. A preset fills this value; editing it switches the preset to Custom."}),
                "cfg": ("FLOAT", {"default": 3.5, "min": 0.0, "max": 20.0, "step": 0.1,
                                  "tooltip": "Actual executed CFG. Turbo reference: 1.0; RAW reference: 3.5."}),
                "sampler_name": (comfy.samplers.KSampler.SAMPLERS, {
                    "default": "euler", "tooltip": "Native ComfyUI sampler. Refined Solver requires Euler."}),
                "scheduler": (comfy.samplers.KSampler.SCHEDULERS, {
                    "default": "simple", "tooltip": "Native ComfyUI scheduler. Uses the MODEL's existing flow shift."}),
                "denoise": ("FLOAT", {"default": 1.0, "min": 0.0, "max": 1.0, "step": 0.01}),
                # Single preset selector. Turbo = distilled checkpoint; other rows = RAW.
                "quality_preset": (list(PRESET_NAMES), {
                    "default": "Balanced", "tooltip": "Turbo: distilled Krea 2 Turbo (8 / CFG 1). Fast, Balanced, Quality: Krea 2 RAW. Selects visible Steps/CFG only; load the matching checkpoint upstream. Manual edits switch to Custom."}),
                # All four already validated modes retain their algorithms.
                "sampling_mode": (list(MODES), {
                    "default": "Native Reference", "tooltip": "Native uses ComfyUI's KSampler directly; the other three modes are experimental."}),
                "sigma_strength": ("FLOAT", {"default": 0.5, "min": 0.0, "max": 1.0, "step": 0.05,
                    "tooltip": "Warp strength (Stage/Smooth), or derivative correction (Refined). Ignored by Native Reference; 0=no correction."}),
                # Independent text-fusion option, disabled unless requested.
                "prompt_adherence": ("BOOLEAN", {"default": False,
                    "tooltip": "Experimental prompt fidelity adjustment; OFF for exact native KSampler comparison."}),
                "adherence_strength": ("FLOAT", {"default": 0.5, "min": 0.0, "max": 2.0, "step": 0.05,
                    "tooltip": "Strength of the optional Krea 2 text-fusion adjustment."}),
                "text_scale": ("FLOAT", {"default": 1.0, "min": 0.25, "max": 4.0, "step": 0.05,
                    "tooltip": "Scales the internal txtmlp output when prompt adherence is enabled; 1.00 is neutral."}),
            },
            "optional": {
                "add_noise": ("BOOLEAN", {"default": True,
                    "tooltip": "True for normal sampling; disable to sample existing noisy latents."}),
            },
        }

    RETURN_TYPES = ("LATENT",)
    RETURN_NAMES = ("samples",)
    FUNCTION = "sample"
    CATEGORY = "VicNodes/Krea 2 Smart Sampler"
    DESCRIPTION = (
        "Standalone Krea 2 Turbo/RAW sampler with independent quality presets, "
        "native ComfyUI reference, three experimental sampling modes and optional prompt adherence."
    )

    def sample(self, model, positive, negative, latent_image, seed, steps, cfg,
               sampler_name="euler", scheduler="simple", denoise=1.0,
               quality_preset="Balanced",
               sampling_mode="Native Reference", sigma_strength=0.5,
               prompt_adherence=False, adherence_strength=0.5,
               text_scale=1.0, add_noise=True):
        import comfy.sample
        import comfy.samplers
        import comfy.utils
        import latent_preview

        if type(model.model).__name__ != "Krea2":
            raise TypeError("Krea 2 Smart Sampler supports ComfyUI's Krea2 model only.")
        # This validates UI selections, but intentionally DOES NOT alter steps
        # or CFG: the widget values the user sees are exactly what runs.
        get_preset(quality_preset)
        if sampler_name not in comfy.samplers.KSampler.SAMPLERS:
            raise ValueError(f"Unknown ComfyUI sampler: {sampler_name}")
        if scheduler not in comfy.samplers.KSampler.SCHEDULERS:
            raise ValueError(f"Unknown ComfyUI scheduler: {scheduler}")
        if sampling_mode not in MODES:
            raise ValueError(f"Unknown Krea 2 Smart Sampler mode: {sampling_mode}")
        if sampling_mode == "Refined Solver" and sampler_name != "euler":
            raise ValueError(
                "Refined Solver is an Euler-family solver. Select sampler_name='euler', "
                "or use another sampling_mode with your chosen sampler."
            )
        if not (0.0 <= float(sigma_strength) <= 1.0):
            raise ValueError("sigma_strength must be between 0 and 1")

        samples = latent_image["samples"]
        # EmptyLatentImage commonly supplies 4D [B,C,H,W], whereas Krea 2's
        # Qwen/Wan-family VAE can encode IMG2IMG input as 5D [B,C,T,H,W]
        # (usually T=1 for an image). ComfyUI's KSampler accepts both and
        # fix_empty_latent_channels() normalizes 4D latents when required.
        # Do not squeeze, reshape or convert encoded 5D latents: preserving
        # their original dimensionality is essential for IMG2IMG fidelity.
        if not torch.is_tensor(samples) or samples.ndim not in (4, 5):
            raise TypeError(
                "Krea 2 Smart Sampler requires a 4D or 5D LATENT "
                "([batch, channels, height, width] or "
                "[batch, channels, frames, height, width])"
            )
        # Avoid imposing extra spatial-size checks beyond those in the native
        # ComfyUI sampler. VAEEncode and KSampler own size compatibility.
        if denoise <= 0:
            return (latent_image.copy(),)

        sampling_model = attach_adherence(model, bool(prompt_adherence), float(adherence_strength), float(text_scale))
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

        if sampling_mode == "Native Reference":
            callback = latent_preview.prepare_callback(sampling_model, int(steps))
            result = comfy.sample.sample(
                sampling_model, noise, int(steps), float(cfg), sampler_name, scheduler,
                positive, negative, fixed,
                denoise=float(denoise), disable_noise=not add_noise,
                noise_mask=noise_mask, callback=callback,
                disable_pbar=disable_pbar, seed=int(seed),
            )
        else:
            sigmas = make_sigmas(sampling_model, int(steps), float(denoise),
                                 sampling_mode, float(sigma_strength),
                                 sampler_name=sampler_name, scheduler=scheduler)
            if sigmas.numel() < 2:
                return (latent_image.copy(),)
            if sampling_mode == "Refined Solver":
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
