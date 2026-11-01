import importlib
import torch
import pytest


class DummyFlow:
    shift = 5.0
    multiplier = 1.0
    sigma_max = 1.0
    def sigma(self, timestep):
        return timestep


class MOSSImage:
    pass


class DummyPatcher:
    model = MOSSImage()
    def get_model_object(self, name):
        assert name == "model_sampling"
        return DummyFlow()


def test_node_loads_legacy_api_and_preview_and_noise(plugin):
    pkg, state = plugin
    node = pkg.NODE_CLASS_MAPPINGS["MOSSSmartSampler"]()
    assert node.RETURN_TYPES == ("LATENT",)
    required = node.INPUT_TYPES()["required"]
    assert "model" in required and "latent_image" in required
    lat = {"samples": torch.zeros((1, 4, 8, 8)), "batch_index": [0]}
    result, = node.sample(
        DummyPatcher(), ["positive"], ["negative"], lat, 42, "Turbo",
        0, 0, "euler", "simple", "Native Reference", 0, 1, True,
    )
    assert result["samples"].shape == lat["samples"].shape
    assert state["preview"] == 8
    assert len(state["calls"]) == 1
    assert state["calls"][0]["cfg"] == 1.0
    assert state["calls"][0]["sampler"] == "euler"
    assert state["calls"][0]["sigmas"].numel() == 9
    assert state["calls"][0]["options"]["seed"] == 42
    assert torch.equal(lat["samples"], torch.zeros_like(lat["samples"]))


def test_model_guard(plugin):
    pkg, state = plugin
    class OtherModel:
        pass
    patcher = DummyPatcher()
    patcher.model = OtherModel()
    node = pkg.NODE_CLASS_MAPPINGS["MOSSSmartSampler"]()
    lat = {"samples": torch.zeros((1, 4, 4, 4))}
    with pytest.raises(ValueError, match="MOSS-Image models only"):
        node.sample(patcher, [], [], lat, 1, "Balanced", 0, 0,
                    "euler", "simple", "Native Reference", 0, 1, True)
    assert not state["calls"]


def test_zero_denoise_skips_forward(plugin):
    pkg, state = plugin
    node = pkg.NODE_CLASS_MAPPINGS["MOSSSmartSampler"]()
    lat = {"samples": torch.ones((1, 4, 4, 4))}
    (out,) = node.sample(DummyPatcher(), [], [], lat, 0, "Balanced", 0, 0,
                         "euler", "simple", "Stage Weighted", 0, 0, True)
    assert out is not lat and out["samples"] is lat["samples"]
    assert not state["calls"]
