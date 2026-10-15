import { describe, expect, it } from "vitest";

import type { Cue } from "../cues";
import { closureGate, emptyActivations, fitPhrases, frameMemory, frameTargets, LIPSYNC, LIPSYNC_PARTS, loudnessGate, roundingAt, shapeShare, speedShare, speedUpShare, type SpeechSource } from "../evaluator";

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
  it("lets a p/b/m shut faster than the mouth opens (closeBoost)", () => {
    const dt = 1 / 60;
    expect(speedShare(-10, -8, dt, true) * 8).toBeCloseTo(LIPSYNC.jawSpeed * LIPSYNC.closeBoost * dt, 6);
    expect(speedShare(10, 8, dt, true)).toBe(speedShare(10, 8, dt)); // opening: the calm speeds
    expect(speedShare(-10, -8, dt)).toBe(speedShare(10, 8, dt)); // no closure asked for: the calm speeds
  });
});


describe("shape hold", () => {
  /** One vowel held from 0.2 to 0.8 s, with the voice at `level` (0..1 of the line's loudest moment) except a burst at 0. */
  const source = (viseme: Cue["viseme"], level: number): SpeechSource => ({
    playing: true,
    time: () => 0.5,
    cues: [{ viseme, start: 0.2, end: 0.8, text: "" }],
    decodedSeconds: () => Infinity,
    streamDone: true,
    loudness: (t) => (t < 0.05 ? 1 : level),
    trebleLoudness: () => 0,
  });
  const at = (viseme: Cue["viseme"], level: number) => {
    const out = emptyActivations();
    frameTargets(source(viseme, level), 0.5, 0, out, frameMemory());
    return out;
  };

  it("keeps an o rounded (through u) and an eh spread (through ee) as the loudness takes the opening away", () => {
    const quiet = at("O", 0.02);
    const loud = at("O", 1);
    expect(quiet.O).toBeLessThan(loud.O); // the opening follows the loudness …
    expect(quiet.U).toBeGreaterThan(0.5); // … the rounding stays
    expect(loud.U).toBe(0);
    expect(at("E", 0.02).I).toBeGreaterThan(0.3);
    expect(at("U", 0.02).U).toBeGreaterThanOrEqual(LIPSYNC.shapeHold.U * at("U", 1).U - 1e-9);
  });

  it("is off with LIPSYNC_PARTS.shapeHold (the lab's switch)", () => {
    LIPSYNC_PARTS.shapeHold = false;
    try {
      expect(at("O", 0.02).U).toBe(0);
    } finally {
      LIPSYNC_PARTS.shapeHold = true;
    }
  });
});

describe("speedUpShare", () => {
  const dt = 1 / 60;
  const grow = LIPSYNC.speedUp * 1000 * dt; // mm/s a movement may speed up by in one frame

  it("eases a movement in from rest, and lets it keep its speed once moving", () => {
    // from rest, a 5 mm jaw step (300 mm/s) is held to the speed it may reach in one frame
    expect(speedUpShare(0, 5, 1, 0, 0, dt) * 5 / dt).toBeCloseTo(grow, 6);
    // already moving that way at 300 mm/s: the whole step
    expect(speedUpShare(0, 5, 1, 0, 300, dt)).toBe(1);
  });

  it("never holds back slowing down, and starts a turn from rest", () => {
    expect(speedUpShare(0, 0.1, 1, 0, 300, dt)).toBe(1); // slowing from 300 to 6 mm/s
    expect(speedUpShare(0, 5, 1, 0, -300, dt) * 5 / dt).toBeCloseTo(grow, 6); // reversing
    expect(speedUpShare(0, 5, 0.5, 0, 300, dt)).toBe(0.5); // the top speed's share stays the ceiling
  });
});

describe("followRelease", () => {
  // "b" + a vowel stamped 0.2 s late: the lips are shut 0.3–0.4 s (a dip), then the vowel sounds from 0.4 s
  const line = (): SpeechSource => ({
    playing: true,
    time: () => 0,
    cues: [
      { viseme: "PP", start: 0.33, end: 0.38, text: "b", ws: 0.33, n: 0 },
      { viseme: "E", start: 0.6, end: 0.7, text: "ea", ws: 0.33, n: 1 },
    ],
    decodedSeconds: () => Infinity,
    streamDone: true,
    loudness: (t) => (t < 0.3 ? 0.6 : t < 0.4 ? 0.01 : t < 1 ? 0.6 : 0),
    trebleLoudness: () => 0,
  });
  const vowelStart = () => {
    const src = line();
    LIPSYNC_PARTS.placeLine = false; // the line is placed already: only the word moves
    LIPSYNC_PARTS.alignPhrases = false;
    try {
      frameTargets(src, 0, 0, emptyActivations(), frameMemory());
    } finally {
      LIPSYNC_PARTS.placeLine = true;
      LIPSYNC_PARTS.alignPhrases = true;
    }
    const b = src.cues.find((c) => c.viseme === "PP")!;
    return { vowel: src.cues.find((c) => c.viseme === "E")!.start, release: b.end };
  };

  it("starts the sounds after a p/b/m in its word where the lips let go", () => {
    const { vowel, release } = vowelStart();
    expect(release).toBeGreaterThan(0.35);
    expect(vowel).toBeCloseTo(release + LIPSYNC.releaseGap, 5);
  });

  it("is off with LIPSYNC_PARTS.followRelease (the lab's switch)", () => {
    LIPSYNC_PARTS.followRelease = false;
    try {
      expect(vowelStart().vowel).toBeCloseTo(0.6, 5);
    } finally {
      LIPSYNC_PARTS.followRelease = true;
    }
  });
});

