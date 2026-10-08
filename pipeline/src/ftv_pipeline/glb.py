"""A small GLB writer on top of pygltflib: numpy arrays in, one binary buffer out.

Meshes carry positions, normals, optional UVs (TEXCOORD_0), uint16 indices and positions-only
morph targets, in one primitive or several (one per material). Materials are either flat colours
(`material`) or textured (`image` -> `texture` -> `textured_material`, with an optional
normalTexture); images are embedded in the same binary buffer as PNG or WebP (EXT_texture_webp,
which three.js's GLTFLoader reads natively).
"""
from __future__ import annotations

from collections.abc import Sequence
from pathlib import Path

import numpy as np
from pygltflib import (
    ARRAY_BUFFER,
    CLAMP_TO_EDGE,
    ELEMENT_ARRAY_BUFFER,
    FLOAT,
    GLTF2,
    LINEAR,
    LINEAR_MIPMAP_LINEAR,
    MASK,
    REPEAT,
    SCALAR,
    UNSIGNED_INT,
    UNSIGNED_SHORT,
    VEC3,
    Accessor,
    Asset,
    Attributes,
    Buffer,
    BufferView,
    Image,
    Material,
    Mesh,
    Node,
    NormalMaterialTexture,
    PbrMetallicRoughness,
    Primitive,
    Sampler,
    Scene,
    Texture,
    TextureInfo,
)

WEBP_EXTENSION = "EXT_texture_webp"
_MIME_BY_MAGIC = ((b"\x89PNG", "image/png"), (b"RIFF", "image/webp"), (b"\xff\xd8", "image/jpeg"))

_COMPONENT_TYPE = {
    np.dtype(np.float32): FLOAT,
    np.dtype(np.uint16): UNSIGNED_SHORT,
    np.dtype(np.uint32): UNSIGNED_INT,
}
_ACCESSOR_TYPE = {1: SCALAR, 2: "VEC2", 3: VEC3, 4: "VEC4"}


def srgb_to_linear(hex_color: str) -> list[float]:
    """glTF baseColorFactor is linear; designers think in sRGB hex."""
    h = hex_color.lstrip("#")
    out = []
    for i in (0, 2, 4):
        c = int(h[i : i + 2], 16) / 255
        out.append(c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4)
    return [*out, 1.0]


