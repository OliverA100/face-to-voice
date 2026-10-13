/**
 * The mouth, one frame at a time: cues → smoothed viseme activations → morph values for the `viseme` layer (activation
 * × preset weights from visemes.json), with the seal, rounding, tongue track and speed limits. Plain code with its
 * outside world passed in (MouthWorld), so the scene's LipSync runs it on the live face and the measuring bench
 * (qa/lipsync) runs the very same steps on saved lines.
 */
import { visemePreset, visemes } from "@/lib/data";

import { VISEME_IDS, type VisemeId } from "./cues";
import { emptyActivations, frameMemory, frameTargets, lateralAt, LIPSYNC, LIPSYNC_PARTS, roundingAt, sealWeight, shapeShare, smoothTowards, speedShare, speedUpShare, tongueAt, type Activations, type FrameMemory, type SpeechSource } from "./evaluator";

/** What the mouth reads from and writes to. */
export interface MouthWorld {
  /** This face's limit for a viseme (animCaps visemeCap): 1 = the full preset. */
  cap(viseme: string): number;
  /** The mouth sliders' own value on a target (replaced by the visemes while speaking). */
  userValue(target: string): number;
  /** How much the face is speaking (0..1), and how formed a closure is: the emotion's mouth part steps back. */
  speechActivity(held: number, closure?: number): void;
  write(target: string, value: number): void;
  clear(): void;
}

/** What the mouth shows, for the rest of the app (lipsyncState) or a bench. */
export interface MouthState {
  active: boolean;
  activations: Activations;
  energy: number;
}

export class Mouth {
  /** Every morph target any viseme touches, so the ones no longer active go back to 0. */
  readonly targets: string[];
  /** mm of lip / jaw opening per unit of each target (visemes.json "speed"): the speed limit, and a bench's mm. */
  readonly speed: { gap: number[]; jaw: number[] };
  private readonly presets: Record<VisemeId, Record<string, number>>;
  private readonly roundedClosure: Record<string, number>; // a p/b/m with the lips rounded (LIPSYNC.roundAhead)
  private readonly lateralTongue: Record<string, number>; // the tongue of an "l" (visemes.json "ll": tongue morphs only)
  private readonly jawTarget = Object.keys(visemes.roles.jawOpen)[0]; // gets a second smoothing stage (jawTau)
  private readonly scratch = emptyActivations();
  // the lips' shapes (LIPSYNC_PARTS.jawSplit): the cues under the softer shape gate, smoothed like the activations
  private readonly shapeScratch = emptyActivations();
  readonly shapes = emptyActivations();
  // What each speech source's frames remember (snapped cues, the held vowel): the player's lines and a conversation's.
  private readonly memories = new WeakMap<SpeechSource, FrameMemory>();
  private jawValue = 0;
  // the lips' and jaw's velocities last frame (mm/s), for LIPSYNC.speedUp
  private gapVel = 0;
  private jawVel = 0;
  // the shapes as drawn (open shapes after the seal), and as asked for this frame: LIPSYNC.widthSpeed / roundSpeed
  private readonly drawnAct = emptyActivations();
  private readonly askedAct = emptyActivations();
  // "Speaking" as the emotion and the mouth sliders see it, 0..1: is there voice within speechHold before or
  // speechAhead after now (the audio is decoded ahead)? Eased by speechFade. They step back once per phrase.
  private held = 0;
  // How rounded a p/b/m is made now (0 = the plain PP shape, 1 = "ppr"), eased (LIPSYNC.roundTau).
  private rounding = 0;
  // how far the tongue tip is up for a d/t/n/l (tongueAt), smoothed; and how much of that is an "l" (lateralAt)
  private tongue = 0;
  private lateral = 0;
  /** The viseme layer as last written, per target (targets order): the speed limit moves from here to `next`. */
  readonly written: Float32Array;
  private readonly next: Float32Array;

