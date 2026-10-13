"use client";

/**
 * Drives the mouth from the voice playing (activeSpeech(): the speech player, or a live conversation's voice) every
 * frame: the clip time the mouth shows → lib/lipsync/mouth.ts (cues → smoothed viseme activations → the `viseme` morph
 * layer, on top of whatever the sliders say). Runs only while something is playing or fading out.
 */
import { useFrame } from "@react-three/fiber";
import { useEffect, useMemo } from "react";

import { setSpeechActivity } from "@/lib/emotion";
import { CLOCK } from "@/lib/lipsync/clock";
import { mouthLead, oldTiming } from "@/lib/lipsync/evaluator";
import { Mouth } from "@/lib/lipsync/mouth";
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

// `?lipsync=v1`: the timing before the 2026-10-13 pass, to compare (TEMPORARY, see oldTiming)
if (typeof window !== "undefined" && new URLSearchParams(window.location.search).get("lipsync") === "v1") {
  oldTiming();
  CLOCK.fixes = false;
}

export function LipSync() {
  const lead = useMemo(() => mouthLead(typeof window !== "undefined" ? new URLSearchParams(window.location.search).get("lipsyncOffsetMs") : null), []);
  useEffect(() => {
    lipsyncState.leadMs = Math.round(lead * 1000);
  }, [lead]);

  useFrame((_, dt) => {
    const src = activeSpeech();
    const heard = src.playing ? src.time() : -1; // the sound's time, read once per frame (the dev overlays' cursor)
    lipsyncState.clipTime = heard;
    // the whole mouth runs `lead` ahead of the sound (LIPSYNC.lead): shapes and loudness alike
    mouth.frame(src, src.playing ? heard + lead : -1, dt);
  });

  return null;
}
