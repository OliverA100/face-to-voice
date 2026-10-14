# /// script
# requires-python = "==3.12.*"
# dependencies = ["numpy", "scipy", "mediapipe==0.10.14"]
# ///
"""Per-frame lips of GRID talkers, saved once for shape work (grid.py keeps only its events): for each sentence the
inner-lip gap, mouth width and nose-to-chin (each over the outer-eye-corner distance, as grid.py), its word timings
and its audio's loudness (dB, 10 ms).

  uv run gridframes.py out/grid/s1 [--max 300]      → out/grid/frames/s1.jsonl
"""
from __future__ import annotations
import json, sys
from pathlib import Path
import numpy as np
HERE = Path(__file__).parent
sys.path.insert(0, str(HERE))
from grid import audio, frames, lips, words, SR  # noqa: E402
from truth import db_env  # noqa: E402

if __name__ == "__main__":
    import mediapipe as mp
    talker = Path(sys.argv[1])
    cap = int(sys.argv[sys.argv.index("--max") + 1]) if "--max" in sys.argv else 300
    aligns = HERE / "out" / "grid" / "align" / "alignments"
    out = HERE / "out" / "grid" / "frames" / f"{talker.name}.jsonl"
    out.parent.mkdir(exist_ok=True)
    vids = sorted(v for v in talker.rglob("*.mpg") if not v.name.startswith("._") and "__MACOSX" not in v.parts)[:cap]
    done = {json.loads(l)["video"] for l in open(out)} if out.exists() else set()
    with mp.solutions.face_mesh.FaceMesh(static_image_mode=False, max_num_faces=1, refine_landmarks=True) as mesh, open(out, "a") as fo:
        for n, v in enumerate(vids):
            if v.stem in done:
                continue
            al = aligns / talker.name / f"{v.stem}.align"
            if not al.exists():
                al = next(iter(sorted(aligns.glob(f"*/{v.stem}.align"))), None)
                if al is None:
                    continue
            fr = frames(v)
            x = audio(v)
            if len(fr) < 10 or len(x) < SR:
                continue
            L = lips(mesh, fr)
            env = db_env(x, SR, hop=0.01, win=0.02)
            r = {"video": v.stem, "fps": 25, "lips": [[None if np.isnan(q) else round(float(q), 4) for q in row] for row in L],
                 "words": words(al), "db": [round(float(q), 1) for q in env]}
            fo.write(json.dumps(r) + "\n")
            fo.flush()
            if n % 50 == 0:
                print(f"{talker.name}: {n}/{len(vids)}", flush=True)
