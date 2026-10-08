"""`uv run import-hair <source> <style> [--id ID]`: strand hair from another groom, fitted onto the GNM head and
written in the same .strands.bin format as our own grooms (groom.py), so the app draws it the same way.

Sources:
  bystedt <long|curly|cyberpunk|braids|all>  Daniel Bystedt's Blender "Hair Styles" demo (CC BY-SA 4.0, blender.org);
                                             blender/export_curves.py evaluates the geometry-nodes hair first.
  haircs <v0-00005 …>                        one HairCS style (CC BY-NC 4.0). The shipped HairCS set is chosen and built
                                             by haircs_review.py with this module's loader and fitting.

Fitting: the source head is turned into GNM's axes, then fitted onto GNM's cranium (above the eyes) with a
similarity ICP (scale + rotation + translation); every strand is moved by that transform, its root snapped onto the
GNM scalp (the whole strand shifts with it), and points that end up inside the skin are pushed out. HairCS also gets
a smooth whole-head warp (HeadWarp) before the snap, and a push spread along the strand (keep_out_smooth), so hair at
the nape and around the ears follows our head instead of folding against it.
"""
from __future__ import annotations

import argparse
import os
import subprocess
import sys
from pathlib import Path

import numpy as np
from scipy.sparse import coo_matrix, diags
from scipy.spatial import cKDTree

from .bake import blender
from .export_groom import WORK, entry, merge_index, thumbnail
from .gnm import CACHE_DIR, GNM, PIPELINE_DIR
from .groom import Groom, GroomSpec, encode, keep_out, keep_out_smooth, render_views, resample, self_shadow
from .hair_index import HAIR_MODELS_DIR

BYSTEDT_BLEND = CACHE_DIR / "bystedt" / "hair_nodes-female_hair_styles.blend"
BYSTEDT = {  # style -> (curves objects, the head instance empty that offsets it)
    "long": (["long hair main", "long hair strands"], "Long hair head"),
    "curly": (["curly hair"], "Curly hair head"),
    "cyberpunk": (["cyberpunk hair"], "Cyberpunk hair head"),
    "braids": (["braided hair"], "Braids hair head"),
}
# Per style: label, points per strand (curls and braids need more to keep their shape), strands kept (file size),
# children per tier (the demo is already dense), child spread (mm).
BYSTEDT_STYLES = {
    "long": {"label": "Layered", "points": 20, "strands": 11000, "children": (0, 1, 2), "child_radius_mm": 1.2},
    "curly": {"label": "Curls", "points": 23, "strands": 10000, "children": (0, 1, 2), "child_radius_mm": 0.8},
    "cyberpunk": {"label": "Undercut", "points": 8, "strands": 20000, "children": (0, 1, 1), "child_radius_mm": 0.8},
    "braids": {"label": "Braids", "points": 40, "strands": 8000, "children": (0, 1, 1), "child_radius_mm": 0.6},
}
AUTHORS = {
    "bystedt": "Daniel Bystedt (Blender demo, CC BY-SA 4.0)",
    "haircs": "HairCS (Lu, Wang, Shen, Zheng, Jiang, Yang, Wu 2026), CC BY-NC 4.0",
}


# --- sources -------------------------------------------------------------------------------------


def export_curves(npz: Path, names: list[str]) -> None:
    """Blender evaluates the demo's hair into `npz`. Blender exits 0 even when its -P script raises, so the log is
    checked for a traceback and the file must exist; it is written under a temp name, so a failed run leaves none."""
    npz.parent.mkdir(parents=True, exist_ok=True)
    tmp = npz.with_name(npz.stem + ".part.npz")
    tmp.unlink(missing_ok=True)
    r = subprocess.run([blender(), "-b", str(BYSTEDT_BLEND), "-P", str(PIPELINE_DIR / "blender" / "export_curves.py"), "--", str(tmp),
                        "hairstyles main", *names], capture_output=True, text=True, check=False)
    if r.returncode != 0 or "Traceback (most recent call last)" in r.stdout + r.stderr or not tmp.exists():
        tmp.unlink(missing_ok=True)
        raise SystemExit(f"blender export_curves.py failed for {npz.name} (exit {r.returncode}):\n{r.stdout[-2000:]}\n{r.stderr[-2000:]}")
    os.replace(tmp, npz)


