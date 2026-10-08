"""`uv run lash-strands [id …] [--preview]`: eyelashes as strands (ours, MIT), drawn by the app's strand renderer
(lib/groom.ts) like the hair, beards and brows. Roots follow the lids every frame and turn round the eyeball through a
blink (GroomDef.eyeFollow).

Each style (config/lashes.toml) grows, per eye and lid:
  - roots along the lid's lash line (eyelids.lash_lines: the outer edge of the lid margin, where the MakeHuman
    cards' roots sat), sparse at the inner corner, in a few irregular rows across the margin;
  - a length per root along the lid (inner → outer corner; the guide profiles were measured from the MakeHuman cards'
    strips as fitted on our head), with jitter and some shorter, younger lashes;
  - a lash that leaves the lid forward, tilted up (upper) or down (lower), splays towards the temple at the outer
    corner, and curls along its length (most near the root);
  - clumps of a few lashes whose tips gather, a few lashes crossing their neighbours;
  - nothing inside the eyeball.
"""
from __future__ import annotations

import argparse
import json
import time
import tomllib

import numpy as np

from .addon_fit import ADDONS_MODELS_DIR
from .export_groom import WORK, entry
from .eyelids import Polyline, eye_joints, lash_lines, lid_margins
from .gnm import PIPELINE_DIR
from .groom import Groom, GroomSpec, encode, fair, render_views, unit
from .head_context import head_context

CONFIG = PIPELINE_DIR / "config" / "lashes.toml"
MODELS = ADDONS_MODELS_DIR / "eyelashes"


def rotate(v: np.ndarray, axis: np.ndarray, angle: np.ndarray) -> np.ndarray:
    """Rodrigues, per row: v turned about `axis` by `angle` (radians)."""
    axis = unit(axis)
    c, s = np.cos(angle)[:, None], np.sin(angle)[:, None]
    return v * c + np.cross(axis, v) * s + axis * (axis * v).sum(1, keepdims=True) * (1 - c)


def profile(points: list[float], u: np.ndarray) -> np.ndarray:
    """A value per position along the lid from evenly spaced control points (inner → outer corner), smoothly."""
    xs = np.linspace(0, 1, len(points))
    return np.interp(u, xs, points)


