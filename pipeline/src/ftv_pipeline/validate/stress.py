"""The stress test. Measure-only: nothing grows, nothing changes; every face is exact-checked (checks.py).

    uv run validate --stress [--quick] [--vision]

The web app makes the faces it alone can make (web/scripts/stress-states.mjs, headless Chrome on a running app: its
own limiter, Random face, Random character, emotion, blink, visemes, gaze and animation caps); the pipeline makes the rest
with the limiter's mirror (vlimits.py). Families:

  single   every slider alone at both of its shipped ends
  pairs    every Shape slider at an end × every other Shape slider pushed to where the limiter stops it
  rays     random 3–8-slider faces pushed to where the limiter stops them (held-out seed; the known ~0.1% gap)
  random   Random face at Distinctiveness 0.5–2.5 and Random character, as the app made them
  anim     extreme identities × every emotion, blink, viseme and gaze limit, as the app shows them (caps applied).
           Broken only where worse than the average face with the same animation (GNM's own blink already sinks
           the lid edge); animations the caps hold below full strength are listed apart
  fx       extreme identities × each fine-tune / Advanced expression slider pushed to where the limiter stops it
  addons   shape-extreme heads × every hair, eyebrow, eyelash, beard and glasses style (addons_check.py); brows and
           lashes also with 4 emotions and a blink

Writes out/validation/stress.md, stress.json and sheets/ (worst offenders and random controls, failing spot marked).
Never samples or reports by ethnicity or race: identities come from slider ends, the model's own statistics and the
app's own Random face.
"""
from __future__ import annotations

import json
import random as pyrandom
import subprocess
import time
import tomllib
from concurrent.futures import ProcessPoolExecutor
from pathlib import Path

import numpy as np

from ..gnm import REPO_DIR
from . import vlimits
from .checks import Checker
from .model import HeadModel
from .sweep import OUT, SWEPT_KINDS
from .vlimits import CONFIG, REPORT_ONLY, VLimits

IDENTITIES = OUT / "stress_identities.json"
STATES = OUT / "stress_states.json"
SHEETS = OUT / "sheets"
RAYS_SEED = 501  # held out: the limiter is grown on seeds 2026–2031 (vlimits.RAYS_SEED, one per pass)
ID_RAYS_SEED = 502  # the extreme multi-slider identities (held out too)
FX_WORSE_MM = 0.05  # fx on a face already past a limit at rest: broken only where the slider makes it this much worse
# an animation is broken on a face only if worse than on the average face by more than this: up to ~0.5 mm worse is
# not visible, and the app's animation caps use the same allowance
ANIM_WORSE_MM = 0.5
# shape-extreme heads for the add-ons: slider ends that move the scalp, ears, brows, eyes and face outline
ADDON_ENDS = [("sem_head_size", -1), ("sem_head_size", 1), ("sem_head_width", -1), ("sem_head_width", 1),
              ("sem_head_length", -1), ("sem_head_length", 1), ("sem_neck_thickness", 1), ("sem_ear_size", 1),
              ("sem_ear_protrusion", 1), ("sem_eye_depth", -1), ("sem_eye_depth", 1), ("sem_eye_spacing", -1),
              ("sem_eye_spacing", 1), ("sem_cheekbones", 1), ("sem_brow_height", -1)]
ADDON_ANIMS = ["emotion:happy@1", "emotion:angry@1", "emotion:surprised@1", "emotion:sad@1", "blink@1"]

_ctx: dict = {}


def _cfg() -> dict:
    with open(CONFIG, "rb") as f:
        return tomllib.load(f)


def _init() -> None:
    m, cfg = HeadModel.load(), _cfg()
    ch = Checker(m, cfg)
    _ctx.update(m=m, ch=ch, vl=VLimits.build(m, ch, cfg))


def weights(m: HeadModel, w: dict, effective: bool = False) -> np.ndarray:
    """A state's weights -> target vector. Slider values (mix sliders included) are spread like the store does;
    `effective` weights already are per target (anything that is not a morph target, e.g. a mix slider, is skipped)."""
    if effective:
        return m.vector({k: v for k, v in w.items() if k in m.names})
    return m.vector(m.expand({k: v for k, v in w.items() if k in m.names or k in m.sliders}))


def gaze_rot(yaw: float, pitch: float) -> np.ndarray:
    """(2, 3, 3) eye rotations: yaw about y, then pitch about x (pitch > 0 looks down), as IdleLife turns the eyes."""
    a, b = np.radians(yaw), np.radians(pitch)
    ry = np.array([[np.cos(a), 0, np.sin(a)], [0, 1, 0], [-np.sin(a), 0, np.cos(a)]])
    rx = np.array([[1, 0, 0], [0, np.cos(b), -np.sin(b)], [0, np.sin(b), np.cos(b)]])
    return np.stack([ry @ rx] * 2)


