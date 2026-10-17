"""Mouth shapes (web/src/data/visemes.json) solved from exact mouth measures: GNM is linear, so every measure (lip gap,
width, protrusion, teeth showing, the lower lip on the upper teeth, the tongue tip…) is a linear function of the morph
weights, and a shape can be moved toward goals in millimetres while everything else holds still.

    uv run solve-visemes measure                 the measures of every shape now
    uv run solve-visemes solve                   candidates for the shapes in GOALS → out/visemes/cands.json
    uv run solve-visemes apply u=u_round ff=ff_b write the chosen candidates into visemes.json (+ its "speed")

Render candidates with qa/lipsync/shapes.mjs --presets out/visemes/cands.json before applying, and check the caps on
random faces (the app limits each shape per face: animCaps).
"""

from __future__ import annotations

import argparse
import json

import numpy as np
from scipy.optimize import lsq_linear

from . import semantic
from .export_glb import MANIFEST
from .gnm import GNM, OUT_DIR, REPO_DIR

VISEMES = REPO_DIR / "web" / "src" / "data" / "visemes.json"
OUT = OUT_DIR / "visemes"

# the measures' points: landmarks from config/semantic_sliders.toml, and the lip rims 8 and 12 mm out to each side
# (an opening round vs a slit) as GNM template vertices
LANDMARKS = dict(su="stomion_upper", sl="stomion_lower", ls="labrale_superius", li="labrale_inferius", cl="cheilion_l",
                 cr="cheilion_r", sn="subnasale", me="menton")
LIP_RIMS = dict(u8l=4625, l8l=4628, u8r=10753, l8r=10756, u12l=4633, l12l=4635, u12r=10761, l12r=10763)
LOPSIDED = ("002", "007", "012")  # move the mouth sideways or tilt its corners: never in a viseme
LIP_COMPS = [f"lower_face_region_{i:03d}" for i in range(24) if f"{i:03d}" not in LOPSIDED]
TONGUE_COMPS = ["tongue_mean", "tongue_000", "tongue_001"]
# measures that are absolute (mm); the others are reported against the face at rest
ABSOLUTE = {"gap", "upperTeeth", "lowerTeeth", "teethGap", "gap8", "gap12", "lipOnTeethY", "lipOnTeethZ", "tipY", "tipZ"}


