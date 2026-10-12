/**
 * The face during a live conversation: each reply's mood (the agent's "ftv.mood" attribute) becomes the face's
 * expression with the app's own blend (MOTION.blend), and the head nods along while the visitor talks and once as the
 * character answers (lipsyncState, read by IdleLife). The visitor's own expression comes back when the chat ends.
 */
import { gsap } from "gsap";

import { emotionRig, NEUTRAL, setEmotion, setIntensity } from "@/lib/emotion";
import { lipsyncState } from "@/lib/lipsync/state";
import { MOTION } from "@/lib/motion";

let saved: { emotion: string; intensity: number } | null = null;

export function chatFaceStart(): void {
  saved ??= { emotion: emotionRig.current, intensity: emotionRig.intensity };
}

/** A reply's mood: "neutral" at 0 relaxes the face; anything else blends to that emotion at that intensity. */
export function chatMood(mood: { emotion: string; intensity: number }): void {
  if (!saved) return;
  setEmotion(mood.emotion === NEUTRAL || mood.intensity <= 0 ? NEUTRAL : mood.emotion, MOTION.blend);
  if (mood.intensity > 0) setIntensity(mood.intensity, "code", MOTION.blend);
}

/** The visitor is talking (and the character listening): nod along, eased. */
export function chatListening(on: boolean): void {
  gsap.to(lipsyncState, { listening: on ? 1 : 0, duration: MOTION.move, ease: MOTION.ease.follow, overwrite: "auto" });
}

/** The character takes its turn: one nod, down and back. */
export function chatNod(): void {
  gsap.timeline({ overwrite: "auto" })
    .to(lipsyncState, { nod: 1, duration: 0.22, ease: "power2.out" })
    .to(lipsyncState, { nod: 0, duration: 0.45, ease: "power2.inOut" });
}

export function chatFaceEnd(): void {
  chatListening(false);
  if (!saved) return;
  setEmotion(saved.emotion, MOTION.blend);
  setIntensity(saved.intensity, "code", MOTION.blend);
  saved = null;
}
