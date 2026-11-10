"""One-NFE-per-step experimental stabilized AB2 sampler for ComfyUI."""

from __future__ import annotations

import torch


@torch.no_grad()
def sample_refined(model, x, sigmas, extra_args=None, callback=None, disable=None, correction=0.5):
    """Euler predictor + capped variable-step Adams-Bashforth derivative.

    Exactly one denoiser evaluation per step (including the final step).
    Uses prior derivative for a bounded correction; does not claim formal
    second-order convergence once the heuristic cap is applied.
    """
    from comfy.k_diffusion.sampling import to_d
    from comfy.utils import model_trange

    extra_args = {} if extra_args is None else extra_args
    s_in = x.new_ones([x.shape[0]])
    prev_d = None
    prev_h = None
    correction = max(0.0, min(1.0, float(correction)))

    for i in model_trange(len(sigmas) - 1, disable=disable):
        sigma, sigma_next = sigmas[i], sigmas[i + 1]
        denoised = model(x, sigma * s_in, **extra_args)
        d = to_d(x, sigma, denoised)
        if callback is not None:
            callback({"x": x, "i": i, "sigma": sigma, "sigma_hat": sigma, "denoised": denoised})

        h = sigma_next - sigma
        effective_d = d
        if prev_d is not None and prev_h is not None and correction > 0:
            # Clamp the variable time-step ratio to avoid an unstable correction
            # when the last or first interval is disproportionally large.
            ratio = (h / prev_h).clamp(0.0, 1.5)
            candidate = 0.5 * ratio * (d - prev_d)
            # Cap correction norm to 25% of current derivative norm.
            # Batch-wise cap avoids cross-image coupling in batch sampling.
            axes = tuple(range(1, d.ndim))
            d_norm = d.float().square().mean(dim=axes, keepdim=True).sqrt().clamp_min(1e-8)
            c_norm = candidate.float().square().mean(dim=axes, keepdim=True).sqrt().clamp_min(1e-8)
            cap = (0.25 * d_norm / c_norm).clamp(max=1).to(dtype=d.dtype)
            final_damp = 0.5 if float(sigma_next) == 0.0 else 1.0
            effective_d = d + candidate * cap * (correction * final_damp)

        # Preserve the current derivative for the *next* step only.
        prev_d = d.detach()
        prev_h = h
        x = x + effective_d * h
    return x
