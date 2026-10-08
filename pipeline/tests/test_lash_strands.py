"""lash_strands.main: the files of lid fixes and styles that are gone are deleted (the generator itself is stubbed)."""
from __future__ import annotations

import json
import sys
from types import SimpleNamespace

import numpy as np

import ftv_pipeline.lash_strands as ls


def test_main_deletes_lid_files_nothing_references(tmp_path, monkeypatch):
    addons = tmp_path / "addons"
    models = addons / "eyelashes"
    (models / "thumbs").mkdir(parents=True)
    for name in ("kept.strands.bin", "kept.lid.bin", "gone.strands.bin", "gone.lid.bin", "thumbs/kept.webp", "thumbs/gone.webp"):
        (models / name).write_bytes(b"old")
    lid = lambda sid: {"lidFix": {"file": f"addons/eyelashes/{sid}.lid.bin", "targets": ["x"]}}  # noqa: E731
    index = {"styles": [{"id": sid, "pack": "generated", "file": f"addons/eyelashes/{sid}.strands.bin",
                         "thumb": f"addons/eyelashes/thumbs/{sid}.webp", "strands": lid(sid)} for sid in ("kept", "gone")]}
    (models / "index.json").write_text(json.dumps(index))
    config = tmp_path / "lashes.toml"
    config.write_text('[render]\nramp_mm = 1.0\n\n[style.kept]\nlabel = "Kept"\n')

    groom = SimpleNamespace(strands=np.zeros((2, 3, 3)), lid=(np.zeros((2, 0)), []))  # the lid fix is empty now
    monkeypatch.setattr(ls, "CONFIG", config)
    monkeypatch.setattr(ls, "MODELS", models)
    monkeypatch.setattr(ls, "ADDONS_MODELS_DIR", addons)
    monkeypatch.setattr(ls, "head_context", lambda: SimpleNamespace(gnm=None))
    monkeypatch.setattr(ls, "eye_joints", lambda gnm: [np.zeros(3)])
    monkeypatch.setattr(ls, "build", lambda sid, st, cfg, ctx: groom)
    monkeypatch.setattr(ls, "render_views", lambda g, path, **kw: path)
    monkeypatch.setattr(ls, "encode", lambda g: b"new")
    monkeypatch.setattr(ls, "entry", lambda g, n, mesh_fields: {"id": "kept", "strands": {}})
    monkeypatch.setattr(sys, "argv", ["lash-strands"])
    ls.main()

    left = sorted(str(p.relative_to(models)) for p in models.rglob("*") if p.is_file())
    assert left == ["index.json", "kept.strands.bin", "thumbs/kept.webp"]
    (kept,) = json.loads((models / "index.json").read_text())["styles"]
    assert kept["id"] == "kept" and "lidFix" not in kept["strands"]
