"""groom.py: the .strands.bin layout (header, planar int16 second differences, shade bytes) and the strand helpers."""
from __future__ import annotations

import gzip
import struct
from types import SimpleNamespace

import numpy as np
import pytest

from ftv_pipeline.groom import FORMAT_VERSION, MAGIC, QUANTUM_M, encode, fair, resample, smoothstep


def _strands(n: int = 20, p: int = 9, seed: int = 0) -> np.ndarray:
    steps = np.random.default_rng(seed).normal(scale=0.002, size=(n, p, 3))
    return np.array([0.01, 0.3, 0.05]) + np.cumsum(steps, axis=1)


def _decode(data: bytes) -> tuple[tuple, np.ndarray, np.ndarray]:
    """Read the file back by its documented layout (independent of validate/addons_check)."""
    raw = gzip.decompress(data)
    magic, (version, n, p, ox, oy, oz, q) = raw[:4], struct.unpack("<3I4f", raw[4:32])
    count = n * p * 3
    lo = np.frombuffer(raw, np.uint8, count, 32).astype(np.int64)
    hi = np.frombuffer(raw, np.uint8, count, 32 + count).astype(np.int64)
    d2 = ((hi << 8) | lo).astype(np.uint16).view(np.int16).astype(np.int64).reshape(3, n, p).transpose(1, 2, 0)
    steps = d2.copy()
    steps[:, 1:] = np.cumsum(d2[:, 1:], axis=1)  # point 0 stays absolute; undo the change of step …
    q_pts = np.cumsum(steps, axis=1)  # … then add the steps up
    shade = np.frombuffer(raw, np.uint8, n * p, 32 + 2 * count).reshape(n, p)
    return (magic, version, n, p, q), q_pts * q + np.array([ox, oy, oz]), shade


def test_header_and_round_trip():
    strands = _strands()
    shade = np.random.default_rng(1).random(strands.shape[:2])
    (magic, version, n, p, q), points, shade_bytes = _decode(encode(SimpleNamespace(strands=strands, shade=shade)))
    assert (magic, version, n, p) == (MAGIC, FORMAT_VERSION, 20, 9)
    assert q == pytest.approx(QUANTUM_M)
    # quantised to QUANTUM_M about a float32 origin: within half a step (plus the origin's float32 rounding)
    assert np.abs(points - strands).max() <= QUANTUM_M / 2 + 1e-6
    np.testing.assert_array_equal(shade_bytes, np.round(shade * 255).astype(np.uint8))


def test_encode_is_deterministic():
    g = SimpleNamespace(strands=_strands(seed=3), shade=np.ones((20, 9)))
    assert encode(g) == encode(g)  # gzip without a timestamp: re-exports are byte-identical


def test_encode_rejects_steps_beyond_int16():
    strands = _strands()
    strands[0, 5] += 2.0  # a 2 m jump: 40 000 quanta
    with pytest.raises(ValueError):
        encode(SimpleNamespace(strands=strands, shade=np.ones(strands.shape[:2])))


def test_resample_spaces_points_evenly_along_the_polyline():
    poly = np.array([[0, 0, 0], [1, 0, 0], [1, 2, 0]], float)  # an L, 3 long
    out = resample(poly, 7)
    np.testing.assert_allclose(out[[0, -1]], poly[[0, -1]])
    np.testing.assert_allclose(np.linalg.norm(np.diff(out, axis=0), axis=1), 0.5)


def test_resample_of_a_point_repeats_it():
    np.testing.assert_array_equal(resample(np.zeros((3, 3)), 4), np.zeros((4, 3)))


def test_fair_keeps_roots_and_straight_strands():
    straight = np.linspace([0, 0, 0], [0, -0.1, 0], 8)[None].repeat(2, 0)
    np.testing.assert_allclose(fair(straight, 5), straight, atol=1e-12)
    kinked = _strands(n=4, p=8)
    out = fair(kinked, 3)
    np.testing.assert_array_equal(out[:, 0], kinked[:, 0])
    assert np.abs(np.diff(out, 2, axis=1)).sum() < np.abs(np.diff(kinked, 2, axis=1)).sum()


def test_smoothstep():
    np.testing.assert_allclose(smoothstep(np.array([-1.0, 0.0, 0.5, 1.0, 2.0])), [0.0, 0.0, 0.5, 1.0, 1.0])


def test_load_specs_honours_a_styles_own_seed(tmp_path):
    from ftv_pipeline.groom import CONFIG, load_specs

    toml = tmp_path / "grooms.toml"
    toml.write_text('[defaults]\nseed = 5\n\n[style.a]\nlabel = "A"\n\n[style.b]\nlabel = "B"\nseed = 42\n\n[style.c]\nlabel = "C"\n')
    assert {k: s.seed for k, s in load_specs(toml).items()} == {"a": 1000, "b": 42, "c": 1002}
    # the shipped styles keep 1000 + their position (their strands stay byte-identical)
    assert [s.seed for s in load_specs(CONFIG).values()] == [1000 + i for i in range(len(load_specs(CONFIG)))]
