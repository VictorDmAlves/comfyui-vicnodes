"""Regression tests for sigma schedule behavior."""

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
    return pkg, engine, sigma, turbo, standard


@pytest.mark.parametrize("preset,steps", [("Turbo",8), ("Fast",25), ("Balanced",35)])
@pytest.mark.parametrize("scheduler", ["simple", "sgm_uniform", "beta"])
@pytest.mark.parametrize("strategy", ["Stage Weighted", "Smooth Warp"])
def test_strength_one_matches_original_formula_bitwise(plugin, preset, steps, scheduler, strategy):
    _, engine, sigma, turbo, standard = modules(plugin)
    reference = engine.generate_reference_sigmas(object(), scheduler, steps, 1.0)
    if strategy == "Stage Weighted":
        weights = turbo.get_weights() if preset == "Turbo" else standard.get_weights(preset)
        expected = sigma.interpolate_sigmas(reference, sigma.stage_positions(steps, weights))
    else:
        warp = turbo.smooth_strength(0.0) if preset == "Turbo" else standard.smooth_strength(preset, 0.0)
        expected = sigma.interpolate_sigmas(reference, sigma.smooth_positions(steps, warp))
    actual = engine.build_schedule(reference, preset, strategy, 0.0, 1.0)
    assert torch.equal(actual, expected)


@pytest.mark.parametrize("strategy", ["Native Reference", "Stage Weighted", "Smooth Warp"])
@pytest.mark.parametrize("strength", [0.0, 0.2, 0.5, 1.0])
def test_sigma_strength_endpoints_and_validity(plugin, strategy, strength):
    _, engine, _, _, _ = modules(plugin)
    reference = engine.generate_reference_sigmas(object(), "simple", 8, 1.0)
    output = engine.build_schedule(reference, "Turbo", strategy, 0.0, strength)
    assert output.numel() == 9
    assert torch.equal(output[[0, -1]], reference[[0, -1]])
    assert torch.isfinite(output).all()
    assert torch.all(output[1:] <= output[:-1])
    if strategy == "Native Reference" or strength == 0:
        assert torch.equal(output, reference)


def test_node_schema_matches_v120(plugin):
    pkg, _, _, _, _ = modules(plugin)
    from inspect import signature
    node = pkg.NODE_CLASS_MAPPINGS["MOSSSmartSampler"]()
    schema = node.INPUT_TYPES()
    assert schema["required"]["mode"][0] == ["Native Reference", "Stage Weighted", "Smooth Warp"]
    assert schema["required"]["sigma_strength"][1]["default"] == 1.0
    keys = list(schema["required"])
    assert keys.index("sigma_strength") == keys.index("mode") + 1
    assert "integration_strategy" not in schema.get("required", {})
    assert "sigma_strength" in signature(node.sample).parameters
    core = Path(importlib.import_module(pkg.__name__ + ".core.sampling_engine").__file__).parent
    assert not (core / "hybrid_integrator.py").exists()


class _BaseMOSS:
    pass


class _Sampling:
    sigma_min = 0.0
    sigma_max = 5.0
    shift = 1.0
    multiplier = 1.0
    def sigma(self, t):
        return t


def _patcher():
    class Patcher:
        model_options = {}
        model = _BaseMOSS()
        def clone(self): return self
        def get_model_object(self, name):
            assert name == "model_sampling"
            return _Sampling()
    return Patcher()

class Patcher(_patcher().__class__):
    pass


@pytest.mark.parametrize("sampler,scheduler", [("euler", "simple"), ("er_sde", "beta"), ("sa_solver", "sgm_uniform")])
@pytest.mark.parametrize("strength", [0.0, 0.35, 1.0])
@pytest.mark.parametrize("strategy", ["Native Reference", "Stage Weighted", "Smooth Warp"])
def test_node_executes_native_sampler_and_preview(plugin, sampler, scheduler, strength, strategy):
    pkg, state = plugin
    node = pkg.NODE_CLASS_MAPPINGS["MOSSSmartSampler"]()
    latent = {"samples": torch.zeros(1,4,8,8)}
    output, = node.sample(Patcher(), ["pos"], ["neg"], latent, 42, "Turbo", 0, 0, sampler, scheduler, 1.0, strategy, strength, 0.0, True, None, None, "Balanced")
    assert output["samples"].shape == latent["samples"].shape
    call = state["calls"][-1]
    assert call["sampler"] == sampler
    assert call["sigmas"].numel() == 9
    assert call["options"]["seed"] == 42
    assert state["preview"] == 8
