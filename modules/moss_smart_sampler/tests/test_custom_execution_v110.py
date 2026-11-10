"""Integration regression: Custom routing retains chosen original engine."""
import importlib

import pytest
import torch

class MOSSImage:
    pass

class Patcher:
    model = MOSSImage()
    def get_model_object(self, name):
        return type('NativeFlow', (), {'sigma_max':1.0,'shift':5.0,'multiplier':1.0,'sigma':lambda self,t:t})()

@pytest.mark.parametrize('profile,steps,cfg', [('Turbo',12,1.4),('Fast',27,4.1),('Balanced',37,4.2),('Realism',43,3.2),('Quality',53,5.0)])
@pytest.mark.parametrize('strategy', ['Native Reference','Stage Weighted','Smooth Warp'])
def test_custom_calls_original_sigma_engine(plugin, profile, steps, cfg, strategy):
    pkg,state=plugin
    engine=importlib.import_module(pkg.__name__ + '.core.sampling_engine')
    latent={'samples':torch.zeros(1,4,8,8)}
    node=pkg.NODE_CLASS_MAPPINGS['MOSSSmartSampler']()
    node.sample(Patcher(), ['pos'],['neg'],latent, 987, 'Custom',steps,cfg, 'euler','simple',strategy,0.0,1.0,True,1.0,profile)
    reference=engine.generate_reference_sigmas(object(),'simple',steps,1.0)
    expected=engine.build_schedule(reference,profile,strategy,0.0,1.0)
    call=state['calls'][-1]
    assert torch.equal(call['sigmas'],expected)
    assert call['cfg']==cfg
    assert state['preview']==steps
