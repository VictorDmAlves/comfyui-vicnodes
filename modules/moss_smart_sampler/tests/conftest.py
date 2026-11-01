"""Test offline without importing ComfyUI; only native adapter is mocked."""

import importlib
import os
import pathlib
import sys
import types

import pytest
import torch


@pytest.fixture
def plugin(monkeypatch):
    pkg_dir = pathlib.Path(os.environ.get("MOSS_PLUGIN_SOURCE", str(pathlib.Path(__file__).resolve().parents[1])))
    sampling_state = {"calls": [], "preview": None}

    comfy = types.ModuleType("comfy")
    comfy.__path__ = []
    sample = types.ModuleType("comfy.sample")
    samplers = types.ModuleType("comfy.samplers")
    utils = types.ModuleType("comfy.utils")
    kdiff = types.ModuleType("comfy.k_diffusion")
    kdiff.__path__ = []
    ksample = types.ModuleType("comfy.k_diffusion.sampling")
    preview = types.ModuleType("latent_preview")

    def calculate_sigmas(model_sampling, scheduler, steps):
        # Representative shifted flow sigma curve, not a ComfyUI reimplementation.
        t = torch.linspace(1, 0, steps + 1, dtype=torch.float32)
        sigmas = 5.0 * t / (1.0 + 4.0 * t)
        if scheduler == "sgm_uniform":
            sigmas = sigmas.square()
        elif scheduler == "beta":
            sigmas = sigmas.sqrt()
        sigmas[-1] = 0.0
        return sigmas

    def fix_empty(model, latent, spatial=None, temporal=None):
        return latent

    def prepare_noise(x, seed, batch_inds):
        return torch.randn(x.shape, generator=torch.Generator().manual_seed(seed))

    class MockKSAMPLER:
        def __init__(self, fn, extra_options=None, inpaint_options=None):
            self.sampler_function = fn

    def sample_custom(model, noise, cfg, sampler, sigmas, positive, negative, samples, **kwargs):
        call = {"noise": noise, "cfg": cfg, "sampler": sampler,
                "sigmas": sigmas.clone(), "options": kwargs, "nfe": 0, "callbacks": []}
        sampling_state["calls"].append(call)
        if isinstance(sampler, MockKSAMPLER):
            def fake_denoiser(x, sigma, **extra_args):
                call["nfe"] += 1
                return x * 0.7 + sigma.reshape(-1, *([1] * (x.ndim - 1))) * 0.05
            def wrapped_cb(info):
                call["callbacks"].append(info["i"])
            return sampler.sampler_function(fake_denoiser, samples + noise, sigmas,
                                            callback=wrapped_cb, disable=True,
                                            extra_args={"seed": kwargs.get("seed", 0)})
        return samples + noise

    def callback(model, steps):
        sampling_state["preview"] = steps
        return lambda *args: None

    ksample.to_d = lambda x, sigma, denoised: (x - denoised) / sigma
    kdiff.sampling = ksample
    comfy.k_diffusion = kdiff
    utils.model_trange = lambda count, disable=None: range(count)
    samplers.KSAMPLER = MockKSAMPLER
    samplers.calculate_sigmas = calculate_sigmas
    samplers.sampler_object = lambda name: name
    sample.fix_empty_latent_channels = fix_empty
    sample.prepare_noise = prepare_noise
    sample.prepare_empty_noise = torch.zeros_like
    sample.sample_custom = sample_custom
    utils.PROGRESS_BAR_ENABLED = True
    preview.prepare_callback = callback
    comfy.samplers = samplers
    comfy.sample = sample
    comfy.utils = utils
    for name, mod in (("comfy", comfy), ("comfy.sample", sample),
                      ("comfy.samplers", samplers), ("comfy.utils", utils),
                      ("comfy.k_diffusion", kdiff), ("comfy.k_diffusion.sampling", ksample),
                      ("latent_preview", preview)):
        monkeypatch.setitem(sys.modules, name, mod)

    # Load custom node as a package from its real directory (hyphen-safe).
    pkgname = "test_moss_smart_sampler_package"
    monkeypatch.syspath_prepend(str(pkg_dir.parent))
    spec = importlib.util.spec_from_file_location(pkgname, pkg_dir / "__init__.py",
                                                   submodule_search_locations=[str(pkg_dir)])
    module = importlib.util.module_from_spec(spec)
    sys.modules[pkgname] = module
    spec.loader.exec_module(module)
    yield module, sampling_state
    for name in list(sys.modules):
        if name == pkgname or name.startswith(pkgname + "."):
            del sys.modules[name]
