# /// script
# requires-python = ">=3.11"
# dependencies = ["numpy", "scipy", "torch==2.8.0", "torchaudio==2.8.0", "num2words==0.5.14"]
# ///
"""Saved lines whose voice doesn't say what the text says (a voice glitch: "Adding fast fast leads…", "Sickness,
sickness kept…"): the local speech model (wav2vec2, as truth.py, TORCH_HOME out/.torch) transcribes each clip, and its
words are matched to the text's. Lists the extra and missing words. Free, offline.

  uv run glitches.py out/clips/T*.ndjson
"""
import difflib, os, re, sys
from pathlib import Path
import numpy as np
from scipy.signal import resample_poly
HERE = Path(__file__).parent
os.environ.setdefault("TORCH_HOME", str(HERE / "out" / ".torch"))
sys.path.insert(0, str(HERE))
from truth import ClipRun, normalise, spoken_text  # noqa: E402

import torch, torchaudio  # noqa: E402
bundle = torchaudio.pipelines.WAV2VEC2_ASR_BASE_960H
model = bundle.get_model()
labels = bundle.get_labels()


def heard(x16):
    with torch.inference_mode():
        em, _ = model(torch.from_numpy(x16).float()[None])
    ids = em[0].argmax(-1).tolist()
    out, prev = [], None
    for i in ids:
        if i != prev and i != 0:
            out.append(labels[i])
        prev = i
    return "".join(out).replace("|", " ").split()


n = bad = 0
for a in sys.argv[1:]:
    run = ClipRun(Path(a))
    x, sr, _ = run.audio()
    x16 = resample_poly(x, 2, 3).astype(np.float32) if sr == 24000 else x
    said = [w.upper() for w in heard(x16)]
    text = normalise(spoken_text(run)).split()
    sm = difflib.SequenceMatcher(a=text, b=said, autojunk=False)
    extra = [said[j1:j2] for op, i1, i2, j1, j2 in sm.get_opcodes() if op == "insert"]
    n += 1
    # an inserted word that repeats a neighbour is a glitch; other differences are mostly the model's own spelling
    rep = [w for ws in extra for w in ws if w in text]
    if rep:
        bad += 1
        print(f"{Path(a).stem:28} extra: {' '.join(rep):24} | heard: {' '.join(said)}")
print(f"{bad} of {n} lines say a word the text doesn't (a repeat)")
