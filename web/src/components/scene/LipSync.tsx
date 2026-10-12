"use client";

/**
 * Drives the mouth from the voice playing (activeSpeech(): the speech player, or a live conversation's voice) every
 * frame: cues → smoothed viseme activations → the `viseme` morph layer (activation × preset weights from
 * visemes.json), on top of whatever the sliders say. Runs only while something is playing or fading out.
 */
import { useFrame } from "@react-three/fiber";
import { useEffect, useMemo } from "react";

import { visemePreset, visemes } from "@/lib/data";
import { setSpeechActivity } from "@/lib/emotion";
import { VISEME_IDS, type VisemeId } from "@/lib/lipsync/cues";
import { visemeCap } from "@/lib/morphs/animCaps";
import { emptyActivations, frameMemory, frameTargets, LIPSYNC, LIPSYNC_PARTS, mouthLead, roundingAt, sealWeight, tongueAt, smoothTowards, shapeShare, speedShare, speedUpShare, type FrameMemory, type SpeechSource } from "@/lib/lipsync/evaluator";
import { activeSpeech } from "@/lib/lipsync/source";
import { lipsyncState } from "@/lib/lipsync/state";
import { morphs } from "@/lib/morphs/store";

// Per-frame scratch buffer. Module state: this component is a singleton and the render loop
// mutates it every frame, which React state or memo values must not be.
const scratch = emptyActivations();
// What each speech source's frames remember (snapped cues, the held vowel): the player's lines and a conversation's.
const memories = new WeakMap<SpeechSource, FrameMemory>();
const memoryOf = (src: SpeechSource) => memories.get(src) ?? memories.set(src, frameMemory()).get(src)!;
// The jaw morph (visemes.json roles.jawOpen) gets a second smoothing stage; this is its state.
const jawTarget = Object.keys(visemes.roles.jawOpen)[0];
let jawValue = 0;
// the lips' and jaw's velocities last frame (mm/s), for LIPSYNC.speedUp
let gapVel = 0;
let jawVel = 0;
// the shapes as drawn (open shapes after the seal), and as asked for this frame: LIPSYNC.widthSpeed / roundSpeed
const drawnAct = emptyActivations();
const askedAct = emptyActivations();
// "Speaking" as the emotion and the mouth sliders see it, 0..1: is there voice within speechHold before or speechAhead
// after now (the audio is decoded ahead)? Eased by speechFade. They step back once per phrase, not after every word.
let held = 0;
// How rounded a p/b/m is made now (0 = the plain PP shape, 1 = "ppr"), eased (LIPSYNC.roundTau).
let rounding = 0;
// how far the tongue tip is up for a d/t/n/l (tongueAt), smoothed
let tongue = 0;
// The viseme layer as last written, per target (LipSync's targets order): the speed limit moves from here to `next`.
let written: Float32Array | null = null;
let next: Float32Array | null = null;

