"""`uv run slider-ranges`: how far each shape slider should go, in real units.

For every Shape slider (semantic) and Advanced slider (raw GNM identity and expression components):

  σ         one standard deviation of what the slider changes. A semantic slider changes ONE measurement, so its σ
            is that measurement's spread over real faces: the published adult SD (config/anthropometry.toml) when
            the feature has a standard measurement (nose width = al-al), else the model's own population σ
            (semantic.py's ‖J_k‖). A raw slider is a PCA component: its σ is the component's σ.
  candidate each side's end at `target_sigma` σ (config/validation.toml [ranges]).
  measured  all standard measurements at the candidate ends (anthro.py) against the published adult extremes:
              too far    a measurement leaves the range of real adult faces -> the end is pulled back to that point
              too timid  the feature's own measurement does not reach rare territory (`rare_z` SD)
            Expression sliders (mouth, lids, tongue) move the face, they do not shape it: they get σ only (the break
            sweep, sweep.py, trims them where the geometry breaks).

Writes config/slider_ranges.json (each slider's ends; sliders_json.py copies them into sliders.json on the next
`uv run update-sliders` / export), and the report: out/validation/ranges.json, ranges.md and a contact sheet per panel
section (−end / average / +end).
"""
from __future__ import annotations

import argparse
import json
import tomllib
from dataclasses import dataclass, replace

import numpy as np

from .. import semantic
from ..export_glb import load_config as load_components
from ..gnm import OUT_DIR, PIPELINE_DIR
from .anthro import MEASURES, Anthropometer, load_reference
from .model import HeadModel

CONFIG = PIPELINE_DIR / "config" / "validation.toml"
OUT = OUT_DIR / "validation"
RANGES_JSON = OUT / "ranges.json"  # the full report
SLIDER_RANGES = PIPELINE_DIR / "config" / "slider_ranges.json"  # committed: each slider's ends (sliders_json.py reads it)


def load_config() -> dict:
    with open(CONFIG, "rb") as f:
        return tomllib.load(f)


@dataclass
class Side:
    end: float  # proposed morph weight at this end (signed)
    candidate: float  # target_sigma σ (signed)
    limit: str  # why the end is where it is
    own_z: float | None  # the matched measurement at the end, in reference SD from the reference mean
    too_far: list[str]  # measurements beyond published extremes at the candidate end
    values: dict[str, float]  # all measurements at the proposed end (mm)


class Ruler:
    """Measurements of a posed head, expressed against the reference (handles landmark-definition offsets)."""

    def __init__(self, model: HeadModel, cfg: dict):
        self.model = model
        self.anth = Anthropometer(model.gnm)
        self.ref = load_reference()
        w0 = np.zeros(len(model.names), np.float32)
        self.base = self.anth.measure(model.positions(w0), model.pivots(w0))
        offset_z = float(cfg["ranges"]["reference_offset_z"])
        # GNM's average face far from the published mean = our landmark sits elsewhere than the anthropometrist's
        # (e.g. the inner eye corner): compare CHANGES then, as if GNM's mean were the population mean
        forced = set(cfg["ranges"].get("compare_changes", []))
        self.offset = {k: (k in forced or abs(self.base[k] - r.mean) / r.sd > offset_z) for k, r in self.ref.items()}
        self.advisory = set(cfg["ranges"].get("advisory", []))

    def at(self, w: np.ndarray) -> dict[str, float]:
        return self.anth.measure(self.model.positions(w), self.model.pivots(w))

    def as_reference(self, k: str, v: float) -> float:
        """The value in the reference's frame (shifted when the landmark definitions differ)."""
        return self.ref[k].mean + (v - self.base[k]) if self.offset.get(k) else v

    def z(self, k: str, v: float) -> float:
        r = self.ref[k]
        return (self.as_reference(k, v) - r.mean) / r.sd

    def outside(self, vals: dict[str, float], moved_mm: float) -> list[str]:
        """Measurements beyond the published extremes that this slider actually moved."""
        out = []
        for k, v in vals.items():
            if k not in self.ref or k in self.advisory or abs(v - self.base[k]) < moved_mm:
                continue
            x = self.as_reference(k, v)
            if x < self.ref[k].low or x > self.ref[k].high:
                out.append(k)
        return out


