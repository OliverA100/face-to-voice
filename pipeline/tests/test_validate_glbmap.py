"""validate/glbmap.py: every GNM vertex the limiter reads has its own vertex in the shipped head.glb."""
from __future__ import annotations

from pathlib import Path

import numpy as np
import pytest

from ftv_pipeline.gnm import WEIGHTS_FILE
from ftv_pipeline.validate.glbmap import DECODED


@pytest.mark.skipif(not (WEIGHTS_FILE.exists() and DECODED.exists()),
                    reason="needs the cached GNM weights and out/head.decoded.glb (`uv run verify`)")
def test_vertex_map_is_one_to_one_per_part():
    from ftv_pipeline.parts import PARTS
    from ftv_pipeline.validate.glbmap import vertex_map
    from ftv_pipeline.validate.model import HeadModel

    m = HeadModel.load()
    shipped = np.flatnonzero(m.owner >= 0)
    wanted = shipped[:: max(1, len(shipped) // 2000)]
    got = vertex_map(m, wanted)
    assert set(got) == set(wanted.tolist())
    names = [p.name for p in PARTS]
    for v, (part, idx) in got.items():
        assert part == names[m.owner[v]] and idx >= 0
    pairs = list(got.values())
    assert len(set(pairs)) == len(pairs)  # coincident vertices (UV seams, touching teeth) told apart


class _Loaded(Exception):
    pass


def _read_decoded(monkeypatch, decoded, packed) -> bytes:
    """Runs vertex_map up to loading the decoded file and returns the bytes it would map (gltf-transform copies)."""
    import shutil

    import ftv_pipeline.validate.glbmap as gm

    monkeypatch.setattr(gm, "DECODED", decoded)
    monkeypatch.setattr(gm, "PACKED_GLB", packed, raising=False)
    monkeypatch.setattr(gm, "gltf_transform", lambda cmd, src, dst: shutil.copyfile(src, dst), raising=False)
    seen = []

    class Loader:
        def load_binary(self, path):
            seen.append(Path(path).read_bytes())
            raise _Loaded

    monkeypatch.setattr(gm, "GLTF2", Loader)
    with pytest.raises(_Loaded):
        gm.vertex_map(None, np.array([0]))
    return seen[0]


def test_vertex_map_decodes_again_when_head_glb_is_newer(tmp_path, monkeypatch):
    import os

    decoded, packed = tmp_path / "head.decoded.glb", tmp_path / "head.glb"
    decoded.write_bytes(b"decode of the old head")
    packed.write_bytes(b"new head")
    os.utime(decoded, (1_000, 1_000))
    os.utime(packed, (2_000, 2_000))
    assert _read_decoded(monkeypatch, decoded, packed) == b"new head"
    assert decoded.read_bytes() == b"new head" and not (tmp_path / "head.decoded.tmp.glb").exists()


def test_vertex_map_keeps_a_current_decode(tmp_path, monkeypatch):
    import os

    decoded, packed = tmp_path / "head.decoded.glb", tmp_path / "head.glb"
    packed.write_bytes(b"head")
    decoded.write_bytes(b"decoded head")
    os.utime(packed, (1_000, 1_000))
    os.utime(decoded, (2_000, 2_000))
    assert _read_decoded(monkeypatch, decoded, packed) == b"decoded head"
