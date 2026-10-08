"""The GNM eyelids: the lid margins (the rim of each eye opening, split into upper and lower lid), the lash lines (the
margins' outer edge, where lashes grow) and the eyeball centres, plus Polyline. Pure GNM geometry; lash_strands.py
grows its lashes from them."""
from __future__ import annotations

import numpy as np

from .export_glb import boundary_loops, vertex_normals
from .gnm import GNM
from .head_context import HeadContext

LASH_LINE_SMOOTH = 2  # rounds of 1-2-1 smoothing along the lash line (the walk lands on vertices of different rings)


# Where on the lid the lashes grow. The rim of the eye opening is the INNER edge of the lid margin (it touches the
# eyeball); the GNM lids are 2–3 mm thick and the lashes belong on their OUTER edge. Walking outwards from the rim
# the skin normal turns from "into the eye" to "out of the face"; the lash line is where its component along the
# direction from the eyeball's centre reaches this value (0 = the margin's flat underside, 1 = the lid's front).
LASH_LINE_FACING = {"upper": 0.5, "lower": 0.35}  # the lower lid's line sits closer to the rim (its lashes sat 1–2 mm below it)


LASH_LINE_MAX_STEPS = 8  # rings of skin vertices searched outwards from the rim


def eye_joints(gnm: GNM) -> np.ndarray:
    """(2, 3): the eyeball centres, GNM's left_eye and right_eye joints in that order."""
    return np.array([gnm.joint_positions[gnm.joint_names.index(j)] for j in ("left_eye", "right_eye")])


def lid_margins(ctx: HeadContext, positions: np.ndarray | None = None) -> dict[tuple[str, str], np.ndarray]:
    """(side, "upper" | "lower") → GNM vertex ids along that lid margin, from the inner corner of the
    eye to the outer one. The margin is the rim of the eye opening: the open edge of the skin_exterior
    surface around each eye (40 vertices per eye), split at its two corners (smallest and largest |x|)."""
    gnm = ctx.gnm
    pos = gnm.template if positions is None else positions
    skin = gnm.vertex_groups["skin_exterior"] > 0.5
    socket = gnm.vertex_groups["eye_sockets"] > 0.5
    tris = gnm.triangles[skin[gnm.triangles].all(axis=1)]
    out = {}
    for found in boundary_loops(tris):
        if not socket[found].all():  # the bust's rim, the mouth, the nostrils …
            continue
        loop = np.asarray(found)
        side = "left" if pos[loop, 0].mean() > 0 else "right"
        ax = np.abs(pos[loop, 0])
        loop = np.roll(loop, -int(ax.argmin()))  # start at the inner corner
        k = int(np.abs(pos[loop, 0]).argmax())  # the outer corner
        one, two = loop[: k + 1], np.concatenate([loop[k:], loop[:1]])[::-1]
        upper, lower = (one, two) if pos[one, 1].mean() > pos[two, 1].mean() else (two, one)
        out[(side, "upper")], out[(side, "lower")] = upper, lower
    if len(out) != 4:
        raise ValueError(f"expected the two eye openings in the GNM skin, found {sorted(out)}")
    return out


def lash_lines(ctx: HeadContext) -> dict[tuple[str, str], np.ndarray]:
    """(side, lid) → (K, 3) points on the template skin along the OUTER edge of that lid margin, inner
    corner first: one per rim vertex, found by walking outwards over the skin (always to the closest
    vertex of the next ring) until the normal faces out of the face (LASH_LINE_FACING per lid), interpolated
    between the last two vertices of the walk."""
    gnm = ctx.gnm
    pos = gnm.template.astype(np.float64)
    skin = gnm.vertex_groups["skin_exterior"] > 0.5
    tris = gnm.triangles[skin[gnm.triangles].all(axis=1)]
    normals = vertex_normals(gnm.template, tris).astype(np.float64)
    neighbours: dict[int, set[int]] = {}
    for a, b in np.concatenate([tris[:, [0, 1]], tris[:, [1, 2]], tris[:, [2, 0]]]):
        neighbours.setdefault(int(a), set()).add(int(b))
        neighbours.setdefault(int(b), set()).add(int(a))
    margins = lid_margins(ctx)
    out = {}
    for side in ("left", "right"):
        eye = pos[gnm.vertex_groups[f"{side}_eye"] > 0.5]
        centre = (eye.min(0) + eye.max(0)) / 2.0

        def facing(v: int, centre: np.ndarray = centre) -> float:  # the normal's share pointing away from the eyeball
            return float(normals[v] @ (pos[v] - centre) / np.linalg.norm(pos[v] - centre))

        rim = set(int(v) for lid in ("upper", "lower") for v in margins[(side, lid)])
        ring = {v: 0 for v in rim}  # vertex → how many edges from the rim
        front = rim
        for k in range(1, LASH_LINE_MAX_STEPS + 1):
            front = {n for v in front for n in neighbours[v] if n not in ring}
            ring.update({v: k for v in front})
        for lid in ("upper", "lower"):
            line = []
            for rim_v in map(int, margins[(side, lid)]):
                v, point = rim_v, pos[rim_v]
                for _ in range(LASH_LINE_MAX_STEPS):
                    steps = [n for n in neighbours[v] if ring.get(n) == ring[v] + 1]
                    if not steps:
                        break
                    n = min(steps, key=lambda n: np.linalg.norm(pos[n] - pos[v]))
                    f0, f1 = facing(v), facing(n)
                    if f1 >= LASH_LINE_FACING[lid]:
                        t = np.clip((LASH_LINE_FACING[lid] - f0) / max(f1 - f0, 1e-9), 0.0, 1.0)
                        point = pos[v] + t * (pos[n] - pos[v])
                        break
                    v, point = n, pos[n]
                line.append(point)
            line = np.array(line)
            for _ in range(LASH_LINE_SMOOTH):
                line[1:-1] = 0.25 * line[:-2] + 0.5 * line[1:-1] + 0.25 * line[2:]
            out[(side, lid)] = ctx.skin.closest(line)[2]  # back onto the skin
    return out


class Polyline:
    """A curve through points, addressed by arc-length fraction 0…1."""

    def __init__(self, points: np.ndarray):
        self.points = np.asarray(points, np.float64)
        seg = np.linalg.norm(np.diff(self.points, axis=0), axis=1)
        self.length = float(seg.sum())
        self.s = np.concatenate([[0.0], np.cumsum(seg)]) / self.length

    def at(self, s: np.ndarray) -> np.ndarray:
        s = np.clip(s, 0.0, 1.0)
        return np.stack([np.interp(s, self.s, self.points[:, i]) for i in range(3)], axis=-1)
