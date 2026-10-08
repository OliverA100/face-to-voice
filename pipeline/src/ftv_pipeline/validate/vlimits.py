"""The web app's limiter, defined on real vertex positions (and its Python mirror, to measure it).

The limiter re-runs a small part of the exact checks (checks.py) on the vertices that can break, from the morph target
offsets the app already holds on the CPU (no extra download besides vertex ids):

  eyes      every outer-skin vertex that could reach an eyeball: how deep it is inside the visible eye, as in the
            exact check (closest point on the eye's triangles, inside = behind its normal), but only over a fixed set
            of candidate eye triangles around the vertex's direction from the pivot, chosen on the average face.
            Same rule as the exact check: broken past `eye_lids_hard_mm` anywhere, or `eye_lids_count` spots past
            `eye_lids_mm` off the lid edge. Each vertex is measured against its own depth on the average face.
  crossings the triangles that went through each other in any broken face the tests found: the exact check's own
            crossing test (checks.intersecting_pairs) among just those triangles, with its contact rules and graze
            depth rule (how far a triangle really passes through the other), stopping a little earlier
            (limiter_crossing_mm) than the exact check breaks (crossing_depth_mm).
  lips      one lip's inner edge past the other lip's outer edge (exact).

Adding a test only ever tightens the limiter, so `uv run validate --vlimits` iterates: every pair of Shape sliders is
pushed to where the limiter stops it, the exact checks look at that face, and any break found adds its crossing.
Pairs miss faces made with many sliders, so random multi-slider faces (Shape + Advanced head) follow, the same way,
with a fresh seed every pass until one comes back clean. Writes web/src/data/limits.json.
"""
from __future__ import annotations

import gzip
import json
import time
import tomllib
from concurrent.futures import ProcessPoolExecutor
from dataclasses import dataclass, field

import numpy as np
from scipy.spatial import cKDTree

from ..gnm import OUT_DIR, PIPELINE_DIR, REPO_DIR
from ..surface import closest_point_barycentric
from .checks import Checker, crossing_depth, intersecting_pairs
from .model import HeadModel
from .sweep import NOT_A_BREAK, SLIDER_BREAKS, candidate_ends

CONFIG = PIPELINE_DIR / "config" / "validation.toml"
OUT = OUT_DIR / "validation"
LIMITS_JSON = REPO_DIR / "web" / "src" / "data" / "limits.json"
CROSSINGS_JSON = PIPELINE_DIR / "config" / "limit_crossings.json"  # committed: the collected crossing pairs
THRU_NEIGHBOURS = 32  # eye_through: candidate skin triangles around each visible eye point's direction
EYE_NEIGHBOURS = 24  # candidate eye triangles around each skin vertex's direction (wide enough for the face to move)
REPORT_ONLY = (*NOT_A_BREAK, "eye_pivot")  # never a break here: eye_pivot is reported, the limiter does not guard it


