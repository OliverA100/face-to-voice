"""Our own hair: procedural strand grooms grown on the GNM scalp (config/grooms.toml).

`uv run groom-preview <id>` renders a style from four sides (out/groom/<id>.png) without exporting;
`uv run export-groom [id ...]` writes web/public/models/hair/<id>.strands.bin + a thumbnail and lists the style in
hair/index.json (kind "strands").

How a style is grown (all in numpy, deterministic per style):
  1. roots: scattered over the scalp triangles above the hairline (DEFAULT_HAIRLINE), area-weighted, thinning out
     over `hairline_soft_mm` so the hairline is soft, never within `ear_margin_mm` of an ear;
  2. growth: each strand leaves the scalp at `lift` and steps `step_mm` at a time towards a mix of its own direction
     (`stiffness`), the style's flow field (away from the part, back, down; projected onto the scalp under it) and
     gravity (growing over `gravity_onset_mm`), and is pushed back out whenever it comes closer to the skin (ears and
     shoulders included) than a stand-off that grows from the root to the tip (the hair's volume);
  3. shaping: resampled to `points` per strand, then pulled into clumps towards the tips, waved and frizzed;
  4. self-shadow: a density grid of all strands gives every point how much hair lies between it and the key light,
     and between it and the outside: deep strands are darker (the soft dark core of real hair). Baked into one byte.

The file is small on purpose: the browser draws `children` extra strands around every shipped one (lib/groom.ts),
so 6000 strands become 12–36k on screen. Strand roots follow the face sliders through the skin at runtime.
"""
from __future__ import annotations

import argparse
import gzip
import json
import math
import struct
import time
import tomllib
from dataclasses import dataclass, field, fields, replace
from pathlib import Path

import numpy as np
from scipy.cluster.vq import kmeans2
from scipy.interpolate import PchipInterpolator
from scipy.spatial import cKDTree

from .gnm import GNM, OUT_DIR, PIPELINE_DIR, REPO_DIR

CONFIG = PIPELINE_DIR / "config" / "grooms.toml"
PREVIEW_DIR = OUT_DIR / "groom"
MAGIC = b"FTVH"
FORMAT_VERSION = 2
QUANTUM_M = 5e-5  # 0.05 mm per int16 unit (far below a pixel; coarser steps compress better)
KEY_LIGHT = np.array([-1.3, 1.3, 2.0])  # web Lighting.tsx LIGHTING.key.position (the self-shadow is baked towards it)
HEAD_CENTRE = np.array([0.0, 0.29, 0.01])
# (angle from the front in degrees, hairline height in metres). 0° = forehead, 90° = above the
# ear, 180° = nape. Landmarks on the template: forehead region tops out at y 0.360, ears span
# y 0.242–0.302, the crown is at y 0.407, the neck joint at y 0.134.
DEFAULT_HAIRLINE: tuple[tuple[float, float], ...] = ((0, 0.362), (35, 0.356), (60, 0.336), (90, 0.312), (130, 0.268), (155, 0.238), (170, 0.226), (180, 0.223))


@dataclass(frozen=True)
class GroomSpec:
    id: str = ""
    label: str = ""
    strands: int = 6000
    points: int = 16
    step_mm: float = 2.0
    hairline_soft_mm: float = 9.0
    ear_margin_mm: float = 7.0
    lift: float = 0.55
    stiffness: float = 0.85
    gravity: float = 0.15
    gravity_onset_mm: float = 30.0
    standoff_mm: tuple[float, float] = (1.2, 9.0)
    standoff_length_mm: float = 60.0
    length_jitter: float = 0.15
    clumps: int = 260
    clump_strength: float = 0.55
    clump_shape: float = 1.6
    wave_mm: float = 0.0
    wave_period_mm: float = 40.0
    frizz_mm: float = 0.6
    flow_noise: float = 0.25
    children: tuple[int, int, int] = (2, 4, 6)
    child_radius_mm: float = 2.2
    width_mm: float = 0.09
    tip_width: float = 0.35
    shine: float = 1.0  # highlight strength × (fine face hair lying flat lights up grey at full strength)
    cover_min: float = 1.0  # strand opacity floor in the app (1 = every strand counts fully; < 1 for very fine hair)
    natural: tuple[str, str] = ("#2a1d16", "#6b4a35")
    part: dict = field(default_factory=lambda: {"x_mm": 0.0, "depth_mm": 90.0})
    lengths_mm: dict = field(default_factory=lambda: {"top": 60, "sides": 25, "back": 30, "nape": 15})
    flow: dict = field(default_factory=lambda: {"away_from_part": 0.8, "back": 0.5, "down": 0.4})
    lift_regions: dict = field(default_factory=dict)  # optional {top, sides, back, nape} lifts overriding `lift`
    hairline: tuple = DEFAULT_HAIRLINE
    seed: int = 0


