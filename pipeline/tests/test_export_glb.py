"""The mesh partitioning and geometry helpers of the export (no GNM download, no gltfpack)."""
from __future__ import annotations

import numpy as np
import pytest

from ftv_pipeline.export_glb import assign_triangles, assign_vertices, boundary_loops, split_seams, vertex_normals
from ftv_pipeline.gnm import GNM
from ftv_pipeline.parts import PartSpec


def test_assign_vertices_first_part_wins(tiny_gnm: GNM) -> None:
    parts = [PartSpec("teeth", "teeth", "head", ("teeth",)), PartSpec("skin", "skin", "head", ("skin",)),
             PartSpec("all", "skin", "head", ("skin_exterior",))]
    np.testing.assert_array_equal(assign_vertices(tiny_gnm, parts), [1, 1, 1, 1, 0])


def test_assign_triangles_majority_then_priority() -> None:
    owner = np.array([0, 0, 1, 1, -1, -1])
    tris = np.array([[0, 1, 2], [2, 3, 0], [0, 2, 4], [4, 5, 4]])
    # 2×0 → part 0; 2×1 → part 1; one each → the higher-priority part 0; nothing shipped → -1
    np.testing.assert_array_equal(assign_triangles(owner, tris, 2), [0, 1, 0, -1])


def test_split_seams_without_uvs_keeps_vertex_order() -> None:
    used, local, uvs = split_seams(np.array([[5, 2, 9], [9, 2, 7]]), None)
    np.testing.assert_array_equal(used, [2, 5, 7, 9])
    np.testing.assert_array_equal(used[local], [[5, 2, 9], [9, 2, 7]])
    assert uvs is None


def test_split_seams_duplicates_seam_vertices() -> None:
    tris = np.array([[0, 1, 2], [2, 1, 3]])
    corner_uvs = np.array([[[0, 0], [1, 0], [0, 1]], [[0, 1], [0.5, 0.5], [1, 1]]], np.float32)  # vertex 1 on a seam
    used, local, uvs = split_seams(tris, corner_uvs)
    assert len(used) == 5  # 4 template vertices + one copy of vertex 1
    np.testing.assert_array_equal(used[local], tris)
    np.testing.assert_array_equal(uvs[local], corner_uvs)


def test_vertex_normals_of_a_flat_quad() -> None:
    pos = np.array([[0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0]], np.float32)
    n = vertex_normals(pos, np.array([[0, 1, 2], [0, 2, 3]]))
    np.testing.assert_allclose(n, np.tile([0, 0, 1], (4, 1)), atol=1e-7)
    assert n.dtype == np.float32


def test_boundary_loops_of_a_fan() -> None:
    fan = np.array([[4, 0, 1], [4, 1, 2], [4, 2, 3], [4, 3, 0]])  # a square around centre vertex 4
    (loop,) = boundary_loops(fan)
    assert sorted(loop) == [0, 1, 2, 3]
    assert boundary_loops(np.concatenate([fan, fan[:, [0, 2, 1]]])) == []  # closed double-sided surface


def _export_into(tmp_path, monkeypatch, gnm: GNM, budget: int) -> dict:
    """export() on the tiny GNM with every path under tmp_path; gltfpack copies the raw file."""
    import shutil

    import ftv_pipeline.export_glb as ex

    models, out = tmp_path / "models", tmp_path / "out"
    out.mkdir(exist_ok=True)
    for name, path in {"OUT_DIR": out, "MODELS_DIR": models, "RAW_GLB": out / "head.raw.glb", "RAW_EXTRA": out / "head.extra.raw.glb",
                       "REFERENCE_NPZ": out / "head.reference.npz", "REFERENCE_EXTRA_NPZ": out / "head.extra.reference.npz",
                       "PACKED_GLB": models / "head.glb", "PACKED_EXTRA": models / "head.extra.glb",
                       "MANIFEST": models / "head.manifest.json"}.items():
        monkeypatch.setattr(ex, name, path)
    monkeypatch.setattr(ex.GNM, "load", classmethod(lambda cls: gnm))
    monkeypatch.setattr(ex, "PARTS", [PartSpec("skin", "skin", "head", ("skin",)), PartSpec("teeth", "teeth", "head", ("teeth",))])
    monkeypatch.setattr(ex, "gltfpack", lambda src, dst, *flags: shutil.copyfile(src, dst))
    monkeypatch.setattr(ex, "BUDGET_DISK", budget)
    cfg = {"export": {"sigma_scale": 1.0, "split": True, "parts": {"include": ["skin", "teeth"], "min_delta_mm": 0.0, "cap_neck": False}},
           "identity": {"components": ["head_000", "head_001"]}, "expression": {"components": ["lower_face_region_000"]}}
    return ex.export(cfg)


def test_export_over_budget_leaves_the_shipped_files_untouched(tiny_gnm: GNM, tmp_path, monkeypatch) -> None:
    models = tmp_path / "models"
    models.mkdir()
    old = {"head.glb": b"old head", "head.extra.glb": b"old extra", "head.manifest.json": b"{}"}
    for name, data in old.items():
        (models / name).write_bytes(data)
    with pytest.raises(SystemExit, match="over budget"):
        _export_into(tmp_path, monkeypatch, tiny_gnm, budget=0)
    assert {p.name: p.read_bytes() for p in models.iterdir()} == old
    assert not (tmp_path / "out" / "export.staged").exists()


def test_export_within_budget_replaces_the_shipped_files_together(tiny_gnm: GNM, tmp_path, monkeypatch) -> None:
    summary = _export_into(tmp_path, monkeypatch, tiny_gnm, budget=10**9)
    models = tmp_path / "models"
    assert sorted(p.name for p in models.iterdir()) == ["head.extra.glb", "head.glb", "head.manifest.json"]
    assert (models / "head.glb").read_bytes()[:4] == b"glTF"
    assert summary["targets"] == 3
    assert (tmp_path / "out" / "head.reference.npz").exists()
    assert not (tmp_path / "out" / "export.staged").exists()
