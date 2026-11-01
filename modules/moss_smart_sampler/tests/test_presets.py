import importlib
import torch
import pytest


def test_standard_and_turbo_are_independent(plugin):
    pkg, _ = plugin
    engine = importlib.import_module(pkg.__name__ + ".core.sampling_engine")
    assert engine.resolve_parameters("Balanced", 0, 0) == (False, 35, 4.0)
    assert engine.resolve_parameters("Turbo", 0, 0) == (True, 8, 1.0)
    assert engine.resolve_parameters("Turbo", 12, 2) == (True, 12, 2)
    with pytest.raises(ValueError):
        engine.resolve_parameters("Unknown", 0, 0)


def test_native_reference_preserves_sigmas_bitwise(plugin):
    pkg, _ = plugin
    engine = importlib.import_module(pkg.__name__ + ".core.sampling_engine")
    model_sampling = object()
    ref = engine.generate_reference_sigmas(model_sampling, "simple", 8, 1.0)
    out = engine.build_schedule(ref, "Turbo", "Native Reference", -1.0)
    assert torch.equal(out, ref)
    assert out.data_ptr() != ref.data_ptr()
    assert len(out) == 9
    assert engine.generate_reference_sigmas(model_sampling, "simple", 8, 0.5)[0] < ref[0]


def test_stage_weighted_and_smooth_warp_are_distinct(plugin):
    pkg, _ = plugin
    engine = importlib.import_module(pkg.__name__ + ".core.sampling_engine")
    reference = engine.generate_reference_sigmas(object(), "simple", 8, 1.0)
    stage = engine.build_schedule(reference, "Turbo", "Stage Weighted", 0)
    warp = engine.build_schedule(reference, "Turbo", "Smooth Warp", 0)
    assert not torch.equal(stage, reference)
    assert not torch.equal(warp, reference)
    assert not torch.equal(stage, warp)
    assert torch.equal(stage[[0, -1]], reference[[0, -1]])


def test_old_api_turbo_name_is_alias(plugin):
    pkg, _ = plugin
    engine = importlib.import_module(pkg.__name__ + ".core.sampling_engine")
    assert engine.resolve_parameters("UltraFast / Turbo", 0, 0) == (True, 8, 1.0)
