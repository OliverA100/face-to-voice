/**
 * Spoken lines, aligned and cached. A paid generation is read to its end (ElevenLabs streams a line ~0.55 s after its
 * first byte, p90 0.87 s), timed by forced alignment on its audio (alignSpeech.ts, ~0.3 s) and sent with that alignment
 * in front, so even a line's first play has the aligned mouth; the same text goes to the cache. A
 * repeat of the same line in the same voice is served from the cache for free.
 */
import "server-only";

import { after } from "next/server";

import { alignedLine, hasAligned } from "./alignSpeech";
import { cacheGet, cacheSet, storeAudio } from "./cache";
import { streamSpeech, TTS_MODEL } from "./elevenlabs";
import { env } from "./env";
import { ttsKey } from "./keys";

/** In dev without Blob the NDJSON text lives in process memory (small: ~300 KB per line). */
const memClips = new Map<string, string>();

const streamOf = (ndjson: string) => new Response(ndjson).body!;

/**
 * `text` is what ElevenLabs gets, emotion tag included (lib/server/emotion.ts spokenText). Null
 * when this line was never spoken in this voice.
 */
export async function cachedSpeech(voiceId: string, text: string): Promise<ReadableStream<Uint8Array> | null> {
  const key = ttsKey(voiceId, TTS_MODEL, text);
  const pointer = await cacheGet<{ url: string }>(`ftv:tts:${key}`);
  if (!pointer) return null;
  const cached = memClips.get(key) ?? (pointer.url.startsWith("data:") ? null : await fetch(pointer.url).then((r) => (r.ok ? r.text() : null)).catch(() => null));
  if (!cached) return null;
  if (hasAligned(cached)) return streamOf(cached);
  // cached without aligned times: aligned now, once, and cached again with them
  const line = await alignedLine(cached, text);
  if (line === undefined) return streamOf(cached);
  after(() => store(key, line + cached));
  return streamOf(line + cached);
}

/** A paid generation: the whole ElevenLabs stream, with its aligned line in front, cached once it is complete. */
export async function generateSpeech(voiceId: string, text: string): Promise<ReadableStream<Uint8Array>> {
  const key = ttsKey(voiceId, TTS_MODEL, text);
  const ndjson = await readAll(await streamSpeech(voiceId, text));
  if (!completeClip(ndjson, text)) {
    if (ndjson.trim()) console.warn("[speech] incomplete stream; not cached");
    return streamOf(ndjson); // what arrived plays, on its stamps
  }
  const line = await alignedLine(ndjson, text);
  const clip = (line ?? "") + ndjson;
  after(() => store(key, clip));
  return streamOf(clip);
}

/** The stream's text to its end, or as far as it got when it broke off (an error before anything arrived is thrown). */
async function readAll(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let out = "";
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      out += decoder.decode(value, { stream: true });
    }
  } catch (e) {
    if (!out) throw e;
    console.warn("[speech] stream broke off:", e instanceof Error ? e.message : e);
  }
  return out + decoder.decode();
}

/** The clip in the cache: Blob (an aligned clip under its own name: a stored file is never overwritten) or memory. */
async function store(key: string, clip: string): Promise<void> {
  try {
    if (env.hasBlob) {
      const url = await storeAudio(`tts/${key}${hasAligned(clip) ? ".aligned" : ""}.ndjson`, new TextEncoder().encode(clip), "application/x-ndjson");
      await cacheSet(`ftv:tts:${key}`, { url });
    } else {
      memClips.set(key, clip);
      await cacheSet(`ftv:tts:${key}`, { url: "data:memory" });
    }
  } catch (e) {
    console.warn("[speech] cache write failed:", e instanceof Error ? e.message : e);
  }
}

type Line = { audio_base64?: unknown; alignment?: { characters?: unknown; character_end_times_seconds?: unknown } | null };

/** Samples per second of the stream's 16-bit mono audio (elevenlabs.ts TTS_OUTPUT_FORMAT pcm_24000). */
const PCM_RATE = 24000;
/** How far the audio may end before the last character's end time (eleven_v4_turbo measured 0.08 s short). */
const AUDIO_SLACK_S = 0.25;

/**
 * Whether a finished stream is the whole line, so it may be served to everyone from the cache (a stored clip is never
 * overwritten: cache.ts storeAudio). Every line must be a chunk with audio, the alignment must reach the end of the
 * text (the emotion tag at the start may or may not be in it), and the audio must last as long as the alignment says.
 */
export function completeClip(ndjson: string, text: string): boolean {
  const lines = ndjson.split("\n").filter((l) => l.trim());
  if (!lines.length) return false;
  let chars = "";
  let lastEnd = 0;
  let pcmBytes = 0;
  for (const l of lines) {
    let line: Line;
    try {
      line = JSON.parse(l) as Line;
    } catch {
      return false;
    }
    if (!line || typeof line.audio_base64 !== "string") return false;
    pcmBytes += Buffer.byteLength(line.audio_base64, "base64");
    const a = line.alignment;
    if (a && Array.isArray(a.characters) && Array.isArray(a.character_end_times_seconds)) {
      chars += a.characters.join("");
      for (const t of a.character_end_times_seconds) if (typeof t === "number" && t > lastEnd) lastEnd = t;
    }
  }
  const bare = (s: string) => s.replace(/\s+/g, "");
  const spoken = bare(text.replace(/^\[[^\]]*\]/, ""));
  return !!spoken && bare(chars).endsWith(spoken) && pcmBytes / 2 / PCM_RATE >= lastEnd - AUDIO_SLACK_S;
}

export function speechHeaders(cached: boolean): Record<string, string> {
  return { "content-type": "application/x-ndjson", "cache-control": "no-store", "x-ftv-cache": cached ? "hit" : "miss" };
}