class Mouth:
    def __init__(self) -> None:
        g = GNM.load()
        self.g = g
        T = np.asarray(g.template, np.float64)
        self.scale = {t["name"]: float(t["scale"]) for t in json.loads(MANIFEST.read_text())["targets"]}
        lm = semantic.config_landmarks(semantic.load_config())
        L = {k: int(lm[name][0]) for k, name in LANDMARKS.items()} | LIP_RIMS
        teeth = g.vertex_groups["teeth"]
        up = g.vertex_groups["upper_teeth_and_gums"] & teeth
        lo = g.vertex_groups["lower_teeth_and_gums"] & teeth
        mid = np.abs(T[:, 0]) < 0.004
        ui = np.where(up & mid)[0]
        li = np.where(lo & mid)[0]
        L["ut"] = int(ui[np.argmin(T[ui, 1])])  # upper central incisor tip
        L["lt"] = int(li[np.argmax(T[li, 1])])  # lower central incisor tip
        # tongue tip: the most forward midline vertex that the tongue components move (tongue_000 pushes it forward,
        # tongue_001 raises it); the template's most forward tongue vertex is on the underside and hardly moves
        L["tt"] = 14860
        self.L = L
        self.idx = list(L.values())
        self.T = T[self.idx]
        self.deltas: dict[str, np.ndarray] = {}
        self.rest = self.measures({})
        self.keys = list(self.rest)
        self.J = np.stack([self.vec({c: 1.0}) for c in LIP_COMPS + TONGUE_COMPS], 1)

    def delta(self, t: str) -> np.ndarray:
        if t not in self.deltas:
            self.deltas[t] = np.asarray(self.g.delta(t), np.float64)[self.idx]
        return self.deltas[t]

    def points(self, w: dict[str, float]) -> dict[str, np.ndarray]:
        v = self.T.copy()
        for t, x in w.items():
            if x:
                v += x * self.scale[t] * self.delta(t)
        return dict(zip(self.L.keys(), v))

    def measures(self, w: dict[str, float]) -> dict[str, float]:
        p = self.points(w)
        mm = 1000
        return dict(
            gap=(p["su"][1] - p["sl"][1]) * mm,  # lips apart at the middle
            gap8=((p["u8l"][1] - p["l8l"][1]) + (p["u8r"][1] - p["l8r"][1])) / 2 * mm,  # … 8 mm out (round: near gap)
            gap12=((p["u12l"][1] - p["l12l"][1]) + (p["u12r"][1] - p["l12r"][1])) / 2 * mm,
            width=(p["cl"][0] - p["cr"][0]) * mm,
            corner=((p["cl"][1] + p["cr"][1]) / 2 - (p["su"][1] + p["sl"][1]) / 2) * mm,  # + = corners up (a smile)
            protr=((p["ls"][2] + p["li"][2]) / 2 - p["sn"][2]) * mm,
            upperLipZ=(p["ls"][2] - p["sn"][2]) * mm,
            lowerLipZ=(p["li"][2] - p["sn"][2]) * mm,
            upperTeeth=(p["su"][1] - p["ut"][1]) * mm,  # + = upper teeth showing below the upper lip
            lowerTeeth=(p["lt"][1] - p["sl"][1]) * mm,  # + = lower teeth showing above the lower lip
            teethGap=(p["ut"][1] - p["lt"][1]) * mm,  # incisor tips apart (the jaw)
            lipOnTeethY=(p["sl"][1] - p["ut"][1]) * mm,  # lower lip's inner edge above (+) the upper incisor tips: f/v
            lipOnTeethZ=(p["sl"][2] - p["ut"][2]) * mm,  # … in front of (+) or behind (−) them
            tipY=(p["tt"][1] - p["ut"][1]) * mm,  # tongue tip above (+) the upper incisor tips
            tipZ=(p["tt"][2] - p["ut"][2]) * mm,  # … in front of (+) them (between the teeth) or behind (−)
            midX=((p["su"][0] + p["sl"][0]) / 2 + (p["cl"][0] + p["cr"][0]) / 2) / 2 * mm,  # sideways: stays 0
            tilt=(p["cl"][1] - p["cr"][1]) * mm,  # one corner higher: stays 0
        )

    def vec(self, w: dict[str, float]) -> np.ndarray:
        m = self.measures(w)
        return np.array([m[k] - self.rest[k] for k in self.keys])

    def report(self, w: dict[str, float]) -> dict[str, float]:
        m = self.measures(w)
        return {k: round(m[k] if k in ABSOLUTE else m[k] - self.rest[k], 2) for k in self.keys}

    def solve(self, old: dict[str, float], goals: dict[str, float], comps: list[str], hold: float = 0.6, lam: float = 0.02, bound: float = 1.2):
        """Weights near `old` that reach `goals` (mm), holding every other measure where `old` had it."""
        allc = LIP_COMPS + TONGUE_COMPS
        cols = [allc.index(c) for c in comps]
        Jc = self.J[:, cols]
        sig = np.array([self.scale[c] for c in comps])
        w0 = np.array([old.get(c, 0.0) for c in comps])
        fixed = {c: x for c, x in old.items() if c not in comps and not c.endswith(LOPSIDED)}
        mf = self.vec(fixed) if fixed else np.zeros(len(self.keys))
        m0 = Jc @ w0 + mf
        rows, rhs = [], []
        for i, k in enumerate(self.keys):
            if k in ("midX", "tilt"):
                rows.append(4 * Jc[i])
                rhs.append(-4 * mf[i])
            elif k in goals:
                rows.append(Jc[i])
                rhs.append(goals[k] - (self.rest[k] if k in ABSOLUTE else 0) - mf[i])
            else:
                rows.append(hold * Jc[i])
                rhs.append(hold * (m0[i] - mf[i]))
        rows += list(np.sqrt(lam) * np.diag(sig))
        rhs += list(np.sqrt(lam) * sig * w0)
        x = lsq_linear(np.array(rows), np.array(rhs), bounds=(-bound, bound)).x
        x[np.abs(x) < 0.02] = 0
        out = {**fixed, **{c: round(float(v), 3) for c, v in zip(comps, x) if v}}
        return out