@dataclass
class VLimits:
    model: HeadModel
    cfg: dict
    eye_skin: list[np.ndarray] = field(default_factory=list)  # per eye: outer-skin vertex ids
    eye_ring: list[np.ndarray] = field(default_factory=list)  # per eye: (n, K, 3) candidate eye triangles (vertex ids)
    eye_base: list[np.ndarray] = field(default_factory=list)  # per eye: depth on the average face, mm (≥ 0)
    eye_edge: list[np.ndarray] = field(default_factory=list)  # per eye: on the lid edge
    thru_pts: list[np.ndarray] = field(default_factory=list)  # per eye: visible eye points (eye_through)
    thru_cand: list[np.ndarray] = field(default_factory=list)  # per eye: (n, K, 3) candidate skin triangles (vertex ids)
    thru_base: list[np.ndarray] = field(default_factory=list)  # per eye: how far each sticks out on the average face, mm
    thru_edge: list[np.ndarray] = field(default_factory=list)  # per eye: (n, K) candidate is lid-edge skin
    tris: np.ndarray = field(default_factory=lambda: np.zeros(0, np.int64))  # indices into checker.cross_tris
    checker: Checker | None = None
    lips: tuple = ()

    @classmethod
    def build(cls, model: HeadModel, checker: Checker, cfg: dict) -> VLimits:
        c = cfg["checks"]
        vl = cls(model, cfg)
        vl.checker = checker
        T = model.gnm.template
        piv = model.pivots(np.zeros(len(model.names), np.float32))
        for e in range(2):
            tris = checker.shell_tris[e]
            eye = np.unique(tris)
            r = np.linalg.norm(T[eye] - piv[e], axis=1)
            near = checker.ext[np.linalg.norm(T[checker.ext] - piv[e], axis=1) < r.max() + float(c["eye_reach_mm"]) / 1000]
            cen = T[tris].mean(1) - piv[e]
            u = T[near] - piv[e]
            u /= np.linalg.norm(u, axis=1, keepdims=True)
            _, k = cKDTree(cen / np.linalg.norm(cen, axis=1, keepdims=True)).query(u, k=EYE_NEIGHBOURS)
            vl.eye_skin.append(near)
            vl.eye_ring.append(tris[k])
            vl.eye_edge.append(checker.lid_edge[near])
        vl.eye_base = [np.maximum(d, 0.0) for d in vl.eye_depths(T, piv)]
        # eye_through: per visible eye point, the outer skin triangles nearest its direction from the pivot
        for e in range(2):
            cand = thru_candidates(checker, T, piv, e)
            vl.thru_pts.append(checker.shell_v[e])
            vl.thru_cand.append(cand)
            vl.thru_edge.append(checker.lid_edge[cand].any(-1))
        vl.thru_base = vl.through(T, piv)
        up, lo = checker.stomion
        ls, li = checker.lip_outer
        vl.lips = (up, lo, ls, li)
        if CROSSINGS_JSON.exists():
            vl.add_tris(json.loads(CROSSINGS_JSON.read_text()))
        return vl

    # --- the tests (the web app runs the same arithmetic) ---------------------------------------------------------

    def eye_depths(self, P: np.ndarray, piv: np.ndarray) -> list[np.ndarray]:
        """Per eye: how deep each tested skin vertex is inside the visible eye (mm; < 0 outside): the closest point
        on its candidate triangles, inside = behind that triangle's normal; never deeper than the eye's radius allows."""
        out = []
        for e in range(2):
            p = P[self.eye_skin[e]][:, None, :]  # (n, 1, 3)
            tri = self.eye_ring[e]  # (n, K, 3)
            a, b, c = P[tri[..., 0]], P[tri[..., 1]], P[tri[..., 2]]
            bary = closest_point_barycentric(p, a, b, c)
            cp = bary[..., 0:1] * a + bary[..., 1:2] * b + bary[..., 2:3] * c
            d2 = ((cp - p) ** 2).sum(-1)
            k = d2.argmin(1)
            rows = np.arange(len(k))
            n = np.cross(b[rows, k] - a[rows, k], c[rows, k] - a[rows, k])
            n /= np.maximum(np.linalg.norm(n, axis=1, keepdims=True), 1e-18)
            depth = -np.einsum("ij,ij->i", p[:, 0] - cp[rows, k], n)
            radius = np.linalg.norm(P[np.unique(tri)] - piv[e], axis=1).max()
            outside = radius - np.linalg.norm(p[:, 0] - piv[e], axis=1)
            out.append(np.minimum(depth, outside) * 1000)
        return out

    def through(self, P: np.ndarray, piv: np.ndarray) -> list[np.ndarray]:
        """Per eye: how far (mm) each visible eye point sticks out through the skin (checks.Checker._eye_through, over
        its candidate triangles only)."""
        out = []
        clear = float(self.cfg["checks"]["eye_through_clearance_mm"]) / 1000
        for e in range(2):
            V = P[self.thru_pts[e]] - piv[e]
            L0 = np.linalg.norm(V, axis=1)
            D = V / L0[:, None]
            L = L0 + clear  # (checks._eye_through)
            t = ray_pairs(D, P[self.thru_cand[e]] - piv[e])  # (n, K)
            t = np.where(self.thru_edge[e], np.nan, t)  # lid-edge skin does not count (checks._eye_through)
            behind = np.nanmax(np.where(t < L[:, None], t, -np.inf), axis=1)
            out.append(np.where(np.isfinite(behind), (L - behind) * 1000, 0.0))
        return out

    def crossing(self, P: np.ndarray) -> tuple[float, float]:
        """(deepest tooth/tongue-through-skin, deepest skin-through-skin) among the collected triangles, mm."""
        if not len(self.tris):
            return 0.0, 0.0
        ch = self.checker
        sub = self.tris
        i, j = intersecting_pairs(P, ch.cross_tris[sub], float(self.cfg["checks"]["limiter_edge_tol"]))
        depth = crossing_depth(P, ch.cross_tris[sub], i, j)
        i, j = sub[i], sub[j]
        b = ch.base
        new = ~(b["contact"][i] & b["contact"][j]) & ~((ch.rim_zone[i] >= 0) & (ch.rim_zone[i] == ch.rim_zone[j]))
        inner, outer = ch.cross_inner, ch.cross_outer
        mouth = new & ((inner[i] & outer[j]) | (inner[j] & outer[i]))
        skin = new & ~(inner[i] | inner[j])
        return (float(depth[mouth].max()) if mouth.any() else 0.0), (float(depth[skin].max()) if skin.any() else 0.0)

    def broken(self, P: np.ndarray, piv: np.ndarray) -> dict[str, bool]:
        c = self.cfg["checks"]
        slack = float(c["eye_limiter_slack_mm"])  # < 0: a little inside the exact thresholds
        eyes = False
        for d, base, edge in zip(self.eye_depths(P, piv), self.eye_base, self.eye_edge):
            extra = d - base
            eyes |= bool((extra > c["eye_lids_hard_mm"] + slack).any()
                         or ((extra > c["eye_lids_mm"] + slack) & ~edge).sum() >= c["eye_lids_count"])
        up, lo, ls, li = self.lips
        through = max(P[lo].mean(0)[1] - P[ls].mean(0)[1], P[li].mean(0)[1] - P[up].mean(0)[1]) * 1000
        mouth, skin = self.crossing(P)
        lips_limit = c["lips_cross_mm"] + slack  # the same margin inside the exact check
        poke = any(bool(((t - b) > c["eye_through_mm"] + slack).any()) for t, b in zip(self.through(P, piv), self.thru_base))
        return {"eye_lids": eyes, "eye_through": poke, "lips_cross": through > lips_limit,
                "mouth_inside": mouth > c["limiter_crossing_mm"], "self_intersect": skin > c["limiter_crossing_mm"]}

    def ok(self, w: np.ndarray) -> bool:
        return not any(self.broken(self.model.positions(w), self.model.pivots(w)).values())

    def reach(self, w0: np.ndarray, d: np.ndarray, end: float, steps: int = 12) -> float:
        """How far along w0 + x·d (x from 0 toward `end`) the limiter lets a slider go: the last ok x."""
        if self.ok(w0 + end * d):
            return end
        lo, hi = 0.0, end
        if not self.ok(w0):
            return 0.0
        for _ in range(steps):
            mid = (lo + hi) / 2
            if self.ok(w0 + mid * d):
                lo = mid
            else:
                hi = mid
        return lo

    # --- growing the crossing set ------------------------------------------------------------------------------

    def add_tris(self, ids) -> int:
        """Add cross-triangle indices; returns how many were new."""
        before = len(self.tris)
        self.tris = np.union1d(self.tris, np.asarray(list(ids), np.int64))
        return len(self.tris) - before

    def tris_from_break(self, checker: Checker, P: np.ndarray, piv: np.ndarray) -> list[int]:
        """The triangles of every new crossing in a broken face (the exact check's own list), as cross_tris indices."""
        raw = checker._raw(P, piv)
        b = checker.base
        i, j = raw["cross"]
        new = ~(b["contact"][i] & b["contact"][j]) & ~((checker.rim_zone[i] >= 0) & (checker.rim_zone[i] == checker.rim_zone[j]))
        inner, outer = checker.cross_inner, checker.cross_outer
        keep = new & (((inner[i] & outer[j]) | (inner[j] & outer[i])) | ~(inner[i] | inner[j]))
        return grow_region(checker, set(i[keep].tolist()) | set(j[keep].tolist()))


