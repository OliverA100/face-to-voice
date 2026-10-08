from __future__ import annotations

import struct
from pathlib import Path

import numpy as np
import pytest
from pygltflib import GLTF2

from ftv_pipeline.glb import WEBP_EXTENSION, GlbWriter, srgb_to_linear
from ftv_pipeline.verify_glb import read_accessor

PNG_MAGIC = b"\x89PNG\r\n\x1a\n"


def test_srgb_to_linear() -> None:
    assert srgb_to_linear("#000000") == [0.0, 0.0, 0.0, 1.0]
    assert srgb_to_linear("#FFFFFF") == [1.0, 1.0, 1.0, 1.0]
    r, g, b, a = srgb_to_linear("808080")
    assert r == g == b == pytest.approx(0.2158605, abs=1e-6)  # sRGB 128 is ~22% linear
    assert a == 1.0


def _target_accessor(target) -> int:
    return target["POSITION"] if isinstance(target, dict) else target.POSITION


def test_mesh_round_trip(tmp_path: Path) -> None:
    """Positions, normals, UVs, indices and morph targets come back bit for bit, with names and materials."""
    rng = np.random.default_rng(1)
    pos = rng.standard_normal((5, 3)).astype(np.float32)
    normals = np.tile(np.array([0, 0, 1], np.float32), (5, 1))
    uvs = rng.random((5, 2)).astype(np.float32)
    tris = np.array([[0, 1, 2], [2, 3, 4]], np.uint32)
    deltas = [rng.standard_normal((5, 3)).astype(np.float32) for _ in range(2)]

    w = GlbWriter(generator="test")
    mat = w.material("skin", "#C99A7E", 0.55)
    assert w.material("skin", "#000000", 0.1) == mat  # one material per name
    mesh = w.mesh("part", positions=pos, normals=normals, indices=tris, material=mat,
                  target_deltas=deltas, target_names=["a", "b"], uvs=uvs)
    w.finish(tmp_path / "t.glb", roots=[w.node("head", children=[w.node("part", mesh=mesh, translation=(0, 1, 0))])])

    gltf = GLTF2().load_binary(str(tmp_path / "t.glb"))
    blob = gltf.binary_blob()
    prim = gltf.meshes[0].primitives[0]
    np.testing.assert_array_equal(read_accessor(gltf, blob, prim.attributes.POSITION), pos)
    np.testing.assert_array_equal(read_accessor(gltf, blob, prim.attributes.NORMAL), normals)
    np.testing.assert_array_equal(read_accessor(gltf, blob, prim.attributes.TEXCOORD_0), uvs)
    np.testing.assert_array_equal(read_accessor(gltf, blob, prim.indices).reshape(-1, 3), tris)
    for d, t in zip(deltas, prim.targets):
        np.testing.assert_array_equal(read_accessor(gltf, blob, _target_accessor(t)), d)
    assert gltf.meshes[0].extras == {"targetNames": ["a", "b"]}
    assert gltf.meshes[0].weights == [0.0, 0.0]
    assert gltf.accessors[prim.attributes.POSITION].min == pytest.approx(pos.min(axis=0).tolist())
    assert [n.name for n in gltf.nodes] == ["part", "head"]
    assert gltf.nodes[0].translation == [0.0, 1.0, 0.0]
    assert gltf.materials[0].pbrMetallicRoughness.baseColorFactor == pytest.approx(srgb_to_linear("#C99A7E"))


def test_mesh_rejects_bad_input() -> None:
    w = GlbWriter(generator="test")
    pos = np.zeros((3, 3), np.float32)
    tris = np.array([[0, 1, 2]])
    with pytest.raises(ValueError, match="uvs"):
        w.mesh("m", positions=pos, normals=pos, indices=tris, material=0, target_deltas=[], target_names=[],
               uvs=np.zeros((2, 2)))
    with pytest.raises(ValueError, match="targets"):
        w.mesh("m", positions=pos, normals=pos, indices=tris, material=0, target_deltas=[pos], target_names=["a"],
               extra_primitives=[{"positions": pos, "normals": pos, "indices": tris, "material": 0, "target_deltas": []}])
    big = np.zeros((70_000, 3), np.float32)
    with pytest.raises(ValueError, match="uint16"):
        w.primitive("big", positions=big, normals=big, indices=tris, material=0, target_deltas=[])


def test_images_and_textures() -> None:
    w = GlbWriter(generator="test")
    png = w.image(PNG_MAGIC + b"rest")
    webp = w.image(b"RIFF" + struct.pack("<I", 4) + b"WEBP")
    assert w.gltf.images[png].mimeType == "image/png"
    assert w.gltf.images[webp].mimeType == "image/webp"
    assert WEBP_EXTENSION in w.gltf.extensionsUsed and WEBP_EXTENSION in w.gltf.extensionsRequired
    assert len(w._blob) % 4 == 0  # every buffer view starts 4-byte aligned
    t_png, t_webp = w.texture(png), w.texture(webp, mipmaps=False, clamp=True)
    assert w.gltf.textures[t_png].source == png
    assert w.gltf.textures[t_webp].source is None
    assert w.gltf.textures[t_webp].extensions == {WEBP_EXTENSION: {"source": webp}}
    m = w.textured_material("hair", t_png, normal_texture=t_webp)
    assert w.gltf.materials[m].alphaCutoff == 0.5
    assert w.gltf.materials[m].normalTexture.index == t_webp
    with pytest.raises(ValueError, match="already defined"):
        w.textured_material("hair", t_png)
    with pytest.raises(ValueError, match="not PNG"):
        w.image(b"GIF89a")