def load_specs(path: Path = CONFIG) -> dict[str, GroomSpec]:
    with open(path, "rb") as f:
        cfg = tomllib.load(f)
    names = {f.name for f in fields(GroomSpec)}
    base = {k: (tuple(v) if isinstance(v, list) else v) for k, v in cfg.get("defaults", {}).items() if k in names}
    out = {}
    for i, (sid, s) in enumerate(cfg.get("style", {}).items()):
        over = {k: (tuple(v) if isinstance(v, list) else v) for k, v in s.items() if k in names}
        # a style's own `seed` wins; without one it is 1000 + its position in the file (set one to keep a style's
        # strands when styles are added or reordered above it)
        out[sid] = GroomSpec(**{**base, "seed": 1000 + i, **over, "id": sid})
    return out


def smoothstep(x):
    x = np.clip(x, 0.0, 1.0)
    return x * x * (3.0 - 2.0 * x)


def unit(v: np.ndarray) -> np.ndarray:
    return v / np.maximum(np.linalg.norm(v, axis=-1, keepdims=True), 1e-12)


# --- where hair grows ----------------------------------------------------------------------------


def hairline_height(p: np.ndarray, hairline=DEFAULT_HAIRLINE, axis_z: float = 0.02) -> np.ndarray:
    angle = np.degrees(np.abs(np.arctan2(p[:, 0], p[:, 2] - axis_z)))
    a, h = zip(*sorted(hairline))
    return PchipInterpolator(a, h)(np.clip(angle, a[0], a[-1]))


def scatter_roots(gnm: GNM, spec: GroomSpec, rng: np.random.Generator):
    """(positions, normals) of `spec.strands` roots on the scalp."""
    from .surface import gnm_surface

    surf = gnm_surface(gnm)  # skin_exterior without the ears
    pos, tris = surf.positions, surf.triangles
    a, b, c = (pos[tris[:, i]] for i in range(3))
    centroid = (a + b + c) / 3
    area = 0.5 * np.linalg.norm(np.cross(b - a, c - a), axis=1)
    above = centroid[:, 1] - hairline_height(centroid, spec.hairline)
    ears = gnm.template[gnm.vertex_groups["ears"] > 0.5]
    ear_d = cKDTree(ears).query(centroid)[0]
    density = smoothstep(above / (spec.hairline_soft_mm / 1000)) * smoothstep((ear_d - spec.ear_margin_mm / 1000) / 0.006)
    weight = area * density
    pick = rng.choice(len(tris), size=spec.strands, p=weight / weight.sum())
    r1, r2 = rng.random(spec.strands), rng.random(spec.strands)
    s = np.sqrt(r1)
    bary = np.stack([1 - s, s * (1 - r2), s * r2], axis=1)
    roots = np.einsum("nk,nkd->nd", bary, pos[tris[pick]])
    normals = surf.normals_at(pick.astype(np.int32), bary.astype(np.float32))
    return roots, normals


# --- the style's flow field ----------------------------------------------------------------------


def region_weights(p: np.ndarray) -> dict[str, np.ndarray]:
    """Soft weights per point for top / sides / back / nape (sum 1)."""
    angle = np.degrees(np.abs(np.arctan2(p[:, 0], p[:, 2] - 0.02)))  # 0 front, 90 side, 180 back
    top = smoothstep((p[:, 1] - 0.355) / 0.035)
    back = smoothstep((angle - 105) / 45)
    low = smoothstep((0.29 - p[:, 1]) / 0.04)  # the nape: low at the back
    rest = 1 - top
    return {"top": top, "sides": rest * (1 - back), "back": rest * back * (1 - low), "nape": rest * back * low}


