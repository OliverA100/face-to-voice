/**
 * Fine-tune reach: how far each fine-tune control (Expression tab › Fine-tune) may go on top of the current emotion
 * and the other fine-tune controls, so stacking them never makes a face no face can make.
 *
 * Data: data/fxReach.json (`uv run validate --fx-reach`). Two limits per control and side:
 *  - the envelope: every expression measure (lid opening, brow height, jaw drop …, each side apart) stays within the
 *    furthest any real expression takes it (+ tolMm). Linear in the weights, so exact for any emotion mix and
 *    intensity: Surprised already opens the eyes about as wide as eyes go, so "Eyes wide" adds little on it.
 *  - geometry: where emotion + control starts to break the face on the average head, per emotion at full strength,
 *    interpolated by the emotion's weight here.
 *
 * The slider keeps its full travel: the store spreads `value × reach` (store.setComboReach), so the slider's end
 * always means "as far as this face allows now". The control being moved yields to the others (it is computed
 * last), so moving one slider never makes another one jump. Nothing here runs per frame: only when the emotion
 * blends or a fine-tune value changes.
 */
import reachDoc from "@/data/fxReach.json";
import { morphs } from "@/lib/morphs/store";

type Ctl = { pos: number[]; neg: number[]; geo: Record<string, [number, number]> };
const doc = reachDoc as unknown as {
  measures: string[];
  tolMm: number;
  minRateMm: number;
  lo: number[];
  hi: number[];
  emotions: Record<string, { upper: number[]; lower: number[] }>;
  controls: Record<string, Ctl>;
};
const N = doc.lo.length;

/** Most recently moved last: it yields to the rest. */
const order: string[] = Object.keys(doc.controls);
let emotion: Record<string, number> = {};

/** How far (0..end) one side may go from `acc` (mm per measure so far) before a measure leaves the envelope. */
function envelopeReach(acc: Float64Array, a: number[], end: number): number {
  let t = end;
  for (let j = 0; j < N; j++) {
    const r = a[j];
    if (Math.abs(r) < doc.minRateMm) continue;
    const lim = r > 0 ? (doc.hi[j] + doc.tolMm - acc[j]) / r : (doc.lo[j] - doc.tolMm - acc[j]) / r;
    if (lim < t) t = Math.max(0, lim);
  }
  return t;
}

/** The geometric reach on the current emotion mix: neutral's, moved toward each emotion's by its weight. */
function geoReach(c: Ctl, side: 0 | 1): number {
  const n = c.geo.neutral[side];
  let g = n;
  for (const [id, w] of Object.entries(emotion)) if (w > 0 && c.geo[id]) g += w * (c.geo[id][side] - n);
  return Math.max(0, g);
}

/** Recompute every control's reach and hand it to the store (which re-spreads only the ones that changed). */
function updateFxReach(): void {
  const acc = new Float64Array(N);
  for (const [id, w] of Object.entries(emotion)) {
    const e = doc.emotions[id];
    if (!e || !w) continue;
    for (let j = 0; j < N; j++) acc[j] += w * (e.upper[j] + e.lower[j]);
  }
  for (const t of order) {
    const c = doc.controls[t];
    const [min, max] = morphs.ranges[t] ?? [-1, 1];
    const reach: [number, number] = [0, 0];
    ([[0, -min, c.neg], [1, max, c.pos]] as const).forEach(([side, end, a]) => {
      if (end <= 1e-6) return;
      reach[side] = Math.min(envelopeReach(acc, a, end), geoReach(c, side), end) / end;
    });
    morphs.setComboReach(t, reach);
    const x = morphs.base[t] ?? 0;
    const a = x < 0 ? c.neg : c.pos;
    const k = Math.abs(x) * reach[x < 0 ? 0 : 1];
    if (k) for (let j = 0; j < N; j++) acc[j] += k * a[j];
  }
}

/** What the fine-tune controls spread over the morph targets now (target → weight; animCaps.ts). */
export function fxSpread(): Record<string, number> {
  const out: Record<string, number> = {};
  for (const t of order) {
    const x = morphs.base[t] ?? 0;
    const c = x ? morphs.comboOf(t) : undefined;
    if (!c) continue;
    const w = x < 0 && c.neg ? c.neg : c.pos;
    const k = x < 0 && c.neg ? -x : x;
    for (const [n, v] of Object.entries(w)) out[n] = (out[n] ?? 0) + k * v;
  }
  return out;
}

/** mm the emotion's mouth part parts the lips at full strength (its lip_part measure; 0 for closed-lip emotions). */
export function emotionLipPartMm(id: string): number {
  const j = doc.measures.indexOf("lip_part");
  const e = doc.emotions[id];
  return e && j >= 0 ? Math.max(0, e.lower[j]) : 0;
}

/** emotion.ts: the applied strength of each emotion (weight × intensity curve; the mouth part counted in full). */
export function setFxEmotion(weights: Record<string, number>): void {
  emotion = weights;
  updateFxReach();
}

// a fine-tune value moved: it goes last, so it yields to the others and to the emotion
morphs.onChange((target, _v, source) => {
  if (!(target in doc.controls)) return;
  if (source === "ui") {
    order.splice(order.indexOf(target), 1);
    order.push(target);
  }
  updateFxReach();
});
