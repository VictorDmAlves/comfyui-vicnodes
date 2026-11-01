"""Hybrid Sampler v1.0.0.

Native ComfyUI sampling, optional advanced components, and native step previews.
The connected advanced components always take precedence over internal widgets.
"""

import torch

import comfy.model_management
import comfy.nested_tensor
import comfy.sample
import comfy.samplers
import comfy.utils
import latent_preview


class _SeedNoise:
    """Implements the standard NOISE protocol for the internal seed widget."""

    def __init__(self, seed):
        self.seed = seed

    def generate_noise(self, latent):
        samples = latent["samples"]
        return comfy.sample.prepare_noise(samples, self.seed, latent.get("batch_index"))


class HybridSampler:
    CATEGORY = "VicNodes/Hybrid Sampler"
    FUNCTION = "sample"
    RETURN_TYPES = ("LATENT", "LATENT")
    RETURN_NAMES = ("output", "denoised_output")
    DESCRIPTION = (
        "KSampler-style controls with optional NOISE, GUIDER, SAMPLER and SIGMAS "
        "overrides. External inputs take priority. Uses native ComfyUI sampling previews."
    )

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "model": ("MODEL",),
                "positive": ("CONDITIONING",),
                "negative": ("CONDITIONING",),
                "latent_image": ("LATENT",),
                "seed": ("INT", {"default": 0, "min": 0, "max": 0xFFFFFFFFFFFFFFFF, "control_after_generate": True}),
                "steps": ("INT", {"default": 20, "min": 1, "max": 10000}),
                "cfg": ("FLOAT", {"default": 1.0, "min": 0.0, "max": 100.0, "step": 0.1, "round": 0.01}),
                "sampler_name": (comfy.samplers.SAMPLER_NAMES,),
                "scheduler": (comfy.samplers.SCHEDULER_NAMES,),
                "denoise": ("FLOAT", {"default": 1.0, "min": 0.0, "max": 1.0, "step": 0.01}),
            },
            "optional": {
                "sigmas": ("SIGMAS",),
                "sampler": ("SAMPLER",),
                "guider": ("GUIDER",),
                "noise": ("NOISE",),
            },
        }

    @staticmethod
    def _internal_sigmas(model, scheduler, steps, denoise):
        # Exactly the BasicScheduler algorithm; no alternate scheduler math.
        if denoise <= 0.0:
            return torch.FloatTensor([])
        total_steps = steps if denoise >= 1.0 else int(steps / denoise)
        if total_steps < 1:
            raise ValueError("Hybrid Sampler: invalid step count.")
        values = comfy.samplers.calculate_sigmas(
            model.get_model_object("model_sampling"), scheduler, total_steps
        ).cpu()
        return values[-(steps + 1):]

    def sample(
        self, model, positive, negative, latent_image, seed, steps, cfg,
        sampler_name, scheduler, denoise, sigmas=None, sampler=None,
        guider=None, noise=None,
    ):
        # GUIDER can reference its own model. Use it consistently for latent
        # channel adjustment and previews, as SamplerCustomAdvanced does.
        if guider is None:
            guider = comfy.samplers.CFGGuider(model)
            guider.set_conds(positive, negative)
            guider.set_cfg(cfg)
        preview_model = guider.model_patcher

        if sampler is None:
            sampler = comfy.samplers.sampler_object(sampler_name)
        if sigmas is None:
            sigmas = self._internal_sigmas(model, scheduler, steps, denoise)
        if noise is None:
            noise = _SeedNoise(seed)

        if sigmas.ndim != 1:
            raise ValueError("Hybrid Sampler: SIGMAS must be a one-dimensional tensor.")
        if sigmas.numel() < 2:
            # A zero-denoise internal schedule is an intentional no-op.
            if denoise == 0 and sigmas.numel() == 0:
                out = latent_image.copy()
                return (out, out.copy())
            raise ValueError("Hybrid Sampler: SIGMAS must contain at least two values.")

        latent = latent_image.copy()
        samples = comfy.sample.fix_empty_latent_channels(
            preview_model,
            latent["samples"],
            latent.get("downscale_ratio_spacial"),
            latent.get("downscale_ratio_temporal"),
        )
        latent["samples"] = samples
        x0_output = {}
        # This is the same callback used by SamplerCustomAdvanced. It respects
        # Settings > Preview method (auto/latent2rgb/taesd/none).
        callback = latent_preview.prepare_callback(preview_model, sigmas.shape[-1] - 1, x0_output)
        result = guider.sample(
            noise.generate_noise(latent), samples, sampler, sigmas,
            denoise_mask=latent.get("noise_mask"),
            callback=callback,
            disable_pbar=not comfy.utils.PROGRESS_BAR_ENABLED,
            seed=noise.seed,
        )
        result = result.to(comfy.model_management.intermediate_device())

        out = latent.copy()
        out.pop("downscale_ratio_spacial", None)
        out.pop("downscale_ratio_temporal", None)
        out["samples"] = result

        if "x0" not in x0_output:
            return (out, out.copy())

        x0 = x0_output["x0"]
        if result.is_nested and not x0.is_nested:
            shapes = [t.shape for t in result.unbind()]
            x0 = comfy.nested_tensor.NestedTensor(comfy.utils.unpack_latents(x0, shapes))
        denoised = out.copy()
        denoised["samples"] = preview_model.model.process_latent_out(x0.cpu())
        return (out, denoised)
