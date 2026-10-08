/**
 * Pose: where the head points and where the eyes look (the Pose section), plus "look at cursor".
 *
 * `poseRig.base` holds the sliders' pose in degrees (GSAP eases it; React never sees it). IdleLife is the one
 * writer of the head and eye transforms: every frame it adds the cursor follow, the idle sway, breathing and
 * saccades on top of this base, so a posed head is never frozen.
 *
 * Angles are as seen from the front: yaw + = turned to the viewer's right, pitch + = up, roll + = the top of the
 * head tilts to the viewer's right.
 */
import gsap from "gsap";

import { MOTION } from "@/lib/motion";

/** Tweak freely. Limits come from sliders.json (pipeline sliders_json.py POSE_SLIDERS); these are the dynamics. */
export const POSE = {
  ease: 0.35, // seconds: slider drags (heavier than MOTION.follow on purpose: the whole head turns)
  centre: 0.6, // seconds: the Centre button
  follow: {
    reach: { yaw: 30, pitch: 20 }, // degrees of gaze at the edge of the 3D view
    headShare: 0.35, // share of a cursor look the head takes (the eyes do the rest)
    eyeRate: 12, // 1/s: how fast the eyes catch up (exponential damping, frame-rate independent)
    headRate: 4, // 1/s: the head is slower
    returnAfter: 2.5, // seconds without pointer movement before looking back at the base pose
  },
  lidFollow: 0.35, // looking down lowers the upper lids this much (share of a blink) at full downward gaze
};

export type PoseKey = "headYaw" | "headPitch" | "headRoll" | "gazeYaw" | "gazePitch";
export const POSE_TARGETS: Record<string, PoseKey> = {
  pose_head_yaw: "headYaw",
  pose_head_pitch: "headPitch",
  pose_head_roll: "headRoll",
  pose_gaze_yaw: "gazeYaw",
  pose_gaze_pitch: "gazePitch",
};

export const LIMITS: Record<PoseKey, [number, number]> = {
  headYaw: [-35, 35],
  headPitch: [-20, 20],
  headRoll: [-15, 15],
  gazeYaw: [-25, 25],
  gazePitch: [-20, 15],
};

const zero = (): Record<PoseKey, number> => ({ headYaw: 0, headPitch: 0, headRoll: 0, gazeYaw: 0, gazePitch: 0 });

export const poseRig = {
  base: zero(), // the sliders (degrees)
  follow: { on: false, x: 0, y: 0, lastMove: -1e9 }, // the pointer, -1..1 across the 3D view
  // what the cursor follow currently adds (degrees), damped towards its target every frame
  cursor: { headYaw: 0, headPitch: 0, gazeYaw: 0, gazePitch: 0 },
};

export const clamp = (v: number, [lo, hi]: [number, number]) => Math.min(hi, Math.max(lo, v));

/** Frame-rate-independent exponential approach of `current` to `target` at `rate` (1/s). */
export const damp = (current: number, target: number, rate: number, dt: number) =>
  current + (target - current) * (1 - Math.exp(-rate * Math.min(dt, 0.1)));

/**
 * Split a look direction (degrees) between head and eyes: the head takes `headShare` of it, the eyes the rest,
 * and when the eyes would pass their limit the head takes the overflow (up to its own limit).
 */
export function splitLook(yaw: number, pitch: number, headShare = POSE.follow.headShare) {
  let headYaw = yaw * headShare;
  let headPitch = pitch * headShare;
  const gazeYaw = clamp(yaw - headYaw, LIMITS.gazeYaw);
  const gazePitch = clamp(pitch - headPitch, LIMITS.gazePitch);
  headYaw = clamp(yaw - gazeYaw, LIMITS.headYaw);
  headPitch = clamp(pitch - gazePitch, LIMITS.headPitch);
  return { headYaw, headPitch, gazeYaw, gazePitch };
}

/**
 * The pose actually shown (base + cursor follow, clamped): what IdleLife draws and the look reports. `withCursor` false:
 * the pose the visitor set, without what following the cursor adds (the voice panel's "has the face changed").
 */
export function currentPose(withCursor = true): Record<PoseKey, number> {
  const b = poseRig.base;
  const c = withCursor ? poseRig.cursor : { headYaw: 0, headPitch: 0, gazeYaw: 0, gazePitch: 0 };
  return {
    headYaw: clamp(b.headYaw + c.headYaw, LIMITS.headYaw),
    headPitch: clamp(b.headPitch + c.headPitch, LIMITS.headPitch),
    headRoll: clamp(b.headRoll, LIMITS.headRoll),
    // the gaze sliders and "look at cursor" are exclusive: while following, only the cursor moves the eyes
    gazeYaw: clamp((poseRig.follow.on ? 0 : b.gazeYaw) + c.gazeYaw, LIMITS.gazeYaw),
    gazePitch: clamp((poseRig.follow.on ? 0 : b.gazePitch) + c.gazePitch, LIMITS.gazePitch),
  };
}

// --- kept across reloads -------------------------------------------------------------------------------------

const POSE_KEY = "ftv-pose"; // sessionStorage, like the face (lib/faceSession.ts): kept across reloads, a new tab starts centred
/** Where the sliders asked the head to go (poseRig.base eases towards it): what is saved. */
const posed = zero();

