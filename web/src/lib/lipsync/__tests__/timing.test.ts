import { afterEach, describe, expect, it, vi } from "vitest";

import { BLUETOOTH, HeardClock, IOS_EXTRA } from "../clock";
import type { Cue } from "../cues";
import { alignLine, placeLine, placePhrases, snapClosures } from "../placement";
import { LIPSYNC, LIPSYNC_PARTS } from "../tuning";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("the heard clock", () => {
  const ctxWith = (currentTime: number, outputLatency: number) => ({ currentTime, outputLatency }) as unknown as AudioContext;

  it("hears what played the reported output delay ago, plus the measured Bluetooth extra", () => {
    vi.spyOn(performance, "now").mockReturnValue(1000);
    expect(new HeardClock(() => ctxWith(5, 0.024)).heard()).toBeCloseTo(5 - 0.024, 9);
    // AirPods report ~0.16–0.17 s but take ~0.245 s (docs/lipsync.md)
    expect(new HeardClock(() => ctxWith(5, 0.168)).heard()).toBeCloseTo(5 - 0.168 - BLUETOOTH.extra, 9);
  });

  it("carries the time between the context's steps on performance.now, at most one step", () => {
    const now = vi.spyOn(performance, "now").mockReturnValue(1000);
    const ctx = { currentTime: 2, outputLatency: 0 } as unknown as AudioContext;
    const clock = new HeardClock(() => ctx);
    expect(clock.heard()).toBeCloseTo(2, 9);
    now.mockReturnValue(1005); // 5 ms later, the context hasn't stepped yet
    expect(clock.heard()).toBeCloseTo(2.005, 9);
    now.mockReturnValue(1100); // a stalled context stays (nearly) still
    expect(clock.heard()).toBeCloseTo(2.012, 9);
    (ctx as unknown as { currentTime: number }).currentTime = 2.0107; // the step comes
    expect(clock.heard()).toBeCloseTo(2.0107, 9);
  });

  it("takes iPhone Safari's over-reported delay off", () => {
    vi.spyOn(performance, "now").mockReturnValue(1000);
    vi.stubGlobal("navigator", { maxTouchPoints: 5, userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Mobile/15E148 Safari/604.1" });
    expect(new HeardClock(() => ctxWith(5, 0.08)).heard()).toBeCloseTo(5 - (0.08 + IOS_EXTRA), 9);
    // as an iPhone really reports (12 ms): the whole correction, past zero, not clamped to 12 ms
    expect(new HeardClock(() => ctxWith(5, 0.012)).heard()).toBeCloseTo(5 - (0.012 + IOS_EXTRA), 9);
  });
});

/** A line's loudness from (from, to, level) stretches, 0.002 elsewhere (silence), on the evaluator's 10 ms grid. */
const loudnessOf = (parts: [number, number, number][]) => (t: number) => {
  for (const [a, b, l] of parts) if (t >= a - 1e-9 && t < b - 1e-9) return l;
  return 0.002;
};
let order = 0;
const cue = (viseme: Cue["viseme"], start: number, end: number, ws: number): Cue => ({ viseme, start, end, text: "", ws, n: order++ });

describe("phrases after a pause", () => {
  it("move onto where the voice comes back when their stamps are far off, and stay when they are close", () => {
    // phrase one 0.1–0.6 s, a pause, the voice back at 1.0 s; the next phrase is stamped 250 ms late
    const loud = loudnessOf([
      [0.1, 0.6, 0.6],
      [1.0, 1.6, 0.7],
    ]);
    const cues = [cue("aa", 0.12, 0.5, 0.1), cue("E", 1.25, 1.4, 1.25), cue("I", 1.4, 1.55, 1.25)];
    placePhrases(cues, loud, Infinity, true);
    expect(cues[0].start).toBeCloseTo(0.12, 6); // the first phrase is placeLine's
    expect(cues[1].start).toBeCloseTo(1.0, 6);
    expect(cues[2].start).toBeCloseTo(1.15, 6); // the rest of the phrase moves with it
    const near = [cue("aa", 0.12, 0.5, 0.1), cue("E", 1.02, 1.2, 1.02)];
    placePhrases(near, loud, Infinity, true);
    expect(near[1].start).toBeCloseTo(1.02, 6); // 20 ms: stamp jitter, left to the snapping
  });
});

describe("a closure after a pause", () => {
  it("snaps onto its own silence even when the phrase before trailed off far below its vowel", () => {
    // "peppers, but": the phrase before ends quietly (0.15), a pause, then "b" released at 0.80 into a loud vowel (1.0).
    // The b is stamped 50 ms late. It used to be pushed past its own vowel (the closure rule wanted a syllable within
    // closureSyllableDb of the vowel since the previous closure, and the trailing phrase was 16 dB down).
    const loud = loudnessOf([
      [0.07, 0.35, 0.15],
      [0.8, 0.95, 1.0],
      [0.95, 1.1, 0.4],
    ]);
    const cues = [cue("PP", 0.0, 0.06, 0.0), cue("E", 0.1, 0.3, 0.0), cue("PP", 0.79, 0.87, 0.85), cue("aa", 0.86, 0.94, 0.85)];
    placeLine(cues, loud, Infinity);
    placePhrases(cues, loud, Infinity, false);
    alignLine(cues, loud, loud, Infinity, false); // the snapping on its own
    snapClosures(cues, loud, Infinity, new WeakSet<Cue>());
    const b = cues.find((c) => c.viseme === "PP" && c.ws === 0.85)!;
    expect(b.end).toBeCloseTo(0.8 - LIPSYNC.closureOffShift, 2); // the lips part at the burst
    expect(b.end).toBeLessThan(0.86); // not over its vowel
  });
});

describe("two p/b/m with no vowel between", () => {
  it("share one closure: \"Bob bought\" closes once and parts on the burst, not again on the late stamp", () => {
    // "Bo-b b-ought": the vowel, one closure (0.35–0.45), the next vowel; "bought"'s b is stamped 110 ms into its vowel
    const loud = loudnessOf([
      [0.1, 0.35, 1.0],
      [0.45, 0.75, 1.0],
    ]);
    const make = () => [cue("PP", 0.05, 0.1, 0.05), cue("aa", 0.1, 0.3, 0.05), cue("PP", 0.33, 0.4, 0.05), cue("PP", 0.56, 0.62, 0.56), cue("aa", 0.6, 0.75, 0.56)];
    const snap = (cues: Cue[]) => {
      placeLine(cues, loud, Infinity);
      placePhrases(cues, loud, Infinity, false);
      alignLine(cues, loud, loud, Infinity, false); // the snapping on its own
      snapClosures(cues, loud, Infinity, new WeakSet<Cue>());
    };
    const cues = make();
    snap(cues);
    const [bob, bought] = cues.filter((c) => c.viseme === "PP").sort((p, q) => p.n! - q.n!).slice(1);
    expect(Math.abs(bob.end - (0.45 - LIPSYNC.closureOffShift))).toBeLessThan(0.011); // parts on the burst
    expect(bought.start).toBeCloseTo(bob.start, 6);
    expect(bought.end).toBeCloseTo(bob.end, 6); // no second closing on "ought"
    LIPSYNC_PARTS.joinClosures = false;
    const old = make();
    snap(old);
    expect(old.filter((c) => c.viseme === "PP").sort((p, q) => p.n! - q.n!)[2].end).toBeGreaterThan(0.55); // as before
    LIPSYNC_PARTS.joinClosures = true;
  });
});

describe("aligning a line's sounds in order", () => {
  it("puts a late-stamped p/b/m on its own closure, not the next word's, and the vowel after it on its own peak", () => {
    // three syllables (peaks at 0.2, 0.5, 0.8 s) with a closure between each (dips at 0.35 and 0.65); the middle
    // syllable's "p" and vowel are stamped ~120 ms late, as close to the next closure as to their own
    const peak = (t: number, at: number) => 0.8 * Math.exp(-(((t - at) / 0.05) ** 2) / 2);
    const loud = (t: number) => Math.max(0.002, peak(t, 0.2), peak(t, 0.5), peak(t, 0.8));
    const cues = [cue("aa", 0.16, 0.24, 0.16), cue("PP", 0.47, 0.53, 0.47), cue("E", 0.58, 0.66, 0.47), cue("PP", 0.62, 0.68, 0.62), cue("I", 0.76, 0.84, 0.62)];
    LIPSYNC_PARTS.placeLine = false;
    try {
      placeLine(cues, loud, Infinity);
    } finally {
      LIPSYNC_PARTS.placeLine = true;
    }
    placePhrases(cues, loud, Infinity, false);
    alignLine(cues, loud, loud, Infinity, true);
    const [p1, e] = [cues.find((c) => c.viseme === "PP" && c.ws === 0.47)!, cues.find((c) => c.viseme === "E")!];
    expect((p1.start + p1.end) / 2).toBeCloseTo(0.35, 1); // its own dip, not the next word's at 0.65
    expect((e.start + e.end) / 2).toBeLessThan(0.58); // the vowel moved onto its syllable (0.5), ahead of the next closure
  });
});

