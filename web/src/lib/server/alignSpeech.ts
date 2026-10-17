/**
 * A spoken line's times from forced alignment on its own audio (elevenlabs.ts forcedAlignment), sent to the browser
 * before the audio as one NDJSON line, {"aligned": {characters, character_start_times_seconds, …}}. eleven_v4_turbo's
 * own stamps spread a word's letters evenly and can put a word ~0.2 s off; the aligned times are where it is said, and
 * the mouth then only snaps closures and vowels onto the sound (evaluator.ts SpeechSource.aligned). The line-test review
 * (2026-10-14, the 300 Harvard lines in six voices) passed every line this way. {"aligned": null}: aligned, but nothing
 * came back; the stamps are used.
 */
import "server-only";

import type { Alignment } from "@/lib/lipsync/cues";

import { forcedAlignment, type ForcedAlignment } from "./elevenlabs";
import { env } from "./env";
import { phonemesFor } from "./pronounce";

/** Samples per second of the stream's 16-bit mono audio (elevenlabs.ts TTS_OUTPUT_FORMAT pcm_24000). */
const PCM_RATE = 24000;
/** A word aligned shorter than this per sound (s) beside a "pause" that has speech in it was misplaced (fixSqueezed). */
const MIN_PER_SOUND = 0.025;
/** Loudness (dB under the line's peak, per 10 ms) that counts as speech for fixSqueezed. */
const SPEECH_DB = -25;
/** fixSqueezed: this many 10 ms blocks of speech beside a squeezed word are the speech it was said over. */
const SPEECH_BLOCKS = 6;

type Chunk = { audio_base64?: unknown; alignment?: Alignment | null; normalized_alignment?: Alignment | null; aligned?: unknown };

/** Whether a stored clip carries its aligned line already. */
export function hasAligned(ndjson: string): boolean {
  return ndjson.startsWith('{"aligned"');
}

/** The clip's 16-bit audio, and the text its stamps say with audio tags left out ("[happy] " is not said). */
function clipAudio(ndjson: string): { pcm: Buffer; text: string } {
  const parts: Buffer[] = [];
  let chars = "";
  for (const l of ndjson.split("\n")) {
    if (!l.trim()) continue;
    let j: Chunk;
    try {
      j = JSON.parse(l) as Chunk;
    } catch {
      continue;
    }
    if (typeof j.audio_base64 === "string") parts.push(Buffer.from(j.audio_base64, "base64"));
    const a = j.normalized_alignment ?? j.alignment;
    if (a?.characters) chars += a.characters.join("");
  }
  const text = chars.replace(/\[[^\]]*\]/g, " ").replace(/\s+/g, " ").trim();
  return { pcm: Buffer.concat(parts), text };
}

/** The audio as a mono WAV file. */
export function wavOf(pcm: Buffer): Uint8Array {
  const bytes = pcm.length & ~1;
  const out = Buffer.alloc(44 + bytes);
  out.write("RIFF", 0);
  out.writeUInt32LE(36 + bytes, 4);
  out.write("WAVEfmt ", 8);
  out.writeUInt32LE(16, 16);
  out.writeUInt16LE(1, 20); // PCM
  out.writeUInt16LE(1, 22); // mono
  out.writeUInt32LE(PCM_RATE, 24);
  out.writeUInt32LE(PCM_RATE * 2, 28);
  out.writeUInt16LE(2, 32);
  out.writeUInt16LE(16, 34);
  out.write("data", 36);
  out.writeUInt32LE(bytes, 40);
  pcm.copy(out, 44, 0, bytes);
  return out;
}

/** Loudness per 10 ms block in dB under the loudest block. */
function blocksDb(pcm: Buffer): Float64Array {
  const per = PCM_RATE / 100;
  const n = Math.floor(pcm.length / 2 / per);
  const db = new Float64Array(n);
  let peak = -Infinity;
  for (let k = 0; k < n; k++) {
    let sum = 0;
    for (let i = 0; i < per; i++) {
      const x = pcm.readInt16LE((k * per + i) * 2) / 32768;
      sum += x * x;
    }
    db[k] = 20 * Math.log10(Math.max(Math.sqrt(sum / per), 1e-5));
    if (db[k] > peak) peak = db[k];
  }
  for (let k = 0; k < n; k++) db[k] -= peak;
  return db;
}

