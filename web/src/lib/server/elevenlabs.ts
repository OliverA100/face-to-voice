/**
 * Every ElevenLabs call, all server-side: plain fetch against the REST API (field names as in its
 * OpenAPI spec). Set FTV_MOCK_ELEVENLABS=1 in .env.local to develop without a paid plan: previews
 * become short generated tones, speech a synthetic stream, and no voice is ever created.
 */
import "server-only";

import { createHash } from "node:crypto";

import { env } from "./env";
import { ApiError, MESSAGES } from "./errors";

const API = "https://api.elevenlabs.io";
const DESIGN_MODEL = "eleven_ttv_v3";
// eleven_v4_turbo rather than Flash v2.5: it reads audio tags, so a line can sound happy or sad, and it streams
// timestamps like Flash. The cost is first audio at ~0.40 s vs Flash's ~0.26 s (`uv run el-probe --emotion`).
export const TTS_MODEL = "eleven_v4_turbo";
const TTS_OUTPUT_FORMAT = "pcm_24000"; // raw 16-bit mono: not tier-gated, and the browser decodes it in one line
const MOCK = env.mockElevenLabs;

export interface Preview {
  generatedVoiceId: string;
  audio: Uint8Array;
  mediaType: string;
  durationSecs: number;
}

/** A non-OK answer from ElevenLabs. Its status stays on the server (the browser gets MESSAGES.upstream): a 404 tells a
 *  deleted voice or an expired preview apart from an outage. */
export class UpstreamError extends ApiError {
  constructor(
    readonly upstreamStatus: number,
    readonly upstreamCode: string,
  ) {
    super("upstream", MESSAGES.upstream, 502);
  }
}

async function call(path: string, init: RequestInit & { query?: Record<string, string>; version?: "v1" | "v2" } = {}): Promise<Response> {
  const key = env.elevenLabsKey();
  if (!key) throw new ApiError("unavailable", MESSAGES.unavailable, 503);
  const url = new URL(`${API}/${init.version ?? "v1"}${path}`);
  for (const [k, v] of Object.entries(init.query ?? {})) url.searchParams.set(k, v);
  const res = await fetch(url, {
    ...init,
    headers: { "xi-api-key": key, "content-type": "application/json", ...(init.headers ?? {}) },
    signal: init.signal ?? AbortSignal.timeout(60_000),
  });
  if (!res.ok) {
    // Log the status and the machine-readable code only; never forward upstream bodies.
    const body = (await res.json().catch(() => null)) as { detail?: { status?: string; code?: string } } | null;
    const code = body?.detail?.status ?? body?.detail?.code ?? "";
    console.warn(`[elevenlabs] ${init.method ?? "GET"} ${path} -> ${res.status} ${code}`);
    if (res.status === 429) throw new ApiError("visitor_limit", MESSAGES.visitor_limit, 429);
    throw new UpstreamError(res.status, code);
  }
  return res;
}

/**
 * Voice Design settings used for every face. They travel with each voice record so the export can hand the
 * visitor the full request (lib/export). The same seed and inputs do NOT give the same voice again (probed), so
 * the export presents it as the recipe for a similar voice.
 */
export const DESIGN_SETTINGS = { modelId: DESIGN_MODEL, guidanceScale: 8, loudness: 0.5, outputFormat: "mp3_44100_128" } as const;
export type DesignSettings = typeof DESIGN_SETTINGS;

