/**
 * The per-frame shape maths: each cue's envelope, the gates that scale the shapes by the audio's loudness, the tongue
 * and rounding tracks, the smoothing and the speed limits. Plain functions of the cues and the loudness at one time.
 */
import { VISEME_IDS, type Cue, type VisemeId } from "./cues";
import { LIPSYNC, LIPSYNC_PARTS } from "./tuning";

export const OPEN_VISEMES: VisemeId[] = ["aa", "E", "I", "O", "U", "DD", "SS", "CH"];
/** Shapes made on quiet sounds (a closure, or the hiss of f/v/th): held back while the voice is loud, never scaled
 *  down by the loudness (that left a "th" at a fifth of its shape), and placed on their quiet stretch in the audio. */
export const CLOSED_VISEMES: VisemeId[] = ["PP", "FF", "TH"];
export const VOWELS = new Set<VisemeId>(["aa", "E", "I", "O", "U"]);
/** The shapes a formed closure (PP, FF) pushes aside in targetsAt. */
const UNDER_CLOSURE: VisemeId[] = ["aa", "E", "I", "O", "U", "TH"];
/** Shapes held at their peak however long the cue (envelope). */
const SHORT_VISEMES: VisemeId[] = ["DD", "SS", "TH"];

/** The smoothstep curve, x clamped to 0..1. */
export function smoothstep(x: number): number {
  const c = Math.min(1, Math.max(0, x));
  return c * c * (3 - 2 * c);
}

/**
 * Lips cannot be shut while the voice is at full volume, and ElevenLabs stamps a "p"/"m" a
 * little before its sound; so closures are held back while the audio is loud and let through
 * as it dips. Returns a multiplier for the closed shapes.
 */
export function closureGate(loudness: number): number {
  return 1 - smoothstep((loudness - LIPSYNC.closureLoud) / LIPSYNC.closureBand);
}

/** 0..1: how rounded the lips should be for a closure at time t (LIPSYNC.roundAhead): the coming or just-ended U / O. */
export function roundingAt(cues: Cue[], t: number): number {
  let r = 0;
  for (const c of cues) {
    if (c.start - LIPSYNC.roundAhead > t) break; // sorted by start
    // an r or w rounds no closure, nor does a weak vowel (the "-er" of "snapper" puckered its p: an extra movement)
    if ((c.viseme !== "U" && c.viseme !== "O") || c.glide || (c.weak && LIPSYNC_PARTS.weakNoRound) || t > c.end + LIPSYNC.roundAfter) continue;
    r = Math.max(r, c.viseme === "U" ? 1 : LIPSYNC.roundO);
  }
  return r;
}

/** Multiplier for the open shapes from the audio loudness at this instant. */
export function loudnessGate(loudness: number): number {
  return LIPSYNC.gateFloor + (1 - LIPSYNC.gateFloor) * smoothstep(loudness / LIPSYNC.gateLevel);
}

/** The loudness the open gate is measured against at t (LIPSYNC.gateLocal): the loudest 10 ms block within ±gateLocal,
 *  at least gateLocalFloor; 1 (the line's peak) when gateLocal is 0. */
export function localPeak(loudness: (t: number) => number, t: number): number {
  if (!(LIPSYNC.gateLocal > 0)) return 1;
  let m = LIPSYNC.gateLocalFloor;
  for (let x = t - LIPSYNC.gateLocal; x <= t + LIPSYNC.gateLocal; x += 0.01) m = Math.max(m, loudness(x));
  return Math.min(1, m);
}

/** Mean of `loudness` over a window `width` seconds wide centred on t, one sample per 10 ms block
 *  (width 0 = the single block at t). */
export function windowedLoudness(loudness: (t: number) => number, t: number, width: number): number {
  const n = Math.round(width * 100) + 1;
  let sum = 0;
  for (let k = 0; k < n; k++) sum += loudness(t - width / 2 + k * 0.01);
  return sum / n;
}

export type Activations = Record<VisemeId, number>;

export function emptyActivations(): Activations {
  return Object.fromEntries(VISEME_IDS.map((v) => [v, 0])) as Activations;
}

