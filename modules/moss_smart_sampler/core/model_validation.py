"""Read-only checks for the native MOSS model and its sampling configuration."""

from __future__ import annotations


def validate_model(model):
    """Validate without changing MODEL, patches, LoRAs or model_sampling.

    The native ComfyUI wrapper is comfy.model_base.MOSSImage. Different
    wrappers that erase this type are intentionally not certified in v0.1.0.
    """
    base = getattr(model, "model", None)
    if base is None:
        raise ValueError("MOSS Smart Sampler: MODEL has no native model wrapper.")
    name = type(base).__name__.lower()
    diffusion = getattr(base, "diffusion_model", None)
    diffusion_name = type(diffusion).__name__.lower() if diffusion is not None else ""
    if "moss" not in name and "moss" not in diffusion_name:
        raise ValueError(
            "MOSS Smart Sampler accepts MOSS-Image models only. "
            f"Received MODEL type {type(base).__name__!r}."
        )
    try:
        sampling = model.get_model_object("model_sampling")
    except (AttributeError, KeyError, ValueError) as exc:
        raise ValueError("MOSS Smart Sampler: MODEL has no model_sampling object.") from exc
    if not hasattr(sampling, "sigma_max") or not hasattr(sampling, "sigma"):
        raise ValueError("MOSS Smart Sampler: incompatible model_sampling object.")
    multiplier = getattr(sampling, "multiplier", None)
    if multiplier is not None and abs(float(multiplier) - 1.0) > 1e-6:
        raise ValueError(
            "MOSS Smart Sampler: native MOSS requires flow timestep multiplier 1. "
            "Avoid ModelSamplingSD3 (multiplier 1000); use the default model "
            "sampling or ModelSamplingAuraFlow instead."
        )
    return sampling


def model_info(model, sampling) -> str:
    base = getattr(model, "model", None)
    shift = getattr(sampling, "shift", "unknown")
    multiplier = getattr(sampling, "multiplier", "unknown")
    return f"model={type(base).__name__} | shift(inherited)={shift} | multiplier={multiplier}"
