/**
 * Random face: a believable face first, and, if asked, a few striking features.
 *
 * The face: the raw GNM identity sliders from a truncated normal (GNM coefficients are standard deviations; weight
 * 1.0 == 3σ, so ±0.8 == ±2.4σ), handed mostly to the Feature sliders so they visibly move and can be tweaked from
 * there. The split (data/random.json, pipeline random_split.py): a raw draw w over the head shape sliders becomes
 * Feature values s = w·P plus a raw remainder r = w·Q on the Advanced sliders: the same face within about 1 mm.
 * Eyeball and teeth sliders keep their own draw. Age, the other Feature sliders and the expression sliders go back to
 * rest, unless the caller holds them (Random character holds its Age: the face is fitted at that age); emotion and pose
 * are left alone.
 *
 * Distinctiveness (the panel's slider; randomState.variation, 0 … RANDOM.maxVariation):
 *   below 1  the same face moves toward the average face (0 = the average face)
 *   1        the face as drawn: typical, believable
 *   above 1  the face stays typical, but 2–4 "striking" Feature sliders (picked from different areas when the face is
 *            rolled, each toward one of its ends) move toward their wide ends: none at 1, RANDOM.strikingReach of the
 *            way at the maximum. Real unusual people are mostly average with a few striking features; scaling the
 *            whole face up instead reads as a caricature. The sliders show those values, so they can be dialled back.
 * Distinctiveness moves only what the draw set, by the change in the draw, so slider tweaks made after the draw stay.
 * A face made by hand (no random face behind it) counts as drawn as it is: below 1 it eases toward the average face,
 * above 1 it gets striking features. Age is left alone either way. The reset face has nothing to vary (greyed out).
 *
 * Every random face fits the limiter (lib/morphs/limits.ts): a typical draw that would break is pulled toward the
 * average face, and each striking feature goes only as far as the face allows. randomState.lastFit says when it had
 * to step in. Nothing here looks at, or samples by, ethnicity or race: only the model's own shape statistics.
 */
import type { SliderDef, Weights } from "@/lib/data";
import randomJson from "@/data/random.json";
import { canAsk } from "@/lib/morphs/capsClient";
import { limiter, plainStore } from "@/lib/morphs/limiter";

/** Tweak freely. */
export const RANDOM = {
  spread: 0.33, // standard deviation in slider units (≈ 1σ of the model) at Distinctiveness 1
  limit: 0.8, // never beyond ±2.4σ per raw slider at Distinctiveness 1
  maxVariation: 2.25, // the top of the Distinctiveness slider
  striking: [2, 4] as const, // how many striking Feature sliders a face gets (inclusive)
  strikingReach: 0.79, // share of the way to a striking slider's end at the maximum Distinctiveness (~0.63 per unit above 1)
};
export const VARIATION = {
  min: 0,
  max: RANDOM.maxVariation,
  default: 1,
  notch: 0.05, // the slider's step: every value it can stop at is worked out ahead (precomputeVariations)
};
/** The Distinctiveness slider's current value, and what the limiter did to the last random face (for the panel / e2e). */
export const randomState = {
  variation: VARIATION.default,
  lastFit: { shrunk: 0, striking: [] as { target: string; wanted: number; got: number }[] },
};

const split = randomJson as { raw: string[]; features: string[]; P: number[][]; Q: number[][] };

/** The draw behind the current random face: unit normals per raw slider, and its striking features. */
let lastDraw: Record<string, number> = {};
let striking: Striking = [];
/** Sliders the caller set along with the random face (Random character: Age): every fit keeps them, so the limiter sees them. */
let held: Weights = {};
/** A face made by hand, as it was when Distinctiveness first moved on it: what it scales from (null for a random face). */
let asIs: Weights | null = null;
/** What the draw put on the sliders at the current variation (varyFace moves sliders by the change of this). */
let lastApplied: Weights = {};
/** The sliders Distinctiveness scales on a face made by hand: the Features (not Age) and the raw identity sliders. */
const isShape = (d: SliderDef) => d.kind === "identity" || (d.kind === "semantic" && d.group !== "sem_age");

