"""Average GNM ExpressionSampler samples into one clean expression vector per label.

GNM's ExpressionSampler is a conditional-VAE decoder: (z ~ N(0, I) in 64-D, one-hot label) -> 383
expression coefficients (σ units, GNM's expression order). A single sample is one noisy example of
the label; the mean over many samples is the label's "clean" expression. Averaging washes out the
per-sample variation and also some of the strength, so we also store the typical strength of one
sample (median ‖sample‖). The main pipeline (`uv run emotions`) can rescale the mean to that
strength.

Writes the "sampler" and "labels" blocks of pipeline/config/emotions.json and leaves every other
block (the hand-tuned emotion recipes) untouched. Its own environment (Python 3.12 + TensorFlow, see
pyproject.toml) keeps TensorFlow out of the main pipeline.

    cd pipeline/tools/gnm_sampler && uv run sample-emotions [--samples 1024] [--seed 20260930]
"""
from __future__ import annotations

import argparse
import json
import time
from pathlib import Path

import numpy as np

EMOTIONS_JSON = Path(__file__).resolve().parents[2] / "config" / "emotions.json"
GNM_COMMIT = "f6895509c2b639edc36db20ede82b4315cc28c26"  # the gnm-shape pin in pyproject.toml = ftv_pipeline.gnm.GNM_COMMIT
EXPRESSION_DIM = 383


def main(argv: list[str] | None = None) -> None:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--samples", type=int, default=1024, help="samples per label (default 1024)")
    p.add_argument("--seed", type=int, default=20260930)
    args = p.parse_args(argv)

    from gnm.shape.semantic_sampler import Expression, ExpressionSampler  # imports TensorFlow (slow)

    t0 = time.time()
    sampler = ExpressionSampler()
    rng = np.random.default_rng(args.seed)
    labels: dict[str, dict] = {}
    for label in Expression:
        x = np.asarray(sampler.sample_expression(label, args.samples, rng=rng), np.float64)
        if x.shape != (args.samples, EXPRESSION_DIM):
            raise SystemExit(f"unexpected sampler output {x.shape} for {label.name}")
        mean = x.mean(axis=0)
        norms = np.linalg.norm(x, axis=1)
        labels[label.name] = {
            "median_sample_norm": round(float(np.median(norms)), 4),  # typical strength of ONE sample (σ)
            "mean_norm": round(float(np.linalg.norm(mean)), 4),  # strength of the average (≤ the above)
            "spread": round(float(np.sqrt(np.mean(np.sum((x - mean) ** 2, axis=1)))), 4),  # RMS distance to the mean
            "mean": [round(float(v), 5) for v in mean],
        }
        print(f"  {label.name:14s} |mean| {labels[label.name]['mean_norm']:6.2f}   median |sample| "
              f"{labels[label.name]['median_sample_norm']:6.2f}   spread {labels[label.name]['spread']:6.2f}")

    doc = json.loads(EMOTIONS_JSON.read_text()) if EMOTIONS_JSON.exists() else {}
    doc["sampler"] = {
        "source": "GNM ExpressionSampler (gnm/shape/semantic_sampler.py, expression_decoder_model.h5), Google LLC, Apache-2.0",
        "repo": "https://github.com/google/GNM",
        "commit": GNM_COMMIT,
        "samples_per_label": args.samples,
        "seed": args.seed,
        "note": "labels.<LABEL>.mean = average of the samples, 383 values in GNM's expression order (σ units).",
    }
    doc["labels"] = labels
    EMOTIONS_JSON.write_text(json.dumps(doc, indent=2, ensure_ascii=False) + "\n")  # the file's own format
    print(f"{len(labels)} labels x {args.samples} samples in {time.time() - t0:.0f} s -> {EMOTIONS_JSON}")


if __name__ == "__main__":
    main()