def load_bystedt(style: str):
    names, empty = BYSTEDT[style]
    npz = CACHE_DIR / "bystedt" / "out" / f"{style}.npz"
    if not npz.exists():
        export_curves(npz, names)
    d = np.load(npz)
    offset = dict(zip(d["empty_names"].tolist(), d["empty_locs"]))[empty]
    pts = d["points"] - offset  # the style sits on a head instanced at the empty's offset
    strands = np.split(pts, np.cumsum(d["counts"])[:-1])

    def to_gnm(p: np.ndarray) -> np.ndarray:  # Blender z-up, face towards -y
        return np.stack([p[..., 0], p[..., 2], -p[..., 1]], -1)

    return [to_gnm(s) for s in strands], to_gnm(d["head_v"]), d["head_t"]


def read_obj(path: Path) -> tuple[np.ndarray, np.ndarray]:
    verts, faces = [], []
    for line in path.read_text().splitlines():
        if line.startswith("v "):
            verts.append([float(x) for x in line.split()[1:4]])
        elif line.startswith("f "):
            idx = [int(t.split("/")[0]) - 1 for t in line.split()[1:]]
            faces += [(idx[0], idx[i], idx[i + 1]) for i in range(1, len(idx) - 1)]
    return np.array(verts), np.array(faces)


HAIRCS_DIR = CACHE_DIR / "haircs"  # HairCS (CC BY-NC 4.0, huggingface.co/datasets/HairCS2027/HairCS), fetched per style


def load_haircs(name: str, keep: int = 14000):
    """A HairCS style ("v0-00005" = data/v0/00005.npz): 60k strands × 64 points, float16 metres on a standing body
    (y up, face +z). float16 rounds y to ~1 mm at that height: strands are lightly smoothed here."""
    P = np.load(HAIRCS_DIR / "data" / f"{name}.npz")["P"].astype(np.float64)
    rng = np.random.default_rng(0)
    if len(P) > keep:
        P = P[rng.choice(len(P), keep, replace=False)]
    for _ in range(2):  # smooth the 1 mm float16 steps, roots fixed
        P[:, 1:-1] = 0.5 * P[:, 1:-1] + 0.25 * (P[:, :-2] + P[:, 2:])
    v, f = read_obj(HAIRCS_DIR / "meta" / "head_with_uv.obj")
    return list(P), v, f


# --- fitting -------------------------------------------------------------------------------------


def similarity_fit(src: np.ndarray, dst: np.ndarray):
    """Umeyama: s, R, t with dst ≈ s R src + t."""
    ms, md = src.mean(0), dst.mean(0)
    a, b = src - ms, dst - md
    u, sig, vt = np.linalg.svd(b.T @ a / len(src))
    d = np.sign(np.linalg.det(u @ vt))
    D = np.diag([1, 1, d])
    R = u @ D @ vt
    s = (sig * np.diag(D)).sum() / (a ** 2).sum(1).mean()
    return s, R, md - s * R @ ms


def fit_head(src_v: np.ndarray, gnm: GNM, iters: int = 40):
    """Similarity mapping the source head onto GNM's cranium."""
    skin = gnm.template[(gnm.vertex_groups["skin_exterior"] > 0.5) & (gnm.vertex_groups["ears"] < 0.5)]
    cranium = skin[skin[:, 1] > 0.30]
    tree = cKDTree(cranium)
    # start: match the top of the head and the head's width
    g_top, g_w = skin[:, 1].max(), np.ptp(cranium[:, 0])
    s_top = src_v[:, 1].max()
    s_crown = src_v[src_v[:, 1] > s_top - 0.4 * np.ptp(src_v[:, 1])]
    s0 = g_w / np.ptp(s_crown[:, 0])
    R, s = np.eye(3), s0
    t = np.array([0, g_top, 0.0]) - s * np.array([src_v[:, 0].mean(), s_top, s_crown[:, 2].mean()]) + np.array([0, 0, cranium[:, 2].mean()])
    level = 0.30
    for _ in range(iters):
        p = (s * src_v @ R.T) + t
        sel = p[:, 1] > level
        q = p[sel]
        d, j = tree.query(q)
        keep = d < np.quantile(d, 0.8)  # trimmed: ignore the worst 20 %
        ds, dR, dt = similarity_fit(q[keep], cranium[j[keep]])
        s, R, t = ds * s, dR @ R, ds * dR @ t + dt
    p = (s * src_v @ R.T) + t
    d, _ = tree.query(p[p[:, 1] > level])
    print(f"  fit: scale {s:.4f}, cranium rms {np.sqrt((d ** 2).mean()) * 1000:.1f} mm")
    return s, R, t