def lengths_for(p: np.ndarray, spec: GroomSpec, rng) -> np.ndarray:
    w = region_weights(p)
    total = sum(w.values())
    L = sum(w[k] * spec.lengths_mm.get(k, 0) for k in w) / np.maximum(total, 1e-6)
    return L / 1000 * (1 + spec.length_jitter * (rng.random(len(p)) * 2 - 1))


def comb(p: np.ndarray, n: np.ndarray, spec: GroomSpec, twist: np.ndarray) -> np.ndarray:
    """Unit comb direction in the tangent plane at each point (n = the scalp normal under it)."""
    part_x = spec.part.get("x_mm", 0) / 1000
    side = np.sign(p[:, 0] - part_x + 1e-9)
    # The part runs back from the hairline (z ≈ 0.12) by depth_mm; behind it (the crown) the hair falls back/down.
    front_z = 0.115
    on_part = smoothstep((p[:, 2] - (front_z - spec.part.get("depth_mm", 90) / 1000)) / 0.02) * smoothstep((p[:, 1] - 0.33) / 0.03)
    f = spec.flow
    c = (f.get("away_from_part", 0) * on_part)[:, None] * side[:, None] * np.array([1.0, 0, 0])
    c = c + f.get("back", 0) * np.array([0, 0, -1.0]) + f.get("down", 0) * np.array([0, -1.0, 0]) + f.get("forward", 0) * np.array([0, 0, 1.0])
    c = c - (c * n).sum(1, keepdims=True) * n
    # Per-strand random turn about the normal: the hair is combed, not ruled.
    cos, sin = np.cos(twist)[:, None], np.sin(twist)[:, None]
    c = c * cos + np.cross(n, c) * sin + n * (n * c).sum(1, keepdims=True) * (1 - cos)
    return unit(c)


# --- growth ------------------------------------------------------------------------------------


def grow(gnm: GNM, spec: GroomSpec, roots, normals, lengths, rng) -> list[np.ndarray]:
    """Polyline per strand (variable point count), from the root outwards."""
    from .surface import gnm_surface

    collide = gnm_surface(gnm, ears=True, extrude=True)
    step = spec.step_mm / 1000
    n_steps = math.ceil(lengths.max() / step)
    twist = np.radians(rng.normal(0, 1, len(roots)) * spec.flow_noise * 40)
    p = roots.astype(np.float64).copy()
    c0 = comb(p, normals, spec, twist)
    lift = np.full(len(p), spec.lift)
    if spec.lift_regions:
        w = region_weights(p)
        lift = sum(w[k] * spec.lift_regions.get(k, spec.lift) for k in w) / np.maximum(sum(w.values()), 1e-6)
    d = unit(lift[:, None] * normals + (1 - lift[:, None]) * c0)
    lo, hi = (x / 1000 for x in spec.standoff_mm)
    paths = [p.copy()]
    alive = np.ones(len(p), bool)
    s = np.zeros(len(p))
    down = np.array([0, -1.0, 0])
    for _ in range(n_steps):
        idx = np.where(alive)[0]
        if not len(idx):
            break
        q = p[idx]
        tri, bary, cp = collide.closest(q)
        nrm = collide.normals_at(tri, bary)
        g = spec.gravity * smoothstep(s[idx] / (spec.gravity_onset_mm / 1000))
        want = spec.stiffness * d[idx] + (1 - spec.stiffness) * comb(q, nrm, spec, twist[idx]) + g[:, None] * down
        q_next = q + unit(want) * step
        # keep the stand-off: push out along the skin normal under the new point
        tri, bary, cp = collide.closest(q_next)
        nrm = collide.normals_at(tri, bary)
        dist = ((q_next - cp) * nrm).sum(1)
        # volume grows along the strand, and short strands get less of it (a crop lies on the head)
        reach = np.minimum(1.0, lengths[idx] / (spec.standoff_length_mm / 1000 * 2))
        off = lo + (hi - lo) * smoothstep((s[idx] + step) / (spec.standoff_length_mm / 1000)) * reach
        push = np.clip(off - dist, 0, None)
        q_next = q_next + push[:, None] * nrm
        d[idx] = unit(q_next - q)
        p[idx] = q_next
        s[idx] += step
        alive[idx] = s[idx] < lengths[idx]
        paths.append(p.copy())
    stack = np.stack(paths, axis=1)  # (N, steps+1, 3); dead strands repeat their last point
    out = []
    for i in range(len(roots)):
        k = int(min(stack.shape[1] - 1, math.ceil(lengths[i] / step)))
        out.append(stack[i, : k + 1])
    return out


