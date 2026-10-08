/**
 * Slider travel: what a morph slider's thumb position means.
 *
 * sliders.json `min` / `max` are the morph weights at the two ends of a slider (pipeline: `uv run slider-ranges`
 * sizes each end in real units, and a feature can go further one way than the other). The panel always shows a
 * two-sided slider as −1 … +1 with the average face (weight 0) in the middle, and scales each half to its own end:
 *
 *   thumb u < 0  ->  weight = u × |min|        thumb u > 0  ->  weight = u × max
 *
 * So the middle is always the average face and the whole track always does something; a tick may be a different
 * number of millimetres on the two sides. One-sided sliders (min 0, e.g. "Jaw open") keep their weights as they are.
 *
 * While a slider is dragged its ends adapt (adaptiveTrack): the end of the track is as far as THIS face allows right
 * now (lib/morphs/limits.ts span()), so a slider always drags to its end and never meets a wall.
 */
import { type SliderDef, sliders } from "@/lib/data";

type Ends = Pick<SliderDef, "min" | "max">;

const twoSided = (d: Ends) => d.min < 0 && d.max > 0;

/** The input's own range. */
export const uiMin = (d: Ends) => (twoSided(d) ? -1 : d.min);
export const uiMax = (d: Ends) => (twoSided(d) ? 1 : d.max);

/** Thumb position -> morph weight. */
export function toWeight(d: Ends, u: number): number {
  if (!twoSided(d)) return u;
  return u < 0 ? u * -d.min : u * d.max;
}

/** Morph weight -> thumb position (clamped to the track). */
export function toUi(d: Ends, w: number): number {
  if (!twoSided(d)) return w;
  return Math.max(-1, Math.min(1, w < 0 ? w / -d.min : w / d.max));
}

const byTarget = new Map(sliders.sliders.map((d) => [d.target, d]));

/** The slider definition behind a store target (undefined for hidden targets such as emotions). */
export const sliderFor = (target: string): SliderDef | undefined => byTarget.get(target);

/**
 * The dragged slider's track: thumb → weight through four fixed points, linear between them:
 *   −1 → lo (as far down as this face allows), 0 → 0 (the average face), +1 → hi (as far up as it allows),
 *   and the thumb's position when it was grabbed (u0) → the weight it had (w0), so nothing jumps.
 * One-sided sliders use 0 → lo (= 0 or their minimum) and +1 → hi. A fixed point the thumb already sits on takes the
 * current weight instead. If the face only allows one side of 0, the result is kept inside [lo, hi].
 */
export function adaptiveTrack(d: Ends, u0: number, w0: number, lo: number, hi: number): (u: number) => number {
  // a fixed point where the thumb already sits takes the slider's current weight instead (nothing may jump)
  const pts: [number, number][] = (twoSided(d) ? [[-1, lo], [0, 0], [1, hi]] : [[d.min, lo], [d.max, hi]])
    .filter(([u]) => Math.abs(u - u0) > 1e-6) as [number, number][];
  pts.push([u0, w0]);
  pts.sort((a, b) => a[0] - b[0]);
  return (u: number) => {
    let k = 0;
    while (k < pts.length - 2 && u > pts[k + 1][0]) k++;
    const [ua, wa] = pts[k];
    const [ub, wb] = pts[k + 1];
    const w = ub === ua ? wb : wa + ((u - ua) / (ub - ua)) * (wb - wa);
    return Math.max(lo, Math.min(hi, w));
  };
}