def _check(job: dict) -> dict:
    """Exact checks on one face: {id, values {check: mm}, fail [checks], where (vertex)}."""
    m, ch = _ctx["m"], _ctx["ch"]
    w = job["w"] if isinstance(job["w"], np.ndarray) else weights(m, job["w"], job.get("effective", False))
    g = job.get("gaze") or [0, 0]
    P = m.positions(w, gaze=gaze_rot(*g)) if any(g) else m.positions(w)
    piv = m.pivots(w)
    back = job.get("retract")  # a blink on this face draws the eyeballs back (Head.tsx drawEyesBack), metres per eye
    if back and any(back):
        P = P.copy()
        piv = piv.copy()
        for e in range(2):
            P[m.eye == e, 2] -= back[e]
            piv[e, 2] -= back[e]
    res = ch.run(P, piv)
    fail = [k for k, r in res.items() if r.fail and k not in REPORT_ONLY]
    worst = max(fail, key=lambda k: res[k].value, default=None)
    return {"family": job["family"], "id": job["id"], "values": {k: round(float(r.value), 3) for k, r in res.items()},
            "fail": fail, "report": [k for k, r in res.items() if r.fail and k in REPORT_ONLY],
            "where": res[worst].where if worst else -1}


def _fx(job: tuple) -> list[dict]:
    """One identity × every fine-tune / Advanced expression slider, each end pushed to the limiter's stop."""
    ident, w0_list, sliders = job
    m, vl = _ctx["m"], _ctx["vl"]
    w0 = np.asarray(w0_list, np.float32)
    # a face already past a limit at rest is reported by its own family; here only what a slider makes worse counts
    r0 = _check({"family": "fx", "id": f"{ident}|rest", "w": w0})
    out = []
    for t in sliders:
        for end in (m.sliders[t]["min"], m.sliders[t]["max"]):
            if abs(end) < 1e-6:
                continue
            d = m.vector(m.expand({t: end})) / end
            x = vl.reach(w0, d, end)
            r = _check({"family": "fx", "id": f"{ident}|{t}@{end:+.2f}", "w": w0 + x * d})
            r["fail"] = [k for k in r["fail"] if k not in r0["fail"] or r["values"][k] > r0["values"][k] + FX_WORSE_MM]
            r["stopped"] = abs(x - end) > 1e-6
            r["weights"] = {n: float(v) for n, v in zip(m.names, w0 + x * d) if v}
            out.append(r)
    return out


# --- identities (the extreme faces the app animates) -------------------------------------------------------------


def make_identities(m: HeadModel, quick: bool, workers: int) -> list[dict]:
    ends = lambda t, s: m.sliders[t]["max"] if s > 0 else m.sliders[t]["min"]  # noqa: E731
    ids = [{"id": "average", "sliders": {}, "addons": True}]
    for t, s in ADDON_ENDS:
        ids.append({"id": f"{t}{'+' if s > 0 else '-'}", "sliders": {t: ends(t, s)}, "addons": True})
    # the app's own Random face at the maximum Distinctiveness
    ids += [{"id": f"random-D2.5-{k}", "random": {"seed": 90000 + k, "level": 2.5}, "addons": True} for k in range(4)]
    # single sliders whose shipped end sits closest to where they break
    sweep = {(r["target"], np.sign(r["end"])): r for r in json.loads((OUT / "sweep.json").read_text()) if r["break"]}
    near = []
    for t, s in m.sliders.items():
        if s["kind"] not in ("semantic", "identity"):
            continue
        for side in (-1, 1):
            r = sweep.get((t, side))
            end = ends(t, side)
            if r and end and not any(i["sliders"] == {t: end} for i in ids if "sliders" in i):
                near.append((abs(end / r["break"]), t, end))
    for _, t, end in sorted(near, reverse=True)[:8]:
        ids.append({"id": f"{t}@{end:+.2f}", "sliders": {t: end}})
    # multi-slider faces at the limiter's stop (held-out seed), the most extreme of 200
    faces = vlimits.ray_faces(m, 200, ID_RAYS_SEED)
    with ProcessPoolExecutor(workers, initializer=vlimits._init, initargs=([],)) as pool:
        xs = list(pool.map(_reach_ray, faces, chunksize=4))
    size = [x * np.sqrt(sum((v / max(abs(m.sliders[t]["min"]), m.sliders[t]["max"])) ** 2 for t, v in f.items())) for f, x in zip(faces, xs)]
    ids += [{"id": f"ray-{ID_RAYS_SEED}-{k}", "sliders": {t: v * xs[k] for t, v in faces[k].items()}}
            for k in np.argsort(size)[::-1][:8]]
    if quick:  # the average face, a few add-on heads, the Random faces and the most extreme multi-slider faces
        keep = {"average", "sem_head_size+", "sem_head_width-", "sem_ear_protrusion+", "sem_eye_spacing+", "sem_eye_depth+"}
        rays = [i for i in ids if i["id"].startswith("ray-")][:4]
        ids = [i for i in ids if i["id"] in keep or i["id"] in ("random-D2.5-0", "random-D2.5-1")] + rays
    return ids