def sigma_per_weight(model: HeadModel, rows, sigma_scale: float, overrides: dict) -> dict[str, tuple[float, str]]:
    """target -> (σ of its feature per unit morph weight, which σ). Model σ here; reference σ is applied later."""
    out = {}
    by_id = {r["id"]: r for r in rows}
    for target, s in model.sliders.items():
        if s["kind"] == "semantic" and target.startswith(semantic.TARGET_PREFIX):
            sid = target[len(semantic.TARGET_PREFIX):]
            if sid in by_id:
                r = by_id[sid]
                out[target] = (abs(r["own_mm"]) / r["pop_sigma_mm"], "model")
        elif s["kind"] in ("identity", "expression"):
            out[target] = (float(overrides.get(target, sigma_scale)), "component")  # weight 1 = sigma_scale σ
    return out


def solve_side(ruler: Ruler, target: str, sign: float, spw: float, own: str | None, cfg: dict, shape: bool) -> Side:
    """Walk one side of one slider and decide where its end goes."""
    rc = cfg["ranges"]
    model = ruler.model
    cand = sign * float(rc["target_sigma"]) / spw
    far_cap = sign * float(rc["max_feature_sigma"]) / spw

    def weights(x: float) -> np.ndarray:
        return model.vector(model.expand({target: x}))

    if not shape:  # expression sliders: σ only
        return Side(cand, cand, f"{rc['target_sigma']:g}σ", None, [], {})
    end, limit = cand, f"{rc['target_sigma']:g}σ (model)"
    own_z = None
    if own and own in ruler.ref:
        # real-unit σ: put the end where the feature sits at target_sigma reference SD (never past max_feature_sigma)
        r = ruler.ref[own]
        d1 = ruler.at(weights(sign))[own] - ruler.base[own]  # mm per unit weight on this side (signed)
        if abs(d1) > 1e-6:
            goal = r.mean + np.sign(d1) * float(rc["target_sigma"]) * r.sd
            x = (goal - ruler.as_reference(own, ruler.base[own])) / d1  # weight magnitude to reach it
            if x > 0:
                if x > abs(far_cap):
                    x, limit = abs(far_cap), f"{rc['max_feature_sigma']:g}σ model cap"
                else:
                    limit = f"{rc['target_sigma']:g} SD (published)"
                end = sign * x
    # too far: the first point where a measurement it moves leaves the published adult range
    vals_c = ruler.at(weights(cand))
    too_far = ruler.outside(vals_c, float(rc["moved_mm"]))
    steps = np.linspace(0.0, end, int(rc["steps"]) + 1)[1:]
    prev = 0.0
    for x in steps:
        bad = ruler.outside(ruler.at(weights(x)), float(rc["moved_mm"]))
        if bad:
            lo, hi = prev, x  # bisect between the last good and the first bad step
            for _ in range(8):
                mid = (lo + hi) / 2
                if ruler.outside(ruler.at(weights(mid)), float(rc["moved_mm"])):
                    hi = mid
                else:
                    lo = mid
            end, limit = lo, "published extreme: " + ", ".join(bad)
            break
        prev = x
    vals = ruler.at(weights(end))
    if own and own in ruler.ref:
        own_z = ruler.z(own, vals[own])
    return Side(float(end), float(cand), limit, own_z, too_far, vals)


