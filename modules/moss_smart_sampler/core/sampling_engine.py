"""ComfyUI native sampling, with an optional linear sigma-strength interpolation.

No custom integrators, no model modifications, no model_sampling shift reapplication.
"""

from __future__ import annotations

import logging
import math
import time

import comfy.sample
import comfy.samplers
import comfy.utils
import latent_preview
import torch

from . import sigma_utils, standard_engine, ultrafast_engine
from .model_validation import validate_model, model_info

LOGGER = logging.getLogger("MOSS-Smart-Sampler")
SAMPLER_CHOICES = ("euler", "er_sde", "sa_solver")
SCHEDULER_CHOICES = ("simple", "sgm_uniform", "beta")
SIGMA_STRATEGIES = ("Native Reference", "Stage Weighted", "Smooth Warp")


def is_turbo(preset: str) -> bool:
    # Accept the old API preset name as a compatibility alias. The visible
    # ComfyUI dropdown only shows "Turbo"; older UI workflows may need re-selection.
    return preset in (ultrafast_engine.PRESET_NAME, "UltraFast / Turbo")


def resolve_parameters(preset: str, steps: int, cfg: float):
    turbo = is_turbo(preset)
    if not turbo and preset not in standard_engine.PRESET_STEPS:
        raise ValueError(f"Unrecognized MOSS Smart Sampler preset: {preset}")
    if not isinstance(steps, int) or not 0 <= steps <= 150:
        raise ValueError("steps must be 0 (Auto) or between 1 and 150.")
    if not math.isfinite(cfg) or not 0 <= cfg <= 30:
        raise ValueError("cfg must be 0 (Auto) or between 0 and 30.")
    resolved_steps = steps or (ultrafast_engine.DEFAULT_STEPS if turbo else standard_engine.PRESET_STEPS[preset])
    resolved_cfg = cfg or (ultrafast_engine.DEFAULT_CFG if turbo else standard_engine.PRESET_CFG[preset])
    return turbo, resolved_steps, resolved_cfg


def generate_reference_sigmas(model_sampling, scheduler: str, steps: int, denoise: float):
    """ComfyUI native sigmas. The model already owns its shifted sampling logic."""
    if scheduler not in SCHEDULER_CHOICES:
        raise ValueError(f"Unsupported base scheduler: {scheduler}")
    if not 0 < denoise <= 1:
        raise ValueError("denoise must be >0 and <=1 for schedule construction.")
    total_steps = steps if denoise >= 0.9999 else int(steps / denoise)
    native = comfy.samplers.calculate_sigmas(model_sampling, scheduler, total_steps).detach().cpu()
    return native[-(steps + 1):].clone()


def build_schedule(reference: torch.Tensor, preset: str, strategy: str,
                   refinement_bias: float = 0.0, sigma_strength: float = 1.0):
    """Return the selected schedule, retaining original formulas at strength 1.

    For 0 < strength < 1, a convex combination in sigma *value* space:
      result = reference + strength * (original_strategy - reference)
    No reapplication of flow shift, no extra denoiser calls and no changes to
    the original sigma formulas. Both endpoints are retained exactly.
    """
    if strategy not in SIGMA_STRATEGIES:
        raise ValueError(f"Unrecognized sigma strategy: {strategy}")
    if not math.isfinite(sigma_strength) or not 0 <= sigma_strength <= 1:
        raise ValueError("sigma_strength must be finite and between 0.0 and 1.0.")
    steps = reference.numel() - 1

    if strategy == "Native Reference" or sigma_strength == 0.0:
        return sigma_utils.validate_sigmas(reference.clone(), steps)

    if strategy == "Stage Weighted":
        weights = (ultrafast_engine.get_weights() if is_turbo(preset)
                   else standard_engine.get_weights(preset))
        weights = sigma_utils.apply_refinement_bias(weights, refinement_bias)
        candidate = sigma_utils.interpolate_sigmas(
            reference, sigma_utils.stage_positions(steps, weights))
    else:  # Smooth Warp, unmodified original formula
        warp_strength = (ultrafast_engine.smooth_strength(refinement_bias)
                         if is_turbo(preset)
                         else standard_engine.smooth_strength(preset, refinement_bias))
        candidate = sigma_utils.interpolate_sigmas(
            reference, sigma_utils.smooth_positions(steps, warp_strength))

    if sigma_strength == 1.0:
        result = candidate  # Exact bitwise compatibility with original schedule.
    else:
        result = reference + sigma_strength * (candidate - reference)
        result[0] = reference[0]
        result[-1] = reference[-1]
    return sigma_utils.validate_sigmas(result, steps)