def resample(poly: np.ndarray, n: int) -> np.ndarray:
    seg = np.linalg.norm(np.diff(poly, axis=0), axis=1)
    s = np.concatenate([[0], np.cumsum(seg)])
    if s[-1] <= 0:
        return np.repeat(poly[:1], n, axis=0)
    t = np.linspace(0, s[-1], n)
    return np.stack([np.interp(t, s, poly[:, k]) for k in range(3)], axis=1)


def shape(strands: np.ndarray, spec: GroomSpec, rng) -> np.ndarray:
    """Clumps, waves, frizz on (N, P, 3) strands."""
    N, P, _ = strands.shape
    t = np.linspace(0, 1, P)
    # clumps: k-means on the roots + the tip direction, so a clump is strands that go the same way
    feats = np.concatenate([strands[:, 0], (strands[:, -1] - strands[:, 0]) * 0.3], axis=1)
    _, label = kmeans2(feats, min(spec.clumps, N), seed=spec.seed, minit="++")
    centre = np.zeros((label.max() + 1, P, 3))
    np.add.at(centre, label, strands)
    count = np.bincount(label, minlength=len(centre))[:, None, None]
    centre /= np.maximum(count, 1)
    pull = spec.clump_strength * t ** spec.clump_shape
    # short strands barely clump (clumps of 2 cm hair read as tufts); full strength from 8 cm
    length0 = np.linalg.norm(np.diff(strands, axis=1), axis=2).sum(1)
    pull = pull[None, :] * np.minimum(1.0, length0 / 0.08)[:, None]
    out = strands + (centre[label] - strands) * pull[..., None]
    # waves and frizz in the plane across each strand
    tang = unit(np.gradient(out, axis=1))
    ref = unit(out - HEAD_CENTRE)
    side = unit(np.cross(tang, ref))
    length = np.linalg.norm(np.diff(out, axis=1), axis=2).sum(1)
    arc = t[None, :] * length[:, None]
    if spec.wave_mm > 0:
        phase = rng.random(N)[:, None] * 2 * np.pi
        w = spec.wave_mm / 1000 * np.sin(2 * np.pi * arc / (spec.wave_period_mm / 1000) + phase) * smoothstep(t * 3)[None]
        out = out + side * w[..., None]
    if spec.frizz_mm > 0:
        f = np.zeros_like(out)
        for _ in range(2):  # two smooth random wobbles per strand
            amp = rng.normal(0, 1, (N, 1, 3))
            freq = rng.uniform(1.5, 4.0, (N, 1, 1))
            ph = rng.random((N, 1, 1)) * 2 * np.pi
            f += amp * np.sin(freq * 2 * np.pi * t[None, :, None] + ph)
        # by real length: a 2 cm strand barely wobbles, a 30 cm one fully (frizz is a long-hair thing)
        out = out + f * (spec.frizz_mm / 1000) * (np.minimum(arc / 0.12, 1.0) ** 2)[..., None]
    out[:, 0] = strands[:, 0]  # roots stay on the scalp
    return out


def keep_out(gnm: GNM, strands: np.ndarray, min_m: float) -> np.ndarray:
    """Push every point back to at least `min_m` outside the skin (after clumping and frizz)."""
    from .surface import gnm_surface

    collide = gnm_surface(gnm, ears=True, extrude=True)
    N, P, _ = strands.shape
    flat = strands.reshape(-1, 3)
    tri, bary, cp = collide.closest(flat)
    nrm = collide.normals_at(tri, bary)
    dist = ((flat - cp) * nrm).sum(1)
    push = np.clip(min_m - dist, 0, None)
    push.reshape(N, P)[:, 0] = 0
    return (flat + push[:, None] * nrm).reshape(N, P, 3)