def main(argv=None) -> None:
    p = argparse.ArgumentParser(description="Propose each shape slider's range from σ and published adult anthropometry.")
    p.add_argument("--no-sheet", action="store_true")
    p.add_argument("--only", nargs="*", help="targets to process (default: all)")
    p.add_argument("--size", type=int, default=230)
    args = p.parse_args(argv)
    cfg = load_config()
    model = HeadModel.load()
    comp = load_components()
    sigma_scale = float(comp["export"]["sigma_scale"])
    sol = semantic.solve(model.gnm, semantic.load_config())
    rows = semantic.evaluate(model.gnm, sol)
    ruler = Ruler(model, cfg)
    spw = sigma_per_weight(model, rows, sigma_scale, comp["export"].get("scale_overrides", {}))
    match = cfg["ranges"]["match"]
    skip = set(cfg["ranges"]["skip"])

    result: dict[str, dict] = {}
    for target, s in model.sliders.items():
        if target in skip or target not in spw or (args.only and target not in args.only):
            continue
        per_w, basis = spw[target]
        shape = s["kind"] in ("semantic", "identity")
        own = match.get(target)
        sides = {name: solve_side(ruler, target, sign, per_w, own, cfg, shape) for name, sign in (("min", -1.0), ("max", 1.0))}
        looks = cfg["ranges"].get("looks", {}).get(target)  # ends chosen by eye: the model cannot go further without distortion
        if looks:
            for k, (name, sd) in enumerate((("min", sides["min"]), ("max", sides["max"]))):
                if abs(looks[k] - sd.end) > 1e-6:
                    sides[name] = replace(sd, end=float(looks[k]), limit="chosen by eye")
        result[target] = {
            "kind": s["kind"], "name": s["name"], "group": s["group"],
            "sigma_per_weight": per_w, "sigma_basis": basis, "own": own,
            "min": round(sides["min"].end, 3), "max": round(sides["max"].end, 3),
            "sides": {k: {"end": v.end, "candidate": v.candidate, "limit": v.limit, "own_z": v.own_z,
                          "too_far_at_candidate": v.too_far} for k, v in sides.items()},
            "measures": {k: {"min": sides["min"].values.get(k), "max": sides["max"].values.get(k)} for k in MEASURES} if shape else {},
        }
        print(f"{target:24s} {result[target]['min']:+6.2f} .. {result[target]['max']:+6.2f}   "
              f"{sides['min'].limit} | {sides['max'].limit}")

    OUT.mkdir(parents=True, exist_ok=True)
    doc = {"note": "written by `uv run slider-ranges`; sliders_json.py copies min/max into web/src/data/sliders.json",
           "config": cfg["ranges"], "baseline": ruler.base, "offset": ruler.offset, "ranges": result}
    if args.only and RANGES_JSON.exists():  # keep the other sliders of a previous full run
        old = json.loads(RANGES_JSON.read_text())
        old["ranges"].update(result)
        doc["ranges"] = {t: r for t, r in old["ranges"].items() if t in model.sliders}  # (a slider since removed goes)
    RANGES_JSON.write_text(json.dumps(doc, indent=1))
    SLIDER_RANGES.write_text(json.dumps({t: {"min": r["min"], "max": r["max"], "why": [r["sides"]["min"]["limit"], r["sides"]["max"]["limit"]]}
                                         for t, r in doc["ranges"].items()}, indent=1, ensure_ascii=False) + "\n")
    write_markdown(doc, ruler, OUT / "ranges.md")
    print(f"-> {SLIDER_RANGES}\n-> {RANGES_JSON}\n-> {OUT / 'ranges.md'}")
    if not args.no_sheet:
        from .sheets import range_sheets

        for path in range_sheets(model, doc["ranges"], args.size):
            print(f"-> {path}")


def write_markdown(doc: dict, ruler: Ruler, path) -> None:
    ref = ruler.ref
    L = ["# Slider ranges", "",
         f"Each end sits at {doc['config']['target_sigma']:g}σ of the feature the slider changes: published adult SD where the "
         "feature has a standard measurement, the model's own population σ otherwise (raw sliders: component σ). An end is "
         "pulled back where any measurement it moves would leave the published adult range. The UI shows every slider as "
         "−1 … +1 with the average face in the middle; each half is scaled to its own end.", ""]
    L += ["## The average face (GNM mean) against published adult means", "",
          "| measurement | GNM mean mm | published mean ± SD | z | extremes (what) | note |", "|---|---:|---:|---:|---|---|"]
    for k, (label, _) in MEASURES.items():
        if k not in ref:
            L.append(f"| {label} | {ruler.base[k]:.1f} | — | — | — | no reference |")
            continue
        r = ref[k]
        z = (ruler.base[k] - r.mean) / r.sd
        note = "; ".join(n for n, on in (("landmark definition differs: changes compared, not absolute values", ruler.offset[k]),
                                           ("advisory: reported, never limits a slider", k in ruler.advisory)) if on)
        L.append(f"| {label} | {ruler.base[k]:.1f} | {r.mean:.1f} ± {r.sd:.1f} | {z:+.1f} | {r.low:g}–{r.high:g} ({r.extremes}) | {note} |")
    L += ["", "## Ranges", "",
          "weights: morph weight at the UI's −1 / +1. own: the feature's own measurement at each end, in "
          "published SD from the published mean. too far at candidate: measurements a plain ±σ end would push past real adult "
          "faces.", "",
          "| slider | kind | σ / weight | −end | +end | own at −/+ (z) | why −end | why +end | too far at candidate |",
          "|---|---|---:|---:|---:|---|---|---|---|"]
    for r in doc["ranges"].values():
        s = r["sides"]
        oz = " / ".join(f"{s[k]['own_z']:+.1f}" if s[k]["own_z"] is not None else "—" for k in ("min", "max"))
        own = f"{MEASURES[r['own']][0]}: {oz}" if r["own"] else "—"
        far = sorted(set(s["min"]["too_far_at_candidate"]) | set(s["max"]["too_far_at_candidate"]))
        L.append(f"| {r['name']} | {r['kind']} | {r['sigma_per_weight']:.2f} ({r['sigma_basis']}) | {r['min']:+.2f} | {r['max']:+.2f} | "
                 f"{own} | {s['min']['limit']} | {s['max']['limit']} | {', '.join(far) or '—'} |")
    path.write_text("\n".join(L) + "\n")