  constructor(
    private readonly world: MouthWorld,
    readonly state: MouthState = { active: false, activations: emptyActivations(), energy: 0 },
  ) {
    this.presets = Object.fromEntries(VISEME_IDS.map((v) => [v, visemePreset(v)])) as Record<VisemeId, Record<string, number>>;
    this.roundedClosure = visemePreset("ppr");
    this.lateralTongue = visemePreset("ll");
    const set = new Set<string>();
    for (const v of [...VISEME_IDS, "ppr", "ll"]) for (const t of Object.keys(visemePreset(v))) set.add(t);
    this.targets = [...set];
    this.speed = { gap: this.targets.map((t) => visemes.speed?.gap[t] ?? 0), jaw: this.targets.map((t) => visemes.speed?.jaw[t] ?? 0) };
    this.written = new Float32Array(this.targets.length);
    this.next = new Float32Array(this.targets.length);
  }

  private memoryOf(src: SpeechSource): FrameMemory {
    return this.memories.get(src) ?? this.memories.set(src, frameMemory()).get(src)!;
  }

  /**
   * One frame. `t`: the clip time the mouth shows now (the sound's time plus any lead), or −1 when nothing plays.
   * `dt`: seconds since the last frame.
   */
  frame(src: SpeechSource, t: number, dt: number): void {
    const { world, scratch, state, targets, presets, drawnAct, askedAct, written, next, speed } = this;
    const split = LIPSYNC_PARTS.jawSplit;
    const { shapeScratch, shapes } = this;
    if (t >= 0) frameTargets(src, t, 0, scratch, this.memoryOf(src), split ? shapeScratch : undefined);
    else for (const v of VISEME_IDS) scratch[v] = shapeScratch[v] = 0;
    const act = state.activations;
    smoothTowards(act, scratch, Math.min(dt, 0.1));
    if (split) smoothTowards(shapes, shapeScratch, Math.min(dt, 0.1));
    let any = false;
    for (const v of VISEME_IDS) if (act[v] > 0) any = true;
    if (!any && !state.active && t < 0) return; // idle: nothing to write
    const step = Math.min(dt, 0.1);
    if (step <= 0) return; // a zero-length frame: nothing moves (and the speeds below would divide by 0)
    // While speaking, the visemes replace whatever the mouth sliders say (a face shaped with an
    // open jaw would otherwise never close on a "p"); the sliders fade back in as speech ends.
    let voiced = 0;
    if (t >= 0)
      for (let x = t - LIPSYNC.speechHold; x <= t + LIPSYNC.speechAhead; x += 0.01)
        if (src.loudness(x) > LIPSYNC.speechLoud) {
          voiced = 1;
          break;
        }
    this.held += (voiced - this.held) * (1 - Math.exp(-step / LIPSYNC.speechFade));
    if (this.held < 0.002) this.held = 0;
    const held = this.held;
    state.active = any || held > 0;
    const seal = LIPSYNC_PARTS.seal ? sealWeight(act) : 1; // a formed closure pushes the open shapes out of the way
    // The emotion's mouth part steps back while speaking (EMOTION.lowerWhileSpeaking), and out of the way of a formed
    // p/b/m or f/v if that emotion holds the lips apart (Surprised, Afraid, Pain …).
    world.speechActivity(held, 1 - seal);
    const kJaw = LIPSYNC.jawTau > 0 ? 1 - Math.exp(-step / LIPSYNC.jawTau) : 1;
    this.rounding += ((t >= 0 && LIPSYNC_PARTS.rounding ? roundingAt(src.cues, t) : 0) - this.rounding) * (1 - Math.exp(-step / LIPSYNC.roundTau));
    const kTongue = 1 - Math.exp(-step / (LIPSYNC.tau.DD ?? LIPSYNC.tau.default));
    this.tongue += ((t >= 0 && LIPSYNC_PARTS.tongue ? tongueAt(src.cues, t) : 0) - this.tongue) * kTongue;
    this.lateral += ((t >= 0 && LIPSYNC_PARTS.tongue && LIPSYNC_PARTS.lateral ? lateralAt(src.cues, t) : 0) - this.lateral) * kTongue;
    const lat = this.tongue > 1e-3 ? Math.min(1, this.lateral / this.tongue) : 0; // the share of the raise that is an "l"
    const rounding = this.rounding;
    const ppCap = world.cap("pp") * (1 - rounding) + world.cap("ppr") * rounding;
    for (let ti = 0; ti < targets.length; ti++) {
      const target = targets[ti];
      let value = 0;
      // a tongue morph takes the "d"'s tongue from its own track (LIPSYNC_PARTS.tongue); the lips and jaw keep act.DD
      const tongueMorph = LIPSYNC_PARTS.tongue && target.startsWith("tongue");
      // jawSplit: the jaw opens with the loudness (act); every other target takes the lips' shapes
      const from = split && target !== this.jawTarget ? shapes : act;
      for (const v of VISEME_IDS) {
        const a = v === "DD" && tongueMorph ? this.tongue : from[v];
        if (!a) continue;
        if (v === "PP") {
          const w = (presets.PP[target] ?? 0) * (1 - rounding) + (this.roundedClosure[target] ?? 0) * rounding;
          value += act.PP * w * ppCap; // this face's limit (animCaps)
          continue;
        }
        // the tongue of a "d" blends to an "l"'s where the raise is one (lateralAt)
        const w = v === "DD" && tongueMorph && lat ? (presets.DD[target] ?? 0) * (1 - lat) + (this.lateralTongue[target] ?? 0) * lat : presets[v][target];
        if (w) value += a * w * (v === "FF" ? 1 : seal) * world.cap(v); // this face's limit (animCaps)
      }
      // The jaw is the heavy articulator: its second stage turns cue-edge kinks and the seal's
      // snap into syllable-rate arcs (LIPSYNC.jawTau). The lip morphs are written directly.
      if (target === this.jawTarget) value = this.jawValue += (value - this.jawValue) * kJaw;
      next[ti] = value - world.userValue(target) * held;
    }
    // Speed limit (LIPSYNC.gapSpeed / jawSpeed): how far the lips and jaw would move this frame, in mm (the shapes are
    // linear), and the share of that step they may take.
    let dGap = 0,
      dJaw = 0;
    for (let ti = 0; ti < targets.length; ti++) {
      const d = next[ti] - written[ti];
      dGap += d * speed.gap[ti];
      dJaw += d * speed.jaw[ti];
    }
    // the top speeds (lip gap and jaw, then the mouth's width and rounding), then how fast a movement may start
    for (const v of VISEME_IDS) askedAct[v] = (split ? shapes : act)[v] * (v === "PP" || v === "FF" ? 1 : seal);
    const share = speedUpShare(dGap, dJaw, shapeShare(drawnAct, askedAct, speedShare(dGap, dJaw, step), step), this.gapVel, this.jawVel, step);
    this.gapVel = (dGap * share) / step;
    this.jawVel = (dJaw * share) / step;
    for (const v of VISEME_IDS) drawnAct[v] += (askedAct[v] - drawnAct[v]) * share;
    for (let ti = 0; ti < targets.length; ti++) {
      const target = targets[ti];
      const v = (written[ti] += (next[ti] - written[ti]) * share);
      if (target === this.jawTarget && share < 1) this.jawValue = v + world.userValue(target) * held; // the jaw's own stage follows
      world.write(target, v);
    }
    state.energy = act.aa + 0.6 * (act.O + act.E) + 0.3 * (act.I + act.U);
    if (!state.active) {
      world.speechActivity(0);
      world.clear();
      state.energy = 0;
      this.jawValue = 0;
      this.tongue = this.lateral = 0;
      this.gapVel = this.jawVel = 0;
      for (const v of VISEME_IDS) drawnAct[v] = shapes[v] = 0;
      written.fill(0);
    }
  }

  /** The lips' and jaw's opening as written, in mm from the face at rest (visemes.json "speed": linear). */
  openingMm(): { gap: number; jaw: number } {
    let gap = 0,
      jaw = 0;
    for (let ti = 0; ti < this.targets.length; ti++) {
      gap += this.written[ti] * this.speed.gap[ti];
      jaw += this.written[ti] * this.speed.jaw[ti];
    }
    return { gap, jaw };
  }
}