def keep_out_smooth(gnm: GNM, strands: np.ndarray, min_m: float, rounds: int = 8) -> np.ndarray:
    """keep_out without the kinks: the push is spread along each strand (roots fixed) and repeated until the strand
    clears the skin, so hair that meets the neck or an ear bends away over a few points instead of folding into a
    ledge. A last plain keep_out catches what is left (sub-millimetre)."""
    from .surface import gnm_surface

    collide = gnm_surface(gnm, ears=True, extrude=True)
    _, P, _ = strands.shape
    total = np.zeros_like(strands)
    live = np.arange(len(strands))  # strands still touching the skin
    for _ in range(rounds):
        flat = (strands[live] + total[live]).reshape(-1, 3)
        tri, bary, cp = collide.closest(flat)
        nrm = collide.normals_at(tri, bary)
        push = np.clip(min_m - ((flat - cp) * nrm).sum(1), 0, None).reshape(len(live), P)
        hit = push.max(1) > 1e-5
        live, push, nrm = live[hit], push[hit], nrm.reshape(len(hit), P, 3)[hit]
        if not len(live):
            break
        t = total[live] + push[..., None] * nrm
        for _ in range(3):  # spread along the strand
            t[:, 1:-1] = 0.5 * t[:, 1:-1] + 0.25 * (t[:, :-2] + t[:, 2:])
            t[:, -1] = 0.5 * (t[:, -1] + t[:, -2])
            t[:, 0] = 0
        total[live] = t
    return keep_out(gnm, strands + total, min_m)


def fair(strands: np.ndarray, passes: int) -> np.ndarray:
    """Smooth each strand along its length (root fixed): walking a faceted skin and the push-outs leave kinks that read
    as scribbled, wiry hair."""
    s = strands.copy()
    for _ in range(passes):
        s[:, 1:-1] = 0.5 * s[:, 1:-1] + 0.25 * (s[:, :-2] + s[:, 2:])
        s[:, -1] = 0.5 * s[:, -1] + 0.5 * (2 * s[:, -2] - s[:, -3])
        s[:, 0] = strands[:, 0]
    return s


def self_shadow(strands: np.ndarray, cell_m: float = 0.003, sigma: float = 0.06) -> np.ndarray:
    """(N, P) 0..1: light reaching each point through the other strands (key light and straight out)."""
    pts = strands.reshape(-1, 3)
    lo = pts.min(0) - 0.02
    dims = np.ceil((pts.max(0) + 0.02 - lo) / cell_m).astype(int)
    grid = np.zeros(dims)
    ijk = ((pts - lo) / cell_m).astype(int)
    np.add.at(grid, tuple(ijk.T), 1.0)

    def march(dirs: np.ndarray, steps: int = 14, dl: float = 0.004) -> np.ndarray:
        acc = np.zeros(len(pts))
        for k in range(1, steps + 1):
            q = ((pts + dirs * dl * k - lo) / cell_m).astype(int)
            ok = np.all((q >= 0) & (q < dims), axis=1)
            acc[ok] += grid[tuple(q[ok].T)]
        return np.exp(-sigma * acc)

    key = march(np.broadcast_to(unit(KEY_LIGHT), pts.shape))
    out = march(unit(pts - HEAD_CENTRE))
    return (0.55 * key + 0.45 * out).reshape(strands.shape[:2])


# --- one style ---------------------------------------------------------------------------------


@dataclass
class Groom:
    spec: GroomSpec
    strands: np.ndarray  # (N, P, 3) float64 metres, GNM space, random order
    shade: np.ndarray  # (N, P) 0..1


def build(spec: GroomSpec, gnm: GNM | None = None, log=print) -> Groom:
    t0 = time.time()
    gnm = gnm or GNM.load()
    rng = np.random.default_rng(spec.seed)
    roots, normals = scatter_roots(gnm, spec, rng)
    lengths = lengths_for(roots, spec, rng)
    polys = grow(gnm, spec, roots, normals, lengths, rng)
    strands = np.stack([resample(p, spec.points) for p in polys])
    strands = shape(strands, spec, rng)
    strands = keep_out(gnm, strands, spec.standoff_mm[0] / 1000 * 0.6)
    shade = self_shadow(strands)
    order = rng.permutation(len(strands))  # any prefix is an even subset (the low tier could draw fewer)
    log(f"  {spec.id}: {len(strands)} strands × {spec.points} points, lengths {lengths.min() * 1000:.0f}–{lengths.max() * 1000:.0f} mm, "
        f"shade {shade.min():.2f}–{shade.max():.2f}, {time.time() - t0:.1f} s")
    return Groom(spec, strands[order], shade[order])


