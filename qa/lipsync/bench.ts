/*
 * Offline bench: runs the app's own mouth code (web/src/lib/lipsync: cues, evaluator, mouth.ts) on saved lines, frame by
 * frame, with no browser, and writes the lips' and jaw's opening in mm per frame. bench.py scores it against the
 * line's audio truth (truth.py <clip>.ndjson), so timing changes can be tried in seconds before any browser check.
 *
 *   ./bench.sh [--fps 120] [--tag name] [--set lead=0.03,closureOffShift=0] [--off seal,shapeHold] clip.ndjson …
 *
 * The frame at sound time s shows the mouth at s + lead (what LipSync.tsx does), on a perfect clock: the browsers'
 * clock and output-delay errors are measured separately (room.mjs) and are not in here.
 */
import fs from "node:fs";
import path from "node:path";

import { alignmentToCues, mergeAlignments, type Alignment, type Cue } from "@/lib/lipsync/cues";
import { LoudnessEnvelope } from "@/lib/lipsync/envelope";
import { LIPSYNC, LIPSYNC_PARTS, type SpeechSource } from "@/lib/lipsync/evaluator";
import { Mouth } from "@/lib/lipsync/mouth";

const args = process.argv.slice(2);
const opt = (k: string, d: string) => {
  const i = args.indexOf(`--${k}`);
  if (i < 0) return d;
  const v = args[i + 1];
  args.splice(i, 2);
  return v;
};
const fps = Number(opt("fps", "120"));
const tag = opt("tag", "bench");
const sets = opt("set", "");
const off = opt("off", "");
const out = opt("out", path.join(path.dirname(new URL(import.meta.url).pathname), "out", "bench"));

// LIPSYNC overrides: "key=value,key.sub=value"
const L = LIPSYNC as unknown as Record<string, unknown>;
for (const kv of sets.split(",").filter(Boolean)) {
  const [k, v] = kv.split("=");
  const keys = k.split(".");
  let o = L as Record<string, unknown>;
  for (const key of keys.slice(0, -1)) o = o[key] as Record<string, unknown>;
  o[keys.at(-1)!] = Number(v);
}
for (const p of off.split(",").filter(Boolean)) (LIPSYNC_PARTS as Record<string, boolean>)[p] = false;

class SavedLine implements SpeechSource {
  playing = true;
  streamDone = true;
  cues: Cue[];
  now = -1;
  private env = new LoudnessEnvelope();
  constructor(nd: string) {
    const aligns: Alignment[] = [];
    for (const line of nd.split("\n")) {
      if (!line.trim()) continue;
      const j = JSON.parse(line) as { audio_base64?: string; alignment?: Alignment; normalized_alignment?: Alignment };
      const a = j.normalized_alignment ?? j.alignment;
      if (a && a.characters?.length) aligns.push(a);
      if (j.audio_base64) {
        const b = Buffer.from(j.audio_base64, "base64");
        const s = new Int16Array(b.buffer.slice(b.byteOffset, b.byteOffset + (b.byteLength & ~1)));
        this.env.push(Float32Array.from(s, (x) => x / 32768));
      }
    }
    this.cues = alignmentToCues(mergeAlignments(aligns));
  }
  time() {
    return this.now;
  }
  decodedSeconds() {
    return this.env.seconds();
  }
  loudness(t: number) {
    return this.env.loudness(t);
  }
  trebleLoudness(t: number) {
    return this.env.trebleLoudness(t);
  }
}

fs.mkdirSync(out, { recursive: true });
for (const clip of args.map((a) => path.resolve(process.env.INIT_CWD ?? process.cwd(), a))) {
  const src = new SavedLine(fs.readFileSync(clip, "utf8"));
  const mouth = new Mouth({ cap: () => 1, userValue: () => 0, speechActivity: () => {}, write: () => {}, clear: () => {} });
  const lead = LIPSYNC.lead;
  const dur = src.decodedSeconds() + 0.5;
  const frames: { t: number; gap: number; jaw: number; act: Record<string, number> }[] = [];
  const t0 = performance.now();
  for (let k = 0; k * (1 / fps) < dur; k++) {
    const s = k / fps; // the sound's time: what is heard while this frame is on screen
    src.now = s;
    mouth.frame(src, s + lead, 1 / fps);
    const mm = mouth.openingMm();
    frames.push({ t: s, gap: +mm.gap.toFixed(3), jaw: +mm.jaw.toFixed(3), act: Object.fromEntries(Object.entries(mouth.state.activations).map(([v, a]) => [v, +a.toFixed(3)])) });
  }
  const ms = (performance.now() - t0) / frames.length;
  const name = `${tag}-${path.basename(clip, ".ndjson")}`;
  // the cues as the evaluator left them (snapped to the audio in place)
  const cues = src.cues.map((c) => ({ v: c.viseme, s: +c.start.toFixed(3), e: +c.end.toFixed(3), x: c.text }));
  fs.writeFileSync(path.join(out, name + ".json"), JSON.stringify({ clip: path.resolve(clip), fps, lead, sets, off, msPerFrame: ms, frames, cues }));
  console.log(`${name}: ${frames.length} frames, ${(ms * 1000).toFixed(1)} µs/frame`);
}
