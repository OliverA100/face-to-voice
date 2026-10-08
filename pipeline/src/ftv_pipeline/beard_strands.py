"""`uv run beard-strands [id …] [--preview]`: full beards and moustaches as strands (ours, MIT), drawn by the app's strand
renderer (lib/groom.ts) like the hair, with live roots so they follow the jaw and lips through speech and emotions.

Each style (config/beards.toml):
  - roots spread over the skin inside the style's outline (stubble.mask: the MakeHuman beards' contact with the skin as
    shape guides, plus a groomed cheek line and neckline), denser where the outline is solid;
  - a length per root: the style's length, shorter on the cheeks and upper lip, and on the chin and jaw as long as the
    guide beard hangs below that root (so the Viking guide gives a long beard, the full beard a short-to-medium one);
  - growth: leaving the skin along its normal, combed down along it, then falling under gravity, standing off the face
    more and more along its length (volume); moustache hairs comb down and out from the middle of the lip;
  - clumps (neighbouring hairs gather towards their clump's centre towards the tips) and per-style curl / frizz;
  - nothing passes inside the skin (lips included: the moustache rests on the upper lip).
"""
from __future__ import annotations

import argparse
import json
import time
import tomllib

import numpy as np
from PIL import Image
from scipy.spatial import cKDTree

from .addon_fit import ADDONS_MODELS_DIR
from .bake import BAKE_DIR, ktx2
from .export_groom import WORK, entry
from .gnm import PIPELINE_DIR
from .groom import Groom, GroomSpec, encode, fair, keep_out_smooth, render_views, self_shadow, unit
from .guides import beard_guide
from .head_context import head_context
from .skin_maps import rasterize, skin_triangles
from .stubble import LANDMARKS, guide_roots, mask, picker_order, smooth
from .surface import Surface, gnm_surface

CONFIG = PIPELINE_DIR / "config" / "beards.toml"
MODELS = ADDONS_MODELS_DIR / "facialHair"


def sample_roots(surf, cov: np.ndarray, n: int, rng, min_cover: float = 0.0) -> tuple[np.ndarray, np.ndarray]:
    """n points on the skin, area × coverage weighted, none where the coverage is under min_cover (the outline's faded
    edge is the stubble under the beard: lone long hairs there read as strays); returns (points, normals)."""
    tri = surf.triangles
    P = surf.positions
    a, b, c = P[tri[:, 0]], P[tri[:, 1]], P[tri[:, 2]]
    area = 0.5 * np.linalg.norm(np.cross(b - a, c - a), axis=1)
    cv = cov[tri].mean(1)
    w = area * cv ** 1.5 * (cv >= min_cover)
    w /= w.sum()
    pick = rng.choice(len(tri), n, p=w)
    r1, r2 = rng.random(n), rng.random(n)
    s = np.sqrt(r1)
    bary = np.stack([1 - s, s * (1 - r2), s * r2], 1)
    pts = bary[:, :1] * a[pick] + bary[:, 1:2] * b[pick] + bary[:, 2:] * c[pick]
    t, bb, cp = surf.closest(pts)
    return cp, surf.normals_at(t, bb)


def hang_lengths(roots: np.ndarray, guide: np.ndarray, mouth_y: float) -> np.ndarray:
    """How far the guide beard hangs below each root (metres; 0 above the mouth corners)."""
    tree = cKDTree(guide[:, [0, 2]])
    out = np.zeros(len(roots))
    for i, r in enumerate(roots):
        near = tree.query_ball_point(r[[0, 2]], 0.012)
        if near:
            out[i] = max(0.0, r[1] - guide[near, 1].min())
    return out * (roots[:, 1] < mouth_y + 0.01)


def smooth_field(roots: np.ndarray, val: np.ndarray, passes: int = 4, k: int = 24) -> np.ndarray:
    """Average a per-root value over its neighbours a few times (a smooth random field over the beard)."""
    nb = cKDTree(roots).query(roots, k=k)[1]
    for _ in range(passes):
        val = val[nb].mean(1)
    return val