/** A cue's raw activation at t: ramped in over its attack, held, ramped out over its release. */
export function cueEnvelope(cue: Cue, t: number): number {
  const a = LIPSYNC.attackFor[cue.viseme] ?? LIPSYNC.attack;
  const r = LIPSYNC.releaseFor[cue.viseme] ?? LIPSYNC.release;
  if (t < cue.start - a || t > cue.end + r) return 0;
  const isR = cue.glide && cue.viseme === "U" && /^r/i.test(cue.text);
  const peak = cue.weak ? LIPSYNC.weakPeak : isR ? LIPSYNC.rPeak : (cue.peak ?? LIPSYNC.peak[cue.viseme] ?? LIPSYNC.peak.default);
  const long = cue.end - cue.start > 0.12 && !cue.weak && !isR && cue.peak === undefined && !SHORT_VISEMES.includes(cue.viseme) ? 1 : peak;
  if (t < cue.start) return long * (1 - (cue.start - t) / a);
  if (t <= cue.end) return long;
  return long * (1 - (t - cue.end) / r);
}

/** Per shape, the `peak` of the cue that drew it in the last targetsAt (1 if none): frameTargets holds the shape there
 *  after the loudness gate, whose openGain would otherwise take a "sun" as wide as a "father". */
export const peakCap = emptyActivations();

/** Raw targets for time t (no smoothing). */
export function targetsAt(cues: Cue[], t: number, out: Activations): Activations {
  for (const v of VISEME_IDS) out[v] = 0;
  for (const v of VISEME_IDS) peakCap[v] = 1;
  for (const cue of cues) {
    if (cue.end + LIPSYNC.release < t) continue; // release is the longest fade, so this is safe
    if (cue.start - LIPSYNC.attack > t) break; // cues are sorted by start
    const e = cueEnvelope(cue, t);
    if (e > out[cue.viseme]) {
      out[cue.viseme] = e;
      peakCap[cue.viseme] = cue.peak ?? 1;
    }
  }
  // Closure dominance: lips pressed / lip under teeth suppress open shapes.
  const closed = Math.max(out.PP, out.FF);
  if (closed > 0) for (const v of UNDER_CLOSURE) out[v] *= 1 - closed;
  // Winner emphasis: during transitions the strongest shape stays crisp instead of averaging into mush.
  let top: VisemeId = "aa";
  for (const v of VISEME_IDS) if (out[v] > out[top]) top = v;
  const topValue = out[top];
  if (topValue > 0) for (const v of VISEME_IDS) if (v !== top) out[v] *= 1 - LIPSYNC.emphasis * topValue;
  // Cap the mouth group so additive presets never over-drive.
  const sum = VISEME_IDS.reduce((s, v) => s + out[v], 0);
  if (sum > LIPSYNC.maxGroupSum) for (const v of VISEME_IDS) out[v] *= LIPSYNC.maxGroupSum / sum;
  return out;
}

/**
 * How far the tongue tip is up against the ridge behind the upper teeth at t (0..1): the d/t/n/l cues (DD, not a k or
 * g), eased up from LIPSYNC.tongueAhead before each and down by tongueAfter after it. On its own track, at full height:
 * the tongue competes with no lip shape, so the vowels around it don't push it aside.
 */
export function tongueAt(cues: Cue[], t: number): number {
  let v = 0;
  for (const c of cues) {
    if (c.start - LIPSYNC.tongueAhead > t) break; // sorted by start
    if (c.viseme !== "DD" || c.back || t > c.end + LIPSYNC.tongueAfter) continue;
    const x = t < c.start ? 1 - (c.start - t) / LIPSYNC.tongueAhead : t > c.end ? 1 - (t - c.end) / LIPSYNC.tongueAfter : 1;
    v = Math.max(v, smoothstep(x));
  }
  return v;
}

/** How much of the tongue's raise at t is an "l" (tongueAt's track, from lateral cues only): the tongue blends from the
 *  "d" pose (tip behind the upper teeth) to visemes.json "ll" (tip at their edge, showing). */
export function lateralAt(cues: Cue[], t: number): number {
  let v = 0;
  for (const c of cues) {
    if (c.start - LIPSYNC.tongueAhead > t) break; // sorted by start
    if (!c.lateral || t > c.end + LIPSYNC.tongueAfter) continue;
    const x = t < c.start ? 1 - (c.start - t) / LIPSYNC.tongueAhead : t > c.end ? 1 - (t - c.end) / LIPSYNC.tongueAfter : 1;
    v = Math.max(v, smoothstep(x));
  }
  return v;
}

