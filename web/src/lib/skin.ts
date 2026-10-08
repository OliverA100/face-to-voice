/**
 * Skin tone. The head has no colour texture, so the tone is simply the colour of the one skin
 * material (scene/materials.ts builds it from `skinHex()`); choosing a swatch recolours that
 * material in place. Like the hair, the choice is plain module state, kept in sessionStorage
 * (per tab: a new tab opens on the blank head), and part of the look that reaches the voice (lib/look.ts).
 *
 * The swatches are a light-to-dark ramp tuned for this renderer. Add, remove or recolour rows
 * freely; ids are what the voice step hears ("skin tone: deep brown"), so keep them readable.
 */
import gsap from "gsap";
import { Color, type MeshPhysicalMaterial } from "three";

import { MOTION } from "@/lib/motion";
import { SKIN_TONES } from "@/lib/swatches";

export { SKIN_TONES } from "@/lib/swatches"; // plain data, shared with the server's allowlist (lib/server/look.ts)
export type SkinToneId = (typeof SKIN_TONES)[number]["id"];

export const SKIN_DEFAULT: SkinToneId = "beige";
const STORAGE_KEY = "ftv-skin";
/** How far the peach-fuzz sheen is lifted towards white from the tone (0 = the tone itself). */
const SHEEN_LIFT = 0.6;

export const skinRig = { material: null as MeshPhysicalMaterial | null };
export const skinState: { tone: SkinToneId } = { tone: SKIN_DEFAULT };

const tone = () => SKIN_TONES.find((t) => t.id === skinState.tone) ?? SKIN_TONES[3];
const white = new Color("#ffffff");

/** The colour the skin material is built with (scene/materials.ts). */
export const skinHex = (): string => tone().hex;
export const skinSheen = (): Color => new Color(tone().hex).lerp(white, SHEEN_LIFT);

// --- a tiny store so the control can follow the state (useSyncExternalStore) ---
const listeners = new Set<() => void>();
export const subscribeSkin = (fn: () => void) => {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
};
export const skinSnapshot = (): SkinToneId => skinState.tone;
export const skinServerSnapshot = (): SkinToneId => SKIN_DEFAULT;

/** Push the current tone onto the skin material (no-op until the head has loaded). */
export function applySkin(): void {
  const material = skinRig.material;
  if (!material) return;
  material.color.set(skinHex());
  material.sheenColor.copy(skinSheen());
}

let tween: gsap.core.Tween | null = null;

/**
 * Choose a tone. `seconds` > 0 blends the material from its current colour (Random character and Reset, in step with
 * the face morph); the Style tab changes it at once. The state (and the voice's look) changes immediately either way.
 */
export function setSkinTone(id: SkinToneId, seconds = 0): void {
  skinState.tone = id;
  try {
    window.sessionStorage.setItem(STORAGE_KEY, id);
  } catch {
    /* private mode: no persistence */
  }
  tween?.kill();
  tween = null;
  const material = skinRig.material;
  if (seconds > 0 && material) {
    const from = { color: material.color.clone(), sheen: material.sheenColor.clone() };
    const to = { color: new Color(skinHex()), sheen: skinSheen() };
    const mix = { t: 0 };
    tween = gsap.to(mix, {
      t: 1,
      duration: seconds,
      ease: MOTION.ease.morph, // blends with the morph
      onUpdate: () => {
        const m = skinRig.material;
        m?.color.lerpColors(from.color, to.color, mix.t);
        m?.sheenColor.lerpColors(from.sheen, to.sheen, mix.t);
      },
    });
  } else applySkin();
  for (const fn of listeners) fn();
}

// Restore the last choice once, in the browser only.
if (typeof window !== "undefined") {
  try {
    const saved = window.sessionStorage.getItem(STORAGE_KEY);
    if (SKIN_TONES.some((t) => t.id === saved)) skinState.tone = saved as SkinToneId;
  } catch {
    /* private mode: keep the default */
  }
}
