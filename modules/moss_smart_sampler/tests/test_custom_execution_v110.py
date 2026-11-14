import torch

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


def test_custom_keeps_base_profile_for_turbo_and_standard(plugin):
    pkg, state = plugin
    node=pkg.NODE_CLASS_MAPPINGS['MOSSSmartSampler']()
    latent={'samples': torch.zeros(1,4,8,8)}
    for profile, steps, cfg, strategy in [
        ('Turbo', 12, 1.4, 'Smooth Warp'),
        ('Balanced', 44, 3.6, 'Stage Weighted'),
    ]:
        node.sample(_patcher(), ['pos'], ['neg'], latent, 987, 'Custom', steps, cfg, 'euler', 'simple', 1.0, strategy, 1.0, 0.0, True, None, None, profile)
        call = state['calls'][-1]
        assert call['cfg'] == cfg
        assert len(call['sigmas']) == steps + 1
