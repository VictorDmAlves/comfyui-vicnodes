"""v1.2.0 UI layout and backend regression checks."""

import inspect


def test_widget_order_and_external_inputs(plugin):
    package, _ = plugin
    node = package.NODE_CLASS_MAPPINGS["MOSSSmartSampler"]()
    required = node.INPUT_TYPES()["required"]
    optional = node.INPUT_TYPES()["optional"]
    keys = list(required)
    assert keys == [
        "model", "positive", "negative", "latent_image",
        "seed", "preset", "steps", "cfg",
        "sampler_name", "scheduler", "denoise", "mode",
        "sigma_strength", "refinement_bias", "add_noise",
    ]
    assert keys.index("sigma_strength") == keys.index("mode") + 1
    assert required["sigma_strength"][1]["default"] == 1.0
    assert "sigma_strength" in inspect.signature(node.sample).parameters
    assert list(optional)[:2] == ["sampler", "sigmas"]
    assert "custom_base_preset" in optional


def test_presets_and_choices_unchanged(plugin):
    package, _ = plugin
    node = package.NODE_CLASS_MAPPINGS["MOSSSmartSampler"]()
    r = node.INPUT_TYPES()["required"]
    assert r["preset"][0] == ["Fast", "Balanced", "Realism", "Quality", "Turbo", "Custom"]
    assert r["sampler_name"][0] == ["euler", "er_sde", "sa_solver"]
    assert r["scheduler"][0] == ["simple", "sgm_uniform", "beta"]
    assert r["mode"][0] == ["Native Reference", "Stage Weighted", "Smooth Warp"]
    assert "integration_strategy" not in r
