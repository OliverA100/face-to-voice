/**
 * Animation caps: on this face, how far may the blink, the current emotion and each mouth shape go before something
 * breaks (lib/morphs/limits.ts caps())? Blink, gaze and emotion scale their whole layer in the store
 * (morphs.setLayerScales); each mouth shape is scaled on its own inside the lip sync (visemeCap), so a face that cannot
 * make a full "p" still speaks every other sound in full. Nothing is computed per frame.
 *
 * Recomputed after the shape settles (Head.tsx), in a worker (capsWorker.ts) or else one animation per idle slice, so
 * no frame waits on it.
 * On the average face every cap is 1: GNM's own motion is never "broken".
 */
import { emotionDefs, visemes } from "@/lib/data";
import { headMorph } from "@/lib/headMorph";
import { fxSpread } from "@/lib/morphs/fxReach";
import { requestCaps } from "@/lib/morphs/capsClient";
import { BLINK_STAGES, type LimitStore, limiter } from "@/lib/morphs/limiter";
import { morphs } from "@/lib/morphs/store";

/** Tweak freely. */
export const ANIM_CAPS = {
  gazeLid: 0.35, // IdleLife's look-down lid follow, as a share of a full blink (POSE.lidFollow)
};

/** The last caps (1 = in full), by channel: "blink", "emotion", "viseme:aa" … */
export const lastCaps: Record<string, number> = {};

/** How far (mm) the eyeballs draw back on this face with the eye `closed` (0 open … 1 shut), interpolated between the
 *  blink stages the limiter solved (0 on most faces; Head.tsx). */
export function blinkRetractMm(closed: number): number {
  if (!lastCaps.blinkRetract100 && !lastCaps.blinkRetract50) return 0;
  let s0 = 0, r0 = 0;
  for (const s of BLINK_STAGES) {
    const r = lastCaps[`blinkRetract${Math.round(s * 100)}`] ?? 0;
    if (closed <= s) return r0 + ((closed - s0) / (s - s0)) * (r - r0);
    s0 = s;
    r0 = r;
  }
  return r0;
}

/** How much of viseme `id` (aa, e, pp …; any case) this face allows (LipSync.tsx). */
export function visemeCap(id: string): number {
  return lastCaps[`viseme:${id.toLowerCase()}`] ?? 1;
}

const idle = (fn: () => void) =>
  typeof window !== "undefined" && "requestIdleCallback" in window ? window.requestIdleCallback(fn, { timeout: 300 }) : setTimeout(fn, 30);

let generation = 0;

/**
 * Recompute the caps soon; a newer call abandons an older run. In a worker where there is one (lib/morphs/capsClient.ts:
 * the same limiter, off the main thread), otherwise here, one animation per idle slice. Either way each answer lands
 * once the morph reveal is over.
 */
export function scheduleAnimCaps(): void {
  const gen = ++generation;
  const answers: Record<string, number>[] = [];
  let waiting = false;
  const land = () => {
    waiting = false;
    if (gen !== generation) return;
    if (headMorph.t < 1) return void ((waiting = true), idle(land)); // not during the morph reveal (as below)
    for (const caps of answers.splice(0)) Object.assign(lastCaps, caps);
    applyCaps();
  };
  const sent = requestCaps(
    gen,
    Object.entries(channels()),
    restFor,
    (g, caps) => {
      if (g !== gen || gen !== generation) return;
      answers.push(caps);
      if (!waiting) land();
    },
    () => gen === generation && scheduleAnimCaps(), // the worker failed: again, here
  );
  if (sent) return;
  const queue = Object.entries(channels());
  const step = () => {
    if (gen !== generation) return;
    if (!limiter.ready) return void idle(step); // its lazy chunk is still loading: again once it is in
    if (headMorph.t < 1) return void idle(step); // not during the morph reveal: a slice there freezes a frame (50–120 ms)
    const next = queue.shift();
    if (!next) return;
    Object.assign(lastCaps, limiter.caps(restFor(next[0]), { [next[0]]: next[1] }));
    applyCaps();
    idle(step);
  };
  idle(step);
}

/** All caps at once (the debug handle / e2e). */
export function updateAnimCaps(): Record<string, number> {
  if (!limiter.ready) return {};
  const t0 = performance.now();
  for (const [name, anim] of Object.entries(channels())) Object.assign(lastCaps, limiter.caps(restFor(name), { [name]: anim }));
  applyCaps();
  return { ...lastCaps, ms: performance.now() - t0 };
}

function applyCaps(): void {
  const b = lastCaps.blink ?? 1;
  const emotion = lastCaps.emotion ?? 1;
  // The emotion is held on the face (blinks and speech pass): a new cap on it changes the shape, so the shading and eye
  // pivots must follow (Head.tsx). Caps computed before head.extra.glb merged hold the emotion at 0 until recomputed.
  const reshaped = (morphs.layerScales().emotion ?? 1) !== emotion;
  morphs.setLayerScales({ blink: b, gaze: b >= ANIM_CAPS.gazeLid ? 1 : b / ANIM_CAPS.gazeLid, emotion });
  if (reshaped) morphs.markShapeChanged();
}

/**
 * The face an animation is capped on. The emotion is judged together with its fine-tune controls (they add to it:
 * Expression tab › Fine-tune), so they leave the rest and join its channel: the average face doing both is what it
 * may do anyway. Otherwise a fine-tune near its end would count as the face's shape and leave the emotion no room.
 */
function restFor(channel: string): LimitStore {
  if (channel !== "emotion") return morphs;
  const fx = fxSpread();
  return { base: morphs.base, userValue: (t) => morphs.userValue(t) - (fx[t] ?? 0), comboOf: (s) => morphs.comboOf(s) };
}

/** The animations to cap, each at full strength. */
function channels(): Record<string, Record<string, number>> {
  const out: Record<string, Record<string, number>> = { blink: { ...visemes.roles.blinkLeft, ...visemes.roles.blinkRight } };
  // the current emotion's two targets as the emotion rig wrote them (mouth part at full gain)
  const emo: Record<string, number> = {};
  for (const e of emotionDefs) {
    const up = morphs.layerValue("emotion", e.upper);
    const low = morphs.layerValue("emotion", e.lower);
    const gain = morphs.emotionGain;
    if (up) emo[e.upper] = up;
    if (low) emo[e.lower] = gain > 0 ? low / gain : low;
  }
  if (Object.keys(emo).length) {
    for (const [t, v] of Object.entries(fxSpread())) emo[t] = (emo[t] ?? 0) + v;
    out.emotion = emo;
  } else lastCaps.emotion = 1;
  for (const [id, preset] of Object.entries(visemes.visemes)) {
    // while speaking the viseme layer replaces the mouth sliders: preset − what the sliders ask for (LipSync.tsx)
    out[`viseme:${id}`] = Object.fromEntries(Object.entries(preset).map(([t, w]) => [t, w - morphs.userValue(t)]));
  }
  return out;
}
