"""Structural migration checks for the existing MOSS Sampler implementation."""


def test_registry_and_category(plugin):
    package, _ = plugin
    assert list(package.NODE_CLASS_MAPPINGS) == ["MOSSSmartSampler"]
    assert package.NODE_DISPLAY_NAME_MAPPINGS == {"MOSSSmartSampler": "MOSS Smart Sampler"}
    assert package.NODE_CLASS_MAPPINGS["MOSSSmartSampler"].CATEGORY == "VicNodes/MOSS Smart Sampler"


def test_module_version_and_widgets_preserved(plugin):
    package, _ = plugin
    node = package.NODE_CLASS_MAPPINGS["MOSSSmartSampler"]()
    assert package.__version__ == "1.2.0"
    assert list(node.INPUT_TYPES()["required"]) == [
        "model", "positive", "negative", "latent_image", "seed", "preset", "steps",
        "cfg", "sampler_name", "scheduler", "denoise", "mode", "sigma_strength",
        "refinement_bias", "add_noise",
    ]
    assert list(node.INPUT_TYPES()["optional"])[:2] == ["sampler", "sigmas"]
    assert node.RETURN_TYPES == ("LATENT",)
    assert node.RETURN_NAMES == ("LATENT",)


def test_shared_frontend_and_no_local_settings(plugin):
    package, _ = plugin
    assert not hasattr(package, "WEB_DIRECTORY")
    assert not hasattr(package, "SETTINGS")
    from pathlib import Path
    root = Path(package.__file__).resolve().parents[2]
    assert (root / "web" / "moss_smart_sampler" / "preset_sync.js").is_file()