def comb_dirs(cfg: dict, roots: np.ndarray, normals: np.ndarray, moustache: np.ndarray, mouth_y: float, rng) -> np.ndarray:
    """Where each hair is combed (world direction): down, a little in towards the chin below the mouth, the moustache
    down and out from the middle of the lip; turned about the skin normal by a smooth random angle shared with the
    neighbours (a beard is combed: every hair goes the way of the ones around it) plus a little of its own."""
    n = len(roots)
    down = np.array([0.0, -1.0, 0.0])
    side = np.sign(roots[:, 0])[:, None] * np.array([1.0, 0.0, 0.0])
    below = np.clip((mouth_y - roots[:, 1]) / 0.02, 0, 1)[:, None]
    c = down - side * cfg["converge"] * below
    # (and off the nostril sill: forward, or under the nose the hairs would wander sideways along it)
    c = np.where(moustache[:, None], down + side * cfg["moustache_spread"] + np.array([0.0, 0.0, 0.35]), c)
    field = smooth_field(roots, rng.normal(0, 1, n))
    field /= max(field.std(), 1e-9)
    ang = np.radians(field * cfg["flow_noise_deg"] + rng.normal(0, cfg["jitter_deg"], n))
    c = unit(c - normals * (c * normals).sum(1, keepdims=True) + 1e-9)
    cos, sin = np.cos(ang)[:, None], np.sin(ang)[:, None]
    return unit(c * cos + np.cross(normals, c) * sin)


def grow(cfg: dict, roots: np.ndarray, normals: np.ndarray, lengths: np.ndarray, moustache: np.ndarray, gnm, mouth_y: float,
         rng) -> np.ndarray:
    """Each hair walks along the skin in its comb direction, at its own layer's height above it (the beard is layers of
    hair lying on the face, thicker towards the tips), until the skin turns away underneath (the jaw line, the chin,
    the lip for the moustache); from there it falls freely under gravity, its end turning under towards the throat."""
    P, sub = int(cfg["points"]), 3
    n = len(roots)
    surf = gnm_surface(gnm)
    down = np.array([0.0, -1.0, 0.0])
    comb = comb_dirs(cfg, roots, normals, moustache, mouth_y, rng)
    # every hair sweeps through a gentle arc (beard hair curves; ruler-straight hair reads as a brush), mostly the way
    # its neighbours sweep
    field = smooth_field(roots, rng.normal(0, 1, n))
    bend = np.radians(field / max(field.std(), 1e-9) * cfg["bend_deg"] + rng.normal(0, cfg["bend_deg"] * 0.4, n))
    bend *= np.where(moustache, cfg["moustache_bend"], 1.0)  # a moustache is combed straight out from the parting
    lo, hi = (v / 1000 for v in cfg["standoff_mm"])
    ramp = cfg["standoff_ramp_mm"] / 1000
    m_hi, m_ramp = cfg["moustache_standoff_mm"] / 1000, cfg["moustache_ramp_mm"] / 1000  # a moustache lies flatter
    layer = rng.random(n) ** cfg["layer_bias"]  # 0 = against the skin … 1 = the beard's outside
    step = lengths / ((P - 1) * sub)
    p, d, s = roots.copy(), comb.copy(), np.zeros(n)
    attached = (normals[:, 1] > -cfg["leave_ny"]) | moustache  # the moustache lies on the lip from under the nose
    back = np.array([0.0, 0.0, -1.0])
    pts = [roots]
    for k in range(1, P):
        for _ in range(sub):
            tri, bary, cp = surf.closest(p)
            nrm = surf.normals_at(tri, bary)
            # the skin turns away underneath (under the jaw and chin), or the moustache reaches the lip: let go
            # (the moustache: at the lip, or where the lip turns in towards the mouth: only near the mouth, not under the
            # nose, where the skin faces down too and the hairs would jut out from their roots)
            curls_in = (nrm[:, 1] < -cfg.get("moustache_leave_ny", 1.0)) & (p[:, 1] < mouth_y + 0.004)
            a = (bend * np.clip(s / np.maximum(lengths, 1e-6), 0, 1))[:, None]
            c_t = comb * np.cos(a) + np.cross(nrm, comb) * np.sin(a)
            walk = unit(c_t - nrm * (c_t * nrm).sum(1, keepdims=True) + 1e-9)
            on_lip = (p[:, 1] >= mouth_y + 0.001) & ~curls_in
            if "moustache_walk_down" in cfg:
                # a moustache hair only lies on the skin where that takes it clearly downwards (under the nose the skin
                # faces down: walking it, the hair would set off sideways and hook); elsewhere it grows down and out,
                # and lies on the lip again further down
                # (nor where it heads back into the mouth: over the bulge of the upper lip)
                follows = (walk[:, 1] < -cfg["moustache_walk_down"]) & (walk[:, 2] > -cfg.get("moustache_walk_back", 1.0))
                attached = np.where(moustache, on_lip & follows, attached & (nrm[:, 1] > -cfg["leave_ny"]))
            else:
                attached &= np.where(moustache, on_lip, nrm[:, 1] > -cfg["leave_ny"])
            # the beard's ends turn under, towards the throat; a moustache past the lip may hang differently
            # (moustache_gravity / moustache_tuck: tucked, its tips hook back into the mouth)
            g = np.where(moustache, cfg.get("moustache_gravity", cfg["gravity"]), cfg["gravity"])[:, None] * min(1.0, k / (P - 1) * 2)
            fall = unit(d * (1 - g) + (down + back * np.where(moustache, cfg.get("moustache_tuck", cfg["tuck"]), cfg["tuck"])[:, None]) * g)
            fall[:, 1] = np.minimum(fall[:, 1], -cfg["min_fall"])
            if "moustache_forward" in cfg:  # a moustache drapes over the lip: its free part never heads back into the mouth
                fall[:, 2] = np.where(moustache, np.maximum(fall[:, 2], cfg["moustache_forward"]), fall[:, 2])
            fall = unit(fall)
            if "moustache_min_fall" in cfg:  # downwards by at least this much once normalised (the clamp above is not)
                y = np.minimum(fall[:, 1], -cfg["moustache_min_fall"])
                xz = fall[:, [0, 2]] * (np.sqrt(1 - y * y) / np.maximum(np.linalg.norm(fall[:, [0, 2]], axis=1), 1e-9))[:, None]
                fall = np.where(moustache[:, None], np.column_stack([xz[:, 0], y, xz[:, 1]]), fall)
            d = np.where(attached[:, None], walk, fall)
            p = p + d * step[:, None]
            s += step
            tri, bary, cp = surf.closest(p)
            nrm = surf.normals_at(tri, bary)
            h = np.where(moustache, lo + (m_hi - lo) * layer * np.clip(s / m_ramp, 0, 1) ** 0.7,
                         lo + (hi - lo) * layer * np.clip(s / ramp, 0, 1) ** 0.7)
            p = np.where(attached[:, None], cp + nrm * h[:, None], p)
        pts.append(p.copy())
    return np.stack(pts, 1)