# What each re-tuned shape should reach (mm). Candidates per shape; render them, pick by eye.
GOALS: dict[str, dict[str, dict[str, float]]] = {
    # "oo": a small ROUND opening, lips forward, not a slit with the lower lip turned out
    "u": {
        "u_round": {"gap": 5.5, "gap8": 4.0, "gap12": 1.0, "width": -15.0, "protr": 5.0, "upperLipZ": 5.2, "lowerLipZ": 4.6},
        "u_rounder": {"gap": 6.5, "gap8": 5.0, "gap12": 2.0, "width": -13.5, "protr": 5.5, "upperLipZ": 5.6, "lowerLipZ": 4.8},
    },
    # f/v: the lower lip tucked up under the upper teeth, which show
    "ff": {
        "ff_tuck": {"upperTeeth": 2.5, "lipOnTeethY": 2.0, "lipOnTeethZ": -0.5, "lowerTeeth": -3.0, "teethGap": 1.5, "gap": 0.8},
        "ff_teeth": {"upperTeeth": 3.0, "lipOnTeethY": 1.6, "lipOnTeethZ": 0.0, "lowerTeeth": -2.8, "teethGap": 1.8, "gap": 1.2},
    },
    # s/z: teeth nearly together, lips relaxed (not spread like ee)
    "ss": {
        "ss_close": {"teethGap": 1.0, "gap": 3.0, "width": 1.0, "upperTeeth": 1.8, "lowerTeeth": 0.8, "corner": 0.6},
    },
    # ee: spread wider, a little more open, corners lifted a touch
    "i": {
        "i_spread": {"width": 7.5, "gap": 4.5, "teethGap": 2.0, "upperTeeth": 2.4, "lowerTeeth": 0.8, "corner": 1.8},
    },
    # l: the tongue tip at the edge of the upper teeth, where it shows (t/d/n keep theirs on the ridge behind the teeth,
    # hidden, as in life). Tongue components only: the lips and jaw stay the "d"'s (mouth.ts blends the tongue to it).
    "ll": {
        "ll_edge": {"tipY": 0.5, "tipZ": -0.5},
        "ll_low": {"tipY": -0.5, "tipZ": -1.0},
    },
}
# a shape solved from another's weights (the tongue-only "l" starts from the "d"), and which components it may use
BASE = {"ll": "dd"}
ONLY = {"ll": TONGUE_COMPS}


def main(argv=None) -> None:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("cmd", nargs="?", default="measure", choices=("measure", "solve", "apply"))
    p.add_argument("pairs", nargs="*", metavar="viseme=candidate", help="apply: the candidates to write")
    args = p.parse_args(argv)
    cmd = args.cmd
    doc = json.loads(VISEMES.read_text())
    vis = doc["visemes"]
    m = Mouth()
    if cmd == "measure":
        for v, w in vis.items():
            print(v.ljust(4), " ".join(f"{k} {x:+.1f}" for k, x in m.report(w).items()))
        return
    OUT.mkdir(parents=True, exist_ok=True)
    cands_file = OUT / "cands.json"
    if cmd == "solve":
        cands: dict[str, dict[str, float]] = {}
        for v, sets in GOALS.items():
            base = vis.get(v) or vis[BASE[v]]
            cands[f"{v}_now"] = base
            for name, goals in sets.items():
                comps = ONLY.get(v) or sorted(set(LIP_COMPS) | {c for c in base if not c.endswith(LOPSIDED)})
                w = m.solve(base, goals, comps)
                if v in ONLY:
                    w = {c: x for c, x in w.items() if c in ONLY[v]}  # the tongue alone
                cands[name] = w
                r = m.report(w)
                print(f"{name:10} " + " ".join(f"{k} {r[k]:+.1f}" for k in r if k in goals or k in ("midX", "tilt", "corner", "protr")) + f"  | {len(w)} comps")
        cands_file.write_text(json.dumps(cands, indent=1))
        print(cands_file)
        return
    if cmd == "apply":
        cands = json.loads(cands_file.read_text())
        for pair in args.pairs:
            v, name = pair.split("=")
            vis[v] = cands[name]
            print(f"{v} ← {name}: " + " ".join(f"{k} {x:+.1f}" for k, x in m.report(vis[v]).items()))
        doc["speed"] = speed(m, doc)
        VISEMES.write_text(json.dumps(doc, indent=2) + "\n")
        print(f"wrote {VISEMES}")


def speed(m: Mouth, doc: dict) -> dict:
    """Lip and jaw opening (mm) per unit weight of every target the shapes use: LipSync's speed limit."""
    targets = sorted({t for p in doc["visemes"].values() for t in p} | {t for r in doc["roles"].values() for t in r if t.startswith("lower_face")})
    gap, jaw = {}, {}
    p0 = m.points({})
    for t in targets:
        p1 = m.points({t: 1.0})
        g = ((p1["su"][1] - p1["sl"][1]) - (p0["su"][1] - p0["sl"][1])) * 1000
        j = ((p1["sn"][1] - p1["me"][1]) - (p0["sn"][1] - p0["me"][1])) * 1000
        if abs(g) > 0.01 or abs(j) > 0.01:
            gap[t], jaw[t] = round(float(g), 3), round(float(j), 3)
    return {"gap": gap, "jaw": jaw}


if __name__ == "__main__":
    main()