class HeadWarp:
    """Smooth space warp from the source head (already similarity-placed) onto the GNM skin, so the hair follows our
    head's shape everywhere, not just on the cranium: HairCS's neck is ~2 cm slimmer at the nape and its head wider
    over the ears. Every source vertex gets the offset to the closest GNM skin point, ears included (the two heads'
    ears line up within ~3 mm; anything GNM has no match for, > `far_mm`, is left out), smoothed over `smooth_mm`; a hair point moves by the inverse-distance blend of
    its nearest source vertices' offsets."""

    def __init__(self, src_v: np.ndarray, gnm: GNM, smooth_mm: float = 15.0, far_mm: float = 25.0):
        from .surface import gnm_surface

        _, _, cp = gnm_surface(gnm, ears=True, extrude=True).closest(src_v)
        d = cp - src_v
        ok = np.linalg.norm(d, axis=1) < far_mm / 1000
        self.tree = cKDTree(src_v)
        sig = smooth_mm / 1000
        near = self.tree.sparse_distance_matrix(self.tree, 2 * sig, output_type="coo_matrix")  # self pairs not stored
        W = coo_matrix((np.exp(-near.data ** 2 / (2 * sig * sig)) * ok[near.col], (near.row, near.col)), shape=near.shape).tocsr()
        W = W + diags(ok.astype(float))
        self.offset = (W @ d) / np.maximum(W @ np.ones(len(d)), 1e-9)[:, None]

    def __call__(self, pts: np.ndarray, k: int = 8) -> np.ndarray:
        dist, j = self.tree.query(pts, k=k)
        w = 1.0 / (dist ** 2 + 0.003 ** 2)
        return pts + (w[..., None] * self.offset[j]).sum(1) / w.sum(1)[:, None]


def fit_strands(strands, s, R, t, gnm: GNM, points: int, head_v: np.ndarray | None = None) -> np.ndarray:
    """`head_v` (the source head's vertices) turns on the whole-head warp and the smooth push (HairCS)."""
    from .surface import gnm_surface

    moved = [(s * x @ R.T) + t for x in strands]
    if head_v is not None:
        warp = HeadWarp((s * head_v @ R.T) + t, gnm)
        moved = [warp(x) for x in moved]
    out = np.stack([resample(x, points) for x in moved])
    scalp = gnm_surface(gnm)
    _, _, cp = scalp.closest(out[:, 0])
    out = out + (cp - out[:, 0])[:, None, :]  # roots onto the GNM scalp; the strand moves with its root
    return keep_out(gnm, out, 0.0008) if head_v is None else keep_out_smooth(gnm, out, 0.0008)