REGION_MM = 2.0  # a crossing adds every triangle within this of it (on the average face): neighbours cross next


def grow_region(checker: Checker, ids: set[int]) -> list[int]:
    """The triangles within REGION_MM of `ids` (cross_tris indices), so a crossing's neighbours are covered too."""
    if not ids:
        return []
    if not hasattr(checker, "_cen_tree"):
        checker._cen0 = checker.model.gnm.template[checker.cross_tris].mean(1)
        checker._cen_tree = cKDTree(checker._cen0)
    out = set(ids)
    for hits in checker._cen_tree.query_ball_point(checker._cen0[sorted(ids)], REGION_MM / 1000):
        out.update(hits)
    return sorted(out)


def thru_candidates(ch: Checker, P: np.ndarray, piv: np.ndarray, e: int) -> np.ndarray:
    """(n, K, 3): per visible eye point of eye e, the outer skin triangles nearest its direction from the pivot."""
    tris = ch.through_tris[e]
    cen = P[tris].mean(1) - piv[e]
    u = P[ch.shell_v[e]] - piv[e]
    _, k = cKDTree(cen / np.linalg.norm(cen, axis=1, keepdims=True)).query(u / np.linalg.norm(u, axis=1, keepdims=True), k=THRU_NEIGHBOURS)
    return tris[k]