def _reach_ray(face: dict) -> float:
    m, vl = vlimits._ctx["model"], vlimits._ctx["vl"]
    d = m.vector(m.expand(face))
    return float(vl.reach(np.zeros_like(d), d, 1.0))


# --- the families -------------------------------------------------------------------------------------------------


def _pool(fn, jobs, workers, init=_init, initargs=(), chunksize=4):
    with ProcessPoolExecutor(workers, initializer=init, initargs=initargs) as pool:
        return list(pool.map(fn, jobs, chunksize=chunksize))


def fam_single(m: HeadModel, workers: int) -> list[dict]:
    jobs = [{"family": "single", "id": f"{t}@{e:+.2f}", "w": {t: e}}
            for t, s in m.sliders.items() if s["kind"] in SWEPT_KINDS for e in (s["min"], s["max"]) if abs(e) > 1e-6]
    return _pool(_check, jobs, workers)


def fam_pairs(m: HeadModel, quick: bool, workers: int) -> tuple[list[dict], dict]:
    shape = [t for t, s in m.sliders.items() if s["kind"] == "semantic"]
    rows = [(b, e, shape) for b in shape for e in (m.sliders[b]["min"], m.sliders[b]["max"]) if abs(e) > 1e-6]
    if quick:
        rows = pyrandom.Random(3).sample(rows, 8)
    res = _pool(vlimits._job, rows, workers, vlimits._init, ([],), chunksize=1)
    out = [{"family": "pairs", "id": f"{x['b']}@{x['b_end']:+.2f} + {x['a']}×{x['x']:+.2f}", "fail": x["checks"],
            "values": {}, "where": -1, "face": {x["b"]: x["b_end"], x["a"]: x["x"]}} for r in res for x in r["broke"]]
    return out, {"tested": sum(r["tested"] for r in res), "stopped": sum(r["stopped"] for r in res)}


def fam_rays(m: HeadModel, quick: bool, workers: int) -> tuple[list[dict], dict]:
    faces = vlimits.ray_faces(m, 500 if quick else 3000, RAYS_SEED)
    res = _pool(vlimits._ray_job, faces, workers, vlimits._init, ([],), chunksize=8)
    out = []
    for k, r in enumerate(res):
        if r["broke"]:
            b = r["broke"]
            out.append({"family": "rays", "id": f"ray-{RAYS_SEED}-{k}", "fail": b["checks"], "values": b["mm"], "where": -1,
                        "face": {t: v * b["x"] for t, v in b["face"].items()}})
    return out, {"tested": len(faces), "stopped": sum(r["stopped"] for r in res)}


def fam_states(m: HeadModel, states: list[dict], workers: int) -> list[dict]:
    jobs = [{"family": s["family"], "id": s["id"], "w": s["weights"], "effective": s.get("effective", False),
             "gaze": s.get("gaze"), "retract": _retract(s, states)} for s in states]
    # a Random character wears an emotion: its reference is the average face with the same emotion and expression weights
    anim_kinds = {n for n, k in zip(m.names, m.kinds) if k in ("emotion", "expression")}
    refs = [{"family": "ref", "id": s["id"], "w": {k: v for k, v in s["weights"].items() if k in anim_kinds},
             "effective": True} for s in states if s["family"] == "character"]
    res = _pool(_check, jobs + refs, workers, chunksize=8)
    res, ref = res[:len(jobs)], {r["id"]: r for r in res[len(jobs):]}
    for r, s in zip(res, states):
        r.update({k: s[k] for k in ("identity", "anim", "level", "fit", "caps") if k in s})
        if r["id"] in ref:
            b = ref[r["id"]]
            r["raw_fail"] = list(r["fail"])
            r["fail"] = [k for k in r["fail"] if r["values"][k] > b["values"][k] + ANIM_WORSE_MM]
    return res


_ROLES = json.loads((REPO_DIR / "web" / "src" / "data" / "visemes.json").read_text())["roles"]
_rest_cache: dict = {}


