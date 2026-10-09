"use client";

/**
 * Drives the mouth from the speech player every frame: cues → smoothed viseme activations →
 * the `viseme` morph layer (activation × preset weights from visemes.json), on top of whatever
 * the sliders say. Runs only while something is playing or fading out.
 */
import { useFrame } from "@react-three/fiber";
import { useEffect, useMemo } from "react";

import { visemePreset, visemes } from "@/lib/data";
import { setSpeechActivity } from "@/lib/emotion";
import { type Cue, VISEME_IDS, type VisemeId } from "@/lib/lipsync/cues";
import { visemeCap } from "@/lib/morphs/animCaps";
import { audioClosureAt, CLOSED_VISEMES, closureGate, emptyActivations, LIPSYNC, LIPSYNC_PARTS, localPeak, loudnessGate, mouthLead, OPEN_VISEMES, placeLine, roundingAt, smoothTowards, snapClosures, snapVowels, speedShare, targetsAt, sealWeight, windowedLoudness } from "@/lib/lipsync/evaluator";
import { speechPlayer } from "@/lib/lipsync/player";
import { lipsyncState } from "@/lib/lipsync/state";
import { morphs } from "@/lib/morphs/store";

// Per-frame scratch buffer. Module state: this component is a singleton and the render loop
// mutates it every frame, which React state or memo values must not be.
const scratch = emptyActivations();
const snapped = new WeakSet<Cue>();
let lastOpen: VisemeId = "aa";
// The jaw morph (visemes.json roles.jawOpen) gets a second smoothing stage; this is its state.
const jawTarget = Object.keys(visemes.roles.jawOpen)[0];
let jawValue = 0;
// "Speaking" as the emotion and the mouth sliders see it, 0..1: is there voice within speechHold before or speechAhead
// after now (the audio is decoded ahead)? Eased by speechFade. They step back once per phrase, not after every word.
let held = 0;
// How rounded a p/b/m is made now (0 = the plain PP shape, 1 = "ppr"), eased (LIPSYNC.roundTau).
let rounding = 0;
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
    const t = speechPlayer.playing ? speechPlayer.time() : -1;
    lipsyncState.clipTime = t;
    if (t >= 0) {
      // once the stream has ended the whole line is decoded: the last word's windows reach past the audio's end
      const decoded = speechPlayer.streamDone ? Infinity : speechPlayer.decodedSeconds();
      placeLine(speechPlayer.cues, (x) => speechPlayer.loudness(x), decoded); // the stamps' offset at the start
      // an "m" closure is found in the treble (its hum keeps the loudness up): LIPSYNC_PARTS.trebleM
      const treble = LIPSYNC_PARTS.trebleM ? (x: number) => speechPlayer.trebleLoudness(x) : (x: number) => speechPlayer.loudness(x);
      if (LIPSYNC_PARTS.snapClosures) snapClosures(speechPlayer.cues, (x) => speechPlayer.loudness(x), decoded, snapped, treble);
      if (LIPSYNC_PARTS.snapVowels) snapVowels(speechPlayer.cues, (x) => speechPlayer.loudness(x), decoded, snapped);
      targetsAt(speechPlayer.cues, t + lead, scratch);
      // The sound itself decides how far the mouth opens and when the lips may shut. The open
      // shapes read a windowed loudness (no wobble on 10 ms dips); closures read the raw one.
      const loud = speechPlayer.loudness(t + LIPSYNC.gateLookahead);
      const loudSmooth = windowedLoudness((x) => speechPlayer.loudness(x), t + LIPSYNC.gateLookahead, LIPSYNC.gateWindow);
      // measured against the loudest moment nearby, so a line that trails off still opens its last words (gateLocal)
      const gate = LIPSYNC_PARTS.gates ? loudnessGate(Math.min(1, loudSmooth / localPeak((x) => speechPlayer.loudness(x), t + LIPSYNC.gateLookahead))) : 1;
      for (const v of OPEN_VISEMES) scratch[v] *= gate;
      const cg = LIPSYNC_PARTS.gates ? closureGate(loud) : 1;
      // closures and f/v/th hisses found in the audio itself pass
      const audio = (x: number) => speechPlayer.loudness(x);
      const anchoredPP = Math.min(scratch.PP, audioClosureAt(speechPlayer.cues, t + lead, audio, "PP", treble));
      const anchoredFF = Math.min(scratch.FF, audioClosureAt(speechPlayer.cues, t + lead, audio, "FF"));
      const anchoredTH = Math.min(scratch.TH, audioClosureAt(speechPlayer.cues, t + lead, audio, "TH"));
      for (const v of CLOSED_VISEMES) scratch[v] *= cg;
      scratch.PP = Math.max(scratch.PP, anchoredPP);
      scratch.FF = Math.max(scratch.FF, anchoredFF);
      scratch.TH = Math.max(scratch.TH, anchoredTH);
      // Hold the last vowel while the voice is still sounding but its (early) cue has ended.
      let openSum = 0;
      for (const v of ["aa", "E", "I", "O", "U"] as VisemeId[]) {
        openSum += scratch[v];
        if (scratch[v] > scratch[lastOpen] && scratch[v] > 0.25) lastOpen = v;
      }
      if (loudSmooth > LIPSYNC.sustainLoud && openSum < 0.25 && cg > 0.5) {
        scratch[lastOpen] = Math.max(scratch[lastOpen], LIPSYNC.sustainLevel * gate * (1 - Math.max(scratch.PP, scratch.FF)));
      }
    } else for (const v of VISEME_IDS) scratch[v] = 0;
    const act = lipsyncState.activations;
    smoothTowards(act, scratch, Math.min(dt, 0.1));
    let any = false;
    for (const v of VISEME_IDS) if (act[v] > 0) any = true;
    if (!any && !lipsyncState.active && t < 0) return; // idle: nothing to write
    const step = Math.min(dt, 0.1);
    // While speaking, the visemes replace whatever the mouth sliders say (a face shaped with an
    // open jaw would otherwise never close on a "p"); the sliders fade back in as speech ends.
    let voiced = 0;
    if (t >= 0) for (let x = t - LIPSYNC.speechHold; x <= t + LIPSYNC.speechAhead; x += 0.01) if (speechPlayer.loudness(x) > LIPSYNC.speechLoud) {
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
    rounding += ((t >= 0 && LIPSYNC_PARTS.rounding ? roundingAt(speechPlayer.cues, t + lead) : 0) - rounding) * (1 - Math.exp(-step / LIPSYNC.roundTau));
    const ppCap = visemeCap("pp") * (1 - rounding) + visemeCap("ppr") * rounding;
    if (!written || !next || written.length !== targets.length) {
      written = new Float32Array(targets.length);
      next = new Float32Array(targets.length);
    }
    for (let ti = 0; ti < targets.length; ti++) {
      const target = targets[ti];
      let value = 0;
      for (const v of VISEME_IDS) {
        if (!act[v]) continue;
        if (v === "PP") {
          const w = (presets.PP[target] ?? 0) * (1 - rounding) + (roundedClosure[target] ?? 0) * rounding;
          value += act.PP * w * ppCap; // this face's limit (animCaps)
          continue;
        }
        const w = presets[v][target];
        if (w) value += act[v] * w * (v === "FF" ? 1 : seal) * visemeCap(v); // this face's limit (animCaps)
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
    const share = speedShare(dGap, dJaw, step);
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
      written.fill(0);
    }
  });

  return null;
}
