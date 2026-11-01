"""v0.5.0: preserve old formulas exactly; test interpolated sigma strength."""

from __future__ import annotations

import importlib
from pathlib import Path

import pytest
import torch


def modules(plugin):
    pkg, _ = plugin
    engine = importlib.import_module(pkg.__name__ + ".core.sampling_engine")
    sigma = importlib.import_module(pkg.__name__ + ".core.sigma_utils")
    turbo = importlib.import_module(pkg.__name__ + ".core.ultrafast_engine")
    standard = importlib.import_module(pkg.__name__ + ".core.standard_engine")
    return engine, sigma, turbo, standard


@pytest.mark.parametrize("preset,steps", [("Turbo",8), ("Turbo",6), ("Fast",25),
                                         ("Balanced",35), ("Realism",40), ("Quality",50)])
@pytest.mark.parametrize("scheduler", ["simple", "sgm_uniform", "beta"])
@pytest.mark.parametrize("strategy", ["Stage Weighted", "Smooth Warp"])
@pytest.mark.parametrize("bias", [-1.0, 0.0, 0.7])
def test_strength_one_matches_original_formula_bitwise(plugin, preset, steps, scheduler, strategy, bias):
    engine, sigma, turbo, standard = modules(plugin)
    reference = engine.generate_reference_sigmas(object(), scheduler, steps, 1.0)
    if strategy == "Stage Weighted":
        weights = turbo.get_weights() if preset == "Turbo" else standard.get_weights(preset)
        weights = sigma.apply_refinement_bias(weights, bias)
        expected = sigma.interpolate_sigmas(reference, sigma.stage_positions(steps, weights))
    else:
        warp = (turbo.smooth_strength(bias) if preset == "Turbo"
                else standard.smooth_strength(preset, bias))
        expected = sigma.interpolate_sigmas(reference, sigma.smooth_positions(steps, warp))
    actual = engine.build_schedule(reference, preset, strategy, bias, 1.0)
    assert torch.equal(actual, expected), (preset, steps, scheduler, strategy, bias)


@pytest.mark.parametrize("strategy", ["Native Reference", "Stage Weighted", "Smooth Warp"])
@pytest.mark.parametrize("strength", [0.0, 0.05, 0.15, 0.5, 0.85, 1.0])
@pytest.mark.parametrize("steps", [4, 6, 8, 12, 25, 35, 40, 50])
def test_all_sigma_strengths_valid_and_endpoints_fixed(plugin, strategy, strength, steps):
    engine, _, _, _ = modules(plugin)
    reference = engine.generate_reference_sigmas(object(), "simple", steps, 1.0)
    preset = "Turbo" if steps <= 12 else "Balanced"
    output = engine.build_schedule(reference, preset, strategy, 0.0, strength)
    assert output.numel() == steps + 1
    assert torch.equal(output[[0, -1]], reference[[0, -1]])
    assert torch.isfinite(output).all()
    assert torch.all(output[1:] <= output[:-1])
    assert torch.all(output >= 0)
    if strategy == "Native Reference" or strength == 0:
        assert torch.equal(output, reference)


@pytest.mark.parametrize("strategy", ["Stage Weighted", "Smooth Warp"])
def test_linear_interpolation_is_numerically_correct(plugin, strategy):
    engine, _, _, _ = modules(plugin)
    reference = engine.generate_reference_sigmas(object(), "simple", 8, 1.0)
    candidate = engine.build_schedule(reference, "Turbo", strategy, sigma_strength=1.0)
    for strength in [0.2, 0.5, 0.75]:
        actual = engine.build_schedule(reference, "Turbo", strategy, sigma_strength=strength)
        expected = reference + strength * (candidate - reference)
        expected[0], expected[-1] = reference[0], reference[-1]
        assert torch.equal(actual, expected)
        assert (actual - reference).abs().max() <= (candidate-reference).abs().max() + 1e-6


@pytest.mark.parametrize("strength", [-0.1, 1.01, float('nan'), float('inf'), -float('inf')])
def test_invalid_strength_rejected(plugin, strength):
    engine, _, _, _ = modules(plugin)
    reference = torch.linspace(1, 0, 9)
    with pytest.raises(ValueError, match="sigma_strength"):
        engine.build_schedule(reference, "Turbo", "Smooth Warp", 0.0, strength)