def grow_lid(line: Polyline, rim: Polyline, side: str, lid: str, c: dict, g: dict, rng) -> np.ndarray:
    """(n, P, 3) lashes for one lid of one eye: `line` its lash line, `rim` the inner edge of its margin."""
    P = int(g["points"])
    n = int(c["count"])
    # roots: denser where the lashes grow thickly (fewer at the inner corner)
    cand = rng.uniform(c["span"][0], c["span"][1], n * 6)
    dens = np.clip(profile(c["density"], (cand - c["span"][0]) / (c["span"][1] - c["span"][0])), 0, None)
    if g.get("patchy", 0):  # real lash lines are uneven: denser runs and thin gaps along the lid (smooth noise)
        knots = rng.uniform(1 - g["patchy"], 1 + g["patchy"], 14)
        dens = dens * np.clip(np.interp(cand, np.linspace(0, 1, 14), knots), 0.05, None)
    u = np.sort(rng.choice(cand, n, replace=False, p=dens / dens.sum()))
    t = (u - c["span"][0]) / (c["span"][1] - c["span"][0])  # 0 inner … 1 outer corner of this lid's lashes
    root = line.at(u)
    across = rim.at(u) - root  # from the lash line in towards the eye's rim (the rows step back across the margin)
    root = root + across * rng.uniform(0, c["rows_depth"], n)[:, None]
    sx = 1.0 if side == "left" else -1.0
    fwd = np.array([0.0, 0.0, 1.0])
    up = np.array([0.0, 1.0, 0.0]) if lid == "upper" else np.array([0.0, -1.0, 0.0])
    out = np.array([sx, 0.0, 0.0])
    # the direction it leaves the lid: forward, tilted up (down), splayed towards the temple at the outer corner and
    # towards the nose at the inner corner
    lift = np.radians(profile(c["lift_deg"], t) + rng.normal(0, g["lift_jitter_deg"], n))
    splay = profile(c["splay"], t)
    d = unit(fwd[None] * np.cos(lift)[:, None] + up[None] * np.sin(lift)[:, None] + out[None] * splay[:, None])
    # each lash a little off its neighbours (they cross: each reads as its own)
    d = rotate(d, np.broadcast_to(up, d.shape), np.radians(rng.normal(0, g["jitter_deg"], n)))
    # lengths along the lid, jitter, and some younger, shorter lashes
    length = profile(c["length_mm"], t) / 1000 * (1 + g["length_jitter"] * rng.uniform(-1, 1, n))
    young = rng.random(n) < g["young_share"]
    length = np.where(young, length * rng.uniform(0.45, 0.85, n), length)
    if g.get("long_share", 0):  # and a few lashes clearly longer than their neighbours
        length = np.where(rng.random(n) < g["long_share"], length * rng.uniform(1.2, 1.5, n), length)
    # curl: a turn towards `up` (away from the eye), strongest near the root
    curl = np.radians(profile(c["curl_deg"], t)) * (1 + g["curl_jitter"] * rng.uniform(-1, 1, n))
    axis = unit(np.cross(d, up[None]))
    k = np.arange(1, P)
    share = (1 - g["curl_root"] * (k - 1) / max(P - 2, 1))
    share = share / share.sum()  # how much of the total turn each step takes (more at the root)
    pts = [root]
    p, dd = root.copy(), d.copy()
    for i in range(P - 1):
        dd = rotate(dd, axis, curl * share[i])  # (about d × up: a positive turn heads towards up)
        p = p + dd * (length / (P - 1))[:, None]
        pts.append(p.copy())
    lash = np.stack(pts, 1)
    # clumps: runs of 1–5 neighbours along the lid whose tips gather
    sizes = []
    while sum(sizes) < n:
        sizes.append(int(rng.choice(g["clump_sizes"], p=np.array(g["clump_weights"]) / sum(g["clump_weights"]))))
    # (a negative clump fans a group out instead: volume extensions, several fine lashes spreading from one place)
    w = (np.linspace(0, 1, P) ** 2)[None, :, None] * g["clump"]
    i0 = 0
    for s in sizes:
        sl = slice(i0, min(n, i0 + s))
        if s > 1:
            tip = lash[sl, -1].mean(0)
            lash[sl] = lash[sl] + (tip - lash[sl, -1])[:, None, :] * w
        i0 += s
    return lash


LASH_TURN = 2.0  # lib/groom.ts GROOM.lashTurn: lashes turn this many times the angle their root travels round the eye


def _mirror(name: str) -> str:
    """The other eye's twin of a lid component (an emotion is its own twin)."""
    if name.startswith("left_"):
        return "right_" + name[len("left_"):]
    return "left_" + name[len("right_"):] if name.startswith("right_") else name


