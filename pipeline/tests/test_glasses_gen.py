"""glasses_gen.py: lens outlines and the GLB mesh renaming (pure helpers; building a frame needs the GNM)."""
from __future__ import annotations

import json
import struct

import numpy as np
import pytest

from ftv_pipeline.glasses_gen import outline, rename_mesh, resample_closed


def signed_area(p: np.ndarray) -> float:
    return 0.5 * float(np.sum(p[:, 0] * np.roll(p[:, 1], -1) - np.roll(p[:, 0], -1) * p[:, 1]))


def test_resample_closed_is_even_counter_clockwise_and_starts_outside():
    square = np.array([[1, -1], [1, 1], [-1, 1], [-1, -1]], float)[::-1]  # clockwise on purpose
    out = resample_closed(square, 16)
    assert len(out) == 16 and signed_area(out) > 0
    np.testing.assert_allclose(np.linalg.norm(np.diff(np.vstack([out, out[:1]]), axis=0), axis=1), 0.5)
    np.testing.assert_allclose(out[0], [1.0, 0.0], atol=0.26)  # the outer middle (u away from the nose)


@pytest.mark.parametrize("shape", ["round", "oval", "rect", "square", "panto", "browline", "dframe", "wayfarer", "cateye",
                                   "aviator", "hexagon", "octagon"])
def test_every_lens_shape_fills_its_box(shape):
    p = outline(shape, 50.0, 40.0)
    assert len(p) == 120 and signed_area(p) > 0
    np.testing.assert_allclose((p.max(0) + p.min(0)) / 2, 0.0, atol=0.6)  # centred on its box
    width = np.ptp(p[:, 0])
    assert 0.9 * 50 < width < 1.25 * 50  # cat-eye and aviator sweep a little past it


def test_unknown_lens_shape_is_an_error():
    with pytest.raises(ValueError):
        outline("heart", 50.0, 40.0)


def glb(doc: dict, bin_chunk: bytes) -> bytes:
    body = json.dumps(doc).encode()
    body += b" " * (-len(body) % 4)
    chunks = struct.pack("<II", len(body), 0x4E4F534A) + body + struct.pack("<II", len(bin_chunk), 0x004E4942) + bin_chunk
    return struct.pack("<4sII", b"glTF", 2, 12 + len(chunks)) + chunks


def test_rename_mesh_rewrites_only_the_json_chunk(tmp_path):
    path = tmp_path / "a.glb"
    bin_chunk = bytes(range(16))
    path.write_bytes(glb({"asset": {"version": "2.0"}, "meshes": [{"primitives": []}, {"name": "x", "primitives": []}]}, bin_chunk))
    rename_mesh(path, "glasses")
    data = path.read_bytes()
    magic, version, length = struct.unpack_from("<4sII", data, 0)
    json_len, _ = struct.unpack_from("<II", data, 12)
    assert (magic, version, length) == (b"glTF", 2, len(data)) and json_len % 4 == 0
    assert [m["name"] for m in json.loads(data[20:20 + json_len])["meshes"]] == ["glasses", "glasses"]
    assert data.endswith(bin_chunk)


def test_rename_mesh_rejects_other_files(tmp_path):
    path = tmp_path / "b.glb"
    path.write_bytes(b"NOPE" + bytes(16))
    with pytest.raises(ValueError):
        rename_mesh(path, "glasses")


def test_main_deletes_the_files_of_styles_dropped_from_the_config(tmp_path, monkeypatch):
    import json
    import sys

    import ftv_pipeline.glasses_gen as gg

    addons = tmp_path / "addons"
    models = addons / "glasses"
    (models / "thumbs").mkdir(parents=True)
    for name in ("gone.glb", "thumbs/gone.webp", "other.glb"):
        (models / name).write_bytes(b"old")
    styles = [{"id": "gone", "pack": "generated", "file": "addons/glasses/gone.glb", "thumb": "addons/glasses/thumbs/gone.webp"}]
    (models / "index.json").write_text(json.dumps({"styles": styles}))
    monkeypatch.setattr(gg, "MODELS", models)
    monkeypatch.setattr(gg, "ADDONS_MODELS_DIR", addons)
    monkeypatch.setattr(gg, "load_styles", dict)
    monkeypatch.setattr(gg, "head_context", lambda: None)
    monkeypatch.setattr(sys, "argv", ["glasses-gen"])
    gg.main()

    assert sorted(str(p.relative_to(models)) for p in models.rglob("*") if p.is_file()) == ["index.json", "other.glb"]
    assert json.loads((models / "index.json").read_text())["styles"] == []
