"""Standard presets; independent of the Turbo 8-step regime."""

PRESET_STEPS = {"Fast": 25, "Balanced": 35, "Realism": 40, "Quality": 50}
PRESET_CFG = {"Fast": 4.0, "Balanced": 4.0, "Realism": 4.0, "Quality": 4.0}

# Stage counts are hypotheses, NOT empirically proven optimizations.
# The stage regions in sigma_utils are fixed at 30% and 72% of the
# native schedule, so these weights move real evaluation points.
STAGE_WEIGHTS = {
    "Fast": (0.29, 0.48, 0.23),
    "Balanced": (0.24, 0.48, 0.28),
    "Realism": (0.21, 0.46, 0.33),
    "Quality": (0.20, 0.45, 0.35),
}


def get_weights(preset: str):
    if preset not in STAGE_WEIGHTS:
        raise ValueError(f"Not a Standard preset: {preset}")
    return STAGE_WEIGHTS[preset]


def smooth_strength(preset: str, bias: float) -> float:
    defaults = {"Fast": 0.24, "Balanced": 0.34, "Realism": 0.41, "Quality": 0.45}
    return max(-0.85, min(0.85, defaults[preset] + bias * 0.35))
