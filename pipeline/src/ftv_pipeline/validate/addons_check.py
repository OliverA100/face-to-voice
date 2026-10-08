"""Add-ons on extreme faces: hair, eyebrows, eyelashes and strand beards (strands), and glasses (meshes with targets).

Strands are decoded from the shipped .strands.bin and moved the way the web app moves them (lib/groom.ts):
  roots   each root follows its 3 nearest skin vertices (weights 1/d⁴) and the whole strand moves with it
  lashes  also turn about the eye's horizontal axis through the root (eyeFollow: GROOM.lashTurn × the angle the root
          travelled round the eye centre, now vs at rest), plus the shape turn (away from skin the face's shape brought
          towards the lash) and the baked lid fix (<id>.lid.bin × each lid target's weight)
  brows   also every point: the face shape's offset at its own skin minus at its root (followShapePoints)
Child strands (drawn on the GPU around each strand, ≤ a few tenths of a mm off) are left out.
Glasses are decoded like `uv run verify` and get their own morph targets (identity and Shape only, as in the app), then
the app's runtime fit (lib/glassesFit.ts: slide forward, open the arms, only as far as needed). Arm tips behind the ear
root may tuck in (real glasses do; so does the fit), so they are not counted as clipping.

Every measure is taken against the same add-on on the average face, so a hair that already brushes the skin there
does not count:
  floating   a strand root, or the whole glasses frame, further off the skin than on the average face (+1 / +3 mm)
  clipping   strand points (or frame vertices) further inside the skin than on the average face (+1 / +0.5 mm), on
             more than a few points (CLIP_SHARE)
  eye        lashes or frame inside / within 0.5 mm of the visible eyeball
"""
from __future__ import annotations

import gzip
import json
import struct
from functools import lru_cache
from pathlib import Path

import numpy as np
from scipy.spatial import cKDTree

from ..export_glb import assign_triangles, boundary_loops
from ..gnm import REPO_DIR
from ..parts import PARTS
from ..surface import Surface
from .model import HeadModel

MODELS = REPO_DIR / "web" / "public" / "models"
LASH_TURN = 2.0  # lib/groom.ts GROOM.lashTurn
SHAPE_TURN_MAX_DEG, SHAPE_TURN_MIN_MM = 45.0, 0.5  # GROOM.shapeTurnMax, GROOM.shapeTurnMinMm
LID_MAX = 16  # lib/groom.ts LID_MAX: lid-fix targets per lash style
MAX_POINTS = 20000  # strand points tested per style (strands are subsampled evenly beyond this)
FLOAT_MM, CLIP_MM, CLIP_SHARE = 1.0, 1.0, 0.01
GLASS_CLIP_MM, GLASS_FLOAT_MM, EYE_GAP_MM = 0.5, 3.0, 0.5
BUST_MM = 25.0
# lib/glassesFit.ts GLASSES_FIT
GLASSES_FIT = {"tolerance_mm": 0.25, "hinge_depth_mm": 22, "arm_min_x_mm": 40, "min_lever_mm": 30, "ear_root_z_mm": 19.7,
               "ear_band_mm": 6, "max_seat_mm": 6, "max_splay": 0.25, "samples": 20000, "reach_mm": 15}


def decode_strands(path: Path) -> np.ndarray:
    """(N, P, 3) float32 metres, head space (inverse of groom.encode)."""
    raw = gzip.decompress(path.read_bytes())
    if raw[:4] != b"FTVH":
        raise ValueError(f"{path.name}: not a strands file")
    _version, N, P, ox, oy, oz, q = struct.unpack("<3I4f", raw[4:32])
    n = N * P * 3
    lo = np.frombuffer(raw, np.uint8, n, 32)
    hi = np.frombuffer(raw, np.uint8, n, 32 + n)
    d2 = (lo.astype(np.uint16) | (hi.astype(np.uint16) << 8)).view(np.int16).astype(np.int64).reshape(3, N, P).transpose(1, 2, 0)
    d = d2.copy()
    d[:, 2:] = np.cumsum(d2[:, 2:], axis=1) + d2[:, 1:2]  # undo the change of step …
    qd = d.copy()
    qd[:, 1:] = np.cumsum(d[:, 1:], axis=1) + d[:, :1]  # … then the steps
    return (qd * q + np.array([ox, oy, oz])).astype(np.float32)


