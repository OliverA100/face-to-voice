/**
 * Per-frame viseme targets from cues: the cues are first placed on the audio (placement.ts); each then ramps in before
 * its onset (anticipation), holds, and ramps out after; closed shapes (PP/FF) dominate open ones so lips can actually
 * close mid-vowel; the mouth group is capped so additive morphs never over-drive (shapes.ts targetsAt); and the
 * loudness gates decide how far the mouth opens and when the lips may shut. The tuning is in tuning.ts.
 */
import type { Cue, VisemeId } from "./cues";
import { alignLine, audioClosureAt, bridgeVowels, fitPhrases, followRelease, placeLine, placePhrases, snapClosures, snapVowels } from "./placement";
import { CLOSED_VISEMES, closureGate, localPeak, loudnessGate, OPEN_VISEMES, peakCap, targetsAt, VOWELS, windowedLoudness, type Activations } from "./shapes";
import { LIPSYNC, LIPSYNC_PARTS } from "./tuning";

export { LIPSYNC, LIPSYNC_PARTS } from "./tuning";
export type { Activations } from "./shapes";

/** Whether an "m" starts between the end of vowel `v` (a little before) and t: its hum, lips shut, ended the vowel. */
function hummedAfter(cues: Cue[], v: Cue, t: number): boolean {
  for (const c of cues) {
    if (c.start > t) break; // sorted by start
    if (c.viseme === "PP" && c.nasal && c.start >= v.end - 0.08 && c.start > v.start) return true;
  }
  return false;
}

/**
 * What the mouth reads speech from: the speech player (a line the visitor asked for, decoded ahead of playback) or a
 * live conversation's voice (lib/lipsync/live.ts, analysed a short delay ahead of what is heard). Times are seconds of
 * the current line; loudness is known up to decodedSeconds().
 */
export interface SpeechSource {
  readonly playing: boolean;
  /** The line's time as the listener hears it now (negative before it starts). */
  time(): number;
  readonly cues: Cue[];
  decodedSeconds(): number;
  /** The whole line is in: nothing more will be added to the loudness. */
  readonly streamDone: boolean;
  loudness(t: number): number;
  trebleLoudness(t: number): number;
  /** The source places each phrase on its sound itself (live.ts anchors): the evaluator's placePhrases stays out. */
  readonly phrasesPlaced?: boolean;
  /** The gate's own look-ahead instead of LIPSYNC.gateLookahead (live.ts: LIPSYNC.liveGateLookahead). */
  readonly gateLookahead?: number;
  /** Where the voice starts (line time), known before it is heard (live.ts: the agent measured it): placeLine uses it
   *  at once instead of waiting to read the loudness. */
  readonly voiceStart?: number;
  /** The cues come from forced alignment on this line's audio (player.ts), not the voice's own stamps: they are where
   *  the words are said, so only the closure and vowel snapping (vowels within LIPSYNC.alignedVowelSearch) move them. */
  readonly aligned?: boolean;
}

/** What one source's frames keep between frames (LipSync.tsx keeps one per source). */
export interface FrameMemory {
  snapped: WeakSet<Cue>;
  lastOpen: VisemeId; // the vowel held while the voice still sounds after its cue ended
}
export const frameMemory = (): FrameMemory => ({ snapped: new WeakSet<Cue>(), lastOpen: "aa" });

/**
 * The viseme targets at time t (into `out`): the cues placed on the audio (line start, closures, vowels), then gated by
 * the loudness so the sound decides how far the mouth opens and when the lips may shut. One frame of LipSync.tsx, also
 * run offline to compare live sources against a whole decoded line.
 */
