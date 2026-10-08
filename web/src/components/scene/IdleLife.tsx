"use client";

/**
 * Idle life on top of the pose: blinks (an additive morph layer on the blink roles), slow head sway and
 * breathing (added to the head pose on the neck pivot), eye saccades (added to the gaze on the eye pivots), and
 * the look-at-cursor follow. This component is the ONE writer of the head and eye transforms: pose (lib/pose.ts)
 * + cursor + idle, every frame. Everything runs on GSAP tweens and useFrame; no React state. With prefers-reduced-motion
 * the sway and breathing stop (the head holds still); blinks and saccades stay.
 * Parameters in lib/idle.ts and lib/pose.ts.
 */
import { useFrame, useThree } from "@react-three/fiber";
import gsap from "gsap";
import { useEffect, useState } from "react";

import { visemes } from "@/lib/data";
import { idleDebug } from "@/lib/debugView";
import { headMorph } from "@/lib/headMorph";
import { IDLE } from "@/lib/idle";
import { lipsyncState } from "@/lib/lipsync/state";
import { morphs } from "@/lib/morphs/store";
import { currentPose, POSE, stepFollow, trackPointer } from "@/lib/pose";
import { reducedMotion } from "@/lib/reducedMotion";

import { headRig, NECK } from "./Head";

const DEG = Math.PI / 180;
// Module state written by the frame loop (this component is a singleton): the lids' gaze follow last applied.
let lidApplied = 0;

const rand = (lo: number, hi: number) => lo + Math.random() * (hi - lo);

/** Smooth, non-repeating wander in [-1, 1] from three incommensurate sines. */
function wander(t: number, seed: number): number {
  return (Math.sin(t + seed * 1.7) + 0.6 * Math.sin(t * 1.61 + seed * 3.1) + 0.3 * Math.sin(t * 2.47 + seed * 5.3)) / 1.9;
}