const listeners = new Set<() => void>();
const notify = () => listeners.forEach((fn) => fn());
/** For the panel: fires when a random face is drawn or cleared. */
export function onRandomChange(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Forget the last random face and put Variation back to its default (Reset). */
export function clearRandomFace(): void {
  newState();
  candidate = null;
  lastDraw = {};
  asIs = null;
  striking = [];
  held = {};
  lastApplied = {};
  randomState.variation = VARIATION.default;
  notify();
}

function gaussian(): number {
  // Box-Muller
  const u = 1 - Math.random();
  const v = Math.random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

const clamp = (v: number, d: SliderDef) => Math.max(d.min, Math.min(d.max, v));

/** 2–4 Feature sliders from different groups (Head, Face, Jaw, Eyes, Nose, Mouth, Ears), each toward one end. */
function pickStriking(defs: SliderDef[]): Striking {
  const byGroup = new Map<string, SliderDef[]>();
  for (const d of defs) {
    if (d.kind !== "semantic" || d.combo || d.group === "sem_age") continue; // not Age or the Head size mix
    byGroup.set(d.group, [...(byGroup.get(d.group) ?? []), d]);
  }
  const groups = [...byGroup.keys()].sort(() => Math.random() - 0.5);
  const [lo, hi] = RANDOM.striking;
  const n = Math.min(groups.length, lo + Math.floor(Math.random() * (hi - lo + 1)));
  return groups.slice(0, n).map((g) => {
    const list = byGroup.get(g)!;
    return { target: list[Math.floor(Math.random() * list.length)].target, side: Math.random() < 0.5 ? -1 : 1 };
  });
}

/** Slider weights for the draw at a given variation (no limiter): the typical face, with the `hold` sliders as given. */
function weightsFor(defs: SliderDef[], draw: Record<string, number>, variation: number, hold: Weights): Weights {
  const v = Math.min(1, variation); // the typical face never goes past "as drawn"
  const limit = RANDOM.limit;
  const raw = (t: string) => Math.max(-limit, Math.min(limit, (draw[t] ?? 0) * RANDOM.spread * v));
  const w = split.raw.map(raw);
  const drawn: Weights = {};
  split.features.forEach((t, k) => (drawn[t] = w.reduce((sum, wi, i) => sum + wi * split.P[i][k], 0)));
  split.raw.forEach((t, j) => (drawn[t] = w.reduce((sum, wi, i) => sum + wi * split.Q[i][j], 0)));
  const out: Weights = {};
  for (const d of defs) {
    if (d.target in drawn) out[d.target] = clamp(drawn[d.target], d);
    else if (d.kind === "identity") out[d.target] = clamp(raw(d.target), d); // eyeballs, teeth: their own draw
    else if (d.kind === "semantic" || d.kind === "expression" || d.kind === "preset") out[d.target] = d.default;
    if (d.target in hold) out[d.target] = clamp(hold[d.target], d);
  }
  return out;
}

/** How far toward their ends the striking features go at this variation (0 at 1, strikingReach at the maximum). */
const strikingShare = (variation: number) =>
  Math.max(0, Math.min(1, (variation - 1) / (RANDOM.maxVariation - 1))) * RANDOM.strikingReach;

/** A face made by hand at a variation: as it is at 1 and above, toward the average face below. */
function scaledAsIs(defs: SliderDef[], face: Weights, variation: number): Weights {
  const v = Math.min(1, variation);
  const out: Weights = {};
  for (const d of defs) if (d.target in face) out[d.target] = d.default + (face[d.target] - d.default) * v;
  return out;
}

/** A question fitting asks the limiter: is this face broken, or how far may slider `target` go toward `end` on it. */
export type LimitAsk = { kind: "broken"; face: Weights } | { kind: "reach"; face: Weights; target: string; end: number };
type FitReport = typeof randomState.lastFit;
type Striking = { target: string; side: 1 | -1 }[];
/** What a fit works from: the draw (shrunk in place when a typical face breaks), a face made by hand, the striking
 *  features, the sliders held as the caller set them. */
type FitState = { draw: Record<string, number>; asIs: Weights | null; striking: Striking; held: Weights };

/**
 * The face at a variation, fitted by the limiter: the typical draw pulled toward the average face while it would
 * break; then each striking feature moved toward its end only as far as the face allows. Written as the questions it
 * asks the limiter, so the same steps run here (fitted) or ahead of time with the caps worker answering
 * (precomputeVariations).
 */
function* fitting(defs: SliderDef[], variation: number, st: FitState, fit: FitReport): Generator<LimitAsk, Weights, boolean | number> {
  if (st.asIs) return yield* striked(defs, scaledAsIs(defs, st.asIs, variation), variation, st.striking, fit); // already a face that fits
  let face = weightsFor(defs, st.draw, variation, st.held);
  for (let k = 0; k < 10 && ((yield { kind: "broken", face }) as boolean); k++) {
    for (const t in st.draw) st.draw[t] *= 0.85; // closer to the average face until it fits
    face = weightsFor(defs, st.draw, variation, st.held);
    fit.shrunk++;
  }
  return yield* striked(defs, face, variation, st.striking, fit);
}

/** Each striking feature moved toward its end, only as far as the face allows. */
function* striked(defs: SliderDef[], face: Weights, variation: number, list: Striking, fit: FitReport): Generator<LimitAsk, Weights, boolean | number> {
  const share = strikingShare(variation);
  if (share > 0) {
    for (const s of list) {
      const d = defs.find((x) => x.target === s.target);
      if (!d) continue;
      const from = face[s.target] ?? 0;
      const end = s.side > 0 ? d.max : d.min;
      const wanted = from + share * (end - from);
      const got = (yield { kind: "reach", face, target: s.target, end: wanted }) as number;
      face = { ...face, [s.target]: got };
      fit.striking.push({ target: s.target, wanted, got });
    }
  }
  return face;
}

/** fitting() answered here, at once (Random face, Random character, Reset, a Distinctiveness value not worked out ahead). */
function fitted(defs: SliderDef[], variation: number): Weights {
  const fit: FitReport = { shrunk: 0, striking: [] };
  const steps = fitting(defs, variation, { draw: lastDraw, asIs, striking, held }, fit);
  let r = steps.next();
  while (!r.done) {
    const a = r.value;
    r = steps.next(a.kind === "broken" ? limiter.broken(plainStore(a.face, defs)) : limiter.reach(plainStore(a.face, defs), a.target, a.end));
  }
  randomState.lastFit = fit;
  if (fit.shrunk) newState(); // the draw changed: what was worked out for the old one no longer holds
  return r.value;
}

// --- Distinctiveness worked out ahead ---------------------------------------------------------------------------------
// A drag above 1 asks the limiter how far each striking feature may go, at every value: answered during the drag, that
// holds a phone at ~2 fps. The face at each value depends only on the face being varied (the draw, or the face made by hand, and its
// striking features) and the limiter's vertices, so the caps worker works the values out ahead (the slider moves in
// notches of VARIATION.notch) and a drag just takes them. The same steps and the same answers as fitted(): a value not
// ready yet is worked out here.

/** Which face Distinctiveness varies: a new key whenever that changes (a random face, Reset, a face made by hand). */
let stateSerial = 0;
let stateKey = "s0";
const ahead = new Map<string, { next: Weights; fit: FitReport; draw: Record<string, number> | null }>(); // `${state}|${geometry}|${value}`
function newState(): void {
  stateKey = `s${++stateSerial}`;
  ahead.clear();
}

/** A face made by hand, not varied yet: worked out ahead as the face Distinctiveness would vary (taken on the first move). */
let candidate: { key: string; face: string; asIs: Weights; striking: Striking } | null = null;
const shapeSignature = (defs: SliderDef[], current: Weights) => JSON.stringify(defs.filter(isShape).map((d) => current[d.target] ?? d.default));

/** The Distinctiveness values the slider can stop at (its notches), nearest to `from` first. */
export function variationNotches(from: number): number[] {
  const out: number[] = [];
  for (let k = 0; k <= Math.round((VARIATION.max - VARIATION.min) / VARIATION.notch); k++) out.push(Math.round((VARIATION.min + k * VARIATION.notch) * 100) / 100);
  return out.sort((a, b) => Math.abs(a - from) - Math.abs(b - from));
}

let working: Promise<void> | null = null;
/**
 * Work the face at `values` out ahead (the caps worker answers the limiter's questions), for the face Distinctiveness
 * varies now, or would vary on its first move (a face made by hand). Stops as soon as that face changes; one run at a
 * time (a call during a run is skipped: the caller asks again when the face settles). Only while the caps worker answers.
 */
export function precomputeVariations(defs: SliderDef[], current: Weights, values: number[], geometry: string, ask: (defs: SliderDef[], a: LimitAsk) => Promise<boolean | number>): Promise<void> {
  if (working) return working;
  let key: string, base: FitState;
  if (hasRandomFace()) {
    key = stateKey;
    base = { draw: lastDraw, asIs, striking, held };
  } else {
    if (!changedByHand(defs, current)) return Promise.resolve();
    const face = shapeSignature(defs, current);
    if (candidate?.face !== face) {
      if (candidate) for (const k of [...ahead.keys()]) if (k.startsWith(`${candidate.key}|`)) ahead.delete(k);
      candidate = { key: `c${++stateSerial}`, face, asIs: Object.fromEntries(defs.filter(isShape).map((d) => [d.target, current[d.target] ?? d.default])), striking: pickStriking(defs) };
    }
    key = candidate.key;
    base = { draw: {}, asIs: candidate.asIs, striking: candidate.striking, held: {} };
  }
  const still = () => (hasRandomFace() ? stateKey : candidate?.key) === key;
  working = (async () => {
    for (const v of values) {
      const k = `${key}|${geometry}|${v}`;
      if (ahead.has(k)) continue;
      const st: FitState = { draw: { ...base.draw }, asIs: base.asIs, striking: base.striking, held: base.held };
      const fit: FitReport = { shrunk: 0, striking: [] };
      const steps = fitting(defs, v, st, fit);
      let r = steps.next();
      while (!r.done) {
        // the worker failed: `ask` would answer here without yielding (every notch at once); worked out on demand instead
        if (!canAsk()) return;
        const answer = await ask(defs, r.value);
        if (!still()) return;
        r = steps.next(answer);
      }
      ahead.set(k, { next: r.value, fit, draw: fit.shrunk ? st.draw : null });
    }
  })().finally(() => (working = null));
  return working;
}

/**
 * A new random face (a fresh draw and fresh striking features) at `variation` (default: the Distinctiveness the
 * slider is set to, which stays set between faces); the panel's slider moves to match. `hold`: sliders set along with
 * the face (Random character's Age), fitted with it and kept at those values.
 */
export function randomFace(defs: SliderDef[], variation: number = randomState.variation, hold: Weights = {}): Weights {
  newState();
  candidate = null;
  lastDraw = Object.fromEntries(defs.filter((d) => d.kind === "identity").map((d) => [d.target, gaussian()]));
  asIs = null;
  striking = pickStriking(defs);
  held = hold;
  randomState.variation = variation;
  lastApplied = fitted(defs, variation);
  notify();
  return lastApplied;
}

const hasRandomFace = () => asIs !== null || Object.keys(lastDraw).length > 0;
const changedByHand = (defs: SliderDef[], current: Weights) =>
  defs.some((d) => isShape(d) && Math.abs((current[d.target] ?? d.default) - d.default) > 1e-3);
/** Whether Distinctiveness has a face to vary: a random face, or one changed by hand (not the reset face; Age aside). */
export const canVary = (defs: SliderDef[], current: Weights) => hasRandomFace() || changedByHand(defs, current);

/**
 * The last random face (or the face made by hand) at another variation; null when there is nothing to vary. `geometry`
 * (capsClient geometryKey): the limiter's vertices now, so a value worked out ahead on others isn't used.
 */
export function varyFace(defs: SliderDef[], variation: number, current: Weights, geometry = ""): Weights | null {
  if (!hasRandomFace()) {
    if (!changedByHand(defs, current)) return null;
    const face = shapeSignature(defs, current);
    if (candidate?.face === face) {
      // worked out ahead as this face (precomputeVariations): take it as the face to vary
      asIs = candidate.asIs;
      striking = candidate.striking;
      stateKey = candidate.key;
    } else {
      asIs = Object.fromEntries(defs.filter(isShape).map((d) => [d.target, current[d.target] ?? d.default]));
      striking = pickStriking(defs);
      newState();
    }
    candidate = null;
    lastApplied = fitted(defs, VARIATION.default); // the face as it is
  }
  const hit = ahead.get(`${stateKey}|${geometry}|${variation}`);
  let next: Weights;
  if (hit) {
    next = hit.next;
    randomState.lastFit = hit.fit;
    if (hit.draw) {
      lastDraw = hit.draw; // as fitted() would have shrunk it
      newState();
    }
  } else {
    const key = stateKey;
    next = fitted(defs, variation);
    if (key === stateKey) ahead.set(`${key}|${geometry}|${variation}`, { next, fit: randomState.lastFit, draw: null });
  }
  // changes made by hand since the last random face ride on top; they fitted the old face, not necessarily this one
  // (a small head with hollow cheeks put the back gums through the cheeks), so they ease back until the face fits
  const kept = (share: number) => {
    const out: Weights = {};
    for (const d of defs) {
      if (!(d.target in next) || (!asIs && !(d.target in lastDraw) && d.kind !== "semantic")) continue;
      out[d.target] = clamp(next[d.target] + share * ((current[d.target] ?? 0) - (lastApplied[d.target] ?? 0)), d);
    }
    return out;
  };
  let out = kept(1);
  const byHand = Object.keys(out).some((t) => Math.abs((current[t] ?? 0) - (lastApplied[t] ?? 0)) > 1e-6);
  for (let share = 1, k = 0; byHand && k <= 10 && limiter.broken(plainStore({ ...current, ...out }, defs)); k++) out = kept((share = k < 10 ? share * 0.85 : 0));
  lastApplied = next;
  return out;
}

/** The striking features of the current random face (for the panel / e2e). */
export const strikingFeatures = () => striking.map((s) => s.target);
