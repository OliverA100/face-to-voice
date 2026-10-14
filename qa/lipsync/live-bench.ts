/*
 * Offline live-chat bench: replays recorded chat replies (chat.mjs runs: meta.json "live" + the heard audio) through the
 * app's own LiveSpeech (web/src/lib/lipsync/live.ts) and Mouth, with a simulated AudioContext clock, and writes the
 * lips' opening per frame for bench.py. What a chat gives the page, as a chat gives it:
 *   - the reply's words and the agent's own loudness ("sent"), up front (they arrive ahead of the audio);
 *   - the meter: the heard audio's 10 ms RMS (and > 2 kHz), LIVE.delay ahead of what is heard (the voice is held back);
 *   - the clock: ctx.currentTime stepping at --fps.
 *
 *   ./live-bench.sh [--tag live] [--set k=v,…] [--off part,…] [--delay s] <run> [<run> …]      (runs under out/runs)
 */
import fs from "node:fs";
import path from "node:path";

import dictionary from "@/data/phonemes.json";
import { LIPSYNC, LIPSYNC_PARTS } from "@/lib/lipsync/evaluator";
import { LIVE, LiveSpeech, type LiveWord } from "@/lib/lipsync/live";
import { Mouth } from "@/lib/lipsync/mouth";
import { addPhonemes, PHONEMES, spokenWords } from "@/lib/lipsync/phonemes";

const args = process.argv.slice(2);
const opt = (k: string, d: string) => {
  const i = args.indexOf(`--${k}`);
  if (i < 0) return d;
  const v = args[i + 1];
  args.splice(i, 2);
  return v;
};
const fps = Number(opt("fps", "120"));
const tag = opt("tag", "live");
const sets = opt("set", "");
const off = opt("off", "");
const delay = opt("delay", ""); // seconds the voice is held back (LIVE.delay): how far the meter sees ahead
const HERE = path.dirname(new URL(import.meta.url).pathname);
const RUNS = path.join(HERE, "out", "runs");
const OUT = path.join(HERE, "out", "bench");
const L = LIPSYNC as unknown as Record<string, unknown>;
for (const kv of sets.split(",").filter(Boolean)) {
  const [k, v] = kv.split("=");
  const keys = k.split(".");
  let o = L as Record<string, unknown>;
  for (const key of keys.slice(0, -1)) o = o[key] as Record<string, unknown>;
  o[keys.at(-1)!] = Number(v);
}
for (const p of off.split(",").filter(Boolean)) {
  if (p === "phonemes") PHONEMES.enabled = false;
  else (LIPSYNC_PARTS as Record<string, boolean>)[p] = false;
}
if (delay) LIVE.delay = Number(delay);
const DICT = dictionary as Record<string, string>;

/** 16-bit mono WAV → samples (−1..1) and rate. */
function wav(file: string): { x: Float32Array; sr: number } {
  const b = fs.readFileSync(file);
  const sr = b.readUInt32LE(24);
  const n = b.readUInt32LE(40) / 2;
  const x = new Float32Array(n);
  for (let i = 0; i < n; i++) x[i] = b.readInt16LE(44 + i * 2) / 32768;
  return { x, sr };
}

/** The meter's blocks (ctx time, RMS, RMS above 2 kHz) from the heard audio, 10 ms each, as the AudioWorklet posts them. */
function meterBlocks(x: Float32Array, sr: number, start: number, shift: number): number[][] {
  const block = Math.round(sr / 100);
  const w = (2 * Math.PI * 2000) / sr, cos = Math.cos(w), alpha = Math.sin(w) / Math.SQRT2, a0 = 1 + alpha;
  const [b0, b1, b2, a1, a2] = [(1 + cos) / 2 / a0, -(1 + cos) / a0, (1 + cos) / 2 / a0, (-2 * cos) / a0, (1 - alpha) / a0];
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  const out: number[][] = [];
  for (let k = 0; (k + 1) * block <= x.length; k++) {
    let e = 0, h = 0;
    for (let i = k * block; i < (k + 1) * block; i++) {
      const v = x[i];
      const y = b0 * v + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
      x2 = x1; x1 = v; y2 = y1; y1 = y;
      e += v * v;
      h += y * y;
    }
    out.push([start + (k * block) / sr - shift, Math.sqrt(e / block), Math.sqrt(h / block)]);
  }
  return out;
}