class LidFix:
    """Lashes against the lid's skin. The app moves each root with the skin (3 nearest skin vertices, 1/d⁴) and turns
    the lash about the eye's horizontal axis through its root by LASH_TURN × the angle the root travelled round the
    eye centre (a blink). Expressions that fold the upper lid down over the lash line (angry above all) still bury the
    lashes: for each such morph target (and sign), the extra turn each lash needs to clear the folded skin is found
    here and stored per lash (`<id>.lid.bin`); the app adds Σ turn × weight to the blink turn."""

    def __init__(self, ctx, cfg: dict):
        from scipy.spatial import cKDTree

        from .emotions import emotion_targets
        from .surface import Surface

        self.Surface = Surface
        g = ctx.gnm
        self.T = g.template.astype(np.float64)
        skin = g.vertex_groups["skin_exterior"] > 0.5
        self.tris = g.triangles[skin[g.triangles].all(1)]
        self.skin_ids = np.flatnonzero(skin)
        self.tree = cKDTree(self.T[self.skin_ids])
        self.eyes = eye_joints(g).astype(np.float64)
        self.cfg = cfg
        named = {n: g.expression_basis[g.expression_names.index(n)].astype(np.float64)
                 for n in g.expression_names if n.split("_region_")[0] in ("left_eye", "right_eye") and 1 <= int(n[-3:]) <= 5}
        # (component 000 is the blink: the app's blink turn handles it, and it must stay the same for both eyes)
        named.update({n: d.astype(np.float64) for n, d in emotion_targets(g) if n.endswith("_upper")})
        # (target, sign) pairs the app can drive: eye components both ways, emotions 0…1
        self.cases = [(n, sg) for n in named for sg in ((1,) if n.startswith("emo_") else (1, -1))]
        self.deltas = named
        self.rest_surf = Surface.build(self.T, self.tris)

    def turn(self, lashes: np.ndarray, phi: np.ndarray) -> np.ndarray:
        """Each lash turned about the x axis through its root by phi (the app's convention, lib/groom.ts)."""
        r0 = lashes[:, :1]
        v = lashes - r0
        cs, sn = np.cos(phi)[:, None], np.sin(phi)[:, None]
        return r0 + np.stack([v[..., 0], v[..., 2] * sn + v[..., 1] * cs, v[..., 2] * cs - v[..., 1] * sn], -1)

    def depth(self, lashes: np.ndarray, surf) -> np.ndarray:
        """Deepest point of each lash below the skin (m, ≥ 0), roots and their first step left out."""
        if not len(lashes):
            return np.zeros(0)
        flat = lashes[:, 2:].reshape(-1, 3)
        tri, bary, cp = surf.closest(flat)
        n = surf.normals_at(tri, bary)
        return np.clip(-((flat - cp) * n).sum(1), 0, None).reshape(len(lashes), -1).max(1)

    def clear(self, lashes: np.ndarray, surf, todo: np.ndarray) -> np.ndarray:
        """The smallest extra turn (radians, either way) that brings each lash in `todo` clear of `surf`."""
        c = self.cfg
        phi = np.zeros(len(lashes))
        best = self.depth(lashes, surf)
        todo = todo & (best > c["clear_mm"] / 1000)
        steps = np.radians(np.arange(c["step_deg"], c["max_deg"] + 1e-6, c["step_deg"]))
        for a in steps:
            if not todo.any():
                break
            for sg in (-1.0, 1.0):
                idx = np.flatnonzero(todo)
                d = self.depth(self.turn(lashes[idx], np.full(len(idx), sg * a)), surf)
                better = d < best[idx] - 1e-5
                phi[idx[better]], best[idx[better]] = sg * a, d[better]
                done = d <= c["clear_mm"] / 1000
                todo[idx[done]] = False
        return phi

    def rest(self, lashes: np.ndarray) -> np.ndarray:
        """Lashes already touching the skin at rest, turned clear (applied to the geometry)."""
        phi = self.clear(lashes, self.rest_surf, np.ones(len(lashes), bool))
        return self.turn(lashes, phi)

    def angles(self, lashes: np.ndarray) -> tuple[np.ndarray, list]:
        """(n, K) extra turn per lash per (target, sign) at full weight, and the K cases that need any."""
        roots = lashes[:, 0]
        d, j = self.tree.query(roots, k=3)
        idx = self.skin_ids[j]
        w = 1 / (d ** 4 + 1e-16)
        w /= w.sum(1, keepdims=True)
        C = np.where(roots[:, :1] > 0, self.eyes[0], self.eyes[1])
        a0 = np.arctan2(roots[:, 1] - C[:, 1], roots[:, 2] - C[:, 2])
        cols, need = {}, set()
        for name, sg in self.cases:
            D = sg * self.deltas[name]
            off = (w[..., None] * D[idx]).sum(1)
            a1 = np.arctan2(roots[:, 1] + off[:, 1] - C[:, 1], roots[:, 2] + off[:, 2] - C[:, 2])
            posed = self.turn(lashes, LASH_TURN * (a1 - a0)) + off[:, None]
            surf = self.Surface.build(self.T + D, self.tris)
            phi = self.clear(posed, surf, np.ones(len(lashes), bool))
            cols[(name, sg)] = phi
            # only expressions that really bury lashes (a few touching near the root are not worth a channel)
            if (np.abs(phi) >= np.radians(self.cfg["min_turn_deg"])).sum() >= self.cfg["min_lashes"]:
                need.add((name, sg))
        # in mirrored pairs: a lid component that needs a channel on one eye gives its twin on the other eye one too
        # (GNM's left and right lid components mirror each other exactly), so both eyes' lashes behave the same
        pairs = sorted({tuple(sorted({c, (_mirror(c[0]), c[1])})) for c in need})
        if sum(len(p) for p in pairs) > self.cfg["max_targets"]:  # the app reads at most this many: keep the biggest
            keep, k = [], 0
            for p in sorted(pairs, key=lambda p: -sum(np.abs(cols[c]).sum() for c in p)):
                if k + len(p) <= self.cfg["max_targets"]:
                    keep.append(p)
                    k += len(p)
            pairs = keep
        used = [[name, sg] for name, sg in self.cases if any((name, sg) in p for p in pairs)]  # in the fixed case order
        cols = [cols[(name, sg)] for name, sg in used]
        return (np.stack(cols, 1) if cols else np.zeros((len(lashes), 0))), used


