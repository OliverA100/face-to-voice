"""Shared Claude client helpers for the pipeline (key loading, pricing, usage accounting)."""
from __future__ import annotations

import os
from dataclasses import dataclass, field

from dotenv import load_dotenv

from .gnm import REPO_DIR

# One key file for the whole repo: web/.env.local (git-ignored). Values already in the
# environment win. Nothing here ever prints a key.
load_dotenv(REPO_DIR / "web" / ".env.local", override=False)

DEFAULT_MODEL = os.environ.get("CLAUDE_MODEL_PIPELINE", "claude-opus-5-5")

# USD per million tokens: (input, output, cache read, 5-minute cache write), from Anthropic's pricing
# page; only used for the cost estimate printed after a run.
PRICES: dict[str, tuple[float, float, float, float]] = {
    "claude-opus-5-5": (4.0, 20.0, 0.20, 5.0),
    "claude-opus-5": (5.0, 25.0, 0.50, 6.25),
    "claude-sonnet-5": (2.0, 10.0, 0.20, 2.50),
    "claude-haiku-4-5": (1.0, 5.0, 0.10, 1.25),
}


def client():
    if not os.environ.get("ANTHROPIC_API_KEY"):
        raise SystemExit("ANTHROPIC_API_KEY is not set (put it in web/.env.local)")
    import anthropic

    return anthropic.Anthropic(max_retries=3, timeout=180.0)


@dataclass
class Usage:
    """Token totals across a run, with a price estimate."""

    model: str
    input_tokens: int = 0
    output_tokens: int = 0
    cache_read: int = 0
    cache_write: int = 0
    requests: int = 0
    errors: list[str] = field(default_factory=list)

    def add(self, usage) -> None:
        self.requests += 1
        self.input_tokens += usage.input_tokens
        self.output_tokens += usage.output_tokens
        self.cache_read += getattr(usage, "cache_read_input_tokens", 0) or 0
        self.cache_write += getattr(usage, "cache_creation_input_tokens", 0) or 0

    def cost_usd(self) -> float | None:
        p = PRICES.get(self.model)
        if not p:
            return None
        return (self.input_tokens * p[0] + self.output_tokens * p[1] + self.cache_read * p[2] + self.cache_write * p[3]) / 1e6

    def summary(self) -> str:
        cost = self.cost_usd()
        return (f"{self.requests} requests, {self.input_tokens} in / {self.output_tokens} out tokens, "
                f"cache read {self.cache_read} / write {self.cache_write}"
                + (f", ≈ ${cost:.2f}" if cost is not None else ""))