/** Factor the open shapes are scaled by once a closure has actually formed (post-smoothing).
 *  1 = untouched, 0 = fully sealed; a smooth ramp so small closure residue does no harm. */
export function sealWeight(act: Activations): number {
  return 1 - smoothstep((act.PP + act.FF) / LIPSYNC.sealAt);
}

/** The share (0..1) of this frame's step the mouth may take: the lips may open or close by at most LIPSYNC.gapSpeed and
 *  the jaw by jawSpeed (mm/s) over `dt` seconds. dGap / dJaw: the step's change in mm. */
export function speedShare(dGap: number, dJaw: number, dt: number, closing = false): number {
  let share = 1;
  const boost = closing ? LIPSYNC.closeBoost : 1;
  const gapSpeed = LIPSYNC.gapSpeed * (dGap < 0 ? boost : 1);
  const jawSpeed = LIPSYNC.jawSpeed * (dJaw < 0 ? boost : 1);
  if (gapSpeed > 0 && Math.abs(dGap) > gapSpeed * dt) share = Math.min(share, (gapSpeed * dt) / Math.abs(dGap));
  if (jawSpeed > 0 && Math.abs(dJaw) > jawSpeed * dt) share = Math.min(share, (jawSpeed * dt) / Math.abs(dJaw));
  return share;
}

/**
 * The share of this frame's step (dGap, dJaw: mm) the mouth takes when it may speed up by at most LIPSYNC.speedUp:
 * `share` from speedShare, and last frame's lip and jaw velocities (mm/s, signed: a turn starts again from rest).
 * Slowing down is never limited.
 */
export function speedUpShare(dGap: number, dJaw: number, share: number, gapVel: number, jawVel: number, dt: number, closing = false): number {
  if (!(LIPSYNC.speedUp > 0) || dt <= 0) return share;
  const grow = LIPSYNC.speedUp * 1000 * dt; // mm/s the speed may grow by this frame
  const boost = closing ? LIPSYNC.closeBoostUp : 1;
  let k = share;
  for (const [d, last] of [[dGap, gapVel], [dJaw, jawVel]]) {
    const g = d < 0 ? grow * boost : grow;
    const speed = (Math.abs(d) * share) / dt;
    const from = Math.sign(d) === Math.sign(last) ? Math.abs(last) : 0;
    if (speed > from + g) k = Math.min(k, (share * (from + g)) / speed);
  }
  return k;
}

/**
 * The share of this frame's step the mouth takes when its width and rounding may change at most LIPSYNC.widthSpeed /
 * roundSpeed: `share` so far, the activations as drawn (`drawn`, open shapes after the seal) and the ones asked for.
 */
export function shapeShare(drawn: Activations, target: Activations, share: number, dt: number): number {
  let dW = 0;
  let dR = 0;
  for (const [v, mm] of Object.entries(LIPSYNC.shapeMm.width)) dW += (target[v as VisemeId] - drawn[v as VisemeId]) * mm;
  for (const [v, mm] of Object.entries(LIPSYNC.shapeMm.round)) dR += (target[v as VisemeId] - drawn[v as VisemeId]) * mm;
  let k = share;
  if (LIPSYNC.widthSpeed > 0 && Math.abs(dW) * k > LIPSYNC.widthSpeed * dt) k = (LIPSYNC.widthSpeed * dt) / Math.abs(dW);
  if (LIPSYNC.roundSpeed > 0 && Math.abs(dR) * k > LIPSYNC.roundSpeed * dt) k = (LIPSYNC.roundSpeed * dt) / Math.abs(dR);
  return k;
}

/** Smoothed activations; call once per frame with the elapsed time. */
export function smoothTowards(current: Activations, target: Activations, dt: number): void {
  for (const v of VISEME_IDS) {
    const tau = LIPSYNC.tau[v] ?? LIPSYNC.tau.default;
    const k = 1 - Math.exp(-dt / tau);
    current[v] += (target[v] - current[v]) * k;
    if (current[v] < 0.002) current[v] = 0;
  }
}