def build(sid: str, st: dict, cfg: dict, ctx) -> Groom:
    g = {**cfg["grow"], **st.get("grow", {})}
    rng = np.random.default_rng(st.get("seed", 7))
    lines, margins = lash_lines(ctx), lid_margins(ctx)
    parts = []
    for side in ("left", "right"):
        # the lashes of each lid, then the lash line: a row of very short, dense lashes along the lid's edge that
        # reads as the dark line the lashes grow from ([upper_line] / [lower_line], on the same lid)
        for key, lid in (("upper", "upper"), ("lower", "lower"), ("upper_line", "upper"), ("lower_line", "lower")):
            if key not in cfg or (key.endswith("_line") and not st.get("lash_line", True)):
                continue
            c = {**cfg.get(lid, {}), **cfg[key], **st.get(key, {})} if key.endswith("_line") else {**cfg[key], **st.get(key, {})}
            if int(c["count"]) > 0:
                rim = Polyline(ctx.gnm.template[np.asarray(margins[(side, lid)], int)].astype(np.float64))
                parts.append(grow_lid(Polyline(lines[(side, lid)]), rim, side, lid, c, g, rng))
    lashes = fair(np.concatenate(parts), int(g["fair"]))
    return finish(sid, st, cfg, g, ctx, lashes, rng)