export function frameTargets(src: SpeechSource, t: number, lead: number, out: Activations, mem: FrameMemory, shapes?: Activations): void {
  // once the stream has ended the whole line is decoded: the last word's windows reach past the audio's end
  const decoded = src.streamDone ? Infinity : src.decodedSeconds();
  const loudnessOf = (x: number) => src.loudness(x);
  placeLine(src.cues, loudnessOf, decoded, LIPSYNC_PARTS.placeLine && !src.aligned, src.voiceStart); // the stamps' offset at the start
  placePhrases(src.cues, loudnessOf, decoded, LIPSYNC_PARTS.placePhrases && !src.phrasesPlaced && !src.aligned); // … and after each pause, where they are far off
  // an "m" closure is found in the treble (its hum keeps the loudness up): LIPSYNC_PARTS.trebleM
  const treble = LIPSYNC_PARTS.trebleM ? (x: number) => src.trebleLoudness(x) : loudnessOf;
  alignLine(src.cues, loudnessOf, treble, decoded, LIPSYNC_PARTS.alignPhrases && !src.phrasesPlaced && !src.aligned); // the words' sounds in order onto the audio
  if (LIPSYNC_PARTS.snapClosures) snapClosures(src.cues, loudnessOf, decoded, mem.snapped, treble);
  if (LIPSYNC_PARTS.snapClosures && LIPSYNC_PARTS.followRelease) followRelease(src.cues, loudnessOf, mem.snapped);
  if (LIPSYNC_PARTS.fitPhrases) fitPhrases(src.cues, loudnessOf, decoded);
  if (LIPSYNC_PARTS.snapVowels) snapVowels(src.cues, loudnessOf, decoded, mem.snapped, src.aligned);
  if (LIPSYNC_PARTS.bridgeVowels) bridgeVowels(src.cues);
  targetsAt(src.cues, t + lead, out);
  // The open shapes read a windowed loudness (no wobble on 10 ms dips); closures read the raw one.
  const at = t + (src.gateLookahead ?? LIPSYNC.gateLookahead);
  const loud = src.loudness(at);
  const loudSmooth = windowedLoudness(loudnessOf, at, LIPSYNC.gateWindow);
  // measured against the loudest moment nearby, so a line that trails off still opens its last words (gateLocal)
  let rel = Math.min(1, loudSmooth / localPeak(loudnessOf, at));
  // through a bridged t/d (bridgeVowels) the gate holds the level around it, not the stop's own dip
  for (const c of src.cues) {
    if (c.start > at) break;
    if (!c.bridge || at < c.bridge[0] - 0.03 || at > c.bridge[1] + 0.03) continue;
    const relOf = (x: number) => Math.min(1, windowedLoudness(loudnessOf, x, LIPSYNC.gateWindow) / localPeak(loudnessOf, x));
    rel = Math.max(rel, Math.min(relOf(c.bridge[0] - 0.03), relOf(c.bridge[1] + 0.03)));
  }
  const gate = LIPSYNC_PARTS.gates ? loudnessGate(rel) * LIPSYNC.openGain : 1;
  if (shapes) {
    // the lips' shapes: the same cues under the softer shape gate (LIPSYNC.shapeGate); the jaw keeps `out`
    const G = LIPSYNC.shapeGate;
    const sg = LIPSYNC_PARTS.gates ? Math.min(1, Math.max(0, (rel - G.from) / (G.full - G.from))) : 1;
    for (const v of OPEN_VISEMES) shapes[v] = Math.min(peakCap[v], out[v] * sg);
  }
  const preE = out.E, preI = out.I, preO = out.O, preU = out.U;
  for (const v of OPEN_VISEMES) out[v] = Math.min(peakCap[v], out[v] * gate);
  if (LIPSYNC_PARTS.gates && LIPSYNC_PARTS.hissGate) {
    // the jaw comes up for a hiss (LIPSYNC.hissClose), read over the gate's own window
    const H = LIPSYNC.hissClose;
    const ratio = windowedLoudness((x) => src.trebleLoudness(x), at, LIPSYNC.gateWindow) / Math.max(loudSmooth, 1e-3);
    const x = Math.min(1, Math.max(0, (ratio - H.from) / (H.to - H.from)));
    const keep = 1 - H.amount * x * x * (3 - 2 * x);
    for (const v of VOWELS) out[v] *= keep;
  }
  if (LIPSYNC_PARTS.gates && LIPSYNC_PARTS.shapeHold) {
    // the lips keep the vowel's shape as the loudness takes the opening away (LIPSYNC.shapeHold)
    const quiet = 1 - Math.min(1, gate);
    const H = LIPSYNC.shapeHold;
    out.I = Math.min(1, Math.max(out.I, preI * H.I) + preE * quiet * H.E);
    out.U = Math.min(1, Math.max(out.U, preU * H.U) + preO * quiet * H.O);
  }
  const cg = LIPSYNC_PARTS.gates ? closureGate(loud) : 1;
  // closures and f/v/th hisses found in the audio itself pass
  const anchoredPP = Math.min(out.PP, audioClosureAt(src.cues, t + lead, loudnessOf, "PP", treble));
  const anchoredFF = Math.min(out.FF, audioClosureAt(src.cues, t + lead, loudnessOf, "FF"));
  const anchoredTH = Math.min(out.TH, audioClosureAt(src.cues, t + lead, loudnessOf, "TH"));
  for (const v of CLOSED_VISEMES) out[v] *= cg;
  out.PP = Math.max(out.PP, anchoredPP);
  out.FF = Math.max(out.FF, anchoredFF);
  out.TH = Math.max(out.TH, anchoredTH);
  // Hold the last vowel while the voice is still sounding but its (early) cue has ended.
  let openSum = 0;
  for (const v of VOWELS) {
    openSum += out[v];
    if (out[v] > out[mem.lastOpen] && out[v] > 0.25) mem.lastOpen = v;
  }
  // … not over a consonant's own shape: a loud "th" brought the "a" of "passed" back between "passed" and "through"
  const consonant = out.TH + out.FF + out.SS + out.CH;
  let hold: VisemeId | null = mem.lastOpen;
  if (loudSmooth > LIPSYNC.sustainLoud && openSum < 0.25 && cg > 0.5 && !(LIPSYNC_PARTS.sustainYield && consonant > 0.2)) {
    // the nearer vowel, the one before or the one coming: the voice ran on from "jam" into "or" before the "or" was
    // stamped, and the "a" of "jam" opened again across the m: the mouth opened twice at the word "or"
    if (LIPSYNC_PARTS.sustainNearest) {
      const tc = t + lead;
      let last: Cue | null = null, next: Cue | null = null;
      for (const c of src.cues) {
        if (!VOWELS.has(c.viseme) || c.glide) continue;
        if (c.start > tc) {
          next = c;
          break;
        }
        if (!last || c.end > last.end) last = c;
      }
      // a vowel an "m" ended is not held after it: the loud voice there is the m's own hum, with the lips shut ("jam
      // or": the "a" of "jam" opened again after the m, and the mouth opened twice for "or")
      const lastOk = last && !(LIPSYNC_PARTS.humEndsVowel && hummedAfter(src.cues, last, tc));
      // … the coming vowel is, close by: within its own word (the "o" of "promoter" stamped late after the m) from 0.3 s
      // out, across a gap only from 0.1 s (the m of "jam" hums on until "or" starts)
      const near = next && (next.ws ?? next.start) <= tc ? 0.3 : 0.1;
      if (next && (!lastOk || next.start - tc < tc - last!.end)) hold = lastOk || next.start - tc < near ? next.viseme : null;
      else if (!lastOk) hold = null;
    }
    if (hold) out[hold] = Math.max(out[hold], Math.min(1, LIPSYNC.sustainLevel * gate) * (1 - Math.max(out.PP, out.FF)));
  }
  if (shapes) {
    for (const v of CLOSED_VISEMES) shapes[v] = out[v];
    if (hold) shapes[hold] = Math.max(shapes[hold], out[hold]); // the held vowel holds its shape too
  }
}