const round3 = (x: number) => Math.round(x * 1000) / 1000;

/**
 * Forced alignment can squeeze a word into a few milliseconds at the edge of its own sound and call the speech beside it
 * a pause ("an X that": the "X" put on the end of its own "s", the spoken "e" taken for a pause). A word aligned far
 * shorter than its sounds (MIN_PER_SOUND each) next to a "pause" with speech in it is stretched over that speech, its
 * letters spread evenly. In place; returns how many words moved.
 */
export function fixSqueezed(chars: ForcedAlignment["characters"], pcm: Buffer, phonemes: Record<string, string>): number {
  const db = blocksDb(pcm);
  const n = db.length;
  const speech = (a: number, b: number) => {
    const out: number[] = [];
    for (let k = Math.max(0, Math.trunc(a * 100)); k < Math.min(n, Math.trunc(b * 100)); k++) if (db[k] > SPEECH_DB) out.push(k / 100);
    return out;
  };
  const words: number[][] = [];
  let cur: number[] = [];
  chars.forEach((c, i) => {
    if (c.text.trim()) cur.push(i);
    else if (cur.length) {
      words.push(cur);
      cur = [];
    }
  });
  if (cur.length) words.push(cur);
  let fixed = 0;
  words.forEach((idx, wi) => {
    const text = idx.map((i) => chars[i].text).join("");
    const said = phonemes[text.toLowerCase().replace(/[^a-z']/g, "")];
    const sounds = (said ? said.split(" ").length : 0) || text.replace(/[^A-Za-z]/g, "").length || 1;
    const a = chars[idx[0]].start, b = chars[idx[idx.length - 1]].end;
    if (b - a >= MIN_PER_SOUND * sounds) return;
    const prevEnd = wi ? chars[words[wi - 1][words[wi - 1].length - 1]].end : 0;
    const nextStart = wi + 1 < words.length ? chars[words[wi + 1][0]].start : n / 100;
    const before = speech(prevEnd + 0.03, a), after = speech(b, nextStart - 0.03);
    if (before.length < SPEECH_BLOCKS && after.length < SPEECH_BLOCKS) return; // no speech beside it: left
    const na = before.length >= SPEECH_BLOCKS ? before[0] : a;
    const nb = after.length >= SPEECH_BLOCKS ? after[after.length - 1] + 0.01 : b;
    const step = (nb - na) / idx.length;
    idx.forEach((i, k) => {
      chars[i].start = round3(na + k * step);
      chars[i].end = round3(na + (k + 1) * step);
    });
    fixed++;
  });
  return fixed;
}

function toAlignment(chars: ForcedAlignment["characters"]): Alignment {
  return { characters: chars.map((c) => c.text), character_start_times_seconds: chars.map((c) => c.start), character_end_times_seconds: chars.map((c) => c.end) };
}

/**
 * The clip's {"aligned"} line (with its newline), or undefined when alignment could not be asked (an outage, a timeout,
 * mock speech): the line is then played on its stamps and asked again next time. `spoken` is what ElevenLabs was given.
 */
export async function alignedLine(ndjson: string, spoken: string): Promise<string | undefined> {
  if (env.mockElevenLabs && !env.savedVoices) return undefined; // the mock's tone says nothing to align
  const { pcm, text } = clipAudio(ndjson);
  if (!text || pcm.length < 2) return undefined;
  let fa: ForcedAlignment;
  try {
    fa = await forcedAlignment(wavOf(pcm), text);
  } catch (e) {
    console.warn("[speech] forced alignment failed:", e instanceof Error ? e.message : e);
    return undefined;
  }
  const chars = Array.isArray(fa.characters) ? fa.characters.filter((c) => typeof c?.text === "string" && Number.isFinite(c.start) && Number.isFinite(c.end)) : [];
  if (!chars.length) return JSON.stringify({ aligned: null }) + "\n";
  fixSqueezed(chars, pcm, phonemesFor(spoken));
  return JSON.stringify({ aligned: toAlignment(chars) }) + "\n";
}
