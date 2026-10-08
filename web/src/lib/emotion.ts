/**
 * Emotions (sliders.json `emotions`, built from pipeline/config/emotions.json): happy, sad, angry, surprised ….
 *
 * Each emotion is two morph targets in head.extra.glb (lib/headExtra.ts): an upper-face part (brows, lids) and a
 * lower-face part (mouth, cheeks). The mix lives in `emotionRig` (plain numbers, GSAP tweens them, React never
 * sees them) and is written into the morph store's "emotion" layer:
 *
 *   upper influence = weight × intensity^curve
 *   lower influence = weight × intensity^curve × lowerGain
 *
 * lowerGain is 1 at rest and drops to EMOTION.lowerWhileSpeaking while the voice talks (set by
 * LipSync every frame it runs), so the visemes stay readable while the eyes keep the feeling.
 */
import gsap from "gsap";

import { emotionDefs, type SliderDef } from "@/lib/data";
import { emotionLipPartMm, setFxEmotion } from "@/lib/morphs/fxReach";
import { MOTION } from "@/lib/motion";
import { morphs } from "@/lib/morphs/store";

/** Tweak freely. */
export const EMOTION = {
  lowerWhileSpeaking: 0.3, // share of the mouth part kept while speaking (0 = visemes only, 1 = full emotion)
  // On a p/b/m or f/v the mouth part of an emotion that parts the lips (Surprised, Afraid, Pain …) gets out of the way,
  // in proportion to how far it parts them: fully from this many mm (at its strength now), not at all for closed lips.
  openLipsMm: 4,
  blend: MOTION.blend, // seconds to cross-fade from one emotion to the next (a Random character uses the morph's)
  ease: MOTION.ease.morph,
  intensityEase: MOTION.follow, // seconds: the intensity slider's easing (like every slider that drags the face)
  // Intensity response: applied strength = intensity^curve. Below 1 the low end of the slider is stronger,
  // so "a hint" of each emotion is already readable (0.1 → 0.25, 0.25 → 0.44 at curve 0.6).
  curve: 0.6,
};

export const NEUTRAL = "neutral";
const LAYER = "emotion";

export const emotionRig = {
  weights: Object.fromEntries(emotionDefs.map((e) => [e.id, 0])) as Record<string, number>,
  intensity: 0.8, // replaced by sliders.json emotions.intensity.default in configureEmotions()
  lowerGain: 1,
  current: NEUTRAL, // the emotion last chosen (what the look and the speak route report)
};

type Listener = (id: string) => void;
const listeners = new Set<Listener>();
let tween: gsap.core.Tween | null = null;
let intensitySetter: ((v: number) => void) | null = null;
let intensityTween: gsap.core.Tween | null = null; // a timed change from code (Random character, Reset)

/** Hidden store definitions for the emotion targets (range 0..1), so the store binds and clamps them. */
export function configureEmotions(defaultIntensity: number): void {
  emotionRig.intensity = defaultIntensity;
  const defs: SliderDef[] = emotionDefs.flatMap((e) =>
    [e.upper, e.lower].map((target) => ({
      id: target, target, kind: "emotion" as const, region: "emotion", name: target, description: "",
      lowLabel: "", highLabel: "", group: "emotion", min: 0, max: 1, default: 0, hidden: true,
    })),
  );
  morphs.configure(defs);
}

/** Push the current mix into the morph layer (cheap: two targets per emotion). */
export function applyEmotion(): void {
  morphs.emotionGain = emotionRig.lowerGain;
  const k = Math.pow(Math.max(0, emotionRig.intensity), EMOTION.curve);
  const applied: Record<string, number> = {};
  for (const e of emotionDefs) {
    const w = emotionRig.weights[e.id] * k;
    morphs.setLayerValue(LAYER, e.upper, w);
    morphs.setLayerValue(LAYER, e.lower, w * emotionRig.lowerGain);
    applied[e.id] = w;
  }
  setFxEmotion(applied); // the fine-tune controls make room for it (fxReach.ts)
}

