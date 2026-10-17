# /// script
# requires-python = ">=3.11"
# dependencies = ["numpy"]
# ///
"""Pools every analysed run into one table per path × browser (the numbers in docs/lipsync-report.md).

Events from all runs in a group are pooled (not averaged per run). Offsets in ms, negative = the mouth is EARLY.
Runs on a dark-skinned face use the app's own values (events-app.json), every other run the pixels (events.json),
unless the head moved out of the mouth crop for over half of the run's events (mouth.py "clipped"): those use the
app's values too.

  uv run summary.py [--md]                      (--md prints a Markdown table)
  uv run summary.py --md --compare rp s5        before/after: runs "rp-<line>-<browser>-<pace>" against "s5-<same>",
                                                only lines recorded in both, per browser × pace
"""

from __future__ import annotations

import json
import re
import sys

import numpy as np

from runio import RUNS

GROUPS = [
    ("Speak, first-time (streamed), Chrome", r"^[ABC]-.*-chrome-first$"),
    ("Speak, cached, Chrome", r"^A-.*-chrome-cached$"),
    ("Speak, cached, Firefox", r"^A-.*-firefox-cached$"),
    ("Speak, cached, Safari", r"^A-.*-safari-cached$"),
    ("Real lines replayed, streamed pace, Chrome", r"^rp-.*-chrome-stream$"),
    ("Real lines replayed, Firefox", r"^rp-.*-firefox-(instant|stream)$"),
    ("Real lines replayed, Safari", r"^rp-.*-safari-(instant|stream)$"),
    ("Slow network (underruns), Chrome", r"^rp-.*-chrome-slow$"),
    ("Live chat, Chrome", r"^A-chat\d-chrome$"),
    ("Live chat, Firefox", r"^A-chat\d-firefox$"),
    ("Live chat, Safari", r"^A-chat\d-safari$"),
]
DARK = {"C"}  # characters whose skin is too dark for the pixel measure


def load(name: str):
    char = name.split("-")[0]
    pixels, app = RUNS / name / "events.json", RUNS / name / "events-app.json"
    e = json.loads(pixels.read_text()) if pixels.exists() else None
    if app.exists() and (char in DARK or (e and e["summary"].get("unmeasured", 0) > len(e["rows"]) / 2)):
        return json.loads(app.read_text())
    return e


def stats(v):
    v = np.array(v, dtype=float) * 1000
    if not len(v):
        return "–"
    return f"{np.median(v):+.0f} (p90 |{np.percentile(np.abs(v), 90):.0f}|)"


def main(md: bool, groups=None):
    names = sorted(p.name for p in RUNS.iterdir() if p.is_dir())
    rows = []
    for title, rx in groups or GROUPS:
        runs = [n for n in names if re.match(rx, n)]
        ev = [e for e in (load(n) for n in runs) if e]
        if not ev:
            continue
        r = [x for e in ev for x in e["rows"]]
        cl = [x for x in r if x["kind"] == "closure"]
        sealed = [x for x in cl if "seal" in x]
        rows.append({
            "group": title,
            "runs": len(ev),
            "lead": stats([e["summary"]["xcorr_lag_ms"] / 1000 for e in ev]),
            "release": stats([x["release_off"] for x in sealed]),
            "seal": stats([x["seal"] for x in sealed]),
            "close": stats([x["close_start"] for x in sealed if "close_start" in x]),
            "vowel": stats([x["off"] for x in r if x["kind"] == "vowel"]),
            "fv": stats([x["off"] for x in r if x["kind"] == "fv"]),
            "sealed": f"{len(sealed)}/{len(cl)}",
        })
    cols = ["group", "runs", "lead", "release", "seal", "close", "vowel", "fv", "sealed"]
    heads = ["Path", "Runs", "Whole-line lag", "p/b/m lips part vs burst", "p/b/m seal vs sound stops", "Closing starts", "Widest vowel vs loudest", "f/v lip-teeth vs hiss", "Sealed"]
    if md:
        print("| " + " | ".join(heads) + " |")
        print("|" + "---|" * len(heads))
        for x in rows:
            print("| " + " | ".join(str(x[c]) for c in cols) + " |")
    else:
        for x in rows:
            print(x)


if __name__ == "__main__":
    # --group "Title=regex" (repeatable) replaces the default groups
    custom = [a.split("=", 1) for i, a in enumerate(sys.argv) if i > 0 and sys.argv[i - 1] == "--group"]
    if "--compare" in sys.argv:
        k = sys.argv.index("--compare")
        before, after = sys.argv[k + 1], sys.argv[k + 2]
        names = {d.name for d in RUNS.iterdir()}
        pairs: dict[str, list[str]] = {}
        for n in sorted(names):
            if n.startswith(before + "-") and f"{after}-{n[len(before) + 1:]}" in names:
                rest = n[len(before) + 1 :]
                browser, pace = rest.split("-")[-2:]
                pairs.setdefault(f"{browser.capitalize()}, {pace}", []).append(rest)
        for key, rests in pairs.items():
            alt = "|".join(re.escape(r) for r in rests)
            custom += [(f"{key}: before", f"^{re.escape(before)}-({alt})$"), (f"{key}: after", f"^{re.escape(after)}-({alt})$")]
    main("--md" in sys.argv, [(t, r) for t, r in custom] or None)
