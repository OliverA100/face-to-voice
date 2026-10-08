/**
 * Eye colour. The iris is one flat-coloured material shared by both eyes (scene/materials.ts builds
 * it from `eyeHex()`); choosing a swatch recolours it in place. Plain module state, kept in
 * sessionStorage (per tab: a new tab opens on the blank head), and part of the look that reaches
 * the voice (lib/look.ts). Swatches live in lib/swatches.ts (EYE_COLOURS).
 */
import gsap from "gsap";
import { Color, type MeshPhysicalMaterial } from "three";

import { MOTION } from "@/lib/motion";
import { EYE_COLOURS } from "@/lib/swatches";

export { EYE_COLOURS } from "@/lib/swatches";
export type EyeColourId = (typeof EYE_COLOURS)[number]["id"];

export const EYE_DEFAULT: EyeColourId = "blue-grey";
const STORAGE_KEY = "ftv-eyes";

export const eyeRig = { material: null as MeshPhysicalMaterial | null };
export const eyeState: { colour: EyeColourId } = { colour: EYE_DEFAULT };

/** The colour the iris material is built with (scene/materials.ts). */
export const eyeHex = (): string => (EYE_COLOURS.find((c) => c.id === eyeState.colour) ?? EYE_COLOURS[1]).hex;

// --- a tiny store so the control can follow the state (useSyncExternalStore) ---
const listeners = new Set<() => void>();
export const subscribeEyes = (fn: () => void) => {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
};
export const eyeSnapshot = (): EyeColourId => eyeState.colour;
export const eyeServerSnapshot = (): EyeColourId => EYE_DEFAULT;

/** Push the current colour onto the iris material (no-op until the head has loaded). */
export function applyEyes(): void {
  eyeRig.material?.color.set(eyeHex());
}

let tween: gsap.core.Tween | null = null;

/** Choose an iris colour. `seconds` > 0 blends it (Random character and Reset); the Style tab changes it at once. */
export function setEyeColour(id: EyeColourId, seconds = 0): void {
  eyeState.colour = id;
  try {
    window.sessionStorage.setItem(STORAGE_KEY, id);
  } catch {
    /* private mode: no persistence */
  }
  tween?.kill();
  tween = null;
  const material = eyeRig.material;
  if (seconds > 0 && material) {
    const from = material.color.clone();
    const to = new Color(eyeHex());
    const mix = { t: 0 };
    tween = gsap.to(mix, { t: 1, duration: seconds, ease: MOTION.ease.morph, onUpdate: () => eyeRig.material?.color.lerpColors(from, to, mix.t) });
  } else applyEyes();
  for (const fn of listeners) fn();
}

// Restore the last choice once, in the browser only.
if (typeof window !== "undefined") {
  try {
    const saved = window.sessionStorage.getItem(STORAGE_KEY);
    if (EYE_COLOURS.some((c) => c.id === saved)) eyeState.colour = saved as EyeColourId;
  } catch {
    /* private mode: keep the default */
  }
}
