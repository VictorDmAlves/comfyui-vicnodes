"""Experimental sigma remapping based on ComfyUI's exact KSampler schedule.

The chosen sampler and scheduler, including any special penultimate-sigma
handling and img2img denoise slicing, are respected before modifying sigmas.
The native mode never calls this module: it goes through comfy.sample.sample.
"""

from __future__ import annotations

import math

import torch


def make_sigmas(model, steps: int, denoise: float, mode: str, strength: float,
                sampler_name: str = "euler", scheduler: str = "simple"):
    import comfy.samplers

    if not 0 <= denoise <= 1:
        raise ValueError("denoise must be between 0 and 1")
    if steps < 1:
        raise ValueError("steps must be at least 1")
    if denoise == 0:
        return torch.empty(0, dtype=torch.float32)

    ksampler = comfy.samplers.KSampler(
        model, steps=int(steps), device=model.load_device,
        sampler=sampler_name, scheduler=scheduler,
        denoise=float(denoise), model_options=model.model_options,
    )
    # Sampling machinery will move the tensor to the correct device.
    sigmas = ksampler.sigmas.cpu()
    if mode == "Refined Solver" or strength == 0.0 or steps == 1:
        return sigmas
    return warp_sigmas(sigmas, mode, strength)


def warp_sigmas(base: torch.Tensor, mode: str, strength: float) -> torch.Tensor:
    """Monotonic positional warp preserving both endpoints and length."""
    if mode not in ("Stage Weighted", "Smooth Warp"):
        raise ValueError(f"Unknown sigma warp mode: {mode}")
    if not 0.0 <= strength <= 1.0:
        raise ValueError("sigma_strength must be between 0 and 1")
    if base.ndim != 1 or len(base) < 2:
        raise ValueError("sigmas must be a 1D tensor with at least 2 values")
    if bool(torch.any(base[:-1] < base[1:])):
        raise ValueError("Input sigmas must be monotonically descending")
    if strength == 0:
        return base.clone()

    n = len(base) - 1
    progress = torch.linspace(0, 1, n + 1, dtype=torch.float64, device=base.device)
    if mode == "Stage Weighted":
        remapped = progress.pow(1.0 - 0.35 * strength)
    else:
        remapped = progress + (0.40 * strength / (2 * math.pi)) * torch.sin(2 * math.pi * progress)

    positions = remapped.clamp(0.0, 1.0) * n
    lower = positions.floor().long()
    upper = positions.ceil().long()
    weight = (positions - lower).to(base.dtype)
    out = base[lower] * (1.0 - weight) + base[upper] * weight
    out[0] = base[0]
    out[-1] = base[-1]
    return out