def _retract(s: dict, states: list[dict]) -> list[float] | None:
    """How far (m) each eyeball is drawn back in an app state: the face's blink pull-back at each blink stage (caps
    blinkRetract25 … 100, mm), at how closed each eye is (blink and lid-follow layers on the blink targets, beyond the
    face at rest)."""
    caps = s.get("caps") or {}
    stages = [(0.0, 0.0)] + [(st, caps.get(f"blinkRetract{round(st * 100)}", 0) or 0) for st in (0.25, 0.5, 0.75, 1.0)]
    if not any(r for _, r in stages) or s.get("family") != "anim":
        return None
    if not _rest_cache:
        _rest_cache.update({x["identity"]: x["weights"] for x in states if x.get("family") == "anim" and x.get("anim") == "rest"})
    rest = _rest_cache.get(s["identity"], {})
    out = []
    for role in ("blinkLeft", "blinkRight"):
        closed = max(((s["weights"].get(t, 0) - rest.get(t, 0)) / wt for t, wt in _ROLES[role].items()), default=0.0)
        c = min(1.0, max(0.0, closed))  # lib/morphs/animCaps.ts blinkRetractMm: between the solved stages
        out.append(float(np.interp(c, [x for x, _ in stages], [r for _, r in stages])) / 1000)
    return out


def anim_verdict(rows: list[dict]) -> None:
    """Animation states: a failing check only counts where worse than the average face with the same animation."""
    ref = {r["anim"]: r for r in rows if r.get("identity") == "average"}
    for r in rows:
        base = ref.get(r["anim"])
        r["raw_fail"] = list(r["fail"])
        if r.get("identity") == "average":
            r["fail"] = []  # the reference itself: what GNM's own animation does (listed under notes)
            continue
        if base is None:
            continue
        r["fail"] = [k for k in r["fail"] if r["values"][k] > base["values"][k] + ANIM_WORSE_MM]


def fam_fx(m: HeadModel, identities: list[dict], rest: dict, quick: bool, workers: int) -> list[dict]:
    sliders = [t for t, s in m.sliders.items() if s["kind"] in ("control", "expression")]
    if quick:
        sliders = pyrandom.Random(4).sample(sliders, 12)
    jobs = [(i["id"], rest[i["id"]].tolist(), sliders) for i in identities if i["id"] in rest]
    return [r for rows in _pool(_fx, jobs, workers, chunksize=1) for r in rows]


_actx: dict = {}


def _addon_init() -> None:
    from .addons_check import AddonChecker

    m = HeadModel.load()
    a = AddonChecker(m)
    _actx.update(m=m, a=a)


def _addon_job(job: tuple) -> list[dict]:
    style, heads = job
    a = _actx["a"]
    out = []
    for hid, w, key, base_w in heads:
        r = a.check(style, np.asarray(w, np.float32), np.asarray(base_w, np.float32), key)
        out.append({"family": "addons", "id": f"{style['category']}:{style['id']}|{hid}|{key}", "style": style,
                    "head": hid, "anim": key, "fail": r.pop("fail"), "values": {k: round(float(v), 3) for k, v in r.items()
                                                                             if isinstance(v, (int, float)) and k != "where"}, "where": r.get("where", -1)})
    return out


def fam_addons(m: HeadModel, identities: list[dict], by_state: dict, quick: bool, workers: int) -> list[dict]:
    from .addons_check import styles

    heads = [i["id"] for i in identities if i.get("addons")]
    avg = lambda anim: by_state[("average", anim)]  # noqa: E731
    jobs = []
    for st in styles():
        anims = ["rest"] + (ADDON_ANIMS if st["category"] in ("eyebrows", "eyelashes") else [])
        hs = [(h, by_state[(h, an)].tolist(), an, avg(an).tolist()) for h in heads for an in anims
              if (h, an) in by_state and ("average", an) in by_state]
        jobs.append((st, hs))
    if quick:  # every eyebrow, eyelash and glasses style; a sample of hair and beards
        r = pyrandom.Random(5)
        jobs = [j for j in jobs if j[0]["category"] in ("eyebrows", "eyelashes", "glasses") or r.random() < 0.15]
    return [x for rows in _pool(_addon_job, jobs, workers, _addon_init, chunksize=1) for x in rows]


# --- report -------------------------------------------------------------------------------------------------------


FAMILY_TITLES = {"single": "Single sliders at both ends", "pairs": "Pairs (Shape × Shape at the limiter's stop)",
                 "rays": "Multi-slider faces at the limiter's stop (known gap)", "random": "Random face (Distinctiveness 0.5–2.5)",
                 "character": "Random character", "anim": "Extreme faces × animation", "fx": "Extreme faces × fine-tune / expression sliders",
                 "addons": "Add-ons on extreme heads"}


# the value that measures each add-on check (the face checks are named by their own value)
ADDON_VALUE = {"clipping": "clip_mm", "eye": "eye_gap_mm", "floating": "floating_mm"}


def summarise(rows: list[dict], family: str, tested: int | None = None) -> dict:
    fam = [r for r in rows if r["family"] == family]
    tested = tested if tested is not None else len(fam)
    broken = [r for r in fam if r["fail"]]
    checks: dict[str, list] = {}
    for r in broken:
        for k in r["fail"]:
            checks.setdefault(k, []).append(r)
    val = lambda x, k: x["values"].get(ADDON_VALUE.get(k, k) if family == "addons" else k, 0.0)  # noqa: E731
    per = {k: {"n": len(v), "worst": max((val(x, k) for x in v), default=0.0),
               "worst_id": max(v, key=lambda x: val(x, k))["id"]} for k, v in checks.items()}
    report = {}
    for r in fam:
        for k in r.get("report", []):
            report[k] = report.get(k, 0) + 1
    return {"family": family, "tested": tested, "broken": len(broken), "checks": per, "report_only": report}


