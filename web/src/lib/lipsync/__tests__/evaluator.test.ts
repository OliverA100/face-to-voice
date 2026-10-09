import { describe, expect, it } from "vitest";

import type { Cue } from "../cues";
import { closureGate, LIPSYNC, loudnessGate, roundingAt, speedShare } from "../evaluator";

describe("closureGate", () => {
  it("lets closures through while quiet and holds them back once the voice is loud", () => {
    expect(closureGate(0)).toBe(1);
    expect(closureGate(LIPSYNC.closureLoud)).toBe(1);
    expect(closureGate(LIPSYNC.closureLoud + LIPSYNC.closureBand)).toBe(0);
    expect(closureGate(1)).toBe(0);
    const mid = closureGate(LIPSYNC.closureLoud + LIPSYNC.closureBand / 2);
    expect(mid).toBeCloseTo(0.5, 5);
  });
});

describe("loudnessGate", () => {
  it("keeps quiet vowels at gateFloor and opens fully at gateLevel", () => {
    expect(loudnessGate(0)).toBeCloseTo(LIPSYNC.gateFloor, 9);
    expect(loudnessGate(LIPSYNC.gateLevel)).toBe(1);
    expect(loudnessGate(1)).toBe(1);
    expect(loudnessGate(LIPSYNC.gateLevel / 2)).toBeGreaterThan(LIPSYNC.gateFloor);
  });
});

describe("roundingAt", () => {
  const cue = (viseme: Cue["viseme"], start: number, end: number): Cue => ({ viseme, start, end, text: "" });

  it("rounds a closure for a coming or just-ended U (fully) or O (roundO), not for other vowels", () => {
    const cues = [cue("PP", 0.4, 0.45), cue("U", 0.5, 0.6), cue("O", 1.2, 1.3), cue("aa", 2, 2.1)];
    expect(roundingAt(cues, 0.45)).toBe(1); // U starts within roundAhead
    expect(roundingAt(cues, 0.6 + LIPSYNC.roundAfter - 0.01)).toBe(1); // U just ended
    expect(roundingAt(cues, 1.1)).toBe(LIPSYNC.roundO);
    expect(roundingAt(cues, 1.9)).toBe(0);
  });
});

describe("speedShare", () => {
  it("lets a step through whole when it is slow enough, and shortens it to the top speed when it is not", () => {
    const dt = 1 / 60;
    expect(speedShare(1, 0.5, dt)).toBe(1); // 60 mm/s lips, 30 mm/s jaw
    const lips = speedShare(10, 0, dt); // 600 mm/s
    expect(lips * 10).toBeCloseTo(LIPSYNC.gapSpeed * dt, 6);
    const jaw = speedShare(0, -8, dt); // 480 mm/s, closing
    expect(jaw * 8).toBeCloseTo(LIPSYNC.jawSpeed * dt, 6);
    expect(speedShare(10, 8, dt)).toBe(Math.min(lips, jaw)); // the stricter of the two
  });
});

