# /// script
# requires-python = "==3.12.*"
# dependencies = ["numpy", "pillow", "mediapipe==0.10.14"]
# ///
"""The app's recorded face (replay runs' full-canvas thumbnails, about GRID's size) measured exactly as gridframes.py
measures GRID's talkers: MediaPipe inner-lip gap and mouth width over the outer-eye-corner distance, per frame, with
each frame's heard time and the clip time the mouth showed (to look up the app's own mm in a bench run).

  uv run appframes.py out/runs/<run> [...]     → <run>/mp.json
"""
import json, sys
from pathlib import Path
import numpy as np
from PIL import Image
import mediapipe as mp
HERE = Path(__file__).parent
sys.path.insert(0, str(HERE))
from events import heard_times  # noqa: E402
from runio import Run  # noqa: E402
LIP_UP, LIP_DOWN, CORNER_L, CORNER_R, EYE_L, EYE_R = 13, 14, 61, 291, 33, 263

with mp.solutions.face_mesh.FaceMesh(static_image_mode=False, max_num_faces=1, refine_landmarks=True) as mesh:
    for d in sys.argv[1:]:
        run = Run(Path(d).name)
        heard = heard_times(run, 0)
        rows = []
        for r in run.frames:
            f = Path(d) / "full" / f"{r['i']:06d}.jpg"
            if not f.exists() or r["i"] not in heard:
                continue
            img = np.asarray(Image.open(f).convert("RGB"))
            res = mesh.process(img)
            if not res.multi_face_landmarks:
                continue
            p = np.array([[q.x * img.shape[1], q.y * img.shape[0]] for q in res.multi_face_landmarks[0].landmark])
            eye = np.linalg.norm(p[EYE_L] - p[EYE_R])
            rows.append({"t": heard[r["i"]], "clip": (r.get("app") or {}).get("clip"), "gap": float(np.linalg.norm(p[LIP_UP] - p[LIP_DOWN]) / eye),
                         "width": float(np.linalg.norm(p[CORNER_L] - p[CORNER_R]) / eye), "act": (r.get("app") or {}).get("act")})
        (Path(d) / "mp.json").write_text(json.dumps(rows))
        print(d, len(rows), "frames")
