"""Original eight-step Turbo Stage Weighted and Smooth Warp formulas.

The original curves are intentionally UNCHANGED. The global Sigma Strength
parameter is applied later, in sampling_engine.build_schedule.
"""

PRESET_NAME = "Turbo"
DEFAULT_STEPS = 8
DEFAULT_CFG = 1.0

STAGE_WEIGHTS = (0.22, 0.56, 0.22)


def get_weights():
    return STAGE_WEIGHTS


def smooth_strength(bias: float) -> float:
    return max(-0.80, min(0.80, 0.22 + bias * 0.42))
