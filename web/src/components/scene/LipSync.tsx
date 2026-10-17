"use client";

/**
 * Drives the mouth from the voice playing (activeSpeech(): the speech player, or a live conversation's voice) every
 * frame: the clip time the mouth shows → lib/lipsync/mouth.ts (cues → smoothed viseme activations → the `viseme` morph
 * layer, on top of whatever the sliders say). Runs only while something is playing or fading out.
 */
import { useFrame } from "@react-three/fiber";

import { setSpeechActivity } from "@/lib/emotion";
import { LIPSYNC, LIPSYNC_PARTS } from "@/lib/lipsync/evaluator";
import { Mouth } from "@/lib/lipsync/mouth";
import { PHONEMES } from "@/lib/lipsync/phonemes";
import { activeSpeech } from "@/lib/lipsync/source";
import { lipsyncState } from "@/lib/lipsync/state";
import { visemeCap } from "@/lib/morphs/animCaps";
import { morphs } from "@/lib/morphs/store";

// Module state: this component is a singleton and the render loop moves the mouth every frame, which React state or
// memo values must not.
const mouth = new Mouth(
  {
    cap: visemeCap,
    userValue: (target) => morphs.userValue(target),
    speechActivity: setSpeechActivity,
    write: (target, value) => morphs.setLayerValue("viseme", target, value),
    clear: () => morphs.clearLayer("viseme"),
  },
  lipsyncState,
);

// `?debug&lipsyncOff=jawSplit,placePhrases,phonemes`: single parts off (LIPSYNC_PARTS, or the pronouncing dictionary),
// to compare one change on the same page.
const query = typeof window !== "undefined" ? new URLSearchParams(window.location.search) : null;
if (query?.has("debug")) {
  for (const part of (query.get("lipsyncOff") ?? "").split(",")) {
    if (part === "phonemes") PHONEMES.enabled = false;
    else if (part in LIPSYNC_PARTS) LIPSYNC_PARTS[part as keyof typeof LIPSYNC_PARTS] = false;
  }
}

export function LipSync() {
  useFrame((_, dt) => {
    const src = activeSpeech();
    const heard = src.playing ? src.time() : -1; // the sound's time, read once per frame (the dev overlays' cursor)
    lipsyncState.clipTime = heard;
    // the whole mouth runs LIPSYNC.lead ahead of the sound: shapes and loudness alike
    mouth.frame(src, src.playing ? heard + LIPSYNC.lead : -1, dt);
  });

  return null;
}
