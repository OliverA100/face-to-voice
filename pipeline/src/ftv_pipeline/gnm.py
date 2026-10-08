"""Google GNM Head v3.0 loaded with numpy only (the official package is not needed).

The geometry is strictly linear:

    vertices = template + sum_i identity[i] * identity_basis[i] + sum_j expression[j] * expression_basis[j]

Pose correctives are all zero in v3.0 and linear blend skinning is the identity at zero rotation,
so this reproduces the official model exactly for the neutral pose. Coefficients are in standard
deviations (1.0 == 1σ); the model's own demos use ±3.
"""
from __future__ import annotations

import hashlib
from dataclasses import dataclass
from pathlib import Path

import numpy as np

PIPELINE_DIR = Path(__file__).resolve().parents[2]
REPO_DIR = PIPELINE_DIR.parent
CACHE_DIR = PIPELINE_DIR / ".cache"
OUT_DIR = PIPELINE_DIR / "out"
CONFIG_FILE = PIPELINE_DIR / "config" / "components.toml"
WEIGHTS_FILE = CACHE_DIR / "gnm_head.npz"

# Pinned upstream sources. The git repo carries a slightly different byte stream of the same npz,
# so the checksum below only matches the Hugging Face file.
GNM_REPO = "https://github.com/google/GNM"
GNM_COMMIT = "f6895509c2b639edc36db20ede82b4315cc28c26"
WEIGHTS_URL = "https://huggingface.co/google/gnm-v3/resolve/main/v3_0/gnm_head.npz"
WEIGHTS_SHA256 = "61d78bbfb4ad8e0b38495804a4caef3214d3df00f8c3f68761e63b41ce3747eb"
WEIGHTS_BYTES = 53_328_601

EXPECTED = {"vertices": 17821, "identity": 253, "expression": 383, "joints": 4, "triangles": 35324}


def download_weights(path: Path = WEIGHTS_FILE) -> Path:
    """Download gnm_head.npz once (53 MB) and verify its sha256."""
    if path.exists() and _sha256(path) == WEIGHTS_SHA256:
        return path
    import requests  # local import: only needed on first run

    path.parent.mkdir(parents=True, exist_ok=True)
    print(f"downloading GNM Head weights ({WEIGHTS_BYTES / 1e6:.1f} MB) from {WEIGHTS_URL}")
    with requests.get(WEIGHTS_URL, stream=True, timeout=120) as r:
        r.raise_for_status()
        tmp = path.with_suffix(".part")
        with open(tmp, "wb") as f:
            for chunk in r.iter_content(chunk_size=1 << 20):
                f.write(chunk)
    digest = _sha256(tmp)
    if digest != WEIGHTS_SHA256:
        tmp.unlink(missing_ok=True)
        raise RuntimeError(f"sha256 mismatch for {WEIGHTS_URL}: got {digest}")
    tmp.replace(path)
    return path


