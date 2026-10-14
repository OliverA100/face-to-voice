# /// script
# requires-python = ">=3.11"
# dependencies = []
# ///
"""ElevenLabs Forced Alignment for saved lines: each clip's audio and the words it says (audio tags left out) →
out/fa/<clip>.json (characters and words with start/end in s on the clip's own clock). Billed as Speech to Text.
The API key is read from web/.env.local (ELEVENLABS_API_KEY) and never printed.

  uv run fa.py out/clips/A-plosive.ndjson [...]       (skips clips already done)
"""

import base64
import io
import json
import re
import sys
import urllib.request
import uuid
import wave
from pathlib import Path

HERE = Path(__file__).parent
OUT = HERE / "out" / "fa"
KEY = next((l.split("=", 1)[1].strip().strip('"') for l in (HERE / "../../web/.env.local").read_text().splitlines() if l.startswith("ELEVENLABS_API_KEY=")), None)


def clip(nd: Path) -> tuple[bytes, str]:
    """The clip as a 24 kHz mono WAV, and the text its alignment says (tags like "[happy]" left out)."""
    pcm, chars = b"", []
    for l in nd.read_text().splitlines():
        if not l.strip():
            continue
        j = json.loads(l)
        pcm += base64.b64decode(j.get("audio_base64") or "")
        a = j.get("normalized_alignment") or j.get("alignment")
        if a:
            chars += a["characters"]
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(24000)
        w.writeframes(pcm)
    text = re.sub(r"\[[^\]]*\]", " ", "".join(chars))
    return buf.getvalue(), re.sub(r"\s+", " ", text).strip()


def align(wav: bytes, text: str) -> dict:
    b = uuid.uuid4().hex
    body = (f'--{b}\r\nContent-Disposition: form-data; name="text"\r\n\r\n{text}\r\n'
            f'--{b}\r\nContent-Disposition: form-data; name="file"; filename="clip.wav"\r\nContent-Type: audio/wav\r\n\r\n').encode() + wav + f"\r\n--{b}--\r\n".encode()
    req = urllib.request.Request("https://api.elevenlabs.io/v1/forced-alignment", data=body, method="POST", headers={"xi-api-key": KEY, "Content-Type": f"multipart/form-data; boundary={b}"})
    with urllib.request.urlopen(req, timeout=120) as r:
        return json.loads(r.read())


if __name__ == "__main__":
    if not KEY:
        sys.exit("no ELEVENLABS_API_KEY in web/.env.local")
    OUT.mkdir(parents=True, exist_ok=True)
    for a in sys.argv[1:]:
        nd = Path(a)
        dst = OUT / (nd.stem + ".json")
        if dst.exists():
            continue
        wav, text = clip(nd)
        try:
            res = align(wav, text)
        except urllib.error.HTTPError as e:
            print(nd.stem, "HTTP", e.code, e.read()[:200].decode(errors="ignore"))
            continue
        res["text"] = text
        dst.write_text(json.dumps(res))
        print(nd.stem, len(res.get("words", [])), "words, loss", round(res.get("loss", 0), 3))