export function LipSync() {
  const presets = useMemo(() => Object.fromEntries(VISEME_IDS.map((v) => [v, visemePreset(v)])) as Record<VisemeId, Record<string, number>>, []);
  const roundedClosure = useMemo(() => visemePreset("ppr"), []); // a p/b/m with the lips rounded (LIPSYNC.roundAhead)
  // Every morph target any viseme touches, so we can zero the ones no longer active.
  const targets = useMemo(() => {
    const set = new Set<string>();
    for (const v of [...VISEME_IDS, "ppr"]) for (const t of Object.keys(visemePreset(v))) set.add(t);
    return [...set];
  }, []);

  // mm of lip / jaw opening per unit of each target (visemes.json "speed"), for the speed limit
  const speed = useMemo(() => ({ gap: targets.map((t) => visemes.speed?.gap[t] ?? 0), jaw: targets.map((t) => visemes.speed?.jaw[t] ?? 0) }), [targets]);

  const lead = useMemo(() => mouthLead(typeof window !== "undefined" ? new URLSearchParams(window.location.search).get("lipsyncOffsetMs") : null), []);
  useEffect(() => {
    lipsyncState.leadMs = Math.round(lead * 1000);
  }, [lead]);

  useFrame((_, dt) => {
    const src = activeSpeech();
    // the whole mouth runs `lead` ahead of the sound (LIPSYNC.lead): shapes and loudness alike
    const t = src.playing ? src.time() + lead : -1;
    lipsyncState.clipTime = src.playing ? src.time() : -1; // the sound's time: the dev overlays' cursor
    if (t >= 0) frameTargets(src, t, 0, scratch, memoryOf(src));
    else for (const v of VISEME_IDS) scratch[v] = 0;
    const act = lipsyncState.activations;
    smoothTowards(act, scratch, Math.min(dt, 0.1));
    let any = false;
    for (const v of VISEME_IDS) if (act[v] > 0) any = true;
    if (!any && !lipsyncState.active && t < 0) return; // idle: nothing to write
    const step = Math.min(dt, 0.1);
    if (step <= 0) return; // a zero-length frame: nothing moves (and the speeds below would divide by 0)
    // While speaking, the visemes replace whatever the mouth sliders say (a face shaped with an
    // open jaw would otherwise never close on a "p"); the sliders fade back in as speech ends.
    let voiced = 0;
    if (t >= 0) for (let x = t - LIPSYNC.speechHold; x <= t + LIPSYNC.speechAhead; x += 0.01) if (src.loudness(x) > LIPSYNC.speechLoud) {
      voiced = 1;
      break;
    }
    held += (voiced - held) * (1 - Math.exp(-step / LIPSYNC.speechFade));
    if (held < 0.002) held = 0;
    lipsyncState.active = any || held > 0;
    const seal = LIPSYNC_PARTS.seal ? sealWeight(act) : 1; // a formed closure pushes the open shapes out of the way
    // The emotion's mouth part steps back while speaking (EMOTION.lowerWhileSpeaking), and out of the way of a formed
    // p/b/m or f/v if that emotion holds the lips apart (Surprised, Afraid, Pain …).
    setSpeechActivity(held, 1 - seal);
    const kJaw = LIPSYNC.jawTau > 0 ? 1 - Math.exp(-step / LIPSYNC.jawTau) : 1;
    rounding += ((t >= 0 && LIPSYNC_PARTS.rounding ? roundingAt(src.cues, t) : 0) - rounding) * (1 - Math.exp(-step / LIPSYNC.roundTau));
    tongue += ((t >= 0 && LIPSYNC_PARTS.tongue ? tongueAt(src.cues, t) : 0) - tongue) * (1 - Math.exp(-step / (LIPSYNC.tau.DD ?? LIPSYNC.tau.default)));
    const ppCap = visemeCap("pp") * (1 - rounding) + visemeCap("ppr") * rounding;
    if (!written || !next || written.length !== targets.length) {
      written = new Float32Array(targets.length);
      next = new Float32Array(targets.length);
    }
    for (let ti = 0; ti < targets.length; ti++) {
      const target = targets[ti];
      let value = 0;
      // a tongue morph takes the "d"'s tongue from its own track (LIPSYNC_PARTS.tongue); the lips and jaw keep act.DD
      const tongueMorph = LIPSYNC_PARTS.tongue && target.startsWith("tongue");
      for (const v of VISEME_IDS) {
        const a = v === "DD" && tongueMorph ? tongue : act[v];
        if (!a) continue;
        if (v === "PP") {
          const w = (presets.PP[target] ?? 0) * (1 - rounding) + (roundedClosure[target] ?? 0) * rounding;
          value += act.PP * w * ppCap; // this face's limit (animCaps)
          continue;
        }
        const w = presets[v][target];
        if (w) value += a * w * (v === "FF" ? 1 : seal) * visemeCap(v); // this face's limit (animCaps)
      }
      // The jaw is the heavy articulator: its second stage turns cue-edge kinks and the seal's
      // snap into syllable-rate arcs (LIPSYNC.jawTau). The lip morphs are written directly.
      if (target === jawTarget) value = jawValue += (value - jawValue) * kJaw;
      next[ti] = value - morphs.userValue(target) * held;
    }
    // Speed limit (LIPSYNC.gapSpeed / jawSpeed): how far the lips and jaw would move this frame, in mm (the shapes are
    // linear), and the share of that step they may take.
    let dGap = 0, dJaw = 0;
    for (let ti = 0; ti < targets.length; ti++) {
      const d = next[ti] - written[ti];
      dGap += d * speed.gap[ti];
      dJaw += d * speed.jaw[ti];
    }
    // the top speeds (lip gap and jaw, then the mouth's width and rounding), then how fast a movement may start
    for (const v of VISEME_IDS) askedAct[v] = act[v] * (v === "PP" || v === "FF" ? 1 : seal);
    const share = speedUpShare(dGap, dJaw, shapeShare(drawnAct, askedAct, speedShare(dGap, dJaw, step), step), gapVel, jawVel, step);
    gapVel = (dGap * share) / step;
    jawVel = (dJaw * share) / step;
    for (const v of VISEME_IDS) drawnAct[v] += (askedAct[v] - drawnAct[v]) * share;
    for (let ti = 0; ti < targets.length; ti++) {
      const target = targets[ti];
      const v = (written[ti] += (next[ti] - written[ti]) * share);
      if (target === jawTarget && share < 1) jawValue = v + morphs.userValue(target) * held; // the jaw's own stage follows
      morphs.setLayerValue("viseme", target, v);
    }
    lipsyncState.energy = act.aa + 0.6 * (act.O + act.E) + 0.3 * (act.I + act.U);
    if (!lipsyncState.active) {
      setSpeechActivity(0);
      morphs.clearLayer("viseme");
      lipsyncState.energy = 0;
      jawValue = 0;
      tongue = 0;
      gapVel = jawVel = 0;
      for (const v of VISEME_IDS) drawnAct[v] = 0;
      written.fill(0);
    }
  });

  return null;
}