def clean_strays(strands: np.ndarray, gnm: GNM, face_share: float = 0.08, lonely_mm: float = 3.0) -> tuple[np.ndarray, dict]:
    """Drop generated strays: strands crossing the open face (in front of the skin, below the brows, between the outer
    eye corners) and strands that wander off on their own (their outer half has no other hair within `lonely_mm`)."""
    from .surface import gnm_surface

    N, P, _ = strands.shape
    flat = strands.reshape(-1, 3)
    surf = gnm_surface(gnm)
    tri, bary, cp = surf.closest(flat)
    n = surf.normals_at(tri, bary)
    front = ((flat - cp) * n).sum(1) > 0.001
    box = (np.abs(flat[:, 0]) < 0.045) & (flat[:, 1] > 0.19) & (flat[:, 1] < 0.312) & (flat[:, 2] > 0.06)
    on_face = (front & box).reshape(N, P).mean(1) > face_share
    # loners: sample the outer half of each strand, count other strands' points nearby
    owner = np.repeat(np.arange(N), P)
    tree = cKDTree(flat)
    outer = strands[:, P // 2:: max(1, P // 8)].reshape(-1, 3)
    who = np.repeat(np.arange(N), strands[:, P // 2:: max(1, P // 8)].shape[1])
    near = tree.query_ball_point(outer, lonely_mm / 1000)
    company = np.zeros(N)
    for i, idx in enumerate(near):
        company[who[i]] += np.count_nonzero(owner[idx] != who[i])
    lonely = company / strands[:, P // 2:: max(1, P // 8)].shape[1] < 1.0
    keep = ~(on_face | lonely)
    return strands[keep], {"on_face": int(on_face.sum()), "lonely": int((lonely & ~on_face).sum()), "kept": int(keep.sum())}


# --- main ----------------------------------------------------------------------------------------


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("source", choices=["bystedt", "haircs"])
    ap.add_argument("style")
    ap.add_argument("--id")
    ap.add_argument("--label")
    ap.add_argument("--points", type=int)
    ap.add_argument("--max-strands", type=int)
    ap.add_argument("--preview", action="store_true", help="only render out/groom/<id>.png")
    args = ap.parse_args()
    if args.source == "bystedt" and args.style == "all":
        for style in BYSTEDT_STYLES:
            subprocess.run([sys.executable, "-m", "ftv_pipeline.import_hair", "bystedt", style] + (["--preview"] if args.preview else []),
                           check=True)
        return
    gnm = GNM.load()
    cfg = BYSTEDT_STYLES.get(args.style, {}) if args.source == "bystedt" else {}
    points = args.points or cfg.get("points", 24)
    max_strands = args.max_strands or cfg.get("strands", 12000)
    sid = args.id or f"{args.source}-{args.style}"
    loader = {"bystedt": load_bystedt, "haircs": load_haircs}[args.source]
    strands, head_v, _ = loader(args.style)
    s, R, t = fit_head(head_v, gnm)
    rng = np.random.default_rng(7)
    if len(strands) > max_strands:
        strands = [strands[i] for i in rng.choice(len(strands), max_strands, replace=False)]
    fitted = fit_strands(strands, s, R, t, gnm, points, head_v=head_v if args.source == "haircs" else None)
    if args.source == "haircs":
        fitted, report = clean_strays(fitted, gnm)
        print(f"  strays removed: {report['on_face']} across the face, {report['lonely']} loners; {report['kept']} strands kept")
    fitted = fitted[rng.permutation(len(fitted))]
    natural = ("#24190f", "#6e5038")
    spec = GroomSpec(id=sid, label=args.label or cfg.get("label") or f"Bystedt {args.style}",
                     children=cfg.get("children", (0, 1, 2)), child_radius_mm=cfg.get("child_radius_mm", 1.2), natural=natural)
    groom = Groom(spec, fitted, self_shadow(fitted))
    WORK.mkdir(parents=True, exist_ok=True)
    preview = render_views(groom, WORK / f"{sid}.png", gnm=gnm)
    print(f"  {sid}: {len(fitted)} strands × {points}; preview {preview}")
    if args.preview:
        return
    data = encode(groom)
    # a licensed dataset keeps its own folder (with its LICENSE.md); the rest sit in hair/
    sub = "haircs/" if args.source == "haircs" else ""
    (HAIR_MODELS_DIR / sub / "thumbs").mkdir(parents=True, exist_ok=True)
    (HAIR_MODELS_DIR / f"{sub}{sid}.strands.bin").write_bytes(data)
    thumb = thumbnail(groom, gnm)
    if sub:
        thumb.replace(HAIR_MODELS_DIR / sub / "thumbs" / thumb.name)
    e = entry(groom, len(data))
    e["file"], e["thumb"] = f"hair/{sub}{sid}.strands.bin", f"hair/{sub}thumbs/{sid}.webp"
    e["author"] = AUTHORS[args.source]
    e["pack"] = "haircs" if args.source == "haircs" else "groom"
    # a re-import refreshes the generated fields in place; the curated ones (label, group, type, curly, fringe) and the
    # style's place in the picker stay (export_groom.merge_index); a new style is listed first
    merge_index([e])
    print(f"  → web/public/models/hair/{sub}{sid}.strands.bin {len(data) / 1000:.0f} KB")


if __name__ == "__main__":
    main()
