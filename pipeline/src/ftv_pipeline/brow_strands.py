"""`uv run brow-strands [id …] [--preview]`: eyebrows as strands (ours, MIT), shaped by MakeHuman's painted brow cards
(CC0) and drawn by the app's strand renderer (lib/groom.ts) like the hair and beards, with live roots so they follow
the brows through every expression.

Each style (config/brows.toml `guide`) reads one MakeHuman brow card as fitted on the GNM head, saved in
config/guides/brows/ (guides.py):
  - where the hairs grow and how densely: the texture's alpha, read through the fitted card onto the skin;
  - which way they lie: the painted strokes' orientation (a structure tensor of the alpha), carried from the texture
    into 3D by each card triangle's UV frame; pointing out along the brow, and up at its inner head;
  - how long they are: per style, along the brow (inner head, body, tail).
The hairs then grow along the skin, following that flow, lying close to it.
"""
from __future__ import annotations

import argparse
import json
import time
import tomllib

import numpy as np
from scipy.ndimage import gaussian_filter, map_coordinates, sobel
from scipy.sparse import coo_matrix
from scipy.sparse.csgraph import connected_components
from scipy.spatial import cKDTree

from .addon_fit import ADDONS_MODELS_DIR
from .export_groom import WORK, entry
from .gnm import PIPELINE_DIR
from .groom import Groom, GroomSpec, encode, fair, keep_out_smooth, render_views, unit
from .guides import brow_card
from .head_context import head_context
from .surface import gnm_surface

CONFIG = PIPELINE_DIR / "config" / "brows.toml"
MODELS = ADDONS_MODELS_DIR / "eyebrows"


def stroke_field(alpha: np.ndarray, sigma_px: float) -> tuple[np.ndarray, np.ndarray]:
    """Per pixel: the painted strokes' direction (unit (x, y) in image space, sign arbitrary) and how clear it is
    (0 = no direction … 1 = clean parallel strokes): the structure tensor of the alpha."""
    a = gaussian_filter(alpha, 1.0)
    gx, gy = sobel(a, axis=1), sobel(a, axis=0)
    jxx, jyy, jxy = (gaussian_filter(v, sigma_px) for v in (gx * gx, gy * gy, gx * gy))
    theta = 0.5 * np.arctan2(2 * jxy, jxx - jyy) + np.pi / 2  # the gradient's main axis, turned: along the strokes
    clear = np.sqrt((jxx - jyy) ** 2 + 4 * jxy ** 2) / (jxx + jyy + 1e-9)
    return np.stack([np.cos(theta), np.sin(theta)], -1), clear


def sample(img: np.ndarray, px: np.ndarray) -> np.ndarray:
    """Bilinear lookup of an (H, W[, C]) image at pixel coordinates px (N, 2) = (x, y)."""
    coords = [px[:, 1], px[:, 0]]
    if img.ndim == 2:
        return map_coordinates(img, coords, order=1, mode="nearest")
    return np.stack([map_coordinates(img[..., c], coords, order=1, mode="nearest") for c in range(img.shape[2])], -1)


def drop_islands(strands: np.ndarray, roots: np.ndarray, link_mm: float, share: float) -> np.ndarray:
    """A keep mask: no little patches cut off from the rest of the brow (roots link_mm apart are joined; patches under
    `share` of the biggest go, per brow)."""
    keep = np.ones(len(roots), bool)
    for side in (-1, 1):
        m = np.where(np.sign(roots[:, 0]) == side)[0]
        if len(m) < 2:
            continue
        pairs = cKDTree(roots[m]).query_pairs(link_mm / 1000, output_type="ndarray")
        graph = coo_matrix((np.ones(len(pairs)), (pairs[:, 0], pairs[:, 1])), shape=(len(m), len(m)))
        lab = connected_components(graph, directed=False)[1]
        size = np.bincount(lab)
        keep[m] = size[lab] >= share * size.max()
    return keep


