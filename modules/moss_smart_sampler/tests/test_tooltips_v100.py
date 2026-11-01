"""v1.0.0 release: every control has an accurate tooltip, no change to widget order."""

import pytest

FIELDS = [
    "model", "positive", "negative", "latent_image", "seed", "preset", "steps", "cfg",
    "sampler_name", "scheduler", "sigma_strategy", "sigma_strength", "refinement_bias",
    "denoise", "add_noise",
]


@pytest.mark.parametrize("field", FIELDS)
def test_all_controls_have_tooltips(plugin, field):
    pkg, _ = plugin
    node = pkg.NODE_CLASS_MAPPINGS["MOSSSmartSampler"]()
    required = node.INPUT_TYPES()["required"]
    assert field in required
    spec = required[field]
    assert len(spec) >= 2
    tooltip = spec[1].get("tooltip")
    assert isinstance(tooltip, str) and len(tooltip) >= 30


def test_auto_steps_cfg_explained(plugin):
    pkg, _ = plugin
    required = pkg.NODE_CLASS_MAPPINGS["MOSSSmartSampler"]().INPUT_TYPES()["required"]
    steps_tooltip = required["steps"][1]["tooltip"]
    cfg_tooltip = required["cfg"][1]["tooltip"]
    for k in ["Fast", "Balanced", "Realism", "Quality", "Turbo"]:
        assert k in steps_tooltip and k in cfg_tooltip
    for number in ["25", "35", "40", "50", "8"]:
        assert number in steps_tooltip
    assert "0.0" in cfg_tooltip and "4.0" in cfg_tooltip and "1.0" in cfg_tooltip


def test_widget_order_and_options_stable(plugin):
    pkg, _ = plugin
    node = pkg.NODE_CLASS_MAPPINGS["MOSSSmartSampler"]()
    required = node.INPUT_TYPES()["required"]
    assert list(required) == FIELDS
    assert required["preset"][0] == ["Fast", "Balanced", "Realism", "Quality", "Turbo"]
    assert required["sampler_name"][0] == ["euler", "er_sde", "sa_solver"]
    assert required["scheduler"][0] == ["simple", "sgm_uniform", "beta"]
    assert required["sigma_strategy"][0] == ["Native Reference", "Stage Weighted", "Smooth Warp"]
    assert required["sigma_strength"][1]["default"] == 1.0
    assert pkg.__version__ == "1.0.0"
