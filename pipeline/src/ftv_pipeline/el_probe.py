"""`uv run el-probe`: one-off live checks of the ElevenLabs behaviour the web app depends on.

Answers, with the real account key, the questions the docs leave open:
  1. plan tier, voice slots and monthly add/edit operations (GET /v1/user/subscription)
  2. can text-to-speech run on an UNSAVED generated_voice_id? (expected: no)
  3. does saving consume an add/edit operation, and does deleting free the slot at once?
  4. streaming with timestamps: content-type, chunk count, are character times absolute?
     (records the raw NDJSON to tests/fixtures/stream.ndjson, the fixture of web/src/lib/lipsync/__tests__/cues.test.ts)
  5. does eleven_v3 return alignment on the TTS timestamp endpoints?
Costs: the preview text once (~200 characters), two short TTS lines, one voice slot for a
few seconds, one voice add/edit operation. The voice is deleted at the end.

`uv run el-probe --emotion` instead compares ways to make a line sound emotional (Flash v2.5 with
voice settings vs audio tags on eleven_v4_turbo / eleven_v3) on one of the account's premade voices:
no voice is created or saved. Costs ~450 characters. Writes out/el_emotion/{results.json, *.wav}.
"""
from __future__ import annotations

import base64
import itertools
import json
import os
import sys
import time
import wave

import requests
from dotenv import load_dotenv

from .gnm import OUT_DIR, PIPELINE_DIR, REPO_DIR

load_dotenv(REPO_DIR / "web" / ".env.local", override=False)
API = "https://api.elevenlabs.io/v1"
FIXTURES = PIPELINE_DIR / "tests" / "fixtures"

DESCRIPTION = ("Native English. Gender-neutral, in their 30s. Good quality. Persona: relaxed everyday speaker. "
               "Emotion: calm, friendly, warm. Medium pitch with a rounded timbre and an unhurried conversational pace.")
PREVIEW_TEXT = ("It has been quiet lately, and honestly I have not minded it one bit. I have had time to think, "
                "to slow down, and to notice the small things again. Maybe that is exactly what I needed.")
PLOSIVE_LINE = "Peter Piper picked a peck of pickled peppers, but Bob bought a big blue bat before breakfast."

EMOTION_LINE = "I can't believe it. We actually did it, after all this time."
# (name, model, text prefix, voice_settings): what the speak route could send for "happy" / "sad"
EMOTION_VARIANTS = [
    ("flash_warmup", "eleven_flash_v2_5", "", None),  # connection warm-up, not reported
    ("flash_neutral", "eleven_flash_v2_5", "", None),
    ("flash_happy", "eleven_flash_v2_5", "", {"stability": 0.35}),
    ("flash_sad", "eleven_flash_v2_5", "", {"stability": 0.4}),
    ("v4turbo_neutral", "eleven_v4_turbo", "", None),
    ("v4turbo_happy", "eleven_v4_turbo", "[happy] ", None),
    ("v4turbo_sad", "eleven_v4_turbo", "[sad] ", None),
    ("v3_happy", "eleven_v3", "[happy] ", None),
]


def emotion_probe(s: requests.Session) -> None:
    out = OUT_DIR / "el_emotion"
    out.mkdir(parents=True, exist_ok=True)
    r = s.get(f"{API}/voices", timeout=30)
    r.raise_for_status()
    voices = [v for v in r.json()["voices"] if v.get("category") == "premade"] or r.json()["voices"]
    voice = os.environ.get("FTV_PROBE_VOICE_ID") or voices[0]["voice_id"]
    name = next((v["name"] for v in r.json()["voices"] if v["voice_id"] == voice), voice)
    print(f"voice: {name} ({voice}); line: {EMOTION_LINE!r}")
    rows = []
    for variant, model, prefix, settings in EMOTION_VARIANTS:
        text = prefix + EMOTION_LINE
        body = {"text": text, "model_id": model, "apply_text_normalization": "auto"}
        if settings:
            body["voice_settings"] = settings
        t0 = time.time()
        r = s.post(f"{API}/text-to-speech/{voice}/stream/with-timestamps", params={"output_format": "pcm_24000"},
                   json=body, timeout=120, stream=True)
        first, lines = None, []
        for raw in r.iter_lines():
            if raw and first is None:
                first = time.time() - t0
            if raw:
                lines.append(raw)
        total = time.time() - t0
        row = {"variant": variant, "model": model, "text": text, "voice_settings": settings, "status": r.status_code,
               "first_chunk_s": round(first or 0, 3), "total_s": round(total, 2)}
        if r.status_code == 200:
            chunks = [json.loads(l) for l in lines]
            pcm = b"".join(base64.b64decode(c["audio_base64"]) for c in chunks if c.get("audio_base64"))
            aligned = [c for c in chunks if c.get("alignment")]
            chars = "".join(ch for c in aligned for ch in c["alignment"]["characters"])
            row.update({"audio_s": round(len(pcm) / 2 / 24000, 2), "alignment": bool(aligned),
                        "tag_in_alignment": "[" in chars, "aligned_text_start": chars[:24],
                        "chars_billed": len(text)})
            with wave.open(str(out / f"{variant}.wav"), "wb") as w:
                w.setnchannels(1)
                w.setsampwidth(2)
                w.setframerate(24000)
                w.writeframes(pcm)
        else:
            row["error"] = r.text[:300]
        if variant != "flash_warmup":
            rows.append(row)
        print(f"  {variant:16s} {r.status_code} first {row['first_chunk_s']:.2f}s total {row['total_s']:.2f}s "
              f"audio {row.get('audio_s', 0):.2f}s alignment {row.get('alignment')} tag-in-alignment {row.get('tag_in_alignment')}"
              + (f"  {row.get('error', '')[:120]}" if r.status_code != 200 else ""))
    (out / "results.json").write_text(json.dumps({"voice": {"id": voice, "name": name}, "rows": rows}, indent=2) + "\n")
    print(f"-> {out}")