def _lid_animations(model: HeadModel) -> list[np.ndarray]:
    """Target weights of the animations that move the lids, on the average face: a full blink and each emotion."""
    roles = json.loads((REPO_DIR / "web" / "src" / "data" / "visemes.json").read_text())["roles"]
    out = [model.vector({k: v for k, v in {**roles["blinkLeft"], **roles["blinkRight"]}.items() if k in model.names})]
    emos = sorted({n.rsplit("_", 1)[0] for n in model.names if n.startswith("emo_")})
    out += [model.vector({f"{e}_upper": 1.0, f"{e}_lower": 1.0}) for e in emos]
    return out


def ray_pairs(D: np.ndarray, tri: np.ndarray) -> np.ndarray:
    """(n, K): distance along unit ray D[i] (from the origin) to each of its own K triangles tri[i] ((n, K, 3, 3)),
    nan where it misses (Möller–Trumbore, both faces)."""
    A, B, C = tri[..., 0, :], tri[..., 1, :], tri[..., 2, :]
    e1, e2 = B - A, C - A
    Dk = np.broadcast_to(D[:, None, :], e1.shape)
    h = np.cross(Dk, e2)
    a = (h * e1).sum(-1)
    ok = np.abs(a) > 1e-14
    f = np.where(ok, 1.0 / np.where(ok, a, 1.0), 0.0)
    s = -A
    u = f * (h * s).sum(-1)
    q = np.cross(s, e1)
    v = f * (Dk * q).sum(-1)
    t = f * (e2 * q).sum(-1)
    return np.where(ok & (u >= 0) & (v >= 0) & (u + v <= 1) & (t > 0), t, np.nan)


# --- parallel driver ----------------------------------------------------------------------------------------------

_ctx: dict = {}


def _init(tris: list) -> None:
    with open(CONFIG, "rb") as f:
        cfg = tomllib.load(f)
    model = HeadModel.load()
    checker = Checker(model, cfg)
    vl = VLimits.build(model, checker, cfg)
    vl.add_tris(tris)
    _ctx.update(model=model, checker=checker, vl=vl)


def _job(job: tuple) -> dict:
    """One (B at an end) row: every other Shape slider pushed to the limiter's reach, exact-checked."""
    b, b_end, shape = job
    m, ch, vl = _ctx["model"], _ctx["checker"], _ctx["vl"]
    w0 = m.vector(m.expand({b: b_end}))
    out = {"tested": 0, "broke": [], "rows": [], "stopped": 0}
    for a in shape:
        if a == b:
            continue
        for a_end in (m.sliders[a]["min"], m.sliders[a]["max"]):
            if abs(a_end) < 1e-6:
                continue
            d = m.vector(m.expand({a: a_end})) / a_end
            x = vl.reach(w0, d, a_end)
            out["stopped"] += x != a_end
            w = w0 + x * d
            P, piv = m.positions(w), m.pivots(w)
            res = ch.run(P, piv)
            out["tested"] += 1
            bad = [k for k, r in res.items() if r.fail and k not in REPORT_ONLY]
            if bad:
                out["broke"].append({"b": b, "b_end": b_end, "a": a, "x": x, "checks": bad})
                out["rows"] += vl.tris_from_break(ch, P, piv)
    return out


