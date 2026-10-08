"""import_hair.py: the OBJ reader and the Umeyama fit that places a source head on GNM's cranium."""
from __future__ import annotations

from pathlib import Path

import numpy as np
import pytest

from ftv_pipeline.import_hair import read_obj, similarity_fit


def test_read_obj_fans_polygons_into_triangles(tmp_path):
    path = tmp_path / "quad.obj"
    path.write_text("# a quad\nv 0 0 0\nv 1 0 0\nv 1 1 0\nv 0 1 0\nvt 0 0\nf 1/1 2/1 3/1 4/1\n")
    verts, faces = read_obj(path)
    np.testing.assert_array_equal(verts, [[0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0]])
    np.testing.assert_array_equal(faces, [[0, 1, 2], [0, 2, 3]])


def test_similarity_fit_recovers_scale_rotation_translation():
    rng = np.random.default_rng(5)
    src = rng.normal(size=(30, 3))
    a = 0.4
    R = np.array([[1, 0, 0], [0, np.cos(a), -np.sin(a)], [0, np.sin(a), np.cos(a)]])
    s, R_fit, t = similarity_fit(src, 0.8 * src @ R.T + [0.0, 0.3, -0.1])
    assert s == pytest.approx(0.8)
    np.testing.assert_allclose(R_fit, R, atol=1e-10)
    np.testing.assert_allclose(t, [0.0, 0.3, -0.1], atol=1e-10)



def _stub_import(tmp_path, monkeypatch, index: dict) -> Path:
    """import_hair.main with the fitting, rendering and encoding stubbed; the index and files under tmp_path."""
    import json
    from types import SimpleNamespace

    import ftv_pipeline.export_groom as eg
    import ftv_pipeline.import_hair as ih

    path = tmp_path / "index.json"
    path.write_text(json.dumps(index))
    monkeypatch.setattr(eg, "INDEX", path)
    monkeypatch.setattr(ih, "INDEX", path, raising=False)  # never the shipped index, whichever module writes it
    monkeypatch.setattr(ih, "HAIR_MODELS_DIR", tmp_path)
    monkeypatch.setattr(ih, "WORK", tmp_path / "work")
    monkeypatch.setattr(ih.GNM, "load", classmethod(lambda cls: None))
    monkeypatch.setattr(ih, "load_bystedt", lambda style: ([np.zeros((4, 3))], np.zeros((3, 3)), None))
    monkeypatch.setattr(ih, "fit_head", lambda head_v, gnm: (1.0, np.eye(3), np.zeros(3)))
    monkeypatch.setattr(ih, "fit_strands", lambda strands, s, R, t, gnm, points, head_v=None: np.zeros((1, 4, 3)))
    monkeypatch.setattr(ih, "self_shadow", lambda fitted: None)
    monkeypatch.setattr(ih, "Groom", lambda spec, strands, shade: SimpleNamespace(spec=spec, strands=strands))
    monkeypatch.setattr(ih, "render_views", lambda groom, path, gnm: path)
    monkeypatch.setattr(ih, "encode", lambda groom: b"new strands")
    monkeypatch.setattr(ih, "thumbnail", lambda groom, gnm: tmp_path / f"{groom.spec.id}.webp")
    monkeypatch.setattr(ih, "entry", lambda groom, n: {"id": groom.spec.id, "label": groom.spec.label, "bytes": n, "strands": {"v": 2}})
    return path


def test_reimport_keeps_curated_fields_and_picker_place(tmp_path, monkeypatch):
    import json
    import sys

    import ftv_pipeline.import_hair as ih

    curated = {"id": "bystedt-long", "label": "Long layers", "group": "long", "type": "layered", "curly": False,
               "fringe": True, "bytes": 1, "strands": {"v": 1}}
    path = _stub_import(tmp_path, monkeypatch, {"styles": [{"id": "first"}, curated, {"id": "last"}]})
    monkeypatch.setattr(sys, "argv", ["import-hair", "bystedt", "long"])
    ih.main()
    styles = json.loads(path.read_text())["styles"]
    assert [s["id"] for s in styles] == ["first", "bystedt-long", "last"]
    assert styles[1] == {**curated, "bytes": len(b"new strands"), "strands": {"v": 2}, "file": "hair/bystedt-long.strands.bin",
                         "thumb": "hair/thumbs/bystedt-long.webp", "author": ih.AUTHORS["bystedt"], "pack": "groom"}


def test_bystedt_all_relaunches_through_the_module(monkeypatch):
    import subprocess
    import sys

    import ftv_pipeline.import_hair as ih

    calls = []
    monkeypatch.setattr(subprocess, "run", lambda cmd, check: calls.append(cmd))
    monkeypatch.setattr(sys, "argv", ["/somewhere/else/import-hair", "bystedt", "all", "--preview"])
    ih.main()
    assert calls == [[sys.executable, "-m", "ftv_pipeline.import_hair", "bystedt", s, "--preview"] for s in ih.BYSTEDT_STYLES]


@pytest.mark.parametrize("stdout, stderr, writes", [
    ("", "Error: Python: Traceback (most recent call last):\n  KeyError: 'long hair main'\n", False),  # exit 0, no file
    ("Traceback (most recent call last):\n", "", True),  # a file, but the script raised after writing it
])
def test_load_bystedt_reports_a_failed_blender_run(tmp_path, monkeypatch, stdout, stderr, writes):
    import subprocess

    import ftv_pipeline.import_hair as ih

    def run(cmd, **kw):
        if writes:
            np.savez_compressed(cmd[cmd.index("--") + 1], points=np.zeros((1, 3)))
        return subprocess.CompletedProcess(cmd, 0, stdout, stderr)

    monkeypatch.setattr(ih, "CACHE_DIR", tmp_path)
    monkeypatch.setattr(ih, "blender", lambda: "blender")
    monkeypatch.setattr(subprocess, "run", run)
    with pytest.raises(SystemExit, match="Traceback"):
        ih.load_bystedt("long")
    assert list((tmp_path / "bystedt" / "out").iterdir()) == []
