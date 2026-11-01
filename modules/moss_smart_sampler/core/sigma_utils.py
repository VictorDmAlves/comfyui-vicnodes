"""Pure sigma-index transformations; never recompute or apply a flow shift.

The native ComfyUI scheduler first produces a complete shifted sigma curve.
We only relocate evaluation points *along that existing curve*. This avoids
applying ModelSamplingDiscreteFlow's shift a second time.
"""

from __future__ import annotations

import math
import torch


def stage_counts(steps: int, weights: tuple[float, float, float]) -> tuple[int, int, int]:
    """Allocate exactly `steps` to 3 stages, at least one per stage.

    Largest-remainder method makes Turbo 4/6/8 steps deterministic.
    """
    if steps < 3:
        raise ValueError("Stage Weighted requires at least three steps.")
    if len(weights) != 3 or any(not math.isfinite(w) or w <= 0 for w in weights):
        raise ValueError("Stage weights must be three positive finite numbers.")
    normalized = [w / sum(weights) for w in weights]
    extras = steps - 3
    quotas = [extras * w for w in normalized]
    floors = [int(math.floor(q)) for q in quotas]
    left = extras - sum(floors)
    priority = sorted(range(3), key=lambda k: (-(quotas[k] - floors[k]), k))
    counts = [1 + floors[i] for i in range(3)]
    for i in priority[:left]:
        counts[i] += 1
    return tuple(counts)


def stage_positions(steps: int, weights: tuple[float, float, float],
                    boundaries: tuple[float, float] = (0.30, 0.72)) -> list[float]:
    """Normalized progress positions; continuous and strictly increasing."""
    b1, b2 = boundaries
    if not 0 < b1 < b2 < 1:
        raise ValueError("Stage boundaries must satisfy 0 < b1 < b2 < 1.")
    c1, c2, c3 = stage_counts(steps, weights)
    progress = [i * b1 / c1 for i in range(c1)]
    progress += [b1 + i * (b2 - b1) / c2 for i in range(c2)]
    progress += [b2 + i * (1.0 - b2) / c3 for i in range(c3)]
    return progress + [1.0]


def smooth_positions(steps: int, strength: float) -> list[float]:
    """A smooth monotonic warp of sampling progress, endpoints unchanged.

    strength > 0 spends more evaluations near the *end* of sampling.
    |strength| < 1 ensures d(progress)/du > 0 everywhere.
    """
    if steps < 1 or not math.isfinite(strength) or abs(strength) >= 1:
        raise ValueError("Smooth Warp requires steps >= 1 and |strength| < 1.")
    out = []
    for index in range(steps + 1):
        u = index / steps
        out.append(u + strength * u * (1.0 - u))
    out[0], out[-1] = 0.0, 1.0
    return out



def interpolate_sigmas(reference: torch.Tensor, positions: list[float]) -> torch.Tensor:
    """Linear interpolation in *native scheduler index space*, not raw t/sigma.

    Interpolating shifted sigma values (and not shifting again) preserves the
    incoming model_sampling settings. This is a *candidate* experimental
    schedule, not equivalent to an exact timestep-inverted flow formula.
    """
    if reference.ndim != 1 or reference.numel() < 2:
        raise ValueError("Expected a one-dimensional native sigma schedule.")
    if len(positions) < 2 or abs(positions[0]) > 1e-10 or abs(positions[-1] - 1.0) > 1e-10:
        raise ValueError("Positions must start at 0 and end at 1.")
    if any((not math.isfinite(x) or x < 0 or x > 1) for x in positions):
        raise ValueError("Sigma positions must be finite and within [0, 1].")
    if any(positions[i] <= positions[i - 1] for i in range(1, len(positions))):
        raise ValueError("Sigma positions must be strictly increasing.")
    coords = torch.tensor(positions, dtype=torch.float64, device=reference.device) * (reference.numel() - 1)
    before = coords.floor().long().clamp(max=reference.numel() - 1)
    after = (before + 1).clamp(max=reference.numel() - 1)
    mix = (coords - before).to(dtype=reference.dtype)
    values = reference[before] * (1 - mix) + reference[after] * mix
    values[0] = reference[0]
    values[-1] = reference[-1]
    return values


def apply_refinement_bias(weights: tuple[float, float, float], bias: float):
    """Move at most 10 percentage points between composition and refinement."""
    if not math.isfinite(bias) or not -1.0 <= bias <= 1.0:
        raise ValueError("Refinement bias must be between -1 and 1.")
    a, b, c = weights
    a = max(0.06, a - 0.10 * bias)
    c = max(0.06, c + 0.10 * bias)
    total = a + b + c
    return a / total, b / total, c / total


def validate_sigmas(sigmas: torch.Tensor, expected_steps: int):
    if sigmas.ndim != 1 or sigmas.numel() != expected_steps + 1:
        raise ValueError("Sigma schedule length does not match steps + 1.")
    if not bool(torch.isfinite(sigmas).all()):
        raise ValueError("Sigma schedule contains NaN or infinity.")
    if not bool((sigmas >= 0).all()) or not bool(torch.any(sigmas[:-1] > 0)):
        raise ValueError("Sigma schedule has invalid noise levels.")
    if bool(torch.any(sigmas[1:] > sigmas[:-1] + 1e-6)):
        raise ValueError("Sigma schedule must be non-increasing.")
    return sigmas