RAYS_SEED = 2026  # multi-slider pass k draws its faces with seed RAYS_SEED + k - 1: fresh faces every pass


def ray_faces(model: HeadModel, n: int, seed: int) -> list[dict]:
    """n random multi-slider faces: 3-8 Shape or Advanced head sliders, each at 50-100% of a random end."""
    pool = [t for t, s in model.sliders.items() if s.get("group") == "raw_head" or s["kind"] == "semantic"]
    rng = np.random.default_rng(seed)
    faces = []
    for _ in range(n):
        ts = rng.choice(pool, rng.integers(3, 9), replace=False)
        faces.append({t: float(model.sliders[t]["max"] if rng.random() < 0.5 else model.sliders[t]["min"])
                      * float(rng.uniform(0.5, 1)) for t in ts})
    return faces


def _ray_job(face: dict) -> dict:
    """One multi-slider face pushed from the average face to where the limiter stops it, exact-checked."""
    m, ch, vl = _ctx["model"], _ctx["checker"], _ctx["vl"]
    d = m.vector(m.expand(face))
    x = vl.reach(np.zeros_like(d), d, 1.0)
    w = x * d
    P, piv = m.positions(w), m.pivots(w)
    res = ch.run(P, piv)
    bad = [k for k, r in res.items() if r.fail and k not in REPORT_ONLY]
    out = {"stopped": x != 1.0, "broke": None, "rows": []}
    if bad:
        out["broke"] = {"face": face, "x": x, "checks": bad, "mm": {k: round(res[k].value, 3) for k in bad}}
        out["rows"] = vl.tris_from_break(ch, P, piv)
    return out


def seed_rows(model: HeadModel, checker: Checker, vl: VLimits) -> list:
    """Crossing triangles of every single-slider break (`uv run validate --sweep`): the starting set."""
    rows = []
    states = []
    sweep = OUT / "sweep.json"
    if sweep.exists():
        states += [{r["target"]: r["break"]} for r in json.loads(sweep.read_text()) if r["break"] is not None]
    seen = set()
    for s in states:
        key = tuple(sorted((k, round(v, 2)) for k, v in s.items()))
        if key in seen:
            continue
        seen.add(key)
        w = model.vector(model.expand(s))
        rows += vl.tris_from_break(checker, model.positions(w), model.pivots(w))
    print(f"seeded from {len(seen)} broken faces")
    return rows


