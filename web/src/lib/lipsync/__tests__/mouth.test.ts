import { describe, expect, it } from "vitest";

import type { SpeechSource } from "../evaluator";
import { LIPSYNC } from "../evaluator";
import { Mouth } from "../mouth";

describe("after the voice stops", () => {
  it("the expression comes back eased over LIPSYNC.speechRelease, not in a few frames", () => {
    const activity: number[] = [];
    const mouth = new Mouth({ cap: () => 1, userValue: () => 0, speechActivity: (a) => void activity.push(a), write: () => {}, clear: () => {} });
    // a line that sounds for 1 s, then silence
    const src: SpeechSource = { playing: true, time: () => 0, cues: [], decodedSeconds: () => Infinity, streamDone: true, loudness: (t) => (t < 1 ? 0.8 : 0), trebleLoudness: () => 0 };
    const dt = 1 / 60;
    let t = 0;
    for (; t < 1; t += dt) mouth.frame(src, t, dt);
    expect(activity.at(-1)).toBeCloseTo(1, 2); // speaking: the mouth part stepped back
    const at = (s: number) => {
      for (; t < 1 + s; t += dt) mouth.frame(src, t, dt);
      return activity.at(-1)!;
    };
    // still voiced within speechHold of now, then the release starts: slowly (eased in), half way at half the time
    const start = 1 + LIPSYNC.speechHold;
    expect(at(LIPSYNC.speechHold - 0.02)).toBeCloseTo(1, 2);
    expect(at(start - 1 + 0.1)).toBeGreaterThan(0.9); // 0.1 s in: an exponential (speechFade 0.1) would be at ~0.37
    expect(at(start - 1 + LIPSYNC.speechRelease / 2)).toBeCloseTo(0.5, 1);
    expect(at(start - 1 + LIPSYNC.speechRelease + 0.05)).toBe(0); // back to the expression
  });
});
