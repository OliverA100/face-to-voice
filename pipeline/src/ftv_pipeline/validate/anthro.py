"""Standard anthropometric measurements (millimetres) on any posed head, and the published adult ranges they are
checked against (config/anthropometry.toml).

Landmarks are the ones in config/semantic_sliders.toml [landmarks] (Farkas names: euryon, zygion, gonion, …); a
vertex set counts as its mean position. Distances are straight lines between landmarks, like calipers. The two
circumferences are tape measures: the convex outline of the skin cut by a plane (a tape bridges the hollows).
"""
from __future__ import annotations

import tomllib
from dataclasses import dataclass

import numpy as np
from scipy.spatial import ConvexHull

from ..gnm import GNM, PIPELINE_DIR
from ..semantic import config_landmarks
from ..semantic import load_config as load_semantic

REFERENCE = PIPELINE_DIR / "config" / "anthropometry.toml"

# id -> (label, how it is measured). Kinds: ("dist", a, b) | ("dist2", a, b, c, d) mean of two sides |
# ("x", a, b) |a.x - b.x| mean of both ears | ("pivots",) eye centres | ("head_circ",) | ("neck_circ",)
MEASURES: dict[str, tuple[str, tuple]] = {
    "head_breadth": ("head breadth eu-eu", ("dist", "euryon_l", "euryon_r")),
    "head_length": ("head length g-op", ("dist", "glabella", "opisthocranion")),
    "head_circumference": ("head circumference", ("head_circ",)),
    "neck_circumference": ("neck circumference", ("neck_circ",)),
    "face_width": ("face width zy-zy", ("dist", "zygion_l", "zygion_r")),
    "jaw_width": ("jaw width go-go", ("dist", "gonion_l", "gonion_r")),
    "face_height": ("face height n-gn", ("dist", "nasion", "menton")),
    "forehead_height": ("forehead height tr-n", ("dist", "trichion", "nasion")),
    "intercanthal": ("intercanthal en-en", ("dist", "endocanthion_l", "endocanthion_r")),
    "biocular": ("biocular ex-ex", ("dist", "exocanthion_l", "exocanthion_r")),
    "fissure_length": ("eye fissure length en-ex", ("dist2", "endocanthion_l", "exocanthion_l", "endocanthion_r", "exocanthion_r")),
    "fissure_height": ("eye fissure height ps-pi", ("dist2", "lid_upper_l", "lid_lower_l", "lid_upper_r", "lid_lower_r")),
    "interpupillary": ("interpupillary (eye centres)", ("pivots",)),
    "nose_width": ("nose width al-al", ("dist", "alare_l", "alare_r")),
    "nose_height": ("nose height n-sn", ("dist", "nasion", "subnasale")),
    "nasal_tip_protrusion": ("nasal tip protrusion sn-prn", ("dist", "subnasale", "pronasale")),
    "mouth_width": ("mouth width ch-ch", ("dist", "cheilion_l", "cheilion_r")),
    "upper_vermilion": ("upper vermilion ls-sto", ("dist", "labrale_superius", "stomion")),
    "lower_vermilion": ("lower vermilion sto-li", ("dist", "stomion", "labrale_inferius")),
    "upper_lip_height": ("upper lip height sn-sto", ("dist", "subnasale", "stomion")),
    "philtrum": ("philtrum sn-ls", ("dist", "subnasale", "labrale_superius")),
    "chin_height": ("lower face sto-gn", ("dist", "stomion", "menton")),
    "ear_length": ("ear length", ("dist2", "ear_top_l", "ear_bottom_l", "ear_top_r", "ear_bottom_r")),
    "ear_protrusion": ("ear protrusion", ("x", "ear_out_l", "ear_root_l", "ear_out_r", "ear_root_r")),
}


@dataclass
class Reference:
    """One published adult range. low/high = the rare-but-real extremes (see `extremes` for what they are)."""

    mean: float
    sd: float
    low: float
    high: float
    extremes: str
    source: str


def load_reference() -> dict[str, Reference]:
    if not REFERENCE.exists():
        return {}
    with open(REFERENCE, "rb") as f:
        doc = tomllib.load(f)
    return {k: Reference(**{f: v[f] for f in Reference.__dataclass_fields__}) for k, v in doc.get("measure", {}).items()}


class Anthropometer:
    """Measures every MEASURES entry on a posed head: `measure(P, pivots)` -> {id: mm}."""

    def __init__(self, gnm: GNM):
        self.gnm = gnm
        lm = config_landmarks(load_semantic())
        lm["stomion"] = np.concatenate([lm["stomion_upper"], lm["stomion_lower"]])
        self.lm = lm
        ext = gnm.vertex_groups["skin_exterior"]
        self.skin_tris = gnm.triangles[ext[gnm.triangles].all(1)]
        no_ears = ext & ~gnm.vertex_groups["ears"]
        self.skull_tris = gnm.triangles[no_ears[gnm.triangles].all(1)]

    def _p(self, P: np.ndarray, name: str) -> np.ndarray:
        return P[self.lm[name]].mean(0)

    def measure(self, P: np.ndarray, pivots: np.ndarray) -> dict[str, float]:
        out = {}
        for mid, (_, spec) in MEASURES.items():
            kind = spec[0]
            if kind == "dist":
                v = np.linalg.norm(self._p(P, spec[1]) - self._p(P, spec[2]))
            elif kind == "dist2":
                v = (np.linalg.norm(self._p(P, spec[1]) - self._p(P, spec[2])) + np.linalg.norm(self._p(P, spec[3]) - self._p(P, spec[4]))) / 2
            elif kind == "x":
                v = (abs(self._p(P, spec[1])[0] - self._p(P, spec[2])[0]) + abs(self._p(P, spec[3])[0] - self._p(P, spec[4])[0])) / 2
            elif kind == "pivots":
                v = np.linalg.norm(pivots[0] - pivots[1])
            elif kind == "head_circ":
                g, op = self._p(P, "glabella"), self._p(P, "opisthocranion")
                n = np.cross(g - op, [1.0, 0.0, 0.0])  # the plane through g and op, square to the midline
                v = _outline(P, self.skull_tris, n / np.linalg.norm(n), g)
            else:  # neck: the thinnest level tape between 8 and 40 mm under the chin
                y0 = self._p(P, "menton")[1]
                v = min(_outline(P, self.skin_tris, np.array([0.0, 1.0, 0.0]), np.array([0.0, y, 0.0]))
                        for y in np.linspace(y0 - 0.040, y0 - 0.008, 9))
            out[mid] = float(v) * 1000.0
        return out


def _outline(P: np.ndarray, tris: np.ndarray, n: np.ndarray, origin: np.ndarray) -> float:
    """Convex perimeter (metres) of the surface cut by the plane through `origin` with unit normal `n`."""
    s = (P[tris] - origin) @ n  # (T, 3) signed distances of the corners
    pts = []
    for a, b in ((0, 1), (1, 2), (2, 0)):
        m = s[:, a] * s[:, b] < 0
        f = s[m, a] / (s[m, a] - s[m, b])
        pa, pb = P[tris[m, a]], P[tris[m, b]]
        pts.append(pa + (pb - pa) * f[:, None])
    p = np.concatenate(pts)
    if len(p) < 3:
        return float("inf")
    u = np.cross(n, [0.0, 0.0, 1.0]) if abs(n[2]) < 0.9 else np.cross(n, [1.0, 0.0, 0.0])
    u /= np.linalg.norm(u)
    v = np.cross(n, u)
    return float(ConvexHull(np.c_[p @ u, p @ v]).area)  # in 2-D, "area" is the perimeter