fs.mkdirSync(OUT, { recursive: true });
for (const run of args) {
  const dir = path.join(RUNS, run);
  const meta = JSON.parse(fs.readFileSync(path.join(dir, "meta.json"), "utf8"));
  const truth = JSON.parse(fs.readFileSync(path.join(dir, "truth.json"), "utf8"));
  const live = meta.live as { words: LiveWord[]; sent: number[]; wordsOnset: number } | null;
  if (!live) continue;
  const w = meta.wavs[String(truth.ctx)];
  const { x, sr } = wav(path.join(dir, w.file));
  const outLat = 0.027;
  // the tapped audio is what left the page (after the held-back delay); the meter saw each sample LIVE.delay earlier
  const blocks = meterBlocks(x, sr, w.startTime, LIVE.delay);
  addPhonemes(Object.fromEntries(spokenWords(live.words.map((v) => v.w).join(" ")).filter((v) => DICT[v]).map((v) => [v, DICT[v]])));
  const ctx = { currentTime: w.startTime - 0.5, outputLatency: outLat, state: "running" } as unknown as AudioContext;
  const sp = new LiveSpeech(ctx) as unknown as LiveSpeech & Record<string, unknown> & { blocks(d: number[]): void };
  (sp as unknown as { delay: number }).delay = LIVE.delay;
  // the reply as a chat delivers it: words + the agent's loudness ahead of the sound, then "speaking"
  sp.wordsStarted();
  sp.addWords(live.words);
  if (!Number.isNaN(live.wordsOnset) && live.wordsOnset !== null) sp.voiceOnset(live.wordsOnset);
  sp.addEnvelope(0, (live.sent ?? []).map((v) => (v ?? 0) * 10_000));
  sp.replyStarted();
  const mouth = new Mouth({ cap: () => 1, userValue: () => 0, speechActivity: () => {}, write: () => {}, clear: () => {} });
  const frames: { t: number; gap: number; jaw: number; act: Record<string, number> }[] = [];
  let bi = 0;
  const end = w.startTime + w.seconds;
  const t0 = performance.now();
  for (let tau = w.startTime; tau < end; tau += 1 / fps) {
    (ctx as unknown as { currentTime: number }).currentTime = tau;
    const batch: number[] = [];
    while (bi < blocks.length && blocks[bi][0] <= tau) batch.push(...blocks[bi++]);
    if (batch.length) (sp as unknown as { blocks(d: number[]): void }).blocks(batch);
    const heard = sp.playing ? sp.time() : -1;
    mouth.frame(sp, sp.playing ? heard + LIPSYNC.lead : -1, 1 / fps);
    const mm = mouth.openingMm();
    // the frame shows while the audio being heard is the tapped sample at tau − outLat (events.py's heard time)
    frames.push({ t: tau - outLat, gap: +mm.gap.toFixed(3), jaw: +mm.jaw.toFixed(3), act: Object.fromEntries(Object.entries(mouth.state.activations).map(([k, a]) => [k, +a.toFixed(3)])) });
  }
  const ms = (performance.now() - t0) / frames.length;
  const name = `${tag}-${run}`;
  fs.writeFileSync(path.join(OUT, name + ".json"), JSON.stringify({ truth: path.join(dir, "truth.json"), fps, lead: LIPSYNC.lead, sets, off, msPerFrame: ms, frames, cues: sp.cues.map((c) => ({ v: c.viseme, s: +c.start.toFixed(3), e: +c.end.toFixed(3), x: c.text })) }));
  console.log(`${name}: ${frames.length} frames, ${(ms * 1000).toFixed(1)} µs/frame`);
}