def write_report(summary: list[dict], rows: list[dict], extra: dict, path: Path) -> None:
    L = ["# Stress test", "", f"{extra['when']} · {'quick' if extra['quick'] else 'full'} run · {extra['seconds']:.0f} s", "",
         "Every face is exact-checked (checks.py: eyes vs lids, mouth inside, lips crossing, skin crossing itself).",
         "Values are mm beyond the average face. Broken = at least one check fails.", "",
         "| Family | Tested | Broken | Share | By check (count, worst mm, worst state) | Report-only |", "|---|---:|---:|---:|---|---|"]
    for s in summary:
        share = s["broken"] / max(1, s["tested"])
        by = "<br>".join(f"{k}: {v['n']}, {v['worst']:.2f} mm, `{v['worst_id']}`" for k, v in sorted(s["checks"].items())) or "—"
        rep = ", ".join(f"{k} {n}" for k, n in sorted(s["report_only"].items())) or "—"
        L.append(f"| {FAMILY_TITLES[s['family']]} | {s['tested']} | {s['broken']} | {share:.2%} | {by} | {rep} |")
    for k, v in extra.get("notes", {}).items():
        L += ["", f"**{k}.** {v}"]
    caps = extra.get("caps", [])
    L += ["", "## Animations the caps hold back", "",
          "Per face, an animation the limiter caps below full strength (1 = no cap). Not failures: the face is kept "
          "unbroken by easing the animation off. Candidates for corrective shapes.", ""]
    if caps:
        L += ["| Identity | Capped (value) |", "|---|---|"]
        L += [f"| `{c['identity']}` | {', '.join(f'{k} {v:.2f}' for k, v in sorted(c['caps'].items()))} |" for c in caps]
    else:
        L.append("None.")
    addons = [r for r in rows if r["family"] == "addons" and r["fail"]]
    L += ["", "## Add-on failures by style", ""]
    if addons:
        by: dict[str, list] = {}
        for r in addons:
            by.setdefault(f"{r['style']['category']}:{r['style']['id']}", []).append(r)
        L += ["| Style | Heads × animations failing | Checks | Worst |", "|---|---:|---|---|"]
        for k, v in sorted(by.items(), key=lambda kv: -len(kv[1])):
            checks = sorted({c for r in v for c in r["fail"]})
            w = max(v, key=lambda r: r["values"].get("clip_mm", 0) + r["values"].get("floating_mm", 0))
            L.append(f"| {k} | {len(v)} | {', '.join(checks)} | `{w['head']}|{w['anim']}` "
                     f"clip {w['values'].get('clip_mm', 0):.1f} mm, float {w['values'].get('floating_mm', 0):.1f} mm |")
    else:
        L.append("None.")
    L += ["", "## Sheets", ""] + [f"- `{p.relative_to(OUT)}`" for p in extra.get("sheets", [])]
    if extra.get("vision"):
        L += ["", "## Vision review (claude-opus-5-5)", ""] + extra["vision"]
    path.write_text("\n".join(L) + "\n")


# --- sheets -------------------------------------------------------------------------------------------------------