def finish(sid: str, st: dict, cfg: dict, g: dict, ctx, lashes: np.ndarray, rng) -> Groom:
    """Clear of the eyeballs, then the groom."""
    # never inside an eyeball: points pushed out to the sclera's radius + a clearance
    gnm = ctx.gnm
    sclera = gnm.template[gnm.vertex_groups["scleras"] > 0.5].astype(np.float64)
    for eye in eye_joints(gnm):
        near = sclera[np.linalg.norm(sclera - eye, axis=1) < 0.02]
        r = np.median(np.linalg.norm(near - eye, axis=1)) + g["eye_clearance_mm"] / 1000
        v = lashes - eye
        dist = np.linalg.norm(v, axis=2)
        inside = dist < r
        inside[:, 0] = False
        lashes[inside] = eye + v[inside] / dist[inside][:, None] * r
    r = {**cfg["render"], **st.get("render", {})}
    spec = GroomSpec(id=sid, label=st["label"], children=tuple(r["children"]), child_radius_mm=r["child_radius_mm"],
                     width_mm=r["width_mm"], tip_width=r["tip_width"], natural=tuple(r["natural"]),
                     cover_min=r["cover_min"], shine=r["shine"])
    fix = LidFix(ctx, cfg["lid"])
    lashes = fix.rest(lashes)
    order = rng.permutation(len(lashes))
    # lash-to-lash tone: some a little lighter than others (`tone_var`)
    tone = 1 - g.get("tone_var", 0) * rng.random(len(lashes)) ** 2 if g.get("tone_var", 0) else np.ones(len(lashes))
    groom = Groom(spec, lashes[order], np.repeat(tone[order, None], lashes.shape[1], axis=1))
    groom.lid = fix.angles(groom.strands)  # (angles (n, K), [[target, sign], …]) in the shipped order
    return groom


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
        eye = tuple(float(x) for x in eye_joints(ctx.gnm)[0] + np.array([0, 0.004, 0.0]))
        pv = render_views(g, WORK / f"lash-{sid}.png", gnm=ctx.gnm, views=(0, 35, 80), focal=eye, distance=0.08, line_width=1.5)
        print(f"  {sid}: {len(g.strands)} lashes × {g.strands.shape[1]}; preview {pv} ({time.time() - t0:.0f} s)")
        if args.preview:
            continue
        data = encode(g)
        (MODELS / f"{sid}.strands.bin").write_bytes(data)
        e = entry(g, len(data), mesh_fields=True)
        e["strands"]["eyeFollow"] = True  # turn with the lids round the eyeballs (lib/groom.ts)
        ang, used = g.lid
        if used:  # the extra turn per lash per expression that folds the lid (int8, 0.5° units, lash-major)
            q = np.clip(np.round(np.degrees(ang) * 2), -127, 127).astype(np.int8)
            (MODELS / f"{sid}.lid.bin").write_bytes(q.tobytes())
            e["strands"]["lidFix"] = {"file": f"addons/eyelashes/{sid}.lid.bin", "targets": used}
            print(f"    lid fix: {len(used)} expressions, {int((np.abs(ang) > 0).any(1).sum())} lashes")
        else:  # no lid fix any more: the old file would be left behind unreferenced
            (MODELS / f"{sid}.lid.bin").unlink(missing_ok=True)
        if "darken" in st:  # how far the hair colour is taken to black for this style (lib/addons.ts applyAddons)
            e["strands"]["darken"] = st["darken"]
        e["strands"]["rampMm"] = cfg["render"]["ramp_mm"]
        e.update({"file": f"addons/eyelashes/{sid}.strands.bin", "thumb": f"addons/eyelashes/thumbs/{sid}.webp",
                  "author": "face-to-voice (generated, shaped by MakeHuman's CC0 lash cards)", "pack": "generated",
                  "alphaCutoff": 0, "tint": True})
        entries[sid] = e
        print(f"  → web/public/models/addons/eyelashes/{sid}.strands.bin {len(data) / 1000:.0f} KB")
    if args.preview:
        return
    index["licence"] = ("MIT — generated by the face-to-voice pipeline (lash_strands.py); the MakeHuman lash cards (CC0 1.0, "
                        "© 2020 Data Collection AB, Joel Palmius, Jonas Hauquier) served as references only")
    ours = [i for i in cfg["style"] if i in entries]
    for e in index["styles"]:  # generated styles dropped from the config: their files go too
        if e.get("pack") == "generated" and e["id"] not in cfg["style"]:
            lid = e.get("strands", {}).get("lidFix", {}).get("file")
            for rel in (e["file"], e["thumb"], *([lid] if lid else [])):
                (ADDONS_MODELS_DIR.parent / rel).unlink(missing_ok=True)
            print("  removed", e["id"])
    index["styles"] = [entries[i] for i in ours] + [e for e in index["styles"] if e["id"] not in ours and e.get("pack") != "generated"]
    index_path.write_text(json.dumps(index, indent=2, ensure_ascii=False) + "\n")
