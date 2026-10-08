/**
 * The limiter's small, data-free part: what the morph store, the animation caps and Random face need at once. The
 * limiter itself (limits.ts + data/limits.json, 80 KB gzip) loads after the head's first frame (lib/morphs/limiter.ts).
 */
import type { SliderDef } from "@/lib/data";

/** Layers that move the face's resting shape (limited by each slider's span) vs animation layers (capped per face). */
export const REST_LAYERS = new Set(["combo"]);

export interface LimitStore {
  base: Record<string, number>;
  /** base + combo for a target (no animation layers, no clamp). */
  userValue(target: string): number;
  /** The mix sliders: slider → weights it spreads (pos for x ≥ 0, neg for x < 0 when two-sided). */
  comboOf(slider: string): { pos: Record<string, number>; neg: Record<string, number> | null } | undefined;
}

/** The blink stages at which the eyes' draw-back is solved (Head.tsx interpolates between them, 0 when open). */
export const BLINK_STAGES = [0.25, 0.5, 0.75, 1];

/** A LimitStore over plain slider weights (no meshes): for checking a face before it is applied. */
export function plainStore(base: Record<string, number>, defs: Pick<SliderDef, "target" | "combo" | "comboNeg">[]): LimitStore {
  const mixes = defs.filter((d) => d.combo);
  return {
    base,
    userValue: (t) =>
      (base[t] ?? 0) +
      mixes.reduce((sum, d) => {
        const x = base[d.target] ?? 0;
        return sum + (x < 0 && d.comboNeg ? -x * (d.comboNeg[t] ?? 0) : x * (d.combo![t] ?? 0));
      }, 0),
    comboOf: (slider) => {
      const d = mixes.find((m) => m.target === slider);
      return d ? { pos: d.combo!, neg: d.comboNeg ?? null } : undefined;
    },
  };
}
