/**
 * "Jaw width: +0.60, Smile ↔ frown: -0.20" for the named sliders that are not at rest: the slider line Claude reads
 * next to the screenshot. Built on the server from the validated slider positions (never taken from the browser), so a
 * crafted request cannot put its own words into the casting prompt. Raw sliders are left out: their names mean little,
 * and the designer sees their effect in the image.
 */
import slidersJson from "@/data/sliders.json";

/** Raw model components (the Advanced sliders): each moves many features, so their names mean little to the designer. */
const RAW_KINDS: ReadonlySet<string> = new Set(["identity", "expression", "preset"]);

const NAMES = new Map(
  (slidersJson as unknown as { sliders: { target: string; name: string; kind: string }[] }).sliders
    .filter((s) => !RAW_KINDS.has(s.kind))
    .map((s) => [s.target, s.name]),
);

/** `positions`: slider target → panel position (−1 … +1, lib/morphs/travel.ts), in the order the panel sent them. */
export function summariseSliders(positions: Record<string, number>): string {
  return Object.entries(positions)
    .filter(([t, v]) => NAMES.has(t) && Math.abs(v) >= 0.05)
    .map(([t, v]) => `${NAMES.get(t)}: ${v > 0 ? "+" : ""}${v.toFixed(2)}`)
    .join(", ");
}
