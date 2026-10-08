/**
 * Spoken lines, cached. The ElevenLabs stream (elevenlabs.ts streamSpeech) is passed through untouched so the
 * browser can start playing the first chunk while the rest is still arriving, and teed into a cache write once
 * the response is done. A repeat of the same line in the same voice is served from the cache for free.
 */
import "server-only";

import { after } from "next/server";

import { cacheGet, cacheSet, storeAudio } from "./cache";
import { streamSpeech, TTS_MODEL } from "./elevenlabs";
import { env } from "./env";
import { ttsKey } from "./keys";

/** In dev without Blob the NDJSON text lives in process memory (small: ~300 KB per line). */
const memClips = new Map<string, string>();

/** `text` is what ElevenLabs gets, emotion tag included (lib/server/emotion.ts spokenText). Null when this line was never spoken in this voice. */
export async function cachedSpeech(voiceId: string, text: string): Promise<ReadableStream<Uint8Array> | null> {
  const key = ttsKey(voiceId, TTS_MODEL, text);
  const pointer = await cacheGet<{ url: string }>(`ftv:tts:${key}`);
  if (!pointer) return null;
  const cached = memClips.get(key) ?? (pointer.url.startsWith("data:") ? null : await fetch(pointer.url).then((r) => (r.ok ? r.text() : null)).catch(() => null));
  return cached ? new Response(cached).body! : null;
}

/** A paid generation: the ElevenLabs stream for the browser, written to the cache once it is complete. */
export async function generateSpeech(voiceId: string, text: string): Promise<ReadableStream<Uint8Array>> {
  const key = ttsKey(voiceId, TTS_MODEL, text);
  const [toClient, toStore] = (await streamSpeech(voiceId, text)).tee();
  after(async () => {
    try {
      const ndjson = await new Response(toStore).text();
      if (!completeClip(ndjson, text)) {
        if (ndjson.trim()) console.warn("[speech] incomplete stream; not cached");
        return;
      }
      if (env.hasBlob) {
        const url = await storeAudio(`tts/${key}.ndjson`, new TextEncoder().encode(ndjson), "application/x-ndjson");
        await cacheSet(`ftv:tts:${key}`, { url });
      } else {
        memClips.set(key, ndjson);
        await cacheSet(`ftv:tts:${key}`, { url: "data:memory" });
      }
    } catch (e) {
      console.warn("[speech] cache write failed:", e instanceof Error ? e.message : e);
    }
  });
  return toClient;
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
