import torch
import pytest

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


def test_node_loads_legacy_api_and_preview_and_noise(plugin):
    pkg, state = plugin
    node = pkg.NODE_CLASS_MAPPINGS["MOSSSmartSampler"]()
    assert node.RETURN_TYPES == ("LATENT",)
    required = node.INPUT_TYPES()["required"]
    assert "mode" in required
    latent = {"samples": torch.zeros(1, 4, 8, 8)}
    result, = node.sample(_patcher(), ["pos"], ["neg"], latent, 42, "Turbo", 0, 0,
                          "euler", "simple", 1.0, "Native Reference", 1.0, 0.0, True, None, None, "Balanced")
    assert result["samples"].shape == latent["samples"].shape
    assert state["preview"] == 8


def test_invalid_sampler_still_rejected(plugin):
    pkg, _ = plugin
    node = pkg.NODE_CLASS_MAPPINGS["MOSSSmartSampler"]()
    lat = {"samples": torch.zeros(1, 4, 8, 8)}
    with pytest.raises(ValueError):
        node.sample(_patcher(), [], [], lat, 1, "Balanced", 0, 0,
                    "bad_sampler", "simple", 1.0, "Native Reference", 1.0, 0.0, True, None, None, "Balanced")


def test_denoise_zero_returns_input_when_internal_schedule_is_used(plugin):
    pkg, _ = plugin
    node = pkg.NODE_CLASS_MAPPINGS["MOSSSmartSampler"]()
    lat = {"samples": torch.randn(1, 4, 8, 8)}
    (out,) = node.sample(_patcher(), [], [], lat, 0, "Balanced", 0, 0,
                         "euler", "simple", 0.0, "Native Reference", 1.0, 0.0, True, None, None, "Balanced")
    assert torch.equal(out["samples"], lat["samples"])