export function IdleLife() {
  const [state] = useState(() => ({ blink: 0, eyeYaw: 0, eyePitch: 0 }));
  const canvas = useThree((s) => s.gl.domElement);

  // Pointer tracking for "look at cursor" (the Pose section's toggle turns the follow on and off).
  useEffect(() => trackPointer(canvas), [canvas]);

  useEffect(() => {
    // The blink and the saccade each have one step pending at a time (a wait, or the movement); unmount kills
    // exactly those. (Not a gsap.context: it would keep every tween ever made, megabytes an hour.)
    let blinkStep: gsap.core.Animation | undefined;
    let saccadeWait: gsap.core.Tween | undefined;
    let saccadeMove: gsap.core.Tween | undefined;
    const B = IDLE.blink;
    const roles = visemes.roles;

    const applyBlink = () => {
      for (const [t, w] of Object.entries(roles.blinkLeft)) morphs.setLayerValue("blink", t, state.blink * w);
      for (const [t, w] of Object.entries(roles.blinkRight)) morphs.setLayerValue("blink", t, state.blink * w);
    };

    const blinkOnce = (amount: number, onDone: () => void) => {
      blinkStep = gsap
        .timeline({ onUpdate: applyBlink, onComplete: onDone })
        .to(state, { blink: amount, duration: B.close, ease: "power2.in" })
        .to(state, { blink: amount, duration: B.hold })
        .to(state, { blink: 0, duration: B.open, ease: "power2.out" });
    };

    const scheduleBlink = () => {
      // Skewed interval: mostly around the mean, occasionally long pauses.
      const interval = Math.min(B.maxInterval, Math.max(B.minInterval, -Math.log(1 - Math.random()) * B.meanInterval));
      blinkStep = gsap.delayedCall(interval, () => {
        if (idleDebug.still) return scheduleBlink();
        const amount = Math.random() < B.partialChance ? B.partialAmount : 1;
        blinkOnce(amount, () => {
          if (Math.random() < B.doubleChance) blinkStep = gsap.delayedCall(B.doubleDelay, () => blinkOnce(1, scheduleBlink));
          else scheduleBlink();
        });
      });
    };

    const S = IDLE.saccade;
    const scheduleSaccade = () => {
      saccadeWait = gsap.delayedCall(rand(S.minInterval, S.maxInterval), () => {
        if (idleDebug.still) {
          saccadeMove = gsap.to(state, { eyeYaw: 0, eyePitch: 0, duration: S.duration });
          return scheduleSaccade();
        }
        // Small jumps are far more common than large ones.
        const r = Math.random() ** 2 * S.amplitude;
        const angle = Math.random() * Math.PI * 2;
        saccadeMove = gsap.to(state, { eyeYaw: Math.cos(angle) * r, eyePitch: Math.sin(angle) * r * S.verticalShare, duration: S.duration, ease: "power2.out" });
        scheduleSaccade();
      });
    };

    scheduleBlink();
    scheduleSaccade();
    return () => {
      blinkStep?.kill();
      saccadeWait?.kill();
      saccadeMove?.kill();
      // as the context's revert did: the eyes and lids back where they started (a remount starts from rest)
      Object.assign(state, { blink: 0, eyeYaw: 0, eyePitch: 0 });
      morphs.clearLayer("blink");
      morphs.clearLayer("gaze");
    };
  }, [state]);

  useFrame(({ clock }, dt) => {
    const t = idleDebug.still ? 0 : clock.elapsedTime; // debug: a frozen pose for comparison shots
    stepFollow(dt);
    const pose = currentPose(); // degrees: sliders + cursor follow, clamped to the limits
    const sway = headRig.sway;
    if (sway) {
      const s = IDLE.sway;
      const br = IDLE.breathing;
      // Reduced motion: the head holds still (no sway, no breathing); the eyes still blink and look around, and the
      // pose, the cursor follow and the speaking nod still move it (lib/reducedMotion.ts).
      const calm = reducedMotion.on ? 0 : 1;
      const breath = calm * Math.sin((2 * Math.PI * t) / br.period);
      sway.rotation.order = "YXZ"; // turn, then nod, then tilt
      sway.rotation.y = pose.headYaw * DEG + calm * s.yaw * wander(t * s.speed * 2 * Math.PI, 0) + headMorph.yaw; // (+ the reveal's turn-in)
      // three's +x rotation tips the face down, so "up" is negative; a little nod while speaking.
      sway.rotation.x = -pose.headPitch * DEG + calm * s.pitch * wander(t * s.speed * 2 * Math.PI, 1) + br.pitch * breath + s.speechNod * lipsyncState.energy + headMorph.pitch;
      sway.rotation.z = -pose.headRoll * DEG + calm * s.roll * wander(t * s.speed * 2 * Math.PI, 2);
      sway.position.y = NECK.y + br.bob * breath;
    }
    const drift = IDLE.saccade.driftAmplitude;
    const yaw = pose.gazeYaw * DEG + state.eyeYaw + drift * wander(t * IDLE.saccade.driftSpeedYaw, 4);
    const pitch = -pose.gazePitch * DEG + state.eyePitch + drift * wander(t * IDLE.saccade.driftSpeedPitch, 5);
    for (const eye of [headRig.leftEye, headRig.rightEye]) {
      if (!eye) continue;
      eye.rotation.order = "YXZ";
      eye.rotation.set(pitch, yaw, 0);
    }
    // Looking down lowers the upper lids a little (they follow the eyeball), through the blink roles.
    const down = Math.max(0, pitch) / (20 * DEG);
    const lid = POSE.lidFollow * Math.min(1, down);
    if (Math.abs(lid - lidApplied) > 1e-3) {
      lidApplied = lid;
      for (const [tg, w] of Object.entries(visemes.roles.blinkLeft)) morphs.setLayerValue("gaze", tg, lid * w);
      for (const [tg, w] of Object.entries(visemes.roles.blinkRight)) morphs.setLayerValue("gaze", tg, lid * w);
    }
  });

  return null;
}