def styles() -> list[dict]:
    """Every strand style and every glasses frame: {category, id, file, kind, lidFix?}."""
    out = []
    hair = json.loads((MODELS / "hair" / "index.json").read_text())
    out += [{"category": "hair", "id": s["id"], "file": s["file"], "kind": "strands"} for s in hair["styles"] if s.get("kind") == "strands"]
    for cat in ("eyebrows", "eyelashes", "facialHair", "glasses"):
        doc = json.loads((MODELS / "addons" / cat / "index.json").read_text())
        for s in doc["styles"]:
            kind = s.get("kind", "glb")
            if cat == "glasses":
                out.append({"category": cat, "id": s["id"], "file": s["file"], "kind": "glasses"})
            elif kind == "strands":
                out.append({"category": cat, "id": s["id"], "file": s["file"], "kind": "strands",
                            "eyeFollow": bool(s.get("strands", {}).get("eyeFollow")), "lidFix": s.get("strands", {}).get("lidFix")})
    return out


class AddonChecker:
    def __init__(self, model: HeadModel):
        self.m = model
        g = model.gnm
        names = [p.name for p in PARTS]
        skin = np.flatnonzero(model.owner == names.index("skin"))
        self.skin = skin
        self.tree = cKDTree(g.template[skin])
        ext = (g.vertex_groups["skin_exterior"] > 0.5) & (model.owner == names.index("skin"))
        self.ext_tris = g.triangles[ext[g.triangles].all(1)]
        # the bust's open cut: inside / outside means nothing there (long hair hangs past it), so points whose
        # closest skin is within BUST_MM of it are not judged
        cut = max(boundary_loops(self.ext_tris), key=len)
        d, _ = cKDTree(g.template[cut]).query(g.template[self.ext_tris].mean(1))
        self.near_cut = d < BUST_MM / 1000

        tri_owner = assign_triangles(model.owner, g.triangles, len(PARTS))
        self.skin_tris = g.triangles[tri_owner == names.index("skin")]  # the app's skin mesh (lib/glassesFit.ts rays)
        self.eye_tris = g.triangles[np.isin(tri_owner, [names.index(f"{n}_{s}") for n in ("sclera", "iris", "pupil") for s in "LR"])]
        self.pivot0 = model.pivot0  # lib/groom.ts uEyeL0/R0: the eye centres on the average face
        self.shape_k = np.array([k in ("identity", "semantic") for k in model.kinds])  # lib/groom.ts SHAPE
        self.neutral = np.zeros(len(model.names), np.float32)
        self._base: dict = {}

    # --- strands --------------------------------------------------------------------------------------------------

    @lru_cache(maxsize=4)  # noqa: B019 (a few long-lived checkers per run)
    def _strands(self, file: str) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
        S = decode_strands(MODELS / file)
        N, P, _ = S.shape
        keep = np.arange(N) if N * P <= MAX_POINTS else np.linspace(0, N - 1, max(1, MAX_POINTS // P)).astype(int)
        S = S[keep]
        d, nn = self.tree.query(S[:, 0], k=3)
        w = 1 / (d ** 4 + 1e-16)
        return S, self.skin[nn], w / w.sum(1, keepdims=True)

    @lru_cache(maxsize=4)  # noqa: B019 (a few long-lived checkers per run)
    def _lid(self, file: str, k: int) -> np.ndarray:
        """(N, k) radians: the baked lid-fix turn per lash per target at weight 1 (int8 × 0.5°)."""
        return np.frombuffer((MODELS / file).read_bytes(), np.int8).astype(np.float64).reshape(-1, k) * 0.5 * np.pi / 180

    @lru_cache(maxsize=32)  # noqa: B019 (a few long-lived checkers per run)
    def _points(self, file: str) -> tuple[np.ndarray, np.ndarray]:
        """Every strand point tied to its 3 nearest skin vertices, 1/d⁴ (lib/groom.ts tieToSkin)."""
        S = self._strands(file)[0]
        d, nn = self.tree.query(S.reshape(-1, 3), k=3)
        w = 1 / (d ** 4 + 1e-16)
        return self.skin[nn], w / w.sum(1, keepdims=True)

    @lru_cache(maxsize=32)  # noqa: B019 (a few long-lived checkers per run)
    def _tips(self, file: str) -> tuple[np.ndarray, np.ndarray, np.ndarray, np.ndarray]:
        """Lashes: the skin under each tip tied like the roots (ids, weights), that rest point, and whether it is above
        the lash (lib/groom.ts followSkin `tips`)."""
        S = self._strands(file)[0]
        d, nn = self.tree.query(S[:, -1], k=3)
        w = 1 / (d ** 4 + 1e-16)
        w /= w.sum(1, keepdims=True)
        ids = self.skin[nn]
        under = np.einsum("nk,nkd->nd", w, self.m.gnm.template[ids])
        r0 = S[:, 0]
        above = _yz(under - r0) > _yz(S[:, -1] - r0)
        return ids, w, under, above

    def strands_at(self, style: dict, w: np.ndarray, P: np.ndarray) -> np.ndarray:
        """(n, P, 3) strand points on the face with weights w (P = its vertex positions), as lib/groom.ts draws them."""
        S, nn, wt = self._strands(style["file"])
        T = self.m.gnm.template
        off = np.einsum("nk,nkd->nd", wt, P[nn] - T[nn])
        out = S + off[:, None, :]
        if style["category"] == "eyebrows":
            # lib/groom.ts followShapePoints: every point gets the face SHAPE's offset at its own skin minus at its root
            ids, pw = self._points(style["file"])
            Ps = self.m.positions(np.where(self.shape_k, w, 0))
            d = np.einsum("nk,nkd->nd", pw, Ps[ids] - T[ids]).reshape(S.shape)
            out = out + d - d[:, :1]
        if style.get("eyeFollow"):
            r0 = S[:, 0]
            L = (r0[:, 0] > 0)[:, None]
            piv = self.m.pivots(w)  # the eye centres now (uEyeL/R, from the eye nodes) …
            c, c0 = np.where(L, piv[0], piv[1]), np.where(L, self.pivot0[0], self.pivot0[1])  # … and at rest
            da = LASH_TURN * (_yz(r0 + off - c) - _yz(r0 - c0))
            # the shape turn: away from skin the face's SHAPE brought towards the lash (identity + Shape targets only)
            ids, tw, under, above = self._tips(style["file"])
            Ps = self.m.positions(np.where(self.shape_k, w, 0))
            sr = np.einsum("nk,nkd->nd", wt, Ps[nn] - T[nn])
            su = np.einsum("nk,nkd->nd", tw, Ps[ids] - T[ids])
            turn = _yz(under + su - (r0 + sr)) - _yz(under - r0)
            turn = np.arctan2(np.sin(turn), np.cos(turn))  # wrapped to ±π
            mx = np.radians(SHAPE_TURN_MAX_DEG)
            turn = np.where(above, np.clip(turn, -mx, 0), np.clip(turn, 0, mx))
            turn[np.linalg.norm((under - r0)[:, 1:], axis=1) < SHAPE_TURN_MIN_MM / 1000] = 0
            da = da + turn
            lf = style.get("lidFix")
            if lf:  # lashes are never subsampled (a few thousand points), so the rows line up
                lid = self._lid(lf["file"], len(lf["targets"]))[:, :LID_MAX]
                tw_ = np.array([max(0.0, sign * float(w[self.m.names.index(t)])) if t in self.m.names else 0.0
                                for t, sign in lf["targets"][:LID_MAX]])
                da = da + lid @ tw_
            cs, sn = np.cos(da)[:, None], np.sin(da)[:, None]
            v = S - r0[:, None, :]
            rot = np.stack([v[..., 0], v[..., 2] * sn + v[..., 1] * cs, v[..., 2] * cs - v[..., 1] * sn], -1)
            out = r0[:, None, :] + rot + off[:, None, :]
        return out

    def _signed(self, surf: Surface, X: np.ndarray, cut: bool = False) -> np.ndarray:
        """mm from the surface, < 0 inside; with `cut`, NaN where the closest skin is at the bust's open cut."""
        tri, bary, cp = surf.closest(X, k=8)
        sd = np.einsum("ij,ij->i", X - cp, surf.normals_at(tri, bary)) * 1000
        return np.where(self.near_cut[tri], np.nan, sd) if cut else sd

    def _base_of(self, kind: str, style: dict, base_w: np.ndarray | None, key: str):
        k = (kind, style["file"], key)
        if k not in self._base:
            bw = self.neutral if base_w is None else base_w
            self._base[k] = (self._measure_strands if kind == "s" else self._measure_glasses)(style, bw)
        return self._base[k]

    def check_strands(self, style: dict, w: np.ndarray, base_w: np.ndarray | None = None, base_key: str = "rest") -> dict:
        base = self._base_of("s", style, base_w, base_key)
        now = self._measure_strands(style, w)
        float_mm = float((now["root"] - base["root"]).max())
        judged = np.isfinite(base["sd"]) & np.isfinite(now["sd"])
        # how much further into the skin than on the average face (a point that was off the skin and now just touches
        # it is not deeper by the gap it closed)
        extra = np.where(judged, np.maximum(-now["sd"], 0) - np.maximum(-base["sd"], 0), 0.0)
        inside = judged & (now["sd"] < 0)
        sinking = (extra > CLIP_MM) & inside
        out = {"floating_mm": float_mm, "clip_share": float(sinking.sum() / max(1, judged.sum())),
               "clip_mm": float(np.percentile(extra[inside], 99)) if inside.any() else 0.0,  # p99: not one stray point
               "where": worst_sinking(np.where(judged, now["sd"], 1.0), extra)}
        out["fail"] = [k for k, bad in (("floating", float_mm > FLOAT_MM), ("clipping", out["clip_share"] > CLIP_SHARE)) if bad]
        if style["category"] == "eyelashes":
            eye_extra = np.maximum(now["eye"], 0) - np.maximum(base["eye"], 0)  # further into the visible eye than on the average face
            out["eye_share"] = float((eye_extra > 0.2).mean())
            if out["eye_share"] > CLIP_SHARE:
                out["fail"].append("eye")
        return out

    def _measure_strands(self, style: dict, w: np.ndarray) -> dict:
        P = self.m.positions(w)
        X = self.strands_at(style, w, P)
        skin = Surface.build(P, self.ext_tris)
        pts = X.reshape(-1, 3)
        sd = self._signed(skin, pts, cut=True)
        root = np.abs(self._signed(skin, X[:, 0]))
        res = {"sd": sd, "root": root}
        if style["category"] == "eyelashes":
            eye = Surface.build(P, self.eye_tris)
            res["eye"] = -self._signed(eye, pts)  # > 0 inside the visible eye
        return res

    # --- glasses ----------------------------------------------------------------------------------------------------

    @lru_cache(maxsize=32)  # noqa: B019 (a few long-lived checkers per run)
    def _glasses(self, file: str) -> tuple[np.ndarray, np.ndarray, list[str]]:
        """(rest (V, 3) head space, deltas (T, V, 3), target names) of a glasses .glb (decoded like `uv run verify`)."""
        import tempfile

        from pygltflib import GLTF2

        from ..tools import gltf_transform
        from ..verify_glb import mesh_nodes, read_accessor

        with tempfile.TemporaryDirectory() as tmp:
            dec = Path(tmp) / "g.glb"
            gltf_transform("copy", MODELS / file, dec, capture=True)
            gltf = GLTF2().load_binary(str(dec))
        blob = gltf.binary_blob()
        rest, deltas, names = [], [], None
        for _, node, world in mesh_nodes(gltf):
            lin, offv = world[:3, :3], world[:3, 3]
            for prim in gltf.meshes[node.mesh].primitives:
                rest.append(read_accessor(gltf, blob, prim.attributes.POSITION) @ lin.T + offv)
                tn = list((gltf.meshes[node.mesh].extras or {}).get("targetNames", []))
                names = names or tn
                ds = []
                for t in prim.targets or []:
                    acc = t["POSITION"] if isinstance(t, dict) else t.POSITION
                    ds.append(read_accessor(gltf, blob, acc) @ lin.T)
                deltas.append(np.stack(ds) if ds else np.zeros((0, len(rest[-1]), 3)))
        V = np.concatenate(rest)
        D = np.concatenate(deltas, axis=1) if deltas and len(deltas[0]) else np.zeros((0, len(V), 3))
        return V, D, names or []

    @lru_cache(maxsize=32)  # noqa: B019 (a few long-lived checkers per run)
    def _fit_prep(self, file: str) -> dict:
        """lib/glassesFit.ts prepare(): arms and their levers, the tested points, each one's candidate skin triangles,
        and what it may have on the average face."""
        F = GLASSES_FIT
        V = self._glasses(file)[0]
        hinge = V[:, 2].max() - F["hinge_depth_mm"] / 1000
        arm = (np.abs(V[:, 0]) > F["arm_min_x_mm"] / 1000) & (V[:, 2] < hinge)
        side = np.where(arm, np.sign(V[:, 0]), 0).astype(int)
        lever = np.where(arm, np.sign(V[:, 0]) * (hinge - V[:, 2]), 0.0)
        fronts = np.flatnonzero(side == 0)
        arms = np.flatnonzero((side != 0) & (np.abs(lever) >= F["min_lever_mm"] / 1000)
                              & (V[:, 2] > (F["ear_root_z_mm"] - F["ear_band_mm"]) / 1000))
        every = lambda ids, n: ids[:: max(1, int(np.ceil(len(ids) / n)))]  # noqa: E731
        samples = np.r_[every(fronts, F["samples"] // 2), every(arms, F["samples"] // 2)]
        T = self.m.gnm.template
        cen = T[self.skin_tris].mean(1)
        reach = F["reach_mm"] / 1000
        cand = []
        for g in samples:
            if side[g]:
                near = (np.hypot(cen[:, 1] - V[g, 1], cen[:, 2] - V[g, 2]) < reach) & (cen[:, 0] * side[g] > 0)
            else:
                near = np.hypot(cen[:, 0] - V[g, 0], cen[:, 1] - V[g, 1]) < reach
            cand.append(np.flatnonzero(near))
        prep = {"side": side, "lever": lever, "samples": samples, "cand": cand}
        prep["allow"] = self._exits(prep, T, V[samples]) + F["tolerance_mm"] / 1000
        return prep

    def _exits(self, prep: dict, P: np.ndarray, pts: np.ndarray) -> np.ndarray:
        """lib/glassesFit.ts exitOf for every tested point: how far it must go along its ray (front +z, arm ±x) to be
        out of the skin P; 0 when out (an even number of crossings ahead)."""
        out = np.zeros(len(pts))
        for s, (g, c) in enumerate(zip(prep["samples"], prep["cand"])):
            sd = prep["side"][g]
            k, i, j = (0, 1, 2) if sd else (2, 0, 1)
            tri = P[self.skin_tris[c]] - pts[s]  # (n, 3, 3) relative to the point
            a, b, e = tri[:, 0], tri[:, 1], tri[:, 2]
            w0 = b[:, i] * e[:, j] - b[:, j] * e[:, i]
            w1 = e[:, i] * a[:, j] - e[:, j] * a[:, i]
            w2 = a[:, i] * b[:, j] - a[:, j] * b[:, i]
            hit = ~(((w0 < 0) | (w1 < 0) | (w2 < 0)) & ((w0 > 0) | (w1 > 0) | (w2 > 0)))
            tot = w0 + w1 + w2
            hit &= tot != 0
            at = (w0 * a[:, k] + w1 * b[:, k] + w2 * e[:, k])[hit] / tot[hit]
            ahead = at * (sd or 1)
            ahead = ahead[ahead > 0]
            out[s] = ahead.min() if len(ahead) % 2 else 0.0
        return out

    def glasses_at(self, style: dict, w: np.ndarray) -> np.ndarray:
        """(V, 3) the frame on face w as the app draws it: its baked face-shape targets, then lib/glassesFit.ts (the
        frame slid forward and each arm opened, only as far as needed to be no deeper in than on the average face)."""
        F = GLASSES_FIT
        V, D, names = self._glasses(style["file"])
        tw = np.array([float(w[self.m.names.index(t)]) if t in self.m.names else 0.0 for t in names])
        X = V + (np.tensordot(tw, D, axes=1) if len(names) else 0)
        prep = self._fit_prep(style["file"])
        P = self.m.positions(np.where(self.shape_k, w, 0))  # the skin's shape (the fit ignores expressions)
        side, lever, smp, allow = prep["side"], prep["lever"], prep["samples"], prep["allow"]
        fr = side[smp] == 0
        seat = float(np.clip((self._exits(prep, P, X[smp]) - allow)[fr].max(initial=0.0), 0, F["max_seat_mm"] / 1000))
        need = (self._exits(prep, P, X[smp] + (0, 0, seat)) - allow) / np.where(fr, 1.0, np.abs(lever[smp]))
        splay = {sd: float(np.clip(need[side[smp] == sd].max(initial=0.0), 0, F["max_splay"])) for sd in (1, -1)}
        dx = lever * np.where(lever > 0, splay[1], splay[-1])
        return X + np.c_[dx, np.zeros(len(X)), np.full(len(X), seat)]

    def _measure_glasses(self, style: dict, w: np.ndarray) -> dict:
        X = self.glasses_at(style, w)
        P = self.m.positions(w)
        skin = Surface.build(P, self.ext_tris)
        eye = Surface.build(P, self.eye_tris)
        return {"sd": self._signed(skin, X), "eye": self._signed(eye, X)}

    def check_glasses(self, style: dict, w: np.ndarray, base_w: np.ndarray | None = None, base_key: str = "rest") -> dict:
        base, now = self._base_of("g", style, base_w, base_key), self._measure_glasses(style, w)
        deeper = np.maximum(-now["sd"], 0) - np.maximum(-base["sd"], 0)  # further into the skin than on the average face
        V = self._glasses(style["file"])[0]
        tucked = (self._fit_prep(style["file"])["side"] != 0) & (V[:, 2] <= (GLASSES_FIT["ear_root_z_mm"] - GLASSES_FIT["ear_band_mm"]) / 1000)
        deeper[tucked] = 0.0  # behind the ear root the tips may tuck in (real glasses; lib/glassesFit.ts)
        sinking = int(((now["sd"] < 0) & (deeper > GLASS_CLIP_MM)).sum())
        gap = float(np.abs(now["sd"]).min() - np.abs(base["sd"]).min())  # the frame's closest touch moved off the skin
        eye = float(now["eye"].min())
        out = {"clip_vertices": sinking, "clip_mm": float(deeper[now["sd"] < 0].max(initial=0.0)), "floating_mm": gap, "eye_gap_mm": eye,
               "where": worst_sinking(now["sd"], deeper),
               "fail": [k for k, bad in (("clipping", sinking >= 5), ("floating", gap > GLASS_FLOAT_MM), ("eye", eye < EYE_GAP_MM)) if bad]}
        return out

    def check(self, style: dict, w: np.ndarray, base_w: np.ndarray | None = None, base_key: str = "rest") -> dict:
        fn = self.check_glasses if style["kind"] == "glasses" else self.check_strands
        return fn(style, w, base_w, base_key)

    def points(self, style: dict, w: np.ndarray) -> np.ndarray:
        """The add-on's points on face w, for sheets (strands (n, P, 3); glasses (V, 3))."""
        if style["kind"] == "glasses":
            return self.glasses_at(style, w)
        return self.strands_at(style, w, self.m.positions(w))


def _yz(v: np.ndarray) -> np.ndarray:
    """A direction's angle about the head's x axis (lib/groom.ts yz)."""
    return np.arctan2(v[..., 1], v[..., 2])


def worst_sinking(sd: np.ndarray, deeper: np.ndarray) -> int:
    """Index of the worst sinking point (-1: none)."""
    bad = np.where(sd < 0, deeper, -np.inf)
    return int(bad.argmax()) if np.isfinite(bad).any() else -1