class GlbWriter:
    def __init__(self, generator: str):
        self.gltf = GLTF2(asset=Asset(version="2.0", generator=generator))
        self.gltf.buffers.append(Buffer(byteLength=0))
        self._blob = bytearray()
        self._materials: dict[str, int] = {}

    # --- data ---------------------------------------------------------------------------------

    def accessor(self, array: np.ndarray, *, index: bool = False, minmax: bool = False) -> int:
        """Append an array as its own bufferView + accessor; returns the accessor index."""
        array = np.ascontiguousarray(array)
        ncomp = 1 if array.ndim == 1 else array.shape[1]
        data = array.tobytes()
        offset = len(self._blob)
        self._blob += data
        while len(self._blob) % 4:  # glTF requires 4-byte alignment
            self._blob += b"\0"
        self.gltf.bufferViews.append(
            BufferView(
                buffer=0,
                byteOffset=offset,
                byteLength=len(data),
                target=ELEMENT_ARRAY_BUFFER if index else ARRAY_BUFFER,
            )
        )
        acc = Accessor(
            bufferView=len(self.gltf.bufferViews) - 1,
            byteOffset=0,
            componentType=_COMPONENT_TYPE[array.dtype],
            count=int(array.shape[0]),
            type=_ACCESSOR_TYPE[ncomp],
        )
        if minmax:
            flat = array.reshape(len(array), -1)
            acc.min = [float(x) for x in flat.min(axis=0)]
            acc.max = [float(x) for x in flat.max(axis=0)]
        self.gltf.accessors.append(acc)
        return len(self.gltf.accessors) - 1

    def material(self, name: str, hex_color: str, roughness: float) -> int:
        if name not in self._materials:
            self.gltf.materials.append(
                Material(
                    name=name,
                    pbrMetallicRoughness=PbrMetallicRoughness(
                        baseColorFactor=srgb_to_linear(hex_color),
                        metallicFactor=0.0,
                        roughnessFactor=roughness,
                    ),
                )
            )
            self._materials[name] = len(self.gltf.materials) - 1
        return self._materials[name]

    # --- textures -----------------------------------------------------------------------------

    def image(self, data: bytes, *, name: str | None = None) -> int:
        """Embed encoded PNG / WebP / JPEG bytes in the binary buffer; returns the image index.
        A WebP image marks EXT_texture_webp as used *and* required (no PNG fallback is written)."""
        mime = next((m for magic, m in _MIME_BY_MAGIC if data.startswith(magic)), None)
        if mime is None:
            raise ValueError("image bytes are not PNG, WebP or JPEG")
        offset = len(self._blob)
        self._blob += data
        while len(self._blob) % 4:
            self._blob += b"\0"
        self.gltf.bufferViews.append(BufferView(buffer=0, byteOffset=offset, byteLength=len(data)))
        self.gltf.images.append(Image(mimeType=mime, bufferView=len(self.gltf.bufferViews) - 1, name=name))
        if mime == "image/webp":
            for ext_list in (self.gltf.extensionsUsed, self.gltf.extensionsRequired):
                if WEBP_EXTENSION not in ext_list:
                    ext_list.append(WEBP_EXTENSION)
        return len(self.gltf.images) - 1

    def texture(self, image: int, *, mipmaps: bool = True, clamp: bool = False) -> int:
        """Texture over an embedded image with a linear (mipmapped) sampler; returns its index."""
        self.gltf.samplers.append(
            Sampler(
                magFilter=LINEAR,
                minFilter=LINEAR_MIPMAP_LINEAR if mipmaps else LINEAR,
                wrapS=CLAMP_TO_EDGE if clamp else REPEAT,
                wrapT=CLAMP_TO_EDGE if clamp else REPEAT,
            )
        )
        tex = Texture(sampler=len(self.gltf.samplers) - 1)
        if self.gltf.images[image].mimeType == "image/webp":
            tex.extensions = {WEBP_EXTENSION: {"source": image}}  # core `source` stays unset
        else:
            tex.source = image
        self.gltf.textures.append(tex)
        return len(self.gltf.textures) - 1

    def textured_material(
        self,
        name: str,
        texture: int,
        *,
        alpha_mode: str = MASK,
        alpha_cutoff: float = 0.5,
        double_sided: bool = True,
        roughness: float = 0.6,
        metallic: float = 0.0,
        base_color: tuple[float, float, float, float] = (1.0, 1.0, 1.0, 1.0),
        normal_texture: int | None = None,
    ) -> int:
        """baseColorTexture material (the texture is multiplied by base_color, so a white factor
        shows the painted colours as-is; the app re-tints in its own shader). `normal_texture` adds
        a tangent-space normalTexture (glTF convention: +Y up, scale 1) over the same UVs."""
        if name in self._materials:
            raise ValueError(f"material {name!r} already defined")
        mat = Material(
            name=name,
            pbrMetallicRoughness=PbrMetallicRoughness(
                baseColorFactor=[float(c) for c in base_color],
                baseColorTexture=TextureInfo(index=texture, texCoord=0),
                metallicFactor=float(metallic),
                roughnessFactor=float(roughness),
            ),
            alphaMode=alpha_mode,
            doubleSided=double_sided,
        )
        if alpha_mode == MASK:
            mat.alphaCutoff = float(alpha_cutoff)
        if normal_texture is not None:
            mat.normalTexture = NormalMaterialTexture(index=normal_texture, texCoord=0, scale=1.0)
        self.gltf.materials.append(mat)
        self._materials[name] = len(self.gltf.materials) - 1
        return self._materials[name]

    # --- scene graph --------------------------------------------------------------------------

    def primitive(
        self,
        name: str,
        *,
        positions: np.ndarray,
        normals: np.ndarray,
        indices: np.ndarray,
        material: int,
        target_deltas: list[np.ndarray],
        uvs: np.ndarray | None = None,
    ) -> Primitive:
        """One primitive with positions-only morph targets. `uvs` (V, 2) adds TEXCOORD_0 (glTF UV
        convention: v = 0 at the top of the image; flip .obj UVs with 1 - v)."""
        if len(positions) > 65535:
            raise ValueError(f"mesh {name} has {len(positions)} vertices; uint16 indices need < 65536")
        attributes = Attributes(
            POSITION=self.accessor(positions.astype(np.float32), minmax=True),
            NORMAL=self.accessor(normals.astype(np.float32)),
        )
        if uvs is not None:
            if uvs.shape != (len(positions), 2):
                raise ValueError(f"mesh {name}: uvs must be ({len(positions)}, 2), got {uvs.shape}")
            attributes.TEXCOORD_0 = self.accessor(uvs.astype(np.float32))
        return Primitive(
            attributes=attributes,
            indices=self.accessor(indices.astype(np.uint16).ravel(), index=True),
            material=material,
            targets=[
                Attributes(POSITION=self.accessor(d.astype(np.float32), minmax=True))
                for d in target_deltas
            ],
        )

    def mesh(
        self,
        name: str,
        *,
        positions: np.ndarray,
        normals: np.ndarray,
        indices: np.ndarray,
        material: int,
        target_deltas: list[np.ndarray],
        target_names: list[str],
        uvs: np.ndarray | None = None,
        extra_primitives: Sequence[dict] = (),
    ) -> int:
        """A mesh of one primitive (plus `extra_primitives`: keyword dicts for `primitive`, each
        with its own material and the same number of morph targets, as glTF requires), names in
        extras.targetNames (three.js reads them into mesh.morphTargetDictionary)."""
        prims = [self.primitive(name, positions=positions, normals=normals, indices=indices, material=material,
                                target_deltas=target_deltas, uvs=uvs)]
        for i, extra in enumerate(extra_primitives):
            if len(extra["target_deltas"]) != len(target_deltas):
                raise ValueError(f"mesh {name}: primitive {i + 1} has {len(extra['target_deltas'])} targets, the first {len(target_deltas)}")
            prims.append(self.primitive(f"{name}_{i + 1}", **extra))
        mesh = Mesh(name=name, primitives=prims, weights=[0.0] * len(target_names))
        mesh.extras = {"targetNames": list(target_names)}
        self.gltf.meshes.append(mesh)
        return len(self.gltf.meshes) - 1

    def node(self, name: str, *, mesh: int | None = None, translation=None, children=()) -> int:
        node = Node(name=name, mesh=mesh, children=list(children))
        if translation is not None:
            node.translation = [float(x) for x in translation]
        self.gltf.nodes.append(node)
        return len(self.gltf.nodes) - 1

    def finish(self, path: Path, roots: list[int]) -> None:
        self.gltf.buffers[0].byteLength = len(self._blob)
        self.gltf.scenes = [Scene(nodes=list(roots))]
        self.gltf.scene = 0
        self.gltf.set_binary_blob(bytes(self._blob))
        path.parent.mkdir(parents=True, exist_ok=True)
        self.gltf.save_binary(str(path))