def _sha256(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for block in iter(lambda: f.read(1 << 20), b""):
            h.update(block)
    return h.hexdigest()


@dataclass
class GNM:
    """The arrays we need, as numpy. Shapes: V vertices, T triangles, I identity, E expression comps."""

    template: np.ndarray  # (V, 3) float32, metres, +Y up, +Z forward (same as glTF)
    triangles: np.ndarray  # (T, 3) int32, counter-clockwise, outward facing
    identity_basis: np.ndarray  # (I, V, 3) float32 — displacement per 1σ
    expression_basis: np.ndarray  # (E, V, 3) float32
    identity_names: list[str]
    expression_names: list[str]
    joint_names: list[str]  # neck, head, left_eye, right_eye
    joint_positions: np.ndarray  # (4, 3) float32
    joint_identity_basis: np.ndarray  # (I, 4, 3) — how identity moves the joints
    vertex_groups: dict[str, np.ndarray]  # name -> (V,) bool mask
    mirror: np.ndarray | None = None  # (V,) index of each vertex's left/right mirror partner
    # (T, 3, 2) per-corner UVs, aligned with `triangles`. Each mesh component (skin, eyes, teeth+gums, tongue) has
    # its own 0..1 layout. Stored as GNM ships them; our own textures are authored in glTF order (row = v · height).
    triangle_uvs: np.ndarray | None = None

    @classmethod
    def load(cls, path: Path = WEIGHTS_FILE) -> GNM:
        d = np.load(download_weights(path), allow_pickle=False)
        gnm = cls(
            template=d["template_vertex_positions"].astype(np.float32),
            triangles=d["triangles"].astype(np.int32),
            identity_basis=d["vertex_identity_basis"],
            expression_basis=d["expression_basis"],
            identity_names=[str(n) for n in d["identity_names"]],
            expression_names=[str(n) for n in d["expression_names"]],
            joint_names=[str(n) for n in d["joint_names"]],
            joint_positions=d["template_joint_positions"].astype(np.float32),
            joint_identity_basis=d["joint_identity_basis"],
            vertex_groups={
                str(n): d["vertex_groups"][i] > 1e-4 for i, n in enumerate(d["vertex_group_names"])
            },
            mirror=d["mirror_indices"].astype(np.int64),
            triangle_uvs=d["triangle_uvs"].astype(np.float32),
        )
        gnm._check(d)
        return gnm

    def _check(self, d) -> None:
        V, I, E = self.template.shape[0], len(self.identity_names), len(self.expression_names)
        got = {"vertices": V, "identity": I, "expression": E, "joints": len(self.joint_names),
               "triangles": self.triangles.shape[0]}
        if got != EXPECTED:
            raise RuntimeError(f"unexpected GNM layout {got}, expected {EXPECTED}")
        if str(d["version"]) != "3.0" or str(d["variant"]) != "head":
            raise RuntimeError(f"expected GNM Head 3.0, got {d['variant']} {d['version']}")
        if float(np.abs(d["pose_correctives_regressor"]).max()) != 0.0:
            raise RuntimeError("pose correctives are not zero; the export would no longer be exact")

    # --- component helpers -------------------------------------------------------------------

    @staticmethod
    def region_of(name: str) -> str:
        """'lower_face_region_004' -> 'lower_face_region', 'tongue_mean' -> 'tongue'."""
        return name.rsplit("_", 1)[0]

    def kind_of(self, name: str) -> str:
        if name in self.identity_names:
            return "identity"
        if name in self.expression_names:
            return "expression"
        raise KeyError(f"unknown GNM component {name!r} (run `uv run list-components`)")

    def delta(self, name: str) -> np.ndarray:
        """Vertex displacement (V, 3) for coefficient 1.0 (one standard deviation)."""
        if name in self.identity_names:
            return self.identity_basis[self.identity_names.index(name)]
        return self.expression_basis[self.expression_names.index(name)]

    def joint_delta(self, name: str) -> np.ndarray:
        """Joint displacement (4, 3) for coefficient 1.0; zero for expression components."""
        if name in self.identity_names:
            return self.joint_identity_basis[self.identity_names.index(name)]
        return np.zeros((len(self.joint_names), 3), np.float32)

    def components_by_region(self) -> dict[str, list[str]]:
        out: dict[str, list[str]] = {}
        for n in self.identity_names + self.expression_names:
            out.setdefault(self.region_of(n), []).append(n)
        return out

    def vertices(self, coefficients: dict[str, float]) -> np.ndarray:
        """Neutral-pose vertices for a {component: sigma} dict (the whole forward model)."""
        v = self.template.copy()
        for name, c in coefficients.items():
            if c:
                v += np.float32(c) * self.delta(name)
        return v

    def mask(self, *groups: str, exclude: tuple[str, ...] = ()) -> np.ndarray:
        """AND of vertex groups minus the excluded ones."""
        m = np.ones(self.template.shape[0], bool)
        for g in groups:
            m &= self.vertex_groups[g]
        for g in exclude:
            m &= ~self.vertex_groups[g]
        return m


def list_components_main() -> None:
    """`uv run list-components`: print every component name grouped by region."""
    gnm = GNM.load()
    for region, names in gnm.components_by_region().items():
        kind = gnm.kind_of(names[0])
        print(f"\n{region}  ({kind}, {len(names)} components)")
        line = "  "
        for n in names:
            if len(line) + len(n) + 2 > 100:
                print(line)
                line = "  "
            line += n + "  "
        print(line)
