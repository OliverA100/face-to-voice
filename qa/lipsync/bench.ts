/*
 * Offline bench: runs the app's own mouth code (web/src/lib/lipsync: cues, evaluator, mouth.ts) on saved lines, frame by
 * frame, with no browser, and writes the lips' and jaw's opening in mm per frame. bench.py scores it against the
 * line's audio truth (truth.py <clip>.ndjson), so timing changes can be tried in seconds before any browser check.
 *
 *   ./bench.sh [--fps 120] [--tag name] [--set lead=0.03,closureOffShift=0] [--off seal,shapeHold] [--on vowelInWord] clip.ndjson …
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
import { addPhonemes, PHONEMES, spokenWords } from "@/lib/lipsync/phonemes";
import dictionary from "@/data/phonemes.json";

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
const on = opt("on", ""); // LIPSYNC_PARTS switched on (the ones off by default)
const out = opt("out", path.join(path.dirname(new URL(import.meta.url).pathname), "out", "bench"));
// mm per unit morph weight of the mouth's width, upper teeth shown and lips forward (pipeline rig shape_coefs.py), if made
const coefsFile = path.join(path.dirname(new URL(import.meta.url).pathname), "out", "shape_coefs.json");
const coefs = fs.existsSync(coefsFile) ? (JSON.parse(fs.readFileSync(coefsFile, "utf8")) as Record<string, Record<string, number>>) : null;

// LIPSYNC overrides: "key=value,key.sub=value"
const L = LIPSYNC as unknown as Record<string, unknown>;
for (const kv of sets.split(",").filter(Boolean)) {
  const [k, v] = kv.split("=");
  const keys = k.split(".");
  let o = L as Record<string, unknown>;
  for (const key of keys.slice(0, -1)) o = o[key] as Record<string, unknown>;
  o[keys.at(-1)!] = Number(v);
}
for (const p of off.split(",").filter(Boolean)) {
  if (p === "phonemes") PHONEMES.enabled = false; // the letter rules only
  else (LIPSYNC_PARTS as Record<string, boolean>)[p] = false;
}
for (const p of on.split(",").filter(Boolean)) (LIPSYNC_PARTS as Record<string, boolean>)[p] = true;

const DICT = dictionary as Record<string, string>;

class SavedLine implements SpeechSource {
  playing = true;
  streamDone = true;
  cues: Cue[];
  aligned = false; // the speak route's {"aligned"} line timed it (player.ts)
  now = -1;
  private env = new LoudnessEnvelope();
  constructor(nd: string) {
    const aligns: Alignment[] = [];
    let forced: Alignment | null = null;
    for (const line of nd.split("\n")) {
      if (!line.trim()) continue;
      const j = JSON.parse(line) as { audio_base64?: string; alignment?: Alignment; normalized_alignment?: Alignment; aligned?: Alignment | null };
      if (j.aligned?.characters?.length && LIPSYNC_PARTS.forcedAlignment) forced = j.aligned;
      const a = j.normalized_alignment ?? j.alignment;
      if (a && a.characters?.length) aligns.push(a);
      if (j.audio_base64) {
        const b = Buffer.from(j.audio_base64, "base64");
        const s = new Int16Array(b.buffer.slice(b.byteOffset, b.byteOffset + (b.byteLength & ~1)));
        this.env.push(Float32Array.from(s, (x) => x / 32768));
      }
    }
    // the line's phonemes, as the speak route sends them (lib/server/pronounce.ts)
    const text = aligns.flatMap((a) => a.characters).join("");
    addPhonemes(Object.fromEntries(spokenWords(text).filter((w) => DICT[w]).map((w) => [w, DICT[w]])));
    this.aligned = forced !== null;
    this.cues = alignmentToCues(forced ?? mergeAlignments(aligns));
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
  const frames: { t: number; gap: number; jaw: number; act: Record<string, number>; width?: number; teeth?: number; protr?: number }[] = [];
  const per = (k: string) => mouth.targets.map((t) => coefs?.[k]?.[t] ?? 0);
  const shapeCoefs = coefs ? { width: per("width"), teeth: per("upperTeeth"), protr: per("protr") } : null;
  const t0 = performance.now();
  for (let k = 0; k * (1 / fps) < dur; k++) {
    const s = k / fps; // the sound's time: what is heard while this frame is on screen
    src.now = s;
    mouth.frame(src, s + lead, 1 / fps);
    const mm = mouth.openingMm();
    const f: (typeof frames)[number] = { t: s, gap: +mm.gap.toFixed(3), jaw: +mm.jaw.toFixed(3), act: Object.fromEntries(Object.entries(mouth.state.activations).map(([v, a]) => [v, +a.toFixed(3)])) };
    (f as Record<string, unknown>).tongue = +((mouth as unknown as { tongue: number }).tongue ?? 0).toFixed(3);
    if (shapeCoefs)
      for (const k of ["width", "teeth", "protr"] as const) f[k] = +mouth.written.reduce((sum, w, ti) => sum + w * shapeCoefs[k][ti], 0).toFixed(3);
    frames.push(f);
  }
  const ms = (performance.now() - t0) / frames.length;
  const name = `${tag}-${path.basename(clip, ".ndjson")}`;
  // the cues as the evaluator left them (snapped to the audio in place)
  const cues = src.cues.map((c) => ({ v: c.viseme, s: +c.start.toFixed(3), e: +c.end.toFixed(3), x: c.text, ws: c.ws, n: c.n }));
  fs.writeFileSync(path.join(out, name + ".json"), JSON.stringify({ clip: path.resolve(clip), fps, lead, sets, off, msPerFrame: ms, frames, cues }));
  console.log(`${name}: ${frames.length} frames, ${(ms * 1000).toFixed(1)} µs/frame`);
}