def run(passes: int = 4, workers: int = 8, rays: int = 3000, ray_passes: int = 6) -> None:
    """`passes` over every pair of Shape sliders, then up to `ray_passes` of `rays` random multi-slider faces."""
    with open(CONFIG, "rb") as f:
        cfg = tomllib.load(f)
    model = HeadModel.load()
    checker = Checker(model, cfg)
    vl = VLimits.build(model, checker, cfg)
    if not len(vl.tris):
        vl.add_tris(seed_rows(model, checker, vl))
    shape = [t for t, s in model.sliders.items() if s["kind"] == "semantic"]
    jobs = [(b, e, shape) for b in shape for e in (model.sliders[b]["min"], model.sliders[b]["max"])]
    log = []
    for k in range(1, passes + 1):
        rows_now = vl.tris.tolist()
        t0 = time.time()
        with ProcessPoolExecutor(workers, initializer=_init, initargs=(rows_now,)) as pool:
            results = list(pool.map(_job, jobs))
        tested = sum(r["tested"] for r in results)
        broke = [x for r in results for x in r["broke"]]
        stopped = sum(r["stopped"] for r in results)
        added = vl.add_tris([t for r in results for t in r["rows"]])
        kinds = {}
        for x in broke:
            for c in x["checks"]:
                kinds[c] = kinds.get(c, 0) + 1
        line = (f"pass {k}: {tested} pairs, limiter stepped in on {stopped}, {len(broke)} still broken at its stop "
                f"{kinds}; +{added} triangles (total {len(vl.tris)}), {time.time() - t0:.0f} s")
        print(line, flush=True)
        log.append({"pass": k, "tested": tested, "stopped": stopped, "broke": broke, "added": added})
        save_crossings(vl)
        if not broke or (added == 0 and k > 1):
            break
    for k in range(1, ray_passes + 1 if rays else 1):
        seed = RAYS_SEED + k - 1
        t0 = time.time()
        with ProcessPoolExecutor(workers, initializer=_init, initargs=(vl.tris.tolist(),)) as pool:
            results = list(pool.map(_ray_job, ray_faces(model, rays, seed), chunksize=8))
        broke = [r["broke"] for r in results if r["broke"]]
        stopped = sum(r["stopped"] for r in results)
        added = vl.add_tris([t for r in results for t in r["rows"]])
        kinds = {}
        for x in broke:
            for c in x["checks"]:
                kinds[c] = kinds.get(c, 0) + 1
        deepest = max((v for x in broke for v in x["mm"].values()), default=0.0)
        line = (f"rays {k} (seed {seed}): {rays} multi-slider faces, limiter stepped in on {stopped}, {len(broke)} still "
                f"broken at its stop {kinds} (deepest {deepest:.2f} mm); +{added} triangles (total {len(vl.tris)}), "
                f"{time.time() - t0:.0f} s")
        print(line, flush=True)
        log.append({"rays": k, "seed": seed, "tested": rays, "stopped": stopped, "broke": broke, "added": added})
        save_crossings(vl)
        if not broke:  # a fresh set of faces came back clean
            break
    (OUT / "vlimits_log.json").write_text(json.dumps(log, indent=1))
    export(vl)


def save_crossings(vl: VLimits) -> None:
    CROSSINGS_JSON.write_text(json.dumps(vl.tris.tolist(), separators=(",", ":")) + "\n")


def export(vl: VLimits) -> dict:
    """web/src/data/limits.json: the vertices to read (part + index in head.glb) and the tests on them."""
    from .glbmap import vertex_map

    ch = vl.checker
    extra = [[], []]
    for w in _lid_animations(vl.model):
        T, piv = vl.model.positions(w), vl.model.pivots(w)
        for e in range(2):
            extra[e].append(thru_candidates(ch, T, piv, e))
    tri_v = ch.cross_tris[vl.tris]
    # eye_through: only the skin triangles that some visible eye point picks as a candidate (the app picks among these),
    # on the average face at rest and doing each animation that moves the lids (a blink, every emotion): the app picks
    # again on the average face doing the animation it is testing (Limiter.caps)
    thru = [np.unique(np.concatenate([c.reshape(-1, 3), *[x.reshape(-1, 3) for x in extra[e]]]), axis=0)
            for e, c in enumerate(vl.thru_cand)]
    ids = np.unique(np.concatenate([*vl.eye_skin, *[t.ravel() for t in ch.shell_tris], tri_v.ravel(), *ch.shell_v,
                                    *[t.ravel() for t in thru], *[np.asarray(x) for x in vl.lips]]))
    vmap = vertex_map(vl.model, ids)
    at = {int(v): k for k, v in enumerate(ids.tolist())}
    idx = lambda arr: [at[int(v)] for v in np.asarray(arr).ravel().tolist()]  # noqa: E731
    parts = sorted({p for p, _ in vmap.values()})
    c = vl.cfg["checks"]
    doc = {
        "note": "generated by `uv run validate --vlimits` (pipeline/src/ftv_pipeline/validate/vlimits.py)",
        "version": 2,
        "thresholds": {**{k: c[k] for k in ("eye_lids_mm", "eye_lids_hard_mm", "eye_lids_count", "eye_limiter_slack_mm",
                                             "eye_through_mm", "eye_through_clearance_mm", "limiter_crossing_mm", "limiter_edge_tol")},
                       "lips_cross_mm": c["lips_cross_mm"] + float(c["eye_limiter_slack_mm"])},  # with the limiter's margin
        "parts": parts,
        "vertices": {"part": [parts.index(vmap[int(v)][0]) for v in ids], "index": [vmap[int(v)][1] for v in ids]},
        # per eye: the visible eye's triangles; the app picks each skin vertex's k candidates itself (nearest by
        # direction from the pivot on the average face, as VLimits.build does), which keeps this file small
        # eye_through: the outer skin around each eye that eye points pick as candidates (throughEdge: which of those are
        # lid edge, which does not count); the app picks each visible eye point's thruK of them itself, as build does
        "eyes": [{"skin": idx(vl.eye_skin[e]), "tris": idx(ch.shell_tris[e]), "k": EYE_NEIGHBOURS,
                  "base": [round(float(x), 3) for x in vl.eye_base[e]], "edge": vl.eye_edge[e].astype(int).tolist(),
                  "through": idx(thru[e]), "throughPts": idx(ch.shell_v[e]), "throughEdge": np.flatnonzero(ch.lid_edge[thru[e]].any(1)).tolist(), "thruK": THRU_NEIGHBOURS}
                 for e in range(2)],
        # crossing test: the triangles, and per triangle: inner (tooth/gum/tongue), outer skin, contact zone id
        # (-1 none; same zone = touching is fine), touches itself on the average face (both such = fine)
        "cross": {"tris": idx(tri_v), "inner": ch.cross_inner[vl.tris].astype(int).tolist(),
                  "outer": ch.cross_outer[vl.tris].astype(int).tolist(), "zone": ch.rim_zone[vl.tris].astype(int).tolist(),
                  "contact": ch.base["contact"][vl.tris].astype(int).tolist()},
        "lips": {k: idx(v) for k, v in zip(("up", "lo", "ls", "li"), vl.lips)},
    }
    LIMITS_JSON.write_text(json.dumps(doc, separators=(",", ":")) + "\n")
    size = LIMITS_JSON.stat().st_size
    gz = len(gzip.compress(LIMITS_JSON.read_bytes()))
    print(f"limits.json: {len(ids)} vertices, {len(vl.tris)} crossing triangles, {size / 1024:.0f} KB ({gz / 1024:.0f} KB gzip)")
    return doc


