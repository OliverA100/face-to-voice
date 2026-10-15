# /// script
# requires-python = ">=3.11"
# dependencies = []
# ///
"""ElevenLabs Speech to Text (Scribe) for saved lines: what the voice really says, with each word's and character's
times on the clip's own clock. Unlike Forced Alignment it is not told the text, so a word the voice says twice ("Adding
fast fast leads…", a voice glitch) or skips shows up as such. → out/stt/<clip>.json (the response + the line's text).
The API key is read from web/.env.local (ELEVENLABS_API_KEY) and never printed.

  uv run stt.py out/clips/T1-t013-worried.ndjson [...]       (skips clips already done)
"""
import json, sys, urllib.request, uuid
from pathlib import Path

HERE = Path(__file__).parent
sys.path.insert(0, str(HERE))
from fa import KEY, clip  # noqa: E402

OUT = HERE / "out" / "stt"


def transcribe(wav: bytes) -> dict:
    b = uuid.uuid4().hex
    fields = {"model_id": "scribe_v1", "timestamps_granularity": "character", "tag_audio_events": "true", "language_code": "en"}
    body = b"".join(f'--{b}\r\nContent-Disposition: form-data; name="{k}"\r\n\r\n{v}\r\n'.encode() for k, v in fields.items())
    body += f'--{b}\r\nContent-Disposition: form-data; name="file"; filename="clip.wav"\r\nContent-Type: audio/wav\r\n\r\n'.encode() + wav + f"\r\n--{b}--\r\n".encode()
    req = urllib.request.Request("https://api.elevenlabs.io/v1/speech-to-text", data=body, method="POST", headers={"xi-api-key": KEY, "Content-Type": f"multipart/form-data; boundary={b}"})
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
            res = transcribe(wav)
        except urllib.error.HTTPError as e:
            print(nd.stem, "HTTP", e.code, e.read()[:300].decode(errors="ignore"))
            continue
        res["line_text"] = text
        dst.write_text(json.dumps(res))
        print(nd.stem, "|", res.get("text", "")[:90])
