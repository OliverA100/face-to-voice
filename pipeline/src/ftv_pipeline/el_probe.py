"""`uv run el-probe`: re-records tests/fixtures/stream.ndjson, the real ElevenLabs stream the web tests replay
(web/src/lib/lipsync/__tests__/cues.test.ts, lib/server/__tests__/speechAlign.test.ts and speechCache.test.ts).

One line streamed with character timestamps (Flash v2.5, 24 kHz PCM) on one of the account's premade voices
(FTV_PROBE_VOICE_ID to pick another), so no voice is designed or saved. Costs ~95 characters of credit. Also checks
what the web app relies on: character times are absolute from the clip start, not per chunk.
"""
from __future__ import annotations

import itertools
import json
import os

import requests
from dotenv import load_dotenv

from .gnm import PIPELINE_DIR, REPO_DIR

load_dotenv(REPO_DIR / "web" / ".env.local", override=False)
API = "https://api.elevenlabs.io/v1"
FIXTURE = PIPELINE_DIR / "tests" / "fixtures" / "stream.ndjson"
PLOSIVE_LINE = "Peter Piper picked a peck of pickled peppers, but Bob bought a big blue bat before breakfast."


def main() -> None:
    key = os.environ.get("ELEVENLABS_API_KEY")
    if not key:
        raise SystemExit("ELEVENLABS_API_KEY is not set (put it in web/.env.local)")
    s = requests.Session()
    s.headers.update({"xi-api-key": key})
    voice = os.environ.get("FTV_PROBE_VOICE_ID")
    if not voice:
        r = s.get(f"{API}/voices", timeout=30)
        r.raise_for_status()
        voices = r.json()["voices"]
        voice = next((v for v in voices if v.get("category") == "premade"), voices[0])["voice_id"]

    r = s.post(f"{API}/text-to-speech/{voice}/stream/with-timestamps", params={"output_format": "pcm_24000"},
               json={"text": PLOSIVE_LINE, "model_id": "eleven_flash_v2_5", "apply_text_normalization": "auto"},
               timeout=120, stream=True)
    r.raise_for_status()
    lines = [raw for raw in r.iter_lines() if raw]
    starts = [t for c in map(json.loads, lines) if c.get("alignment") for t in c["alignment"]["character_start_times_seconds"]]
    if not starts:
        raise SystemExit("the stream carried no alignment; the fixture was not changed")
    absolute = all(b >= a for a, b in itertools.pairwise(starts))
    FIXTURE.write_bytes(b"\n".join(lines) + b"\n")
    print(f"{len(lines)} chunks, {len(starts)} characters, times absolute across chunks: {absolute} -> {FIXTURE.relative_to(REPO_DIR)}")


if __name__ == "__main__":
    main()
