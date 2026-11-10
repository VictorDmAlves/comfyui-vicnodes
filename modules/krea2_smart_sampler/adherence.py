"""Opt-in Krea 2 prompt-adherence experiment.

Inspired by the MIT-licensed Krea2 Enhancer by Capitan01R (K3nt3L fork):
https://github.com/K3nt3L/ComfyUI-Krea2-Enhancer

We deliberately use ComfyUI's keyed diffusion-model wrapper rather than
patching model modules between executions. The temporary forward replacement
is always restored in a finally block and never stored in shared model state.
No content-safety filter is disabled by this code.
"""

from __future__ import annotations

import torch

import comfy.patcher_extension

WRAPPER_KEY = "vic_krea2_smart_sampler_adherence_v0_1"
CONFIG_KEY = "vic_krea2_smart_adherence_config"
# The enhanced tap profile matches the reference implementation's 12 taps.
TAP_PROFILE = (1., 1., 1., 1., 1., 1., 1., 2.5, 5., 1.1, 4., 1.)
TOKEN_RELATIVE_CAP = 0.75


def _matches_krea2(model):
    return (
        hasattr(model, "txtfusion")
        and hasattr(model, "txtmlp")
        and hasattr(model, "blocks")
        and hasattr(model, "_unpack_context")
        and int(getattr(model, "txtlayers", -1)) == 12
        and int(getattr(model, "txtdim", -1)) == 2560
    )


def _modified_text(x, strength):
    batch, tokens, taps, dimension = x.shape
    if taps != 12 or dimension != 2560:
        return x
    # Similar tap-specific modulation to Enhancer, but scaling is explicit and
    # the final difference is capped per-token to avoid unbounded changes.
    profile = torch.as_tensor(TAP_PROFILE * 2, device=x.device, dtype=x.dtype)
    gains = (1.0 + strength * (profile - 1.0)).view(1, 1, 24, 1)
    global_gain = 1.0 + 14.0 * strength
    return (x.reshape(batch, tokens, 24, 1280) * gains * global_gain).reshape_as(x)


def _call_original(original, x, mask, transformer_options):
    return original(x, mask=mask, transformer_options=transformer_options)


def _blend_txtfusion(original, x, mask, transformer_options, strength):
    reference = _call_original(original, x, mask, transformer_options)
    if strength <= 0 or x.ndim != 4 or tuple(x.shape[-2:]) != (12, 2560):
        return reference
    candidate = _call_original(original, _modified_text(x, strength), mask, transformer_options)
    ref32 = reference.float()
    delta = candidate.float() - ref32
    axes = (-1,)
    base_rms = ref32.square().mean(dim=axes, keepdim=True).sqrt().clamp_min(1e-8)
    delta_rms = delta.square().mean(dim=axes, keepdim=True).sqrt().clamp_min(1e-8)
    scale = (TOKEN_RELATIVE_CAP * base_rms / delta_rms).clamp(max=1.0)
    return (ref32 + delta * scale).to(dtype=reference.dtype)


def _wrapper(executor, *args, **kwargs):
    opts = kwargs.get("transformer_options")
    if opts is None:
        opts = next((arg for arg in args if isinstance(arg, dict)), {})
    cfg = opts.get(CONFIG_KEY, {})
    if not cfg.get("enabled", False) or cfg.get("_active", False):
        return executor(*args, **kwargs)

    dm = executor.class_obj
    if not _matches_krea2(dm):
        raise RuntimeError("Krea 2 Smart Sampler: prompt adherence requires the Krea2 12-tap text-fusion architecture")

    strength = float(cfg["strength"])
    text_scale = float(cfg["text_scale"])
    if strength <= 0 and text_scale == 1:
        return executor(*args, **kwargs)

    original_fusion = dm.txtfusion.forward
    original_mlp = dm.txtmlp.forward

    def adjusted_fusion(x, mask=None, transformer_options=None):
        return _blend_txtfusion(original_fusion, x, mask, transformer_options or {}, strength)

    def adjusted_mlp(y, *mlp_args, **mlp_kwargs):
        return original_mlp(y, *mlp_args, **mlp_kwargs) * text_scale

    try:
        cfg["_active"] = True
        if strength > 0:
            dm.txtfusion.forward = adjusted_fusion
        if text_scale != 1:
            dm.txtmlp.forward = adjusted_mlp
        return executor(*args, **kwargs)
    finally:
        dm.txtfusion.forward = original_fusion
        dm.txtmlp.forward = original_mlp
        cfg.pop("_active", None)


def attach_adherence(model, enabled: bool, strength: float, text_scale: float):
    if not enabled or (strength <= 0 and text_scale == 1.0):
        return model
    if not hasattr(model, "add_wrapper_with_key"):
        raise RuntimeError("The installed ComfyUI does not support keyed model wrappers; please update ComfyUI")
    patched = model.clone()
    to = patched.model_options.setdefault("transformer_options", {})
    to[CONFIG_KEY] = {
        "enabled": bool(enabled),
        "strength": float(strength),
        "text_scale": float(text_scale),
    }
    patched.add_wrapper_with_key(comfy.patcher_extension.WrappersMP.DIFFUSION_MODEL, WRAPPER_KEY, _wrapper)
    return patched