export async function designVoice(description: string, text: string, seed: number, timeoutMs = 120_000): Promise<{ previews: Preview[]; text: string; settings: DesignSettings }> {
  if (MOCK) return { ...mockDesign(description, seed), settings: DESIGN_SETTINGS };
  const s = DESIGN_SETTINGS;
  const res = await call("/text-to-voice/design", {
    method: "POST",
    query: { output_format: s.outputFormat },
    body: JSON.stringify({ model_id: s.modelId, voice_description: description, text, guidance_scale: s.guidanceScale, loudness: s.loudness, seed }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const data = (await res.json()) as { previews: { audio_base_64: string; generated_voice_id: string; media_type: string; duration_secs: number }[]; text: string };
  return {
    settings: s,
    text: data.text,
    previews: data.previews.map((p) => ({
      generatedVoiceId: p.generated_voice_id,
      audio: new Uint8Array(Buffer.from(p.audio_base_64, "base64")),
      mediaType: p.media_type || "audio/mpeg",
      durationSecs: p.duration_secs,
    })),
  };
}

export async function createVoice(name: string, description: string, generatedVoiceId: string): Promise<string> {
  if (MOCK) return `mock-voice-${generatedVoiceId.slice(-8)}`;
  const res = await call("/text-to-voice", {
    method: "POST",
    body: JSON.stringify({ voice_name: name, voice_description: description, generated_voice_id: generatedVoiceId, labels: { app: "face-to-voice" } }),
  });
  return ((await res.json()) as { voice_id: string }).voice_id;
}

/** Voices this app saved (createVoice names them "face-to-voice …"), oldest first. */
export async function listAppVoices(): Promise<{ voiceId: string; createdAt: number }[]> {
  if (MOCK) return [];
  const res = await call("/voices", {
    version: "v2",
    query: { voice_type: "personal", search: "face-to-voice", sort: "created_at_unix", sort_direction: "asc", page_size: "100" },
  });
  const data = (await res.json()) as { voices: { voice_id: string; name: string; created_at_unix: number }[] };
  return data.voices.filter((v) => v.name.startsWith("face-to-voice ")).map((v) => ({ voiceId: v.voice_id, createdAt: v.created_at_unix * 1000 }));
}

export async function deleteVoice(voiceId: string): Promise<void> {
  if (MOCK || voiceId.startsWith("mock-voice-")) return;
  try {
    await call(`/voices/${voiceId}`, { method: "DELETE" });
  } catch (e) {
    console.warn("[elevenlabs] delete failed for a pooled voice; slot may need manual cleanup");
    if (!(e instanceof ApiError)) throw e;
  }
}

export interface Subscription {
  tier: string;
  characterCount: number;
  characterLimit: number;
  voiceSlotsUsed: number;
  voiceLimit: number;
  voiceAddEditCounter: number;
  maxVoiceAddEdits: number;
}

/** Quotas; null when the key lacks the user_read scope or in mock mode. */
export async function subscription(): Promise<Subscription | null> {
  if (MOCK) return null;
  try {
    const d = (await (await call("/user/subscription")).json()) as Record<string, number | string>;
    return {
      tier: String(d.tier),
      characterCount: Number(d.character_count),
      characterLimit: Number(d.character_limit),
      voiceSlotsUsed: Number(d.voice_slots_used),
      voiceLimit: Number(d.voice_limit),
      voiceAddEditCounter: Number(d.voice_add_edit_counter),
      maxVoiceAddEdits: Number(d.max_voice_add_edits),
    };
  } catch {
    return null;
  }
}

/**
 * Text-to-speech with character timestamps, streamed as newline-delimited JSON
 * ({audio_base64, alignment, normalized_alignment}, TTS_OUTPUT_FORMAT audio). Character times are absolute from the
 * clip start (verified with `uv run el-probe`). `text` is sent as is, audio tag included.
 */
export async function streamSpeech(voiceId: string, text: string): Promise<ReadableStream<Uint8Array>> {
  if (MOCK) return mockSpeechStream(text);
  const res = await call(`/text-to-speech/${voiceId}/stream/with-timestamps`, {
    method: "POST",
    query: { output_format: TTS_OUTPUT_FORMAT },
    body: JSON.stringify({ text, model_id: TTS_MODEL, apply_text_normalization: "auto" }),
    signal: AbortSignal.timeout(45_000),
  });
  if (!res.body) throw new ApiError("upstream", MESSAGES.upstream, 502);
  return res.body;
}

// --- mock -----------------------------------------------------------------------------------

/** A 1.2 s WAV tone whose pitch follows the description hash, so the three previews differ. */
function toneWav(freq: number, seconds = 1.2, rate = 16000): Uint8Array {
  const n = Math.floor(seconds * rate);
  const buf = new ArrayBuffer(44 + n * 2);
  const v = new DataView(buf);
  const str = (o: number, s: string) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
  str(0, "RIFF"); v.setUint32(4, 36 + n * 2, true); str(8, "WAVE"); str(12, "fmt ");
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, rate, true); v.setUint32(28, rate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  str(36, "data"); v.setUint32(40, n * 2, true);
  for (let i = 0; i < n; i++) {
    const t = i / rate;
    const envl = Math.min(1, t * 8) * Math.min(1, (seconds - t) * 8);
    v.setInt16(44 + i * 2, Math.round(Math.sin(2 * Math.PI * freq * t) * envl * 0.4 * 32767), true);
  }
  return new Uint8Array(buf);
}

function mockDesign(description: string, seed: number): { previews: Preview[]; text: string } {
  const h = createHash("sha256").update(description + seed).digest();
  return {
    text: "(mock preview)",
    previews: [0, 1, 2].map((i) => ({
      generatedVoiceId: `mock-${h.toString("hex").slice(0, 12)}-${i}`,
      audio: toneWav(220 + h[i] * 2),
      mediaType: "audio/wav",
      durationSecs: 1.2,
    })),
  };
}

/** A buzzing tone with evenly spaced character times, so lip sync runs without credits. Like the real stream, an
 *  emotion tag at the start is in the alignment (the client drops it). */
function mockSpeechStream(text: string): ReadableStream<Uint8Array> {
  const rate = 24000;
  const perChar = 0.065;
  const chars = [...text];
  const seconds = Math.max(0.6, chars.length * perChar + 0.3);
  const n = Math.floor(seconds * rate);
  const pcm = new Int16Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / rate;
    const idx = Math.min(chars.length - 1, Math.floor(t / perChar));
    const vowel = /[aeiou]/i.test(chars[idx] ?? "");
    const f = vowel ? 140 : 90;
    const envl = t < seconds - 0.3 && chars[idx] !== " " ? 0.5 : 0.02;
    pcm[i] = Math.round(Math.sin(2 * Math.PI * f * t) * envl * 32767 * (0.6 + 0.4 * Math.sin(2 * Math.PI * 3 * t)));
  }
  const alignment = {
    characters: chars,
    character_start_times_seconds: chars.map((_, i) => +(i * perChar).toFixed(3)),
    character_end_times_seconds: chars.map((_, i) => +((i + 1) * perChar).toFixed(3)),
  };
  const bytes = new Uint8Array(pcm.buffer);
  const lines: string[] = [];
  const chunk = rate * 2 * 0.25; // 250 ms per line
  for (let off = 0; off < bytes.length; off += chunk) {
    const slice = bytes.subarray(off, Math.min(bytes.length, off + chunk));
    lines.push(JSON.stringify({ audio_base64: Buffer.from(slice).toString("base64"), alignment: off === 0 ? alignment : null, normalized_alignment: off === 0 ? alignment : null }));
  }
  return new Response(lines.join("\n") + "\n").body!;
}
