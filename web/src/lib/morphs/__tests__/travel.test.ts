import { describe, expect, it } from "vitest";

import { adaptiveTrack, toUi, toWeight, uiMax, uiMin } from "@/lib/morphs/travel";

describe("slider travel (each half scaled to its own end)", () => {
  const nose = { min: -0.8, max: 2.4 }; // goes further one way than the other

  it("keeps the average face in the middle and uses the whole track on both sides", () => {
    expect([uiMin(nose), uiMax(nose)]).toEqual([-1, 1]);
    expect(toWeight(nose, 0)).toBe(0);
    expect(toWeight(nose, -1)).toBeCloseTo(-0.8);
    expect(toWeight(nose, 1)).toBeCloseTo(2.4);
    expect(toWeight(nose, 0.5)).toBeCloseTo(1.2); // even feel within a side
  });

  it("round-trips and clamps weights past the ends to the track", () => {
    for (const u of [-1, -0.37, 0, 0.42, 1]) expect(toUi(nose, toWeight(nose, u))).toBeCloseTo(u);
    expect(toUi(nose, 3)).toBe(1);
    expect(toUi(nose, -2)).toBe(-1);
  });

  it("leaves one-sided sliders (0 … 1) as they are", () => {
    const jaw = { min: 0, max: 1 };
    expect([uiMin(jaw), uiMax(jaw)]).toEqual([0, 1]);
    expect(toWeight(jaw, 0.3)).toBe(0.3);
    expect(toUi(jaw, 0.3)).toBe(0.3);
  });
});

describe("adaptive track (the dragged slider always reaches its end)", () => {
  const nose = { min: -2.8, max: 1.5 };

  it("maps the ends to what this face allows, 0 to the average face, and the grab point to itself", () => {
    const track = adaptiveTrack(nose, 0.3, 0.45, -1.2, 0.9); // grabbed at thumb 0.3, weight 0.45; room −1.2 … 0.9
    expect(track(1)).toBeCloseTo(0.9);
    expect(track(-1)).toBeCloseTo(-1.2);
    expect(track(0)).toBeCloseTo(0);
    expect(track(0.3)).toBeCloseTo(0.45); // nothing jumps when it is grabbed
    let last = -Infinity;
    for (let u = -1; u <= 1.0001; u += 0.05) {
      const w = track(u);
      expect(w).toBeGreaterThanOrEqual(last - 1e-9); // monotone: dragging right never moves the face back
      last = w;
    }
  });

  it("keeps the current weight when the thumb sits on an end already", () => {
    const track = adaptiveTrack(nose, 1, 1.1, -2.8, 1.4); // at the end, but now there is room up to 1.4
    expect(track(1)).toBeCloseTo(1.1);
    expect(track(0.5)).toBeCloseTo(0.55);
  });

  it("stays inside the room when the face only allows one side of 0", () => {
    const track = adaptiveTrack(nose, 0.5, 0.7, 0.4, 1.5);
    for (const u of [-1, -0.5, 0, 0.5, 1]) expect(track(u)).toBeGreaterThanOrEqual(0.4 - 1e-9);
  });
});