def test_invalid_strategy_does_not_bypass_validation_at_zero_strength(plugin):
    engine, _, _, _ = modules(plugin)
    with pytest.raises(ValueError, match="Unrecognized sigma strategy"):
        engine.build_schedule(torch.linspace(1, 0, 9), "Turbo", "Turbo Flow AB3", 0.0, 0.0)


def test_node_only_has_native_sigma_strategies_and_no_integration(plugin):
    pkg, _ = plugin
    from inspect import signature
    node = pkg.NODE_CLASS_MAPPINGS["MOSSSmartSampler"]()
    schema = node.INPUT_TYPES()
    assert schema["required"]["preset"][0] == ["Fast","Balanced","Realism","Quality","Turbo"]
    assert schema["required"]["sigma_strategy"][0] == ["Native Reference","Stage Weighted","Smooth Warp"]
    assert schema["required"]["sampler_name"][0] == ["euler","er_sde","sa_solver"]
    assert schema["required"]["scheduler"][0] == ["simple","sgm_uniform","beta"]
    assert "integration_strategy" not in schema.get("required", {})
    assert "integration_strategy" not in schema.get("optional", {})
    assert "integration_strategy" not in signature(node.sample).parameters
    assert schema["required"]["sigma_strength"][1]["default"] == 1.0
    keys = list(schema["required"])
    assert keys.index("sigma_strength") == keys.index("sigma_strategy") + 1
    assert signature(node.sample).parameters["sigma_strength"].default == 1.0
    core = Path(importlib.import_module(pkg.__name__ + ".core.sampling_engine").__file__).parent
    assert not (core / "hybrid_integrator.py").exists()
    assert not (core / "turbo_multistep.py").exists()


class MOSSImage:
    pass


class Patcher:
    model = MOSSImage()

    def get_model_object(self, name):
        assert name == "model_sampling"
        return type("NativeFlow", (), {"sigma_max":1.0, "shift":5.0, "multiplier":1.0,
                                       "sigma":lambda self,t:t})()


@pytest.mark.parametrize("sampler,scheduler", [
    ("euler", "simple"), ("er_sde", "beta"), ("sa_solver", "sgm_uniform")])
@pytest.mark.parametrize("strength", [0.0, 0.35, 1.0])
@pytest.mark.parametrize("strategy", ["Native Reference", "Stage Weighted", "Smooth Warp"])
def test_node_executes_native_sampler_and_preview_without_integration(plugin, sampler, scheduler,
                                                                      strength, strategy):
    pkg, state = plugin
    node = pkg.NODE_CLASS_MAPPINGS["MOSSSmartSampler"]()
    latent = {"samples":torch.zeros(1,4,8,8)}
    output, = node.sample(Patcher(), ["pos"], ["neg"], latent, 42, "Turbo", 0, 0,
                          sampler, scheduler, strategy, 0.0, 1.0, True, strength)
    assert torch.equal(latent["samples"], torch.zeros_like(latent["samples"]))
    assert output["samples"].shape == latent["samples"].shape
    call = state["calls"][-1]
    assert call["sampler"] == sampler
    assert call["sigmas"].numel() == 9
    assert call["options"]["seed"] == 42
    assert state["preview"] == 8


def test_old_api_call_without_sigma_strength_uses_original_strategy(plugin):
    pkg, state = plugin
    engine, _, _, _ = modules(plugin)
    node = pkg.NODE_CLASS_MAPPINGS["MOSSSmartSampler"]()
    latent = {"samples":torch.zeros(1,4,8,8)}
    node.sample(Patcher(), [], [], latent, 42, "UltraFast / Turbo", 0, 0,
                "euler", "simple", "Stage Weighted", 0.0, 1.0, True)
    expected_ref = engine.generate_reference_sigmas(object(), "simple", 8, 1.0)
    expected_sigmas = engine.build_schedule(expected_ref,"Turbo","Stage Weighted",0.0,1.0)
    assert torch.equal(state["calls"][-1]["sigmas"], expected_sigmas)