# --- slider ends inside the limiter ----------------------------------------------------------------------------------


def _end_job(job: tuple) -> tuple:
    target, end = job
    m, vl = _ctx["model"], _ctx["vl"]
    d = m.vector(m.expand({target: end})) / end
    return job, vl.reach(m.vector({}), d, end)


def limiter_ends(workers: int = 8, margin: float | None = None) -> dict:
    """Pull every slider end in to where the limiter itself stops that slider alone (it is a little stricter than
    the exact checks the sweep used), so no slider end is a face the limiter calls broken. Updates
    config/slider_breaks.json (sliders_json.py applies it)."""
    if margin is None:  # the same share short of the limit as the sweep keeps short of a break
        with open(CONFIG, "rb") as f:
            margin = float(tomllib.load(f)["sweep"]["margin"])
    m = HeadModel.load()
    breaks = json.loads(SLIDER_BREAKS.read_text()) if SLIDER_BREAKS.exists() else {}
    jobs = []
    for t, (lo, hi) in candidate_ends(m).items():
        for side, e in (("min", lo), ("max", hi)):
            cur = breaks.get(t, {}).get(side, {}).get("end", e)
            if abs(cur) > 1e-6:
                jobs.append((t, cur))
    rows = json.loads(CROSSINGS_JSON.read_text()) if CROSSINGS_JSON.exists() else []
    with ProcessPoolExecutor(workers, initializer=_init, initargs=(rows,)) as pool:
        got = list(pool.map(_end_job, jobs))
    pulled = 0
    for (t, end), x in got:
        if abs(x) < abs(end) - 1e-9:
            side = "min" if end < 0 else "max"
            entry = breaks.setdefault(t, {}).setdefault(side, {})
            entry["end"] = round(x * (1 - margin), 3)
            entry["limiter"] = True
            pulled += 1
            print(f"  {m.sliders[t]['name']:24s} {side}: {end:+.2f} -> {entry['end']:+.2f} (the limiter stops it here)")
    SLIDER_BREAKS.write_text(json.dumps(breaks, indent=1) + "\n")
    print(f"limiter ends: {pulled} of {len(jobs)} slider ends pulled in")
    return breaks