def main() -> None:
    key = os.environ.get("ELEVENLABS_API_KEY")
    if not key:
        raise SystemExit("ELEVENLABS_API_KEY is not set (put it in web/.env.local)")
    s = requests.Session()
    s.headers.update({"xi-api-key": key})
    if "--emotion" in sys.argv[1:]:
        emotion_probe(s)
        return
    results: dict[str, object] = {}
    missing: list[str] = []

    def perm_error(r: requests.Response, step: str) -> bool:
        """Record a scoped-key permission error and let the probe continue."""
        if r.status_code in (401, 403):
            try:
                msg = r.json()["detail"]["message"]
            except Exception:
                msg = r.text[:160]
            missing.append(f"{step}: {msg}")
            print(f"  ! {step}: {r.status_code} {msg}")
            return True
        return False

    def sub() -> dict:
        r = s.get(f"{API}/user/subscription", timeout=30)
        if perm_error(r, "GET /v1/user/subscription"):
            return {"unavailable": "user_read permission missing"}
        r.raise_for_status()
        d = r.json()
        return {k: d.get(k) for k in ("tier", "character_count", "character_limit", "voice_slots_used", "voice_limit",
                                       "voice_add_edit_counter", "max_voice_add_edits", "next_character_count_reset_unix")}

    before = sub()
    results["subscription_before"] = before
    print("subscription:", before)

    # 1. Design three previews.
    t0 = time.time()
    r = s.post(f"{API}/text-to-voice/design", params={"output_format": "mp3_44100_128"}, timeout=120,
               json={"model_id": "eleven_ttv_v3", "voice_description": DESCRIPTION, "text": PREVIEW_TEXT,
                     "guidance_scale": 8, "loudness": 0.5, "seed": 12345})
    print("design:", r.status_code, f"{time.time() - t0:.1f}s")
    if perm_error(r, "POST /v1/text-to-voice/design"):
        results["missing_permissions"] = missing
        (OUT_DIR / "probe_results.json").write_text(json.dumps(results, indent=2) + "\n")
        raise SystemExit("cannot continue without Voice Design permission; see the list above")
    r.raise_for_status()
    previews = r.json()["previews"]
    results["design"] = {"previews": len(previews), "seconds": round(time.time() - t0, 1),
                         "preview_bytes": [len(p["audio_base_64"]) * 3 // 4 for p in previews],
                         "durations": [p["duration_secs"] for p in previews]}
    gen_id = previews[0]["generated_voice_id"]
    (OUT_DIR / "probe_preview_0.mp3").write_bytes(base64.b64decode(previews[0]["audio_base_64"]))

    # 2. TTS on the unsaved generated_voice_id.
    r = s.post(f"{API}/text-to-speech/{gen_id}/with-timestamps", params={"output_format": "pcm_24000"}, timeout=60,
               json={"text": "Hello, nice to meet you.", "model_id": "eleven_flash_v2_5"})
    results["tts_on_unsaved_id"] = {"status": r.status_code, "body": r.text[:200]}
    print("tts on unsaved generated_voice_id:", r.status_code, r.text[:120])

    # 3. Save, check counters, then TTS.
    r = s.post(f"{API}/text-to-voice", timeout=60, json={
        "voice_name": "face-to-voice probe", "voice_description": DESCRIPTION, "generated_voice_id": gen_id,
        "labels": {"app": "face-to-voice", "probe": "true"}})
    print("save:", r.status_code, r.text[:120] if r.status_code != 200 else "")
    if perm_error(r, "POST /v1/text-to-voice (save)"):
        results["missing_permissions"] = missing
        (OUT_DIR / "probe_results.json").write_text(json.dumps(results, indent=2) + "\n")
        raise SystemExit("cannot continue without permission to save voices; see the list above")
    r.raise_for_status()
    voice_id = r.json()["voice_id"]
    after_save = sub()
    results["subscription_after_save"] = after_save
    print("after save:", after_save)

    try:
        # 4. Streaming with timestamps (Flash v2.5, PCM 24 kHz).
        t0 = time.time()
        r = s.post(f"{API}/text-to-speech/{voice_id}/stream/with-timestamps",
                   params={"output_format": "pcm_24000"}, timeout=120, stream=True,
                   json={"text": PLOSIVE_LINE, "model_id": "eleven_flash_v2_5", "apply_text_normalization": "auto"})
        first = None
        lines = []
        for raw in r.iter_lines():
            if first is None:
                first = time.time() - t0
            if raw:
                lines.append(raw)
        total = time.time() - t0
        print("stream:", r.status_code, r.headers.get("content-type"), f"{len(lines)} lines, first chunk {first or 0:.2f}s, total {total:.2f}s")
        if perm_error(r, "POST /v1/text-to-speech/{id}/stream/with-timestamps"):
            raise RuntimeError("text-to-speech permission missing")
        r.raise_for_status()
        FIXTURES.mkdir(parents=True, exist_ok=True)
        (FIXTURES / "stream.ndjson").write_bytes(b"\n".join(lines) + b"\n")
        chunks = [json.loads(l) for l in lines]
        with_align = [c for c in chunks if c.get("alignment")]
        starts = [t for c in with_align for t in c["alignment"]["character_start_times_seconds"]]
        firsts = [c["alignment"]["character_start_times_seconds"][0] for c in with_align]
        monotonic = all(b >= a for a, b in itertools.pairwise(starts))
        audio_secs = sum(len(c["audio_base64"]) * 3 // 4 for c in chunks) / 2 / 24000
        results["stream"] = {
            "content_type": r.headers.get("content-type"), "lines": len(lines), "lines_with_alignment": len(with_align),
            "first_chunk_seconds": round(first, 3), "total_seconds": round(total, 2), "audio_seconds": round(audio_secs, 2),
            "chunk_first_start_times": [round(f, 3) for f in firsts], "times_monotonic_across_chunks": monotonic,
            "last_char_end": round(max(t for c in with_align for t in c["alignment"]["character_end_times_seconds"]), 3),
            "has_normalized_alignment": any(c.get("normalized_alignment") for c in chunks),
            "characters_sample": "".join(with_align[0]["alignment"]["characters"][:30]) if with_align else "",
        }
        print("  chunk first-start times:", results["stream"]["chunk_first_start_times"], "monotonic:", monotonic,
              "| audio", round(audio_secs, 2), "s, last char end", results["stream"]["last_char_end"], "s")

        # 5. eleven_v3 on the timestamp endpoint.
        r = s.post(f"{API}/text-to-speech/{voice_id}/with-timestamps", params={"output_format": "pcm_24000"}, timeout=120,
                   json={"text": "Hello, nice to meet you.", "model_id": "eleven_v3"})
        ok = r.status_code == 200
        results["v3_timestamps"] = {"status": r.status_code, "alignment": bool(ok and r.json().get("alignment")),
                                    "body": "" if ok else r.text[:200]}
        print("eleven_v3 with-timestamps:", r.status_code, "alignment:", results["v3_timestamps"]["alignment"], "" if ok else r.text[:120])
    finally:
        # 6. Delete the probe voice and check the counters again.
        r = s.delete(f"{API}/voices/{voice_id}", timeout=60)
        print("delete:", r.status_code)
        perm_error(r, "DELETE /v1/voices/{id}")
        after_delete = sub()
        results["subscription_after_delete"] = after_delete
        print("after delete:", after_delete)

    results["missing_permissions"] = missing
    results["summary"] = {
        "tts_on_unsaved_generated_voice_id": results["tts_on_unsaved_id"]["status"] == 200,
        "save_consumed_add_edit_op": after_save.get("voice_add_edit_counter") != before.get("voice_add_edit_counter") if "unavailable" not in before else None,
        "delete_freed_slot": after_delete.get("voice_slots_used") == before.get("voice_slots_used") if "unavailable" not in before else None,
        "stream_times_absolute": results.get("stream", {}).get("times_monotonic_across_chunks"),
        "v3_alignment": results.get("v3_timestamps", {}).get("alignment"),
    }
    (OUT_DIR / "probe_results.json").write_text(json.dumps(results, indent=2) + "\n")
    print("\nSUMMARY:", json.dumps(results["summary"], indent=2))
    print(f"results -> {OUT_DIR / 'probe_results.json'}, fixture -> {FIXTURES / 'stream.ndjson'}")


if __name__ == "__main__":
    main()