def encode(groom: Groom) -> bytes:
    """The .strands.bin payload (gzip). Header (little-endian): magic "FTVH", u32 version (2), u32 strands, u32
    points, f32 origin xyz, f32 quantum (metres per unit). Body: int16 second differences along each strand (point 0
    absolute, point 1 the first step, then the change of step: smooth strands give tiny numbers), stored per axis
    (all x, all y, all z) with the low bytes of the whole array first and the high bytes after, which gzip packs
    best; then u8 shade per point."""
    s = groom.strands
    N, P, _ = s.shape
    origin = s.reshape(-1, 3).mean(0)
    q = np.round((s - origin) / QUANTUM_M).astype(np.int64)
    d = q.copy()
    d[:, 1:] = q[:, 1:] - q[:, :-1]
    d2 = d.copy()
    d2[:, 2:] = d[:, 2:] - d[:, 1:-1]
    if np.abs(d2).max() > 32767:
        raise ValueError("strand step too large for int16")
    planar = np.ascontiguousarray(d2.transpose(2, 0, 1)).astype("<i2").view(np.uint8).reshape(-1, 2)
    head = MAGIC + struct.pack("<3I4f", FORMAT_VERSION, N, P, *origin.astype(np.float32), QUANTUM_M)
    body = planar[:, 0].tobytes() + planar[:, 1].tobytes() + np.round(groom.shade * 255).astype(np.uint8).tobytes()
    return gzip.compress(head + body, compresslevel=9, mtime=0)


# --- preview -----------------------------------------------------------------------------------


def render_views(groom: Groom, path: Path, size: int = 520, views=(0, 40, 90, 180), gnm: GNM | None = None,
                 focal=(0.0, 0.27, 0.02), distance: float = 0.75, line_width: float = 1.0) -> Path:
    """Strands as lines over the grey head, from several sides, side by side (pyvista, quick look only)."""
    import pyvista as pv
    from PIL import Image

    from .render import HeadRenderer

    gnm = gnm or GNM.load()
    r = HeadRenderer(gnm, size=size)
    r.plotter.set_background("#f5f3f1")
    N, P, _ = groom.strands.shape
    pts = groom.strands.reshape(-1, 3)
    cells = np.hstack([np.full((N, 1), P), np.arange(N * P).reshape(N, P)]).ravel()
    lines = pv.PolyData(pts, lines=cells)
    lo, hi = (np.array([int(groom.spec.natural[i][k: k + 2], 16) for k in (1, 3, 5)]) / 255 for i in (0, 1))
    t = np.tile(np.linspace(0, 1, P), N)
    col = (lo[None] + (hi - lo)[None] * t[:, None]) * (0.35 + 0.65 * groom.shade.reshape(-1))[:, None]
    lines.point_data["rgb"] = (np.clip(col, 0, 1) * 255).astype(np.uint8)
    r.plotter.add_mesh(lines, scalars="rgb", rgb=True, line_width=line_width, lighting=False)
    tiles = []
    for yaw in views:
        r.look(focal, distance, yaw)
        tmp = path.with_name(f"{path.stem}-{yaw}.png")
        r.screenshot(tmp)
        tiles.append(Image.open(tmp).convert("RGB"))
    sheet = Image.new("RGB", (size * len(tiles), size), "white")
    for i, im in enumerate(tiles):
        sheet.paste(im, (i * size, 0))
        Path(path.with_name(f"{path.stem}-{views[i]}.png")).unlink()
    path.parent.mkdir(parents=True, exist_ok=True)
    sheet.save(path)
    return path


def _overrides(spec: GroomSpec, sets: list[str]) -> GroomSpec:
    out = {}
    for s in sets or []:
        k, v = s.split("=", 1)
        cur = getattr(spec, k)
        out[k] = tuple(float(x) for x in v.split(",")) if isinstance(cur, tuple) else type(cur)(json.loads(v)) if not isinstance(cur, dict) else json.loads(v)
    return replace(spec, **out)


def preview_main() -> None:
    ap = argparse.ArgumentParser(description="Render a groom from four sides (out/groom/<id>.png)")
    ap.add_argument("ids", nargs="*")
    ap.add_argument("--set", action="append", default=[], help="override a spec field, e.g. --set lift=0.4")
    args = ap.parse_args()
    specs = load_specs()
    gnm = GNM.load()
    for sid in args.ids or list(specs):
        g = build(_overrides(specs[sid], args.set), gnm)
        print("  →", render_views(g, PREVIEW_DIR / f"{sid}.png", gnm=gnm).relative_to(REPO_DIR))