def cohere(strands: np.ndarray, roots: np.ndarray, cfg: dict) -> np.ndarray:
    """No hair goes its own way: each strand's shape (root → tip, per unit length) is blended towards its neighbours'
    mean shape, fully where it strays from it (an outlier)."""
    rel = strands - roots[:, None]
    L = np.linalg.norm(np.diff(strands, axis=1), axis=2).sum(1)
    shape = rel / np.maximum(L, 1e-6)[:, None, None]
    nb = cKDTree(roots).query(roots, k=int(cfg["cohere_k"]))[1]
    mean = shape[nb].mean(1)
    dev = np.linalg.norm(shape - mean, axis=2).max(1)
    w = np.maximum(cfg["cohere"], np.clip((dev - cfg["stray"]) / cfg["stray"], 0, 1))
    return roots[:, None] + (shape + (mean - shape) * w[:, None, None]) * L[:, None, None]


def clump_and_wave(strands: np.ndarray, normals: np.ndarray, cfg: dict, rng, moustache: np.ndarray | None = None) -> np.ndarray:
    """Clumps (k-means on the roots and where the hair goes; the tips gather towards their clump's centre), then waves
    shared by a clump (a wavy beard waves in locks, not hair by hair) and a little frizz of each hair's own. The
    moustache takes `moustache_clump` / `moustache_wave` of the beard's locks and waves (a wizard's long wavy beard
    under a smooth, flowing moustache)."""
    from scipy.cluster.vq import kmeans2

    N, P, _ = strands.shape
    t = np.linspace(0, 1, P)
    feats = np.concatenate([strands[:, 0], (strands[:, -1] - strands[:, 0]) * 0.5], axis=1)
    k = max(1, N // int(cfg["per_clump"]))
    _, lab = kmeans2(feats, k, seed=int(rng.integers(1 << 30)), minit="++")
    centre = np.zeros((lab.max() + 1, P, 3))
    np.add.at(centre, lab, strands)
    centre /= np.maximum(np.bincount(lab, minlength=len(centre)), 1)[:, None, None]
    pull = cfg["clump"] * t ** 1.5 * (1 + rng.uniform(-0.25, 0.25, N))[:, None]
    m_wave = np.ones(N)
    if moustache is not None and ("moustache_clump" in cfg or "moustache_wave" in cfg):
        pull = pull * np.where(moustache, cfg.get("moustache_clump", 1.0), 1.0)[:, None]
        m_wave = np.where(moustache, cfg.get("moustache_wave", 1.0), 1.0)
    out = strands + (centre[lab] - strands) * pull[..., None]
    L = np.linalg.norm(np.diff(out, axis=1), axis=2).sum(1)
    if cfg["curl_mm"] > 0:
        tang = unit(np.gradient(out, axis=1))
        across = unit(np.cross(tang, normals[:, None]))
        out_n = unit(np.cross(across, tang))
        nk = lab.max() + 1
        phase = rng.uniform(0, 2 * np.pi, nk)[lab] + rng.normal(0, 0.35, N)
        period = cfg["curl_period_mm"] / 1000 * rng.uniform(0.85, 1.15, nk)[lab]
        a = 2 * np.pi * (t[None] * L[:, None]) / period[:, None] + phase[:, None]
        amp = cfg["curl_mm"] / 1000 * np.clip(t[None] * L[:, None] / 0.008, 0, 1) * m_wave[:, None]
        out = out + (across * np.sin(a)[..., None] + out_n * 0.5 * np.cos(a)[..., None]) * amp[..., None]
    if cfg["frizz_mm"] > 0:
        f = sum(rng.normal(0, 1, (N, 1, 3)) * np.sin(rng.uniform(1.5, 3.5, (N, 1, 1)) * 2 * np.pi * t[None, :, None]
                                                      + rng.uniform(0, 2 * np.pi, (N, 1, 1))) for _ in range(2))
        # by length: a short hair (the moustache, the cheek line) barely wobbles
        out = out + f * cfg["frizz_mm"] / 1000 * t[None, :, None] ** 2 * (np.minimum(1.0, L / 0.02) * m_wave)[:, None, None]
    out[:, 0] = strands[:, 0]
    return out


def zone_masks(gnm, tris, L: dict, zc: dict) -> dict[str, np.ndarray]:
    """Named regions of the face (0..1 per GNM vertex), from the landmarks and the skin's shape, that a style's outline
    is made of (`zones`) or cut by (`cut`); `zc` = the style's zone sizes (mm)."""
    P = gnm.template
    x, y, z = P[:, 0], P[:, 1], P[:, 2]
    ax = np.abs(x)
    mm = 1 / 1000
    surf = gnm_surface(gnm)
    tri, bary, _ = surf.closest(P)
    n = surf.normals_at(tri, bary)
    mouth_y, corner_x = L["cheilion_l"][1], L["cheilion_l"][0]
    sub_y, lip_lo = L["subnasale"][1], L["labrale_inferius"][1]

    def ramp(v, soft_mm=2.0):  # 0 → 1 across v = 0, over soft_mm
        return np.clip(v / (soft_mm * mm) + 0.5, 0, 1)

    def near(group: str, within_mm: float, soft_mm: float = 1.5):  # within this far of a vertex group
        d, _ = cKDTree(P[gnm.vertex_groups[group] > 0.5]).query(P)
        return ramp(within_mm * mm - d, soft_mm)

    front = ramp(z - 0.05, 10)  # the face, not the back of the neck
    # the jaw line: from under the chin (menton) along the jawbone to its angle (below and a little in front of the
    # ear lobe), then up its back edge to the sideburn; on the skin, both sides
    ear = P[(gnm.vertex_groups["ears"] > 0.5) & (x > 0)]
    lobe = ear[np.argmin(ear[:, 1])]
    men = np.array(L["menton"]) * [0, 1, 1]
    # (jaw_chin: how far up the front of the chin it starts, 0 = under the chin … 1 = the chin's point)
    men = men + (np.array(L["pogonion"]) * [0, 1, 1] - men) * zc.get("jaw_chin", 0.0)
    angle = lobe + np.array([-8, -30, 8]) * mm
    ctrl = np.array([angle[0] * 0.75, men[1] + 4 * mm, men[2] - 12 * mm])
    t = np.linspace(0, 1, 40)[:, None]
    jaw = (1 - t) ** 2 * men + 2 * (1 - t) * t * ctrl + t ** 2 * angle
    up = angle + t * (lobe + np.array([0, 4, 6]) * mm - angle)
    line = np.vstack([jaw, up])
    line = np.vstack([line, line * [-1, 1, 1]])
    line = surf.closest(line)[2]
    d_jaw, _ = cKDTree(line).query(P)
    zones = {
        # the upper lip, from the nose down to the mouth, out to just past the mouth corners
        "moustache": ramp(y - (mouth_y - 2 * mm)) * ramp(sub_y + 3 * mm - y) * ramp(corner_x + zc.get("moustache_out_mm", 6) * mm - ax) * front,
        # a thin line along the top of the upper lip
        "lip_line": near("upper_lip", zc.get("lip_line_mm", 3.5)) * ramp(y - mouth_y) * ramp(corner_x + 2 * mm - ax) * front,
        # the chin, below the lower lip, and under it
        # (its top corners rounded off by chin_round_mm, so it runs down into a jaw band instead of standing proud)
        "chin": ramp(lip_lo - zc.get("chin_gap_mm", 4) * mm - zc.get("chin_round_mm", 0) * mm * (ax / (zc.get("chin_half_mm", 22) * mm)) ** 2 - y)
        * ramp(zc.get("chin_half_mm", 22) * mm - ax, 4),
        # the groove in the middle of the upper lip
        "philtrum": ramp(zc.get("philtrum_mm", 2.5) * mm - ax, 1.0),
        # a tuft under the middle of the lower lip
        "soul_patch": ramp(1 - np.hypot(x / (zc.get("patch_half_mm", 7) * mm), (y - (lip_lo - zc.get("patch_drop_mm", 8) * mm)) / (zc.get("patch_tall_mm", 6) * mm)), 0.0002 / mm),
        # bars down from the mouth corners to the jaw
        "corners": ramp(zc.get("bar_mm", 9) * mm - np.abs(ax - (corner_x + zc.get("bar_shift_mm", 2) * mm))) * ramp(mouth_y + 3 * mm - y)
        * ramp(y - (mouth_y - zc.get("corner_drop_mm", 100) * mm)) * front,
        # a band along the jaw's edge
        "jaw": ramp(zc.get("jaw_mm", 12) * mm / 2 - d_jaw, zc.get("jaw_soft_mm", 3)),
        # a strip in front of the ears, from the cheekbone down to the jaw
        "sideburns": ramp(ax - zc.get("sideburn_x_mm", 50) * mm, 3) * near("ears", zc.get("sideburn_mm", 16), 4),
        # the cheeks and sideburns, out from a line beside the mouth
        "cheeks": ramp(ax - zc.get("cheek_x_mm", 36) * mm, 4),
        # under the jaw and the chin
        "neck": ramp(-0.45 - n[:, 1], 0.0002 / mm) * ramp(L["pogonion"][1] - y, 6),
    }
    return {k: smooth(gnm, tris, v, 2) for k, v in zones.items()}


def spine_groom(strands: np.ndarray, roots: np.ndarray, moustache: np.ndarray, sp: dict, gnm, L: dict, rng) -> np.ndarray:
    """A sculpted moustache: each side has a spine, out along the upper lip (just off the skin) to `out_mm` past the
    mouth corner, then either a curl upwards (kind "curl", a waxed handlebar: a spiral from `radius_mm`, `tighten`
    tighter by its end, through `turn_deg`) or a tail hanging down (kind "drop", a Fu Manchu: `drop_mm` long, leaning
    `lean` forward and out, swaying `sway_mm`). Every moustache hair joins its side's spine where its root is and follows
    it outwards, gathering onto it (`gather`, by the end of the lip or of the spine: `gather_by`); the hairs end at
    different points along it (`reach`, a share
    of the way to the spine's end), so the wing or tail tapers to a point."""
    out = strands.copy()
    P = strands.shape[1]
    surf = gnm_surface(gnm)
    mm = 1 / 1000
    y0 = L["cheilion_l"][1] + sp["height_mm"] * mm
    x_end = L["cheilion_l"][0] + sp["out_mm"] * mm
    for sgn in (-1, 1):
        m = np.where(moustache & (np.sign(roots[:, 0]) == sgn))[0]
        if not len(m):
            continue
        xs = np.linspace(0.002, x_end, 40)
        q = np.column_stack([xs * sgn, np.full_like(xs, y0), np.full_like(xs, 0.15)])
        tri, bary, cp = surf.closest(q)
        lip = cp + surf.normals_at(tri, bary) * sp["standoff_mm"] * mm
        if sp["kind"] == "curl":
            R, turn = sp["radius_mm"] * mm, np.radians(sp["turn_deg"])
            phi = np.linspace(0, turn, 60)[1:]
            c = lip[-1] + np.array([0.0, R, 0.0])
            r = R * (1 - sp["tighten"] * phi / turn)  # a spiral: tighter towards the tip
            end = c + r[:, None] * np.column_stack([sgn * np.sin(phi), -np.cos(phi), np.zeros_like(phi)])
        else:  # "drop": round the mouth corner, then straight down
            v = np.linspace(0, 1, 60)[1:, None]
            lean = np.array([sgn * sp["lean"][1], 0.0, sp["lean"][0]])
            bend = sp["bend_mm"] * mm
            corner = lip[-1] + np.array([sgn * bend, -bend, 0.0]) * np.sin(np.minimum(v, 0.15) / 0.15 * np.pi / 2)
            d = np.clip((v - 0.15) / 0.85, 0, 1)
            end = corner + (np.array([0.0, -1.0, 0.0]) + lean) * sp["drop_mm"] * mm * d
            end = end + np.array([sgn, 0.0, 0.6]) * sp.get("sway_mm", 0) * mm * np.sin(np.pi * d)  # a gentle sway
        spine = np.vstack([lip, end])
        arc = np.concatenate([[0], np.cumsum(np.linalg.norm(np.diff(spine, axis=0), axis=1))])
        u0 = np.interp(np.abs(roots[m, 0]), np.abs(lip[:, 0]), arc[: len(lip)])  # where each root joins the spine
        reach = (arc[-1] - u0) * rng.uniform(sp["reach"][0], sp["reach"][1], len(m))
        t = np.linspace(0, 1, P)[None, :]
        u = u0[:, None] + reach[:, None] * t
        on = np.stack([np.interp(u, arc, spine[:, k]) for k in range(3)], -1)
        offset = roots[m][:, None] - on[:, :1]
        # gathered onto the spine by the end of the lip (a waxed point, not a disc), or by the spine's end (a tail: thick
        # where it leaves the lip, tapering to its point): `gather_by`
        g_end = arc[len(lip) - 1] if sp.get("gather_by", "lip") == "lip" else arc[-1]
        g = np.clip((u - u0[:, None]) / np.maximum(g_end - u0[:, None], 1e-4), 0, 1)
        w = 1 - sp["gather"] * (g * g * (3 - 2 * g))
        out[m] = on + offset * w[..., None]
    return out


def outline(st: dict, cfg: dict, ctx) -> tuple[np.ndarray, dict[str, np.ndarray]]:
    """A style's outline (coverage 0..1 per GNM vertex): the guide beards' contact with the skin (stubble.mask), cut
    down to the style's `zones` (minus its `cut` ones) for an archetype; and the zone masks."""
    gnm = ctx.gnm
    tris = skin_triangles(gnm)
    m_cfg = {**cfg["mask"], **st.get("mask", {})}
    keep = None
    if "keep_within_x_mm" in st:
        x = np.abs(gnm.template[:, 0]) * 1000
        keep = np.clip((st["keep_within_x_mm"] + 6 - x) / 6, 0, 1)
    cov = mask(gnm, tris, guide_roots(ctx, st["guides"]), m_cfg, keep, "moustache" in st["guides"])
    zm = {}
    if "zones" in st:
        zm = zone_masks(gnm, tris, json.loads(LANDMARKS.read_text())["landmarks"], st.get("zone", {}))
        sel = np.max([zm[k] for k in st["zones"]], axis=0)
        for k in st.get("cut", []):
            sel *= 1 - zm[k]
        # the guides only say where a beard can grow (their faded edge counts as full): the zones shape it
        zm["_sel"] = smooth(gnm, tris, sel, 2)
        cov = np.clip(cov / 0.3, 0, 1) * zm["_sel"]
    return cov, zm


def build(sid: str, st: dict, cfg: dict, ctx) -> tuple[Groom, np.ndarray]:
    """The groom, and its outline (coverage per GNM vertex) for the stubble under it."""
    gnm = ctx.gnm
    rng = np.random.default_rng(st.get("seed", 3))
    L = json.loads(LANDMARKS.read_text())["landmarks"]
    cov, zm = outline(st, cfg, ctx)
    surf = gnm_surface(gnm)
    mouth_y, sub_y = L["cheilion_l"][1], L["subnasale"][1]

    def on_lip(p):  # the moustache: over the upper lip, between the mouth corners and the nose
        return (p[:, 1] > mouth_y - 0.002) & (p[:, 1] < sub_y + 0.002) & (np.abs(p[:, 0]) < 0.03) & (p[:, 2] > 0.1)

    # the moustache is denser than the beard round it (more hairs per area, as the moustache-only style has)
    # … with a crisp edge (the beard's wide fade would leave a fringe of short stubby hairs along its top; the stubble
    # under it keeps the soft outline)
    lip = on_lip(gnm.template)
    lo_c, hi_c = {**cfg["grow"], **st.get("grow", {})}.get("moustache_edge", (0.0, 1.0))
    cov_hair = np.where(lip, np.clip((cov - lo_c) / (hi_c - lo_c), 0, 1), cov)
    dense = cov_hair * np.where(lip, st.get("moustache_density", cfg["grow"]["moustache_density"]), 1.0) ** (1 / 1.5)
    roots, normals = sample_roots(surf, dense, int(st["count"]), rng, cfg["mask"]["min_cover"])
    # and no hair on its own: drop roots with hardly any others round them
    crowd = np.array([len(x) for x in cKDTree(roots).query_ball_point(roots, cfg["mask"]["lone_mm"] / 1000)])
    roots, normals = roots[crowd > 3], normals[crowd > 3]
    vert = cKDTree(gnm.template).query(roots)[1]  # each root's GNM vertex
    if "_sel" in zm:  # an archetype: hairs only where its regions are solid, not in their softened edges (the stubble
        solid = zm["_sel"][vert] >= {**cfg["mask"], **st.get("mask", {})}["zone_solid"]  # under it keeps the soft outline)
        roots, normals, vert = roots[solid], normals[solid], vert[solid]
    if "lip_band_mm" in st:  # a line thinner than the mesh (pencil): measured to the lip's surface, not its vertices
        lip_tris = gnm.triangles[(gnm.vertex_groups["upper_lip"] > 0.5)[gnm.triangles].all(1)]
        d = np.linalg.norm(roots - Surface.build(gnm.template, lip_tris).closest(roots)[2], axis=1)
        keep = d <= st["lip_band_mm"] / 1000
        roots, normals, vert = roots[keep], normals[keep], vert[keep]
    moustache = on_lip(roots)
    if "moustache" in st.get("zones", []):  # an archetype with a moustache: its hairs out to its ends by the mouth corners
        moustache |= zm["moustache"][vert] > 0.5
    # lengths: cheeks and lip shorter, chin and jaw as long as the guide hangs (from its full mesh, not just its roots)
    guide_mesh = np.vstack([beard_guide(g) for g in st.get("hang_guides", st["guides"])])
    hang = hang_lengths(roots, guide_mesh, mouth_y) * st.get("hang_scale", 1.0)
    # smooth the hang over neighbouring roots (the guide mesh has spikes: single long hairs sticking out)
    nb = cKDTree(roots).query(roots, k=24)[1]
    hang = np.median(hang[nb], axis=1)
    base = st["length_mm"] / 1000
    lower = np.clip((mouth_y - roots[:, 1]) / 0.03, 0, 1)
    lengths = base * (st.get("cheek_length", 0.6) + (1 - st.get("cheek_length", 0.6)) * lower)
    lengths = np.maximum(lengths, np.minimum(hang, st.get("max_hang_mm", 150) / 1000))
    if "point" in st:  # long mainly from the middle of the chin (a wizard): the sides stay shorter and flow into it
        pt = st["point"]
        lengths = np.maximum(lengths, pt["mm"] / 1000 * np.exp(-((roots[:, 0] * 1000 / pt["width_mm"]) ** 2)) * lower)
    lengths = np.where(moustache, st.get("moustache_mm", st["length_mm"]) / 1000, lengths)
    for zone, mm in st.get("zone_lengths", {}).items():  # a region's own length (Fu Manchu tails)
        lengths = np.where((zm[zone][vert] > 0.5) & ~moustache, mm / 1000, lengths)
    # shorter towards the outline's edge (where the coverage fades), so the edge thins out instead of sprouting long hairs
    edge = np.clip(cov_hair[vert] / 0.7, 0, 1)
    lengths *= 0.3 + 0.7 * edge ** 1.5
    # no hair much longer than the ones round it
    nb = cKDTree(roots).query(roots, k=16)[1]
    lengths = np.minimum(lengths, np.median(lengths[nb], axis=1) * 1.25)
    gs = {**cfg["grow"], **st.get("grow", {})}
    lengths *= 1 + gs["length_jitter"] * rng.uniform(-1, 1, len(roots))
    # growth stages: some hairs are still growing in, so the ends thin out softly instead of stopping on one line
    young = rng.random(len(roots)) < gs["young_share"]
    lengths = np.where(young, lengths * rng.uniform(0.35, 0.85, len(roots)), lengths)
    g = {**cfg["grow"], **st.get("grow", {})}
    strands = grow(g, roots, normals, lengths, moustache, gnm, mouth_y, rng)
    strands = fair(strands, int(g["fair"]))
    strands = cohere(strands, roots, g)
    strands = clump_and_wave(strands, normals, g, rng, moustache)
    if "taper" in st:  # the beard (not the moustache) gathers to a point at x = 0, or a tail per side at x = ±x_mm
        tp = st["taper"]
        t = np.linspace(0, 1, strands.shape[1])[None, :] ** tp["power"] * tp["amount"]
        target = np.sign(roots[:, 0])[:, None] * tp["x_mm"] / 1000
        pull = np.where(moustache[:, None], 0.0, t)
        strands[..., 0] += (target - strands[..., 0]) * pull
    if "spine" in st:
        strands = spine_groom(strands, roots, moustache, st["spine"], gnm, L, rng)
    strands = keep_out_smooth(gnm, fair(strands, 2), 0.0004)
    # and no lone ends: a hair whose tip is out in empty space (no other hairs round it) is a stray
    pts = strands[:, 1:].reshape(-1, 3)
    owner = np.repeat(np.arange(len(strands)), strands.shape[1] - 1)
    tips = strands[:, -1]
    near = cKDTree(pts).query_ball_point(tips, g["lone_tip_mm"] / 1000)
    others = np.array([len(set(owner[x])) - 1 for x in near])
    keep = others >= g["lone_tip_hairs"]
    print(f"    dropped {int((~keep).sum())} stray ends")
    strands, roots = strands[keep], roots[keep]
    isl = {**cfg["mask"]["islands"], **st.get("islands", {})}
    if isl:  # and no islands: little patches cut off from the rest of the beard (the outline's patchiness can pinch one
        # off at its edge); roots `link_mm` apart are joined, patches under `share` of the biggest go
        from scipy.sparse import coo_matrix
        from scipy.sparse.csgraph import connected_components

        pairs = cKDTree(roots).query_pairs(isl["link_mm"] / 1000, output_type="ndarray")
        graph = coo_matrix((np.ones(len(pairs)), (pairs[:, 0], pairs[:, 1])), shape=(len(roots), len(roots)))
        lab = connected_components(graph, directed=False)[1]
        size = np.bincount(lab)
        keep = size[lab] >= isl["share"] * size.max()
        print(f"    dropped {int((~keep).sum())} hairs in {int((size < isl['share'] * size.max()).sum())} islands")
        strands, roots = strands[keep], roots[keep]
    spec = GroomSpec(id=sid, label=st["label"], children=tuple(cfg["render"]["children"]), child_radius_mm=cfg["render"]["child_radius_mm"],
                     width_mm=cfg["render"]["width_mm"], tip_width=cfg["render"]["tip_width"], natural=tuple(cfg["render"]["natural"]),
                     cover_min=cfg["render"].get("cover_min", 1.0), shine=cfg["render"].get("shine", 0.6))
    order = rng.permutation(len(strands))
    strands = strands[order]
    return Groom(spec, strands, self_shadow(strands)), cov


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("ids", nargs="*")
    ap.add_argument("--preview", action="store_true")
    args = ap.parse_args()
    cfg = tomllib.loads(CONFIG.read_text())
    ctx = head_context()
    index_path = MODELS / "index.json"
    index = json.loads(index_path.read_text())
    entries = {e["id"]: e for e in index["styles"]}
    for sid, st in cfg["style"].items():
        if args.ids and sid not in args.ids:
            continue
        t0 = time.time()
        g, cov = build(sid, st, cfg, ctx)
        focal = (0.0, 0.225, 0.09)
        pv = render_views(g, WORK / f"beard-{sid}.png", gnm=ctx.gnm, views=(0, 35, 80), focal=focal, distance=0.3, line_width=1.5)
        print(f"  {sid}: {len(g.strands)} strands × {g.strands.shape[1]}; preview {pv} ({time.time() - t0:.0f} s)")
        if args.preview:
            continue
        data = encode(g)
        (MODELS / f"{sid}.strands.bin").write_bytes(data)
        # the stubble under it: the skin between the hairs is never bare (and the outline fades out through stubble)
        img = rasterize(ctx.gnm, skin_triangles(ctx.gnm), cov[:, None], 1024)[..., 0]
        BAKE_DIR.mkdir(parents=True, exist_ok=True)  # previews: only bake-ao made it before
        png = BAKE_DIR / f"stubble-{sid}.png"
        Image.fromarray((np.clip(img, 0, 1) * 255 + 0.5).astype(np.uint8)).save(png)
        n_mask = ktx2(png, MODELS / f"{sid}.ktx2", uastc=False, quality=200)
        under = {**cfg["render"]["under"], **st.get("under", {})}
        e = entry(g, len(data) + n_mask, mesh_fields=True)
        e.update({"file": f"addons/facialHair/{sid}.strands.bin", "thumb": f"addons/facialHair/thumbs/{sid}.webp",
                  "author": "face-to-voice (generated)", "pack": "generated", "alphaCutoff": 0, "tint": True,
                  "stubbleMask": f"addons/facialHair/{sid}.ktx2",
                  "stubble": {"length": under["length"], "shadow": under["shadow"], "root": g.spec.natural[0], "tip": g.spec.natural[1]}})
        entries[sid] = e
        print(f"  → web/public/models/addons/facialHair/{sid}.strands.bin {len(data) / 1000:.0f} KB")
    if args.preview:
        return
    ids = list(dict.fromkeys([e["id"] for e in index["styles"]] + [i for i in cfg["style"] if i in entries]))
    index["styles"] = [entries[i] for i in picker_order(ids)]
    index_path.write_text(json.dumps(index, indent=2, ensure_ascii=False) + "\n")
    print("index:", [e["id"] for e in index["styles"]])