def build(sid: str, st: dict, cfg: dict, ctx) -> Groom:
    g = {**cfg["grow"], **st.get("grow", {})}
    rng = np.random.default_rng(st.get("seed", 5))
    card = brow_card(st["guide"])  # a MakeHuman brow card as fitted on the head, saved as our own data (guides.py)
    pos = card.positions.astype(np.float64)
    uv = card.uvs.astype(np.float64)
    tris = card.triangles
    alpha = card.alpha.astype(np.float64) / 255
    H, W = alpha.shape
    flow, clear = stroke_field(alpha, g["tensor_sigma_px"])
    # candidates spread evenly over the fitted card, kept by the texture's alpha (density ∝ alpha^gamma)
    a, b, c = pos[tris[:, 0]], pos[tris[:, 1]], pos[tris[:, 2]]
    area = 0.5 * np.linalg.norm(np.cross(b - a, c - a), axis=1)
    n_cand = int(st["count"] * g["candidates"])
    pick = rng.choice(len(tris), n_cand, p=area / area.sum())
    r1, r2 = rng.random(n_cand), rng.random(n_cand)
    s1 = np.sqrt(r1)
    bary = np.stack([1 - s1, s1 * (1 - r2), s1 * r2], 1)
    t = tris[pick]
    p3 = (bary[:, :, None] * pos[t]).sum(1)
    puv = (bary[:, :, None] * uv[t]).sum(1)
    px = puv * [W, H] - 0.5
    al = sample(alpha, px)
    w = np.where(al > g["cutoff"], al, 0) ** g["gamma"]
    keep = rng.random(n_cand) < w / max(w.max(), 1e-9)
    p3, px, t, al = p3[keep], px[keep], t[keep], al[keep]
    n_keep = int(st["count"] / g["thin_keep"])  # oversampled: the shaping below thins it back to about `count`
    if len(p3) > n_keep:
        sel = rng.choice(len(p3), n_keep, replace=False)
        p3, px, t, al = p3[sel], px[sel], t[sel], al[sel]
    # the strokes' direction, from the texture into 3D through each triangle's UV frame (dP/du, dP/dv)
    fd = sample(flow, px)
    fd /= np.maximum(np.linalg.norm(fd, axis=1, keepdims=True), 1e-9)
    fc = sample(clear, px)
    P0, P1, P2 = pos[t[:, 0]], pos[t[:, 1]], pos[t[:, 2]]
    U0, U1, U2 = uv[t[:, 0]], uv[t[:, 1]], uv[t[:, 2]]
    E = np.stack([P1 - P0, P2 - P0], 1)  # (N, 2, 3)
    D = np.stack([U1 - U0, U2 - U0], 1)  # (N, 2, 2)
    Dinv = np.linalg.pinv(D)  # (N, 2, 2): uv steps → edge weights
    duv = fd / [W, H]  # a pixel-space direction as a uv step
    d3 = np.einsum("ni,nij,njk->nk", duv, Dinv, E)
    surf = gnm_surface(ctx.gnm)
    if "spread_mm" in st:  # a bushier brow: the painted band widened up and down (each root moved by a random offset)
        p3 = p3 + np.array([0.0, 1.0, 0.0]) * (rng.normal(0, st["spread_mm"] / 1000, len(p3)))[:, None]
    if "peak" in st:  # an angular brow: the arch pulled up into a point (`at` along the brow, `height_mm`, `width`)
        pk = st["peak"]
        sx, axp = np.sign(p3[:, 0]), np.abs(p3[:, 0])
        u = np.zeros(len(p3))
        for sgn in (-1, 1):
            m = sx == sgn
            lo, hi = np.percentile(axp[m], 1), np.percentile(axp[m], 99)
            u[m] = np.clip((axp[m] - lo) / (hi - lo), 0, 1)
        p3 = p3 + np.array([0.0, 1.0, 0.0]) * (pk["height_mm"] / 1000 * np.clip(1 - np.abs(u - pk["at"]) / pk["width"], 0, 1))[:, None]
    if "bridge" in st:  # a unibrow: hairs across the gap between the inner heads, pointing up (unclear flow → the brow's own)
        br = st["bridge"]
        sx, axp = np.sign(p3[:, 0]), np.abs(p3[:, 0])
        inner = axp < np.percentile(axp, 12)
        x_in = axp[inner].min() + 0.002
        yc, ys = p3[inner, 1].mean(), p3[inner, 1].std()
        nb_ = int(br["count"])
        bx = rng.uniform(-x_in, x_in, nb_)
        by = yc + rng.normal(0, ys * br["height"], nb_) - br.get("drop_mm", 0) / 1000 * (1 - np.abs(bx) / x_in)
        bp = surf.closest(np.column_stack([bx, by, np.full(nb_, p3[inner, 2].mean())]))[2]
        p3 = np.vstack([p3, bp])
        d3 = np.vstack([d3, unit(np.column_stack([np.where(bx >= 0, 1.0, -1.0) * br.get("fan", 0.5), np.ones(nb_), np.zeros(nb_)]))])
        fc = np.concatenate([fc, np.zeros(nb_)])
        al = np.concatenate([al, np.full(nb_, br.get("alpha", 0.5))])
    # onto the skin
    tri_s, bary_s, roots = surf.closest(p3)
    normals = surf.normals_at(tri_s, bary_s)
    d3 = unit(d3 - normals * (d3 * normals).sum(1, keepdims=True) + 1e-12)
    # which way along the stroke: out along the brow (towards the temple), and up at its inner head
    side = np.where(roots[:, 0] >= 0, 1.0, -1.0)
    ax = np.abs(roots[:, 0])
    along = np.zeros(len(roots))
    span = {}
    for sgn in (-1, 1):
        m = side == sgn
        lo, hi = np.percentile(ax[m], 1), np.percentile(ax[m], 99)
        along[m] = np.clip((ax[m] - lo) / (hi - lo), 0, 1)
        span[sgn] = (lo, hi)
    head = np.clip((g["head"][1] - along) / (g["head"][1] - g["head"][0]), 0, 1)
    # across the brow, 0 = its lower edge … 1 = its upper edge (among the hairs at the same point along it)
    across = np.zeros(len(roots))
    for sgn in (-1, 1):
        m = np.where(side == sgn)[0]
        bins = np.floor(along[m] / g["across_bin"]).astype(int)
        for bnum in np.unique(bins):
            mm = m[bins == bnum]
            y = roots[mm, 1]
            lo_y, hi_y = np.percentile(y, 3), np.percentile(y, 97)
            across[mm] = np.clip((y - lo_y) / max(hi_y - lo_y, 1e-5), 0, 1)
    if "gap" in st:  # a notch: a clean shaved line across the brow (`at` along it, `width` of the brow's length)
        gp = st["gap"]
        kept = np.abs(along - gp["at"]) > gp["width"] / 2
        roots, normals, d3, side, ax, along, head, across, fc, al = (v[kept] for v in (roots, normals, d3, side, ax, along, head, across, fc, al))

    def sm(v, a, b):  # smoothstep of v from a to b
        return np.clip((v - a) / (b - a), 0, 1) ** 2 * (3 - 2 * np.clip((v - a) / (b - a), 0, 1))

    # thinning: the upper edge feathers out, the inner head fades in from the nose, the tail narrows to a few hairs;
    # the lower edge stays (a clean line)
    if g["top_thin"] or g["head_thin"] or g["tail_thin"]:  # (off: the unshaped brows keep their exact random sequence)
        keep_p = (1 - g["top_thin"] * sm(across, 0.55, 1.0)) * (1 - g["head_thin"] * (1 - sm(along, 0.0, 0.18))) \
            * (1 - g["tail_thin"] * sm(along, 0.75, 1.0))
        keep_p = keep_p / max(np.mean(keep_p), 1e-6) * g["thin_keep"]
        kept = rng.random(len(roots)) < keep_p
        if kept.sum() > st["count"]:
            kept[rng.choice(np.where(kept)[0], int(kept.sum() - st["count"]), replace=False)] = False
        roots, normals, d3, side, ax, along, head, across, fc, al = (v[kept] for v in (roots, normals, d3, side, ax, along, head, across, fc, al))
    out = side[:, None] * np.array([1.0, 0.0, 0.0])
    up = np.array([0.0, 1.0, 0.0])
    pref = unit(out * (1 - head)[:, None] + (up + out * 0.25) * head[:, None])
    pref = unit(pref - normals * (pref * normals).sum(1, keepdims=True) + 1e-12)
    d3 = np.where(((d3 * pref).sum(1) < 0)[:, None], -d3, d3)
    # unclear strokes (soft edges, smudges): the brow's own direction instead
    trust = np.clip((fc - g["clear"][0]) / (g["clear"][1] - g["clear"][0]), 0, 1)[:, None]
    d3 = unit(d3 * trust + pref * (1 - trust))
    # a smooth flow: each hair's direction averaged with its neighbours' (same brow)
    apart = roots + side[:, None] * [1.0, 0.0, 0.0]  # (the two brows a metre apart: neighbours stay on one brow)
    nb = cKDTree(apart).query(apart, k=g["field_k"])[1]
    field = unit(d3[nb].mean(1))
    # a share of wiry hairs (`wiry_share`, an older brow): longer, coarser strays that go their own way and curve
    wiry = np.zeros(len(roots), bool)
    if g.get("wiry_share", 0):  # (only then: the other brows keep their exact random sequence)
        wiry = rng.random(len(roots)) < g["wiry_share"]
    # and each hair a little off it (`jitter_deg`): real brow hairs cross their neighbours, so each one reads on its own
    ang = np.radians(rng.normal(0, g["jitter_deg"], len(roots)) * (1 + g["head_fan"] * head))[:, None]  # the head fans out
    if wiry.any():
        ang = ang + np.radians(rng.normal(0, g["wiry_jitter_deg"], len(roots)) * wiry)[:, None]
    turned = unit(field * np.cos(ang) + np.cross(normals, field) * np.sin(ang))
    if wiry.any():  # wiry strays lift up and out: one that would head steeply down turns the other way
        flip = wiry & (turned[:, 1] < -g["wiry_down"])
        back = unit(field * np.cos(-ang) + np.cross(normals, field) * np.sin(-ang))
        turned = np.where(flip[:, None], back, turned)
    field = turned
    # lengths along the brow (inner head, body, tail), shorter where the painted brow fades out
    Lh, Lb, Lt = (v / 1000 for v in st["length_mm"])
    lengths = np.where(along < 0.5, Lh + (Lb - Lh) * along / 0.5, Lb + (Lt - Lb) * (along - 0.5) / 0.5)
    lengths *= 0.55 + 0.45 * np.clip(al / 0.7, 0, 1)
    lengths *= 1 - g["top_short"] * sm(across, 0.6, 1.0)  # the upper edge's hairs are shorter, finer
    lengths *= 1 + g["length_jitter"] * rng.uniform(-1, 1, len(roots))
    if "gap" in st:  # hairs rooted before the notch stop short of it (their tips would cover it)
        gp = st["gap"]
        for sgn in (-1, 1):
            lo, hi = span[sgn]
            gx = lo + (gp["at"] - gp["width"] / 2) * (hi - lo)  # the notch's inner edge (|x|)
            m = (side == sgn) & (ax < gx)
            lengths[m] = np.minimum(lengths[m], np.maximum(gx - ax[m], 0.0005) / g["gap_reach"])
    young = rng.random(len(roots)) < g["young_share"]
    lengths = np.where(young, lengths * rng.uniform(0.4, 0.85, len(roots)), lengths)
    if wiry.any():
        lengths = np.where(wiry, lengths * g["wiry_length"], lengths)
    # grow along the skin, following the flow, lying close to it
    P = int(g["points"])
    tree = cKDTree(roots)
    lo_h, hi_h = (v / 1000 for v in g["standoff_mm"])
    p, d = roots.copy(), field.copy()
    step = lengths / (P - 1)
    # wiry hairs (`curve_deg`): each turns through its own random angle along its length, some reversing halfway (an S),
    # and arches up off the skin (`arch_mm` at the middle)
    curve, s_bend, arch = np.zeros(len(roots)), np.zeros(len(roots), bool), 0.0
    if g.get("curve_deg", 0):  # (only then: the other brows keep their exact random sequence)
        only = wiry if wiry.any() else np.ones(len(roots), bool)  # with a wiry share, only the wiry hairs curve
        curve = np.radians(rng.normal(0, g["curve_deg"], len(roots))) * only
        if wiry.any():  # … and mostly curve upwards (`wiry_up_share`), a few down
            up_turn = np.where(np.cross(field, normals)[:, 1] > 0, -1.0, 1.0)
            curve = np.abs(curve) * up_turn * np.where(rng.random(len(roots)) < g["wiry_up_share"], 1.0, -1.0)
        s_bend = rng.random(len(roots)) < g.get("s_share", 0.0)
        arch = rng.uniform(0, 1, len(roots)) * g.get("arch_mm", 0) / 1000 * only
    pts = [roots]
    for k in range(1, P):
        _, nbk = tree.query(p, k=6)
        f = field[nbk]
        f = np.where(((f * d[:, None]).sum(2) < 0)[..., None], -f, f).mean(1)
        own = np.where(wiry, g.get("wiry_own", g["own"]), g["own"])[:, None]
        f = unit(f) * (1 - own) + field * own  # mostly the flow under it, partly its own angle
        tri_k, bary_k, cp = surf.closest(p)
        nrm = surf.normals_at(tri_k, bary_k)
        d = unit(d * (1 - g["follow"]) + unit(f) * g["follow"])
        d = unit(d - nrm * (d * nrm).sum(1, keepdims=True) + 1e-12)
        if g.get("curve_deg", 0):
            a = (curve * np.where(s_bend & (k > (P - 1) / 2), -1.0, 1.0) * k / (P - 1))[:, None]  # turn so far
            d = unit(d * np.cos(a) + np.cross(nrm, d) * np.sin(a))
        p = p + d * step[:, None]
        tri_k, bary_k, cp = surf.closest(p)
        nrm = surf.normals_at(tri_k, bary_k)
        h = lo_h + (hi_h - lo_h) * (k / (P - 1)) + arch * np.sin(np.pi * k / (P - 1))
        p = cp + nrm * np.broadcast_to(h, (len(p),))[:, None]
        pts.append(p.copy())
    strands = np.stack(pts, 1)
    strands = keep_out_smooth(ctx.gnm, fair(strands, int(g["fair"])), 0.0001)
    isl = {**cfg["grow"]["islands"], **st.get("islands", {})}
    keep = drop_islands(strands, roots, isl["link_mm"], isl["share"])
    print(f"    {len(strands)} hairs, dropped {int((~keep).sum())} in islands")
    strands = strands[keep]
    # hair-to-hair tone: some a little darker than others (the shader adds its own small brightness jitter)
    tone = 1 - g["tone_var"] * rng.random(len(strands)) ** 2 if g["tone_var"] else np.ones(len(strands))
    r = cfg["render"]
    spec = GroomSpec(id=sid, label=st["label"], children=tuple(r["children"]), child_radius_mm=r["child_radius_mm"],
                     width_mm=st.get("width_mm", r["width_mm"]), tip_width=r["tip_width"], natural=tuple(st.get("natural", r["natural"])),
                     cover_min=r.get("cover_min", 1.0), shine=r.get("shine", 0.4))
    order = rng.permutation(len(strands))
    return Groom(spec, strands[order], np.repeat(tone[order, None], strands.shape[1], axis=1))


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
        g = build(sid, st, cfg, ctx)
        pv = render_views(g, WORK / f"brow-{sid}.png", gnm=ctx.gnm, views=(0, 35, 80), focal=(0.03, 0.31, 0.11), distance=0.12, line_width=1.5)
        print(f"  {sid}: {len(g.strands)} strands × {g.strands.shape[1]}; preview {pv} ({time.time() - t0:.0f} s)")
        if args.preview:
            continue
        data = encode(g)
        (MODELS / f"{sid}.strands.bin").write_bytes(data)
        e = entry(g, len(data), mesh_fields=True)
        e.update({"file": f"addons/eyebrows/{sid}.strands.bin", "thumb": f"addons/eyebrows/thumbs/{sid}.webp",
                  "author": "face-to-voice (generated, shaped by MakeHuman's CC0 brow cards)", "pack": "generated",
                  "alphaCutoff": 0, "tint": True})
        ramp = st.get("ramp_mm", cfg["render"]["ramp_mm"])  # root → tip colour length (lib/groom.ts); 0: GROOM.rampLength
        if ramp:
            e["strands"]["rampMm"] = ramp
        entries[sid] = e
        print(f"  → web/public/models/addons/eyebrows/{sid}.strands.bin {len(data) / 1000:.0f} KB")
    if args.preview:
        return
    index["licence"] = ("MIT — generated by the face-to-voice pipeline (brow_strands.py); the MakeHuman brow cards (CC0 1.0, "
                        "© 2020 Data Collection AB, Joel Palmius, Jonas Hauquier) only serve as shape guides")
    ours = [i for i in cfg["style"] if i in entries]
    index["styles"] = [entries[i] for i in ours] + [e for e in index["styles"] if e["id"] not in ours]
    index_path.write_text(json.dumps(index, indent=2, ensure_ascii=False) + "\n")
