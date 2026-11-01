"""v0.5.1 UI layout and backend regression checks."""

import inspect


def test_sigma_strength_immediately_after_sigma_strategy(plugin):
    package, _ = plugin
    node = package.NODE_CLASS_MAPPINGS["MOSSSmartSampler"]()
    required = node.INPUT_TYPES()["required"]
    keys = list(required)
    assert keys.index("sigma_strength") == keys.index("sigma_strategy") + 1
    assert keys.index("sigma_strength") < keys.index("refinement_bias")
    assert keys.index("sigma_strength") < keys.index("denoise")
    assert keys.index("sigma_strength") < keys.index("add_noise")
    assert required["sigma_strength"][1]["default"] == 1.0
    assert inspect.signature(node.sample).parameters["sigma_strength"].default == 1.0


def test_presets_and_choices_unchanged(plugin):
    package, _ = plugin
    node = package.NODE_CLASS_MAPPINGS["MOSSSmartSampler"]()
    r = node.INPUT_TYPES()["required"]
    assert r["preset"][0] == ["Fast", "Balanced", "Realism", "Quality", "Turbo"]
    assert r["sampler_name"][0] == ["euler", "er_sde", "sa_solver"]
    assert r["scheduler"][0] == ["simple", "sgm_uniform", "beta"]
    assert r["sigma_strategy"][0] == ["Native Reference", "Stage Weighted", "Smooth Warp"]
    assert "integration_strategy" not in r