def face_sheets(m: HeadModel, entries: list[dict], name: str, size: int = 230) -> list[Path]:
    """Front, ¾ and profile of each face, the failing spot in red; two faces per row, 10 per sheet."""
    from PIL import Image, ImageDraw, ImageFont

    from ..render import FRAMING
    from .sheets import renderer

    if not entries:
        return []
    font = ImageFont.load_default(size=14)
    r = renderer(m.gnm, size)
    tile = SHEETS / "_tile.png"
    paths = []
    focal, dist = FRAMING["head"]
    for s0 in range(0, len(entries), 10):
        chunk = entries[s0:s0 + 10]
        rows = (len(chunk) + 1) // 2
        sheet = Image.new("RGB", (6 * size, rows * (size + 40)), "#1f1f1f")
        d = ImageDraw.Draw(sheet)
        for i, e in enumerate(chunk):
            w = e["w"]
            g = e.get("gaze") or [0, 0]
            P = m.positions(w, gaze=gaze_rot(*g)) if any(g) else m.positions(w)
            r.set_positions(P)
            r.clear_overlays()
            if e.get("where", -1) >= 0:
                r.add_points(P[[e["where"]]], "#ff2020", size=14)
            x0, y0 = (i % 2) * 3 * size, (i // 2) * (size + 40)
            for c, yaw in enumerate((0.0, 35.0, 90.0)):
                r.look(focal, dist * 0.9, yaw)
                r.screenshot(tile)
                sheet.paste(Image.open(tile).convert("RGB"), (x0 + c * size, y0))
            label = e["label"]
            d.text((x0 + 6, y0 + size + 2), label[:95], fill="white", font=font)
            d.text((x0 + 6, y0 + size + 20), label[95:190], fill="#cfcfcf", font=font)
        p = SHEETS / f"{name}_{s0 // 10 + 1}.png"
        sheet.save(p)
        paths.append(p)
    tile.unlink(missing_ok=True)
    return paths


def addon_sheets(m: HeadModel, entries: list[dict], name: str, size: int = 240) -> list[Path]:
    """Add-on failures: the add-on drawn over the head (strands as lines, glasses as points), worst spot in red.
    Per entry: the average face with the same add-on and animation, then this face from the front and the side;
    brows and lashes close up on the worst spot."""
    from PIL import Image, ImageDraw, ImageFont

    from ..render import FRAMING
    from .addons_check import AddonChecker
    from .sheets import renderer

    if not entries:
        return []
    font = ImageFont.load_default(size=13)
    a = AddonChecker(m)
    r = renderer(m.gnm, size)
    pv = r.pv
    tile = SHEETS / "_tile.png"
    paths = []

    def draw(w, st, where):
        r.set_positions(m.positions(w))
        r.clear_overlays()
        X = a.points(st, w)
        if X.ndim == 3:
            N, Pn, _ = X.shape
            keep = np.arange(N)[:: max(1, N // 3000)]
            pts = X[keep].reshape(-1, 3)
            cells = np.hstack([np.full((len(keep), 1), Pn), np.arange(len(keep) * Pn).reshape(len(keep), Pn)]).ravel()
            r._overlays.append(r.plotter.add_mesh(pv.PolyData(pts, lines=cells), color="#3a2414", line_width=1.5))
            flat = X.reshape(-1, 3)
        else:
            r._overlays.append(r.plotter.add_mesh(pv.PolyData(X.astype(np.float32)), color="#3050c0", point_size=2))
            flat = X
        if where >= 0:
            r.add_points(flat[[where]], "#ff2020", size=10)
        return flat

    for s0 in range(0, len(entries), 8):
        chunk = entries[s0:s0 + 8]
        rows = (len(chunk) + 1) // 2
        sheet = Image.new("RGB", (6 * size, rows * (size + 40)), "#1f1f1f")
        d = ImageDraw.Draw(sheet)
        for i, e in enumerate(chunk):
            st = e["style"]
            x0, y0 = (i % 2) * 3 * size, (i // 2) * (size + 40)
            close = st["category"] in ("eyebrows", "eyelashes")
            flat = draw(e["w"], st, e.get("where", -1))
            if close:
                focal = tuple(flat[e["where"]]) if e.get("where", -1) >= 0 else FRAMING["eyes"][0]
                views = [(focal, 0.09, 0.0), (focal, 0.09, 0.0), (focal, 0.09, 75.0 if focal[0] > 0 else -75.0)]
            else:
                f, dd = FRAMING["head"]
                views = [(f, dd * 0.9, 20.0), (f, dd * 0.9, 20.0), (f, dd * 0.9, 90.0)]
            for c, (f, dist, yaw) in enumerate(views):
                if c == 0:
                    draw(e["base_w"], st, -1)
                elif c == 1:
                    draw(e["w"], st, e.get("where", -1))
                r.look(f, dist, yaw)
                r.screenshot(tile)
                sheet.paste(Image.open(tile).convert("RGB"), (x0 + c * size, y0))
            d.text((x0 + 4, y0 + 4), "average face", fill="#bbbbbb", font=font)
            d.text((x0 + 6, y0 + size + 2), e["label"][:88], fill="white", font=font)
            d.text((x0 + 6, y0 + size + 20), e["label"][88:176], fill="#cfcfcf", font=font)
        p = SHEETS / f"{name}_{s0 // 8 + 1}.png"
        sheet.save(p)
        paths.append(p)
    tile.unlink(missing_ok=True)
    return paths


def vision_review(paths: list[Path]) -> list[str]:
    """Each sheet to Claude for a per-tile verdict (opt-in: `--vision`)."""
    import base64

    from ..claude import DEFAULT_MODEL, Usage, client

    c, usage, out = client(), Usage(DEFAULT_MODEL), []
    prompt = ("These are renders of a 3D head model from a face-shape stress test (front, three-quarter and profile per "
              "face, or a head with hair / glasses drawn over it as lines or points; a red dot marks where an automatic "
              "check found the worst problem). For each face, in reading order, answer on one line: number, then one of "
              "BROKEN (geometry that is impossible: surfaces passing through each other, eyes out of their sockets, "
              "teeth through lips, hair or glasses floating off or sunk into the head), ODD (unusual but physically "
              "possible), FINE; then a few words on what you see. Judge only geometry, never appearance or identity.")
    for p in paths:
        data = base64.b64encode(p.read_bytes()).decode()
        msg = c.messages.create(model=DEFAULT_MODEL, max_tokens=1200, messages=[{"role": "user", "content": [
            {"type": "image", "source": {"type": "base64", "media_type": "image/png", "data": data}},
            {"type": "text", "text": prompt}]}])
        usage.add(msg.usage)
        out += [f"**{p.name}**", "", msg.content[0].text.strip(), ""]
    out.append(f"_{usage.summary()}_")
    return out


# --- driver -------------------------------------------------------------------------------------------------------


def run(quick: bool = False, vision: bool = False, workers: int = 8, fresh: bool = False,
        only: list[str] | None = None) -> None:
    """`only`: just these families (the report then covers only them)."""
    t0 = time.time()
    want = lambda *fs: not only or any(f in only for f in fs)  # noqa: E731
    m = HeadModel.load()
    SHEETS.mkdir(parents=True, exist_ok=True)
    if fresh or not IDENTITIES.exists() or json.loads(IDENTITIES.read_text()).get("quick") != quick:
        ids = make_identities(m, quick, workers)
        IDENTITIES.write_text(json.dumps({"quick": quick, "identities": ids}, indent=1))
        print(f"{len(ids)} identities -> {IDENTITIES}", flush=True)
    ident_doc = json.loads(IDENTITIES.read_text())
    identities = ident_doc["identities"]
    stale = not STATES.exists() or STATES.stat().st_mtime < IDENTITIES.stat().st_mtime
    if stale:
        print("the app's states: node scripts/stress-states.mjs (needs the app running on :3000)", flush=True)
        cmd = ["node", "scripts/stress-states.mjs"] + (["--quick"] if quick else [])
        subprocess.run(cmd, cwd=REPO_DIR / "web", check=True)
    states_doc = json.loads(STATES.read_text())
    states = states_doc["states"]
    print(f"{len(states)} app states ({len(states_doc.get('errors', []))} page errors)", flush=True)

    rows: list[dict] = []
    tested: dict[str, int] = {}
    notes: dict[str, str] = {}
    t = time.time()
    rows += fam_single(m, workers) if want("single") else []
    print(f"single: {sum(r['family'] == 'single' for r in rows)} ({time.time() - t:.0f} s)", flush=True)
    t = time.time()
    if want("pairs"):
        pr, info = fam_pairs(m, quick, workers)
        rows += pr
        tested["pairs"] = info["tested"]
        notes["Pairs"] = f"{info['tested']} pairs; the limiter stopped {info['stopped']} short of the end."
        print(f"pairs: {info['tested']}, broken {len(pr)} ({time.time() - t:.0f} s)", flush=True)
    t = time.time()
    if want("rays"):
        rr, info = fam_rays(m, quick, workers)
        rows += rr
        tested["rays"] = info["tested"]
        notes["Multi-slider faces"] = (f"seed {RAYS_SEED} (held out); the limiter stopped {info['stopped']} of {info['tested']}. "
                                       "Known gap: the limiter only knows crossings it has seen (~0.1% expected).")
        print(f"rays: {info['tested']}, broken {len(rr)} ({time.time() - t:.0f} s)", flush=True)
    t = time.time()
    st_rows = fam_states(m, states, workers) if want("random", "character", "anim") else []
    anim = [r for r in st_rows if r["family"] == "anim"]
    anim_verdict(anim)
    rows += st_rows
    print(f"app states: {len(st_rows)} ({time.time() - t:.0f} s)", flush=True)
    rnd = [s for s in states if s["family"] == "random"]
    if rnd:
        lv = sorted({s["level"] for s in rnd})
        notes["Random face"] = "limiter stepped in (pulled toward average / a striking feature shortened): " + ", ".join(
            f"D{l}: {sum(s['fit']['shrunk'] > 0 for s in rnd if s['level'] == l)} / "
            f"{sum(s['fit']['shortened'] > 0 for s in rnd if s['level'] == l)} of {sum(s['level'] == l for s in rnd)}" for l in lv)
    # identity rest weights (the app's own) for fx and add-ons
    by_state = {(s["identity"], s["anim"]): weights(m, s["weights"], True) for s in states if s["family"] == "anim"}
    rest = {i: w for (i, an), w in by_state.items() if an == "rest"}
    t = time.time()
    rows += fam_fx(m, identities, rest, quick, workers) if want("fx") else []
    print(f"fx: {sum(r['family'] == 'fx' for r in rows)} ({time.time() - t:.0f} s)", flush=True)
    t = time.time()
    ad = fam_addons(m, identities, by_state, quick, workers) if want("addons") else []
    rows += ad
    print(f"addons: {len(ad)}, broken {sum(bool(r['fail']) for r in ad)} ({time.time() - t:.0f} s)", flush=True)

    summary = [summarise(rows, f, tested.get(f)) for f in FAMILY_TITLES if any(r["family"] == f for r in rows) or f in tested]
    avg = [r for r in rows if r["family"] == "anim" and r.get("identity") == "average" and r["raw_fail"]]
    if avg:
        notes["The average face's own animation"] = ("the reference every other face is compared with; GNM's own "
            "animation already trips these checks on it: " + ", ".join(f"{r['anim']} ({', '.join(f'{k} {r['values'][k]:.2f} mm' for k in r['raw_fail'])})" for r in avg))
    # capped animations (per identity, from the app's caps)
    caps = []
    for i in identities:
        cs = next((s["caps"] for s in states if s.get("identity") == i["id"] and s.get("anim") == "rest"), None)
        if cs:
            low = {k: v for k, v in cs.items() if k != "ms" and isinstance(v, (int, float)) and v < 0.999}
            if low:
                caps.append({"identity": i["id"], "caps": low})

    # sheets: worst broken faces (not add-ons), random controls, worst add-ons
    state_by_id = {s["id"]: s for s in states}

    def face_entry(r):
        if "face" in r:
            w = weights(m, r["face"])
        elif "weights" in r:
            w = m.vector({k: v for k, v in r["weights"].items() if k in m.names})
        elif r["family"] == "single":
            t_, e_ = r["id"].split("@")
            w = weights(m, {t_: float(e_)})
        else:
            s = state_by_id[r["id"]]
            w = weights(m, s["weights"], s.get("effective", False))
        vals = ", ".join(f"{k} {r['values'].get(k, 0):.2f}" for k in r["fail"]) or "passes"
        g = state_by_id[r["id"]].get("gaze") if r["id"] in state_by_id else None
        return {"w": w, "gaze": g, "where": r.get("where", -1), "label": f"{r['family']}: {r['id']} — {vals}"}

    score = lambda r: max((r["values"].get(k, 0.0) for k in r["fail"]), default=0.0)  # noqa: E731
    broken = sorted([r for r in rows if r["fail"] and r["family"] != "addons"], key=score, reverse=True)[:40]
    rng = pyrandom.Random(7)
    clean = [r for r in rows if not r["fail"] and r["family"] in ("single", "random", "character", "anim", "fx")]
    controls = rng.sample(clean, min(20, len(clean)))
    t = time.time()
    sheets = face_sheets(m, [face_entry(r) for r in broken], "worst")
    sheets += face_sheets(m, [face_entry(r) for r in controls], "controls")
    sev = lambda r: (r["values"].get("clip_share", 0) + r["values"].get("eye_share", 0)  # noqa: E731
                     + r["values"].get("clip_vertices", 0) / 1000 + r["values"].get("floating_mm", 0) / 10)
    pick = []
    for cat in ("hair", "eyebrows", "eyelashes", "facialHair", "glasses"):  # the worst few styles of every category
        seen = set()
        for r in sorted([r for r in ad if r["fail"] and r["style"]["category"] == cat], key=sev, reverse=True):
            if r["style"]["file"] not in seen and len(seen) < 4:
                seen.add(r["style"]["file"])
                pick.append(r)
    ad_entries = [{"w": by_state[(r["head"], r["anim"])], "base_w": by_state[("average", r["anim"])], "style": r["style"], "where": r["where"],
                   "label": f"{r['style']['category']}:{r['style']['id']} on {r['head']} ({r['anim']}) — {', '.join(r['fail'])}; "
                            + ", ".join(f"{k} {v}" for k, v in r["values"].items())} for r in pick]
    sheets += addon_sheets(m, ad_entries, "addons")
    print(f"sheets: {len(sheets)} ({time.time() - t:.0f} s)", flush=True)
    vis = vision_review(sheets) if vision else None

    extra = {"when": time.strftime("%Y-%m-%d %H:%M"), "quick": quick, "seconds": time.time() - t0, "notes": notes,
             "caps": caps, "sheets": sheets, "vision": vis}
    name = "stress" + ("_" + "_".join(only) if only else "")  # a partial run never overwrites the full report
    write_report(summary, rows, extra, OUT / f"{name}.md")
    slim = [{k: v for k, v in r.items() if k not in ("weights", "style")} | ({"style": r["style"]["id"]} if "style" in r else {})
            for r in rows if r["fail"] or r.get("report")]
    (OUT / f"{name}.json").write_text(json.dumps({"summary": summary, "caps": caps, "failures": slim}, indent=1, default=float))
    for s in summary:
        print(f"{s['family']:8s} {s['tested']:6d} tested, {s['broken']:4d} broken {dict((k, v['n']) for k, v in s['checks'].items())}")
    print(f"-> {OUT / (name + '.md')}  ({time.time() - t0:.0f} s)")