def execute(model, positive, negative, latent, seed: int, preset: str, steps: int,
            cfg: float, sampler_name: str, scheduler: str, sigma_strategy: str,
            refinement_bias: float, denoise: float, add_noise: bool,
            sigma_strength: float = 1.0):
    model_sampling = validate_model(model)
    if sampler_name not in SAMPLER_CHOICES:
        raise ValueError("Available samplers are Euler, er_sde, and sa_solver.")
    available = getattr(comfy.samplers, "SAMPLER_NAMES", None)
    if available is not None and sampler_name not in available:
        raise ValueError(f"Sampler {sampler_name!r} is unavailable in this ComfyUI build.")
    if not 0 <= denoise <= 1:
        raise ValueError("denoise must be in the interval [0, 1].")
    turbo, effective_steps, effective_cfg = resolve_parameters(preset, steps, cfg)
    if denoise == 0:
        LOGGER.info("[MOSS Smart Sampler] denoise=0: unchanged input latent returned.")
        return (latent.copy(),)

    reference = generate_reference_sigmas(model_sampling, scheduler, effective_steps, denoise)
    sigmas = build_schedule(reference, preset, sigma_strategy, refinement_bias, sigma_strength)
    if turbo and effective_steps != 8:
        LOGGER.warning("[MOSS Smart Sampler] Turbo mode with %d steps (8 is the validated baseline).", effective_steps)

    samples = latent["samples"]
    samples = comfy.sample.fix_empty_latent_channels(
        model, samples,
        latent.get("downscale_ratio_spacial", None),
        latent.get("downscale_ratio_temporal", None),
    )
    if add_noise:
        noise = comfy.sample.prepare_noise(samples, seed, latent.get("batch_index", None))
    else:
        noise = comfy.sample.prepare_empty_noise(samples)
    noise_mask = latent.get("noise_mask", None)
    callback = latent_preview.prepare_callback(model, effective_steps)
    disable_pbar = not comfy.utils.PROGRESS_BAR_ENABLED
    sampler = comfy.samplers.sampler_object(sampler_name)

    max_abs_deviation = float((sigmas - reference).abs().max())
    LOGGER.info(
        "[MOSS Smart Sampler v1.0.0] %s | preset=%s | steps=%d | cfg=%.2f | "
        "sampler=%s | scheduler=%s | strategy=%s | sigma_strength=%.2f | bias=%.2f | "
        "denoise=%.2f | add_noise=%s | seed=%d | sigma=[%.6f .. %.6f] | max_abs_delta=%.6f",
        model_info(model, model_sampling), preset, effective_steps, effective_cfg,
        sampler_name, scheduler, sigma_strategy, sigma_strength, refinement_bias,
        denoise, add_noise, seed, float(sigmas[0]), float(sigmas[-1]), max_abs_deviation,
    )
    t0 = time.perf_counter()
    result_samples = comfy.sample.sample_custom(
        model, noise, effective_cfg, sampler, sigmas, positive, negative, samples,
        noise_mask=noise_mask, callback=callback, disable_pbar=disable_pbar, seed=seed,
    )
    elapsed = time.perf_counter() - t0
    LOGGER.info("[MOSS Smart Sampler] sampling complete in %.2f s (includes ComfyUI offload).", elapsed)
    out = latent.copy()
    out.pop("downscale_ratio_spacial", None)
    out.pop("downscale_ratio_temporal", None)
    out["samples"] = result_samples
    return (out,)
