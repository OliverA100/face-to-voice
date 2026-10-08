/**
 * The live character as data (character.json) and its rebuild link. Reads the same state the tab saves to
 * sessionStorage (lib/faceSession.ts and friends), so opening the link (lib/export/openLink.ts) restores it exactly.
 */
import { addonState } from "@/lib/addons";
import { sliders } from "@/lib/data";
import { emotionRig } from "@/lib/emotion";
import { eyeState } from "@/lib/eyes";
import { hairState } from "@/lib/hair";
import { morphs } from "@/lib/morphs/store";
import { LIMITS, poseRig, type PoseKey } from "@/lib/pose";
import { skinState } from "@/lib/skin";

import { CHARACTER_FORMAT, CHARACTER_VERSION, encodeCharacter, type CharacterFile } from "./characterCode";

const round = (v: number, places: number) => Math.round(v * 10 ** places) / 10 ** places;

export function currentCharacter(): CharacterFile {
  // Shape: every slider that moved, as faceSession.ts saves it (emotion targets are the emotion, below).
  const shape: Record<string, number> = {};
  for (const t of morphs.targets()) {
    if (morphs.kinds[t] === "emotion") continue;
    const v = morphs.base[t];
    if (Math.abs(v - morphs.defaults[t]) > 1e-4) shape[t] = round(v, 4);
  }
  return {
    format: CHARACTER_FORMAT,
    version: CHARACTER_VERSION,
    sliders: sliders.version,
    shape,
    emotion: emotionRig.current,
    intensity: round(emotionRig.intensity, 4),
    // the named keys only: GSAP keeps a hidden `_gsap` cache on the object it tweens
    pose: Object.fromEntries((Object.keys(LIMITS) as PoseKey[]).map((k) => [k, round(poseRig.base[k], 2)])),
    hair: { style: hairState.style, colour: hairState.colour },
    addons: { ...addonState },
    skin: skinState.tone,
    eyes: eyeState.colour,
  };
}

/** A link that opens this character in the app (the hash never reaches the server). */
export function characterLink(c: CharacterFile = currentCharacter(), origin = location.origin): string {
  return `${origin}/#c=${encodeCharacter(c)}`;
}