function savePose(): void {
  try {
    window.sessionStorage.setItem(POSE_KEY, JSON.stringify(posed));
  } catch {
    /* private mode: no persistence */
  }
}

// Restore the last pose once, in the browser only (no easing: the head appears already posed).
if (typeof window !== "undefined") {
  try {
    const saved = JSON.parse(window.sessionStorage.getItem(POSE_KEY) ?? "{}") as Partial<Record<PoseKey, number>>;
    for (const key of Object.keys(LIMITS) as PoseKey[]) {
      const v = saved[key];
      if (typeof v === "number" && Number.isFinite(v)) poseRig.base[key] = posed[key] = clamp(v, LIMITS[key]);
    }
  } catch {
    /* private mode or malformed: start centred */
  }
}

// --- sliders ------------------------------------------------------------------------------------------------

const setters = new Map<PoseKey, (v: number) => void>();

/** Eased setter for a pose slider (degrees). */
export function setPose(key: PoseKey, degrees: number): void {
  let s = setters.get(key);
  if (!s) {
    s = gsap.quickTo(poseRig.base, key, { duration: POSE.ease, ease: MOTION.ease.follow });
    setters.set(key, s);
  }
  posed[key] = clamp(degrees, LIMITS[key]);
  s(posed[key]);
  savePose();
}

/** Everything back to looking straight ahead. */
const centreListeners = new Set<(seconds: number) => void>();
/** The Pose tab's sliders are uncontrolled: they ride back to zero through this (over `seconds`) when the pose is centred. */
export function onPoseCentre(fn: (seconds: number) => void): () => void {
  centreListeners.add(fn);
  return () => centreListeners.delete(fn);
}

/** `seconds`: Reset passes the morph's length so the head turns back with the face. */
export function centrePose(seconds = POSE.centre): gsap.core.Tween {
  for (const s of setters.values()) gsap.killTweensOf(s);
  setters.clear();
  for (const fn of centreListeners) fn(seconds);
  Object.assign(posed, zero());
  savePose();
  return gsap.to(poseRig.base, { ...zero(), duration: seconds, ease: MOTION.ease.morph });
}

// --- look at cursor ------------------------------------------------------------------------------------------

const STORAGE_KEY = "ftv-look-cursor";

/** Default: off on every device; the visitor's own choice is remembered. */
export function lookAtCursorDefault(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return localStorage.getItem(STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

const followListeners = new Set<() => void>();
let followInitialised = false;

/** For the toggle (useSyncExternalStore): subscribing also applies the saved / device default once. */
export function subscribeFollow(fn: () => void): () => void {
  if (!followInitialised) {
    followInitialised = true;
    poseRig.follow.on = lookAtCursorDefault();
  }
  followListeners.add(fn);
  return () => followListeners.delete(fn);
}
export const followSnapshot = () => poseRig.follow.on;

export function setLookAtCursor(on: boolean): void {
  poseRig.follow.on = on;
  if (on) {
    // exclusive with the gaze sliders: they go back to centre (the Pose section disables them)
    setPose("gazeYaw", 0);
    setPose("gazePitch", 0);
  }
  try {
    localStorage.setItem(STORAGE_KEY, on ? "1" : "0");
  } catch {}
  for (const fn of followListeners) fn();
}

/** Pointer tracking relative to the 3D view (call once with the canvas element; returns the cleanup). */
export function trackPointer(element: HTMLElement): () => void {
  const f = poseRig.follow;
  const move = (e: PointerEvent) => {
    if (e.pointerType === "touch") return;
    const r = element.getBoundingClientRect();
    f.x = Math.max(-1.5, Math.min(1.5, ((e.clientX - (r.left + r.width / 2)) / (r.width / 2))));
    f.y = Math.max(-1.5, Math.min(1.5, -((e.clientY - (r.top + r.height * 0.4)) / (r.height / 2)))); // eyes sit ~40 % down
    f.lastMove = performance.now();
  };
  const leave = () => {
    f.lastMove = -1e9;
  };
  window.addEventListener("pointermove", move, { passive: true });
  document.documentElement.addEventListener("pointerleave", leave);
  return () => {
    window.removeEventListener("pointermove", move);
    document.documentElement.removeEventListener("pointerleave", leave);
  };
}

/** One frame of the cursor follow (IdleLife calls this before drawing). */
export function stepFollow(dt: number): void {
  const f = poseRig.follow;
  const c = poseRig.cursor;
  const active = f.on && performance.now() - f.lastMove < POSE.follow.returnAfter * 1000;
  const target = active ? splitLook(f.x * POSE.follow.reach.yaw, f.y * POSE.follow.reach.pitch) : { headYaw: 0, headPitch: 0, gazeYaw: 0, gazePitch: 0 };
  c.gazeYaw = damp(c.gazeYaw, target.gazeYaw, POSE.follow.eyeRate, dt);
  c.gazePitch = damp(c.gazePitch, target.gazePitch, POSE.follow.eyeRate, dt);
  c.headYaw = damp(c.headYaw, target.headYaw, POSE.follow.headRate, dt);
  c.headPitch = damp(c.headPitch, target.headPitch, POSE.follow.headRate, dt);
}
