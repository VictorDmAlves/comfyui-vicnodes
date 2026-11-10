"""v1.1.0: explicit defaults and Custom preserve the originating sigma engine."""

import importlib
from pathlib import Path

import pytest
import torch

PRESETS = {
    'Fast': (25, 4.0),
    'Balanced': (35, 4.0),
    'Realism': (40, 4.0),
    'Quality': (50, 4.0),
    'Turbo': (8, 1.0),
}


def engine(plugin):
    pkg, _ = plugin
    return importlib.import_module(pkg.__name__ + '.core.sampling_engine')


def test_new_balanced_visible_defaults(plugin):
    pkg, _ = plugin
    schema = pkg.NODE_CLASS_MAPPINGS['MOSSSmartSampler'].INPUT_TYPES()
    assert schema['required']['preset'][1]['default'] == 'Balanced'
    assert schema['required']['steps'][1]['default'] == 35
    assert schema['required']['cfg'][1]['default'] == 4.0
    assert schema['required']['preset'][0] == list(PRESETS) + ['Custom']
    assert schema['optional']['custom_base_preset'][1]['default'] == 'Balanced'


@pytest.mark.parametrize('name,values', list(PRESETS.items()))
def test_backend_preset_values_match_ui(plugin, name, values):
    e = engine(plugin)
    assert e.resolve_parameters(name, *values) == (name == 'Turbo', *values)
    # Backward-compatibility with old API workflows that stored zeros as Auto.
    assert e.resolve_parameters(name, 0, 0) == (name == 'Turbo', *values)


@pytest.mark.parametrize('base', list(PRESETS))
@pytest.mark.parametrize('strategy', ['Native Reference', 'Stage Weighted', 'Smooth Warp'])
def test_custom_preserves_exact_sigma_profile(plugin, base, strategy):
    e = engine(plugin)
    custom_steps = PRESETS[base][0] + 2
    custom_cfg = PRESETS[base][1] + 0.5
    assert e.resolve_parameters('Custom', custom_steps, custom_cfg, base) == (
        base == 'Turbo', custom_steps, custom_cfg
    )
    ref = e.generate_reference_sigmas(object(), 'simple', custom_steps, 1.0)
    direct = e.build_schedule(ref, base, strategy, 0.2, 0.75)
    custom_profile = base  # exact backend routing for Custom
    custom = e.build_schedule(ref, custom_profile, strategy, 0.2, 0.75)
    assert torch.equal(direct, custom)


def test_custom_requires_explicit_steps(plugin):
    e = engine(plugin)
    with pytest.raises(ValueError, match='positive number'):
        e.resolve_parameters('Custom', 0, 4.0)


def test_custom_rejects_invalid_sigma_origin(plugin):
    e = engine(plugin)
    with pytest.raises(ValueError, match='Unrecognized'):
        e.resolve_parameters('Custom', 35, 4.0, 'Unknown')


def test_custom_can_explicitly_use_cfg_zero(plugin):
    e = engine(plugin)
    assert e.resolve_parameters('Custom', 8, 0.0, 'Turbo') == (True, 8, 0.0)


def test_frontend_source_is_packaged(plugin):
    pkg, _ = plugin
    root = Path(pkg.__file__).parent
    if root.parent.name == 'modules':
        # VicNodes modules/moss_smart_sampler, shared ../.. web dir.
        js = root.parent.parent / 'web' / 'moss_smart_sampler' / 'preset_sync.js'
    else:
        js = root / 'web' / 'moss_smart_sampler' / 'preset_sync.js'
    assert js.exists()
    data = js.read_text()
    assert 'VicNodes.MOSSSmartSampler.PresetSync' in data
    assert 'setCustom' in data
