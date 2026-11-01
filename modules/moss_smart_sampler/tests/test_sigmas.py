import pytest
import torch


def test_counts_and_endpoints(plugin):
    pkg, _ = plugin
    from importlib import import_module
    s = import_module(pkg.__name__ + ".core.sigma_utils")
    for n in (3, 4, 6, 8, 25, 35, 40, 50):
        weights = (0.22, 0.56, 0.22)
        counts = s.stage_counts(n, weights)
        assert sum(counts) == n and min(counts) >= 1
        p = s.stage_positions(n, weights)
        assert len(p) == n + 1
        assert p[0] == 0.0 and p[-1] == 1.0
        assert all(p[i] < p[i + 1] for i in range(n))


def test_interpolation_respects_native_endpoints_and_continuity(plugin):
    pkg, _ = plugin
    from importlib import import_module
    s = import_module(pkg.__name__ + ".core.sigma_utils")
    ref = torch.tensor([1.0, 0.88, 0.76, 0.51, 0.32, 0.16, 0.05, 0.01, 0.0])
    p = s.stage_positions(8, (0.22, 0.56, 0.22))
    out = s.interpolate_sigmas(ref, p)
    s.validate_sigmas(out, 8)
    assert torch.equal(out[[0, -1]], ref[[0, -1]])
    assert not torch.equal(out, ref)


def test_smooth_warp_is_monotone_and_bounded(plugin):
    pkg, _ = plugin
    from importlib import import_module
    s = import_module(pkg.__name__ + ".core.sigma_utils")
    for value in (-0.8, -0.2, 0.0, 0.25, 0.8):
        for n in (4, 8, 35):
            p = s.smooth_positions(n, value)
            assert p[0] == 0 and p[-1] == 1
            assert all(p[i] < p[i + 1] for i in range(n))
    assert s.smooth_positions(8, 0.0) == [i / 8 for i in range(9)]


def test_malformed_sigmas_rejected(plugin):
    pkg, _ = plugin
    from importlib import import_module
    s = import_module(pkg.__name__ + ".core.sigma_utils")
    with pytest.raises(ValueError, match="non-increasing"):
        s.validate_sigmas(torch.tensor([1., .4, .6, 0.]), 3)
    with pytest.raises(ValueError, match="infinity"):
        s.validate_sigmas(torch.tensor([1., float("nan"), 0.]), 2)
    with pytest.raises(ValueError, match="positions"):
        s.interpolate_sigmas(torch.tensor([1., .4, 0.]), [0., .5, .4, 1.])
