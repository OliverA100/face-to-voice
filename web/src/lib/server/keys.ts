/** Cache keys. Sliders are quantised so tiny drags don't miss the cache; keys are sha256 hex. */
import { createHash } from "node:crypto";

import { quantiseFace } from "@/lib/voice/faceSignature";

/** Bump when the description prompt or schema changes, so old cached descriptions are ignored. */
const PROMPT_VERSION = "v8";

const sha = (parts: unknown) => createHash("sha256").update(JSON.stringify(parts)).digest("hex");

/**
 * `look` is everything the visitor styled besides the sliders (lib/server/look.ts: skin, hair, add-ons, expression,
 * pose). It is in the picture Claude sees, so it is in the key too. The quantisation is shared with the voice panel
 * (lib/voice/faceSignature.ts), which uses it to tell whether the face changed.
 */
export function faceKey(weights: Record<string, number>, look: Record<string, string> = {}): string {
  return sha([PROMPT_VERSION, ...quantiseFace(weights, look)]);
}

/** The voice is keyed on the normalised description, so many faces share one saved voice. */
export function descriptionKey(fields: Record<string, string | string[]>): string {
  const normalised = Object.keys(fields)
    .sort()
    .map((k) => [k, Array.isArray(fields[k]) ? [...fields[k]].map((s) => s.toLowerCase()).sort() : String(fields[k]).toLowerCase()]);
  return sha([PROMPT_VERSION, normalised]);
}

/** `text` includes the emotion tag, so the same line in another mood is another clip. */
export function ttsKey(voiceId: string, model: string, text: string): string {
  return sha([voiceId, model, text.trim().replace(/\s+/g, " ")]);
}