/** A blend step: the shading and eye pivots follow live (Head.tsx), not only when it settles. */
function applyEmotionMoving(): void {
  applyEmotion();
  morphs.markShapeChanged();
}

/** Cross-fade to one emotion ("neutral" = none). */
export function setEmotion(id: string, duration = EMOTION.blend): void {
  const target = Object.fromEntries(emotionDefs.map((e) => [e.id, e.id === id ? 1 : 0]));
  emotionRig.current = emotionDefs.some((e) => e.id === id) ? id : NEUTRAL;
  tween?.kill();
  tween = gsap.to(emotionRig.weights, {
    ...target,
    duration,
    ease: EMOTION.ease,
    onUpdate: applyEmotionMoving,
    onComplete: () => {
      morphs.settleNow(); // shading follows the new shape (and Head.tsx's settle recomputes the animation caps)
    },
  });
  for (const fn of listeners) fn(emotionRig.current);
}

const intensityListeners = new Set<(value: number, seconds: number) => void>();

/**
 * Eased intensity (0..1). "code" (random character) also tells the Intensity slider to move; "ui" is the slider itself.
 * `seconds`: a tween of that length on the morph's ease instead of the slider's follow (a Random character / Reset).
 */
export function setIntensity(value: number, source: "ui" | "code" = "ui", seconds?: number): void {
  intensityTween?.kill();
  intensityTween = null;
  if (seconds) {
    gsap.killTweensOf(emotionRig, "intensity");
    intensitySetter = null; // its tween is gone: the next drag makes a new one
    intensityTween = gsap.to(emotionRig, { intensity: value, duration: seconds, ease: EMOTION.ease, onUpdate: applyEmotionMoving, onComplete: () => morphs.settleNow() });
  } else {
    intensitySetter ??= gsap.quickTo(emotionRig, "intensity", {
      duration: EMOTION.intensityEase,
      ease: MOTION.ease.follow,
      onUpdate: applyEmotionMoving,
      onComplete: () => morphs.settleNow(),
    });
    intensitySetter(value);
  }
  if (source === "code") for (const fn of intensityListeners) fn(value, seconds ?? 0);
}

/** The Intensity slider follows code changes; `seconds` > 0: the change is a tween that long (its thumb rides along). */
export function onIntensityChange(fn: (value: number, seconds: number) => void): () => void {
  intensityListeners.add(fn);
  return () => intensityListeners.delete(fn);
}

/**
 * Called by LipSync each frame it runs: `activity` 1 = speaking (the mouth part drops to EMOTION.lowerWhileSpeaking),
 * `closure` 1 = the lips are shut on a p/b/m or f/v (an emotion that parts the lips lets go of them, see openLipsMm).
 */
export function setSpeechActivity(activity: number, closure = 0): void {
  let gain = 1 - (1 - EMOTION.lowerWhileSpeaking) * Math.min(1, Math.max(0, activity));
  if (closure > 0) gain *= 1 - Math.min(1, closure) * lipOpening();
  if (Math.abs(gain - emotionRig.lowerGain) < 1e-3) return;
  emotionRig.lowerGain = gain;
  applyEmotion();
}

/** 0..1: how much the current emotion mix holds the lips apart (its lip_part at the applied strength vs openLipsMm). */
function lipOpening(): number {
  const k = Math.pow(Math.max(0, emotionRig.intensity), EMOTION.curve);
  let open = 0;
  for (const e of emotionDefs) {
    const w = emotionRig.weights[e.id];
    if (!w) continue;
    const x = Math.min(1, Math.max(0, (emotionLipPartMm(e.id) * k) / EMOTION.openLipsMm));
    open += w * x * x * (3 - 2 * x);
  }
  return Math.min(1, open);
}

/**
 * For the speak route and the look: the chosen emotion and its intensity in quarter steps. Never below 0.25:
 * the slider's "a hint" end (0.2) is visible on the face, so the voice should hear a hint too, not 0.
 */
export function currentEmotion(): { emotion: string; intensity: number } {
  return { emotion: emotionRig.current, intensity: Math.max(0.25, Math.round(emotionRig.intensity * 4) / 4) };
}

export function onEmotionChange(fn: Listener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
