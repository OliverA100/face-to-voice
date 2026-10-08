import { describe, expect, it } from "vitest";

import { clamp, damp, LIMITS, splitLook } from "../pose";

describe("pose", () => {
  it("splits a look between head and eyes and lands on the target", () => {
    const s = splitLook(20, 10, 0.35);
    expect(s.headYaw + s.gazeYaw).toBeCloseTo(20);
    expect(s.headPitch + s.gazePitch).toBeCloseTo(10);
    expect(s.headYaw).toBeCloseTo(7);
  });

  it("gives the head the overflow when the eyes reach their limit, and stops at the head's", () => {
    const s = splitLook(80, 0, 0.35);
    expect(s.gazeYaw).toBe(LIMITS.gazeYaw[1]);
    expect(s.headYaw).toBe(LIMITS.headYaw[1]);
  });

  it("damps towards a target, frame-rate independent", () => {
    let a = 0;
    for (let i = 0; i < 60; i++) a = damp(a, 10, 4, 1 / 60);
    let b = 0;
    for (let i = 0; i < 30; i++) b = damp(b, 10, 4, 1 / 30);
    expect(a).toBeCloseTo(b, 5);
    expect(a).toBeGreaterThan(9.5);
  });

  it("clamps to the limits", () => {
    expect(clamp(50, LIMITS.headYaw)).toBe(35);
    expect(clamp(-30, LIMITS.gazePitch)).toBe(-20);
  });
});

describe("look at cursor vs the gaze sliders", () => {
  it("are exclusive: following ignores the gaze sliders and puts them back to centre", async () => {
    const { currentPose, poseRig, setLookAtCursor } = await import("../pose");
    poseRig.follow.on = false;
    poseRig.base.gazeYaw = 20;
    expect(currentPose().gazeYaw).toBe(20);
    setLookAtCursor(true);
    expect(currentPose().gazeYaw).toBe(0); // no cursor movement yet: the sliders no longer count
    await new Promise((r) => setTimeout(r, 500)); // the gaze slider eases to 0 (POSE.ease 0.35 s)
    expect(poseRig.base.gazeYaw).toBeCloseTo(0, 3);
    setLookAtCursor(false);
  });
});
