import { beforeEach, describe, expect, it, vi } from "vitest";

import { frameMemory, frameTargets } from "../evaluator";
import { emptyActivations } from "../shapes";
import { LIPSYNC_PARTS } from "../tuning";
import { LiveSpeech, type LiveWord } from "../live";

// A conversation's voice as the lip sync sees it, without Web Audio: meter blocks are fed in by hand (what the
// AudioWorklet posts: [context time, rms, treble rms] per 10 ms) and the context clock is a number we move.
const ctx = { currentTime: 0, outputLatency: 0.02 } as unknown as AudioContext & { currentTime: number };

function feed(live: LiveSpeech, from: number, seconds: number, rms: (t: number) => number) {
  const data: number[] = [];
  for (let t = from; t < from + seconds - 1e-9; t += 0.01) data.push(t, rms(t), rms(t) / 4);
  (live as unknown as { blocks(d: number[]): void }).blocks(data);
}

const WORDS: LiveWord[] = [
  { w: "Hello ", s: 0.1, e: 0.4 },
  { w: "there.", s: 0.45, e: 0.8 },
];

describe("live speech (a reply as the evaluator's line)", () => {
  // the heard clock carries time on performance.now() between the context's steps: hold it still, the fake context's
  // currentTime is the only clock here
  beforeEach(() => {
    vi.spyOn(performance, "now").mockReturnValue(1000);
  });

  it("puts the reply's time 0 where its first word meets the voice's onset, and builds cues from the words", () => {
    const live = new LiveSpeech(ctx);
    feed(live, 0, 1, () => 0.001); // silence before the reply
    live.wordsStarted();
    live.addWords(WORDS);
    live.replyStarted();
    feed(live, 1, 0.5, () => 0.2); // the voice starts at 1.00 s on the context clock
    expect(live.cues.length).toBeGreaterThan(0);
    // "there." is timed from its first letter to its last: the full stop takes no time, the letters fill the word
    expect(Math.max(...live.cues.map((c) => c.end))).toBeCloseTo(0.8, 5);
    // the first word (0.1 s into the reply's audio) sits on the onset: time 0 is at 0.9 s
    ctx.currentTime = 1.0 + 0.02; // heard 20 ms after the meter saw it (output latency)
    expect(live.time()).toBeCloseTo(0.1, 5);
    expect(live.playing).toBe(true);
    expect(live.streamDone).toBe(false);
  });

  it("pins the words where the agent says the voice starts on their clock, once it says", () => {
    const live = new LiveSpeech(ctx);
    live.wordsStarted();
    live.addWords(WORDS); // the first word is stamped at 0.1 s …
    live.replyStarted();
    feed(live, 6, 0.5, () => 0.2); // … the voice is heard from 6.00 s
    ctx.currentTime = 6.02;
    expect(live.time()).toBeCloseTo(0.1, 5); // pinned on the first word until the agent's onset comes
    live.voiceOnset(0.18); // … but the voice starts 0.18 s into the reply's audio: the stamp ran 80 ms early
    expect(live.time()).toBeCloseTo(0.18, 5);
  });

  it("knows the sound only as far as the meter has got, and normalises by the reply's loudest moment", () => {
    const live = new LiveSpeech(ctx);
    live.wordsStarted();
    live.addWords(WORDS);
    live.replyStarted();
    feed(live, 2, 0.3, (t) => (t < 2.1 ? 0.1 : 0.4));
    ctx.currentTime = 2.3;
    const t0 = 2 - WORDS[0].s; // time 0 of this reply
    expect(live.decodedSeconds()).toBeCloseTo(2.3 - t0, 5);
    expect(live.loudness(2.25 - t0)).toBe(1);
    expect(live.loudness(2.05 - t0)).toBeCloseTo(0.25, 5);
    expect(live.loudness(5)).toBe(0); // not heard yet
  });

  /** The agent's own loudness for a reply (blocks of 10 ms on the words' clock), as it sends it. */
  const sendEnvelope = (live: LiveSpeech, seconds: number, rms: (t: number) => number) =>
    live.addEnvelope(0, Array.from({ length: Math.round(seconds * 100) }, (_, k) => Math.round(rms(k / 100) * 10_000)));

  it("moves a phrase onto its sound in the agent's own audio, and only that phrase", () => {
    const live = new LiveSpeech(ctx);
    live.wordsStarted();
    // "Hello there." then, after a gap in the stamps, "Again." stamped at 1.2 s and "Still." at 2.0 s
    live.addWords([...WORDS, { w: "Again.", s: 1.2, e: 1.5 }, { w: "Still.", s: 2.0, e: 2.3 }]);
    live.voiceOnset(0.1);
    live.replyStarted();
    feed(live, 7, 0.5, () => 0.2); // the voice is heard from 7.00 s: the line's time 0 is 6.9 s
    // the agent's audio: "Hello there." 0.1–0.8, "Again." back at 1.05 (stamped 1.2), "Still." at 2.0 as stamped
    sendEnvelope(live, 2.5, (t) => ((t >= 0.1 && t < 0.8) || (t >= 1.05 && t < 1.6) || t >= 2.0 ? 0.2 : 0.001));
    const starts = (from: number, to: number) => Math.min(...live.cues.filter((c) => c.start >= from && c.start < to).map((c) => c.start));
    expect(starts(0.9, 1.6)).toBeCloseTo(1.05, 5); // "Again." on its sound
    expect(starts(1.9, 2.5)).toBeCloseTo(2.0, 5); // "Still." where it was stamped: the shift stays with its phrase
    expect(starts(0, 0.9)).toBeCloseTo(0.1, 5); // the words before it stay where they were
  });

  it("doesn't take a breath or a click for the voice coming back", () => {
    const live = new LiveSpeech(ctx);
    live.wordsStarted();
    live.addWords([...WORDS, { w: "Again.", s: 1.2, e: 1.5 }]);
    live.voiceOnset(0.1);
    live.replyStarted();
    feed(live, 8, 0.5, () => 0.2);
    // a 60 ms breath at 0.95 s, then "Again." as stamped
    sendEnvelope(live, 1.6, (t) => ((t >= 0.1 && t < 0.8) || (t >= 0.95 && t < 1.01) || t >= 1.2 ? 0.2 : 0.001));
    expect(Math.min(...live.cues.filter((c) => c.start > 0.9).map((c) => c.start))).toBeCloseTo(1.2, 5);
  });

  it("starts a word stamped into the pause before it where the voice comes back; the words after keep their stamps", () => {
    const words: LiveWord[] = [{ w: "Oh, ", s: 0.1, e: 0.28 }, { w: "hey. ", s: 0.36, e: 0.65 }, { w: "I ", s: 1.0, e: 1.4 }, { w: "was ", s: 1.48, e: 1.56 }];
    const firstOf = (live: LiveSpeech, from: number, to: number) => Math.min(...live.cues.filter((c) => c.start >= from && c.start < to).map((c) => c.start));
    const reply = () => {
      const live = new LiveSpeech(ctx);
      live.wordsStarted();
      live.addWords(words);
      live.voiceOnset(0.1);
      live.replyStarted();
      feed(live, 9, 0.5, () => 0.2);
      // "I" was stamped from 1.00 s, through the pause after "hey.": the voice comes back at 1.36 s
      sendEnvelope(live, 1.8, (t) => ((t >= 0.1 && t < 0.65) || t >= 1.36 ? 0.2 : 0.001));
      return live;
    };
    let live = reply();
    expect(firstOf(live, 0.9, 1.45)).toBeCloseTo(1.36, 5); // "I" with the voice
    expect(firstOf(live, 1.45, 1.6)).toBeCloseTo(1.48, 5); // "was" where it was stamped
    // without it: the nearest stamped start, "was", was pinned to the voice's return, the phrase early
    LIPSYNC_PARTS.liveAcross = false;
    live = reply();
    LIPSYNC_PARTS.liveAcross = true;
    expect(firstOf(live, 1.3, 1.45)).toBeCloseTo(1.36, 5);
    expect(firstOf(live, 0.9, 1.3)).toBeCloseTo(1.0, 5); // "I" left in the pause
  });

  it("puts the first word on the voice's start in the agent's audio at once, without waiting to hear it", () => {
    const live = new LiveSpeech(ctx);
    live.wordsStarted();
    live.addWords([{ w: "Honestly, ", s: 0.3, e: 0.8 }, { w: "yes.", s: 0.86, e: 1.1 }]);
    live.voiceOnset(0.1);
    live.replyStarted();
    sendEnvelope(live, 1.2, (t) => (t >= 0.1 && t < 1.1 ? 0.2 : 0.001)); // the voice from 0.10 s, "Honestly" stamped at 0.30
    expect(live.voiceStart).toBeCloseTo(0.1, 5);
    feed(live, 10, 0.1, () => 0.2); // only 0.1 s heard yet
    frameTargets(live, 0.05, 0, emptyActivations(), frameMemory());
    expect(Math.min(...live.cues.map((c) => c.start))).toBeCloseTo(0.1, 5);
    LIPSYNC_PARTS.liveVoiceStart = false;
    expect(live.voiceStart).toBeUndefined();
    LIPSYNC_PARTS.liveVoiceStart = true;
  });

  it("eases time 0 onto the voice when what is heard matches the agent's audio elsewhere", () => {
    const live = new LiveSpeech(ctx);
    live.wordsStarted();
    live.addWords([{ w: "One", s: 0, e: 4 }]);
    live.voiceOnset(0.1);
    live.replyStarted();
    // speech-like loudness in the agent's audio (seeded noise, 10 ms blocks, from 0.1 s); heard 0.1 s later than the
    // onset pin says (a click came first)
    let seed = 7;
    const level = Array.from({ length: 400 }, (_, k) => (k < 10 ? 0.002 : 0.005 + 0.3 * ((seed = (seed * 16807) % 2147483647) / 2147483647) ** 2));
    const syllables = (t: number) => level[Math.round(t * 100)] ?? 0.002;
    sendEnvelope(live, 4, syllables);
    feed(live, 20, 0.02, () => 0.05); // the click: the onset is pinned here
    feed(live, 20.02, 0.08, () => 0.002);
    for (let at = 20.1; at < 23.1 - 1e-9; at += 0.25) feed(live, at, 0.25, (t) => syllables(t - 20)); // the voice, 0.1 s after the pin
    // pinned at the click, time 0 was 19.9; it moves towards 20.0 in small steps
    ctx.currentTime = 23.1;
    const t = live.time() + ctx.outputLatency;
    expect(23.1 - t).toBeGreaterThan(19.95);
    expect(23.1 - t).toBeLessThan(20.02);
  });

  it("holds the last measured level just past the meter (the evaluator reads a little ahead)", () => {
    const live = new LiveSpeech(ctx);
    live.wordsStarted();
    live.addWords(WORDS);
    live.replyStarted();
    feed(live, 9, 0.2, () => 0.2);
    const end = 9.2 - (9 - WORDS[0].s); // line time of the meter's edge
    expect(live.loudness(end + 0.03)).toBe(1);
    expect(live.loudness(end + 0.5)).toBe(0);
  });

  it("keeps following the sound a moment after the reply ends, then lets go", () => {
    const live = new LiveSpeech(ctx);
    live.wordsStarted();
    live.addWords(WORDS);
    live.replyStarted();
    feed(live, 3, 0.4, () => 0.2);
    ctx.currentTime = 3.4;
    live.replyEnded();
    expect(live.streamDone).toBe(false); // its last sound may still be on its way to the meter
    expect(live.playing).toBe(true);
    ctx.currentTime = 3.7;
    expect(live.streamDone).toBe(true);
    ctx.currentTime = 4.1;
    expect(live.playing).toBe(false);
  });

  it("never mouths the last reply's words at the start of the next one", () => {
    const live = new LiveSpeech(ctx);
    live.wordsStarted();
    live.addWords(WORDS);
    live.replyStarted();
    feed(live, 10, 0.5, () => 0.2);
    live.replyEnded();
    live.replyStarted(); // the next reply is heard before its words arrive
    feed(live, 11, 0.3, () => 0.2);
    expect(live.cues).toEqual([]);
    expect(live.playing).toBe(false);
  });

  it("times a new reply's words on its own onset, not the last reply's", () => {
    const live = new LiveSpeech(ctx);
    live.wordsStarted();
    live.addWords(WORDS);
    live.replyStarted();
    feed(live, 40, 0.5, () => 0.2);
    ctx.currentTime = 40.5;
    live.replyEnded();
    // the next reply's words arrive while the last one's tail still plays: no line until its voice is heard
    live.wordsStarted();
    live.addWords(WORDS);
    expect(live.time()).toBe(-1);
    live.replyStarted();
    feed(live, 40.5, 0.5, () => 0.001);
    feed(live, 41, 0.3, () => 0.2); // its voice: from 41.0 s
    ctx.currentTime = 41.02;
    expect(live.time()).toBeCloseTo(0.1, 5); // pinned on its own first word
  });

  it("starts a new line when the next reply's words come without a 'speaking' edge between (merged state updates)", () => {
    const live = new LiveSpeech(ctx);
    live.wordsStarted();
    live.addWords(WORDS);
    live.replyStarted();
    feed(live, 50, 2, () => 0.2);
    ctx.currentTime = 52;
    live.wordsStarted(); // the next reply's stream, still "speaking"
    live.addEnvelope(0, [2000, 2000]); // its loudness before any word: nothing to follow yet, and no error
    feed(live, 52, 0.3, () => 0.001);
    expect(live.time()).toBe(-1);
    live.addWords(WORDS);
    feed(live, 52.3, 0.3, () => 0.2); // its voice: from 52.3 s
    ctx.currentTime = 52.32;
    expect(live.time()).toBeCloseTo(0.1, 5);
  });

  it("waits for both the words and the voice: no line, no mouth", () => {
    const live = new LiveSpeech(ctx);
    live.replyStarted();
    feed(live, 5, 0.3, () => 0.2);
    expect(live.playing).toBe(false); // the voice but no words yet
    expect(live.time()).toBe(-1);
    live.addWords(WORDS);
    expect(live.playing).toBe(true);
  });
});