describe("shapeShare", () => {
  it("holds the mouth's width and rounding to their top speeds, and leaves other steps alone", () => {
    const dt = 1 / 60;
    const from = { ...emptyActivations(), I: 1 }; // "ee": spread
    const to = { ...emptyActivations(), U: 1 }; // "oo": rounded, corners in
    const k = shapeShare(from, to, 1, dt);
    const width = (LIPSYNC.shapeMm.width.U! - LIPSYNC.shapeMm.width.I!) * k;
    const round = LIPSYNC.shapeMm.round.U! * k;
    // ~10 mm of corners and ~5 mm forward in one frame is far too fast: the stricter of the two top speeds holds
    expect(Math.max(Math.abs(width) / dt / LIPSYNC.widthSpeed, Math.abs(round) / dt / LIPSYNC.roundSpeed)).toBeCloseTo(1, 6);
    expect(shapeShare(emptyActivations(), { ...emptyActivations(), aa: 1 }, 1, dt)).toBe(1); // "ah" neither spreads nor rounds
    expect(shapeShare(from, to, 0.001, dt)).toBe(0.001); // a smaller share so far stays
  });
});

describe("vowel rescue", () => {
  // "like" stamped after it was said: its syllable sounds at 0.3 s, a breath follows at 0.55 s, the stamp is at 0.5 s
  const src = (): SpeechSource => ({
    playing: true,
    time: () => 0,
    cues: [{ viseme: "aa", start: 0.46, end: 0.54, text: "i", ws: 0.4, n: 0 }],
    decodedSeconds: () => Infinity,
    streamDone: true,
    loudness: (t) => (Math.abs(t - 0.3) < 0.06 ? 1 - Math.abs(t - 0.3) * 5 : Math.abs(t - 0.55) < 0.02 ? 0.03 : 0.001),
    trebleLoudness: () => 0,
  });

  it("puts a vowel stamped in silence on its syllable, not on a breath", () => {
    const s = src();
    LIPSYNC_PARTS.placeLine = false;
    try {
      frameTargets(s, 0, 0, emptyActivations(), frameMemory());
    } finally {
      LIPSYNC_PARTS.placeLine = true;
    }
    const c = s.cues[0];
    expect((c.start + c.end) / 2).toBeCloseTo(0.3, 1);
  });
});

describe("fitPhrases", () => {
  // "Well…": the vowel is stamped to end at 0.3 s, but the voice holds it, clearly, until 0.6 s, then pauses
  const line = (): SpeechSource => ({
    playing: true,
    time: () => 0,
    cues: [{ viseme: "E", start: 0.1, end: 0.3, text: "e", ws: 0.05, n: 0 }],
    decodedSeconds: () => Infinity,
    streamDone: true,
    loudness: (t) => (t > 0.05 && t < 0.6 ? 0.8 : 0.001),
    trebleLoudness: () => 0,
  });
  const vowelEnd = () => {
    const src = line();
    LIPSYNC_PARTS.placeLine = false;
    LIPSYNC_PARTS.snapVowels = false;
    try {
      frameTargets(src, 0, 0, emptyActivations(), frameMemory());
    } finally {
      LIPSYNC_PARTS.placeLine = true;
      LIPSYNC_PARTS.snapVowels = true;
    }
    return src.cues[0].end;
  };

  it("holds a phrase's last vowel while the voice draws it out", () => {
    expect(vowelEnd()).toBeGreaterThan(0.55);
    expect(vowelEnd()).toBeLessThan(0.62);
  });

  it("holds the vowel up to what is decoded so far while the voice is still on and nothing stamped covers it", () => {
    const loud = (t: number) => (t > 0.05 ? 0.8 : 0.001); // still sounding where decoding has got to (0.5 s)
    const held = [{ viseme: "E" as const, start: 0.1, end: 0.3, text: "e", n: 0 }];
    fitPhrases(held, loud, 0.5);
    expect(held[0].end).toBeGreaterThan(0.35);
    expect(held[0].end).toBeLessThan(0.41); // up to the edge (less its margin), not beyond
    // a sound stamped after the vowel: the stamps haven't run out, the voice is that sound
    const covered = [{ viseme: "E" as const, start: 0.1, end: 0.3, text: "e", n: 0 }, { viseme: "DD" as const, start: 0.32, end: 0.36, text: "d", n: 1 }];
    fitPhrases(covered, loud, 0.5);
    expect(covered[0].end).toBeCloseTo(0.3, 5);
  });

  it("is off with LIPSYNC_PARTS.fitPhrases (the lab's switch)", () => {
    LIPSYNC_PARTS.fitPhrases = false;
    try {
      expect(vowelEnd()).toBeCloseTo(0.3, 5);
    } finally {
      LIPSYNC_PARTS.fitPhrases = true;
    }
  });
});
