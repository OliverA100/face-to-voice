import { describe, expect, it } from "vitest";

import { type DialogueMessage, newTimeline, recordMessage, timeWord } from "./elevenTimings.ts";

const RATE = 1000; // samples per second: 0.1 s of audio is 100 samples
const audio = (seconds: number) => Buffer.alloc(Math.round(seconds * RATE) * 2).toString("base64");
const chars = (text: string, starts: number[], durations: number[]): DialogueMessage["alignment"] => ({ chars: [...text], char_start_times_ms: starts, char_durations_ms: durations });

describe("character times from ElevenLabs' dialogue socket", () => {
  it("follow on from the last message's last character, never after their own audio, a turn starting with its sound", () => {
    const t = newTimeline();
    const feed = (m: DialogueMessage) => recordMessage(t, m, RATE);
    feed({ audio: audio(0.1) }); // silence before the turn
    feed({ alignment: chars("ab", [0, 300], [100, 600]), audio: audio(0.5) }); // the turn starts with its sound: 0.1 s
    feed({ alignment: chars("c", [0], [100]), audio: audio(0.5) }); // its own audio starts at 0.6 s, before 1.0 s
    feed({ alignment: chars("d", [0], [200]), audio: audio(0.5) }); // follows on from "c" (0.7 s), before its audio
    feed({ is_final_audio_for_turn: true, audio: audio(0.2) }); // a pause
    feed({ alignment: chars("e", [50], [100]), audio: audio(0.3) }); // the next turn: from its sound (1.8 s)
    expect(t.starts.map((s) => +s.toFixed(3))).toEqual([0.1, 0.4, 0.6, 0.7, 1.85]);
    expect(t.ends.map((s) => +s.toFixed(3))).toEqual([0.2, 1.0, 0.7, 0.9, 1.95]);
  });

  it("never puts a character before the one before it", () => {
    const t = newTimeline();
    recordMessage(t, { alignment: chars("ab", [0, 400], [100, 100]), audio: audio(0.2) }, RATE);
    recordMessage(t, { alignment: chars("c", [0], [100]), audio: audio(0.2) }, RATE); // own audio at 0.2 s, "b" at 0.4 s
    expect(t.starts).toEqual([0, 0.4, 0.4]);
  });
});

describe("words from the characters", () => {
  /** A timeline whose characters are `text`, one every 0.1 s, each lasting 0.1 s. */
  const timeline = (text: string) => {
    const t = newTimeline();
    recordMessage(t, { alignment: chars(text, [...text].map((_, i) => i * 100), [...text].map(() => 100)) }, RATE);
    return t;
  };
  const times = (t: ReturnType<typeof newTimeline>, words: string[]) => words.map((w) => timeWord(t, w)?.map((x) => +x.toFixed(2)) ?? null);

  it("run from a word's first letter to its last, punctuation and spaces aside", () => {
    expect(times(timeline("Hey there, you."), ["Hey ", "there, ", "you."])).toEqual([[0, 0.3], [0.4, 0.9], [1.1, 1.4]]);
  });

  it("stay in step when the characters differ from the text (a curly quote, a dropped dash, an added tag)", () => {
    // the text's curly apostrophe is straight in the characters, and its dash isn't spoken
    expect(times(timeline("I've seen it"), ["I’ve ", "— ", "seen ", "it"])).toEqual([[0, 0.4], null, [0.5, 0.9], [1.0, 1.2]]);
    // the characters start with an audio tag the text doesn't have
    expect(times(timeline("[calm] Hi there"), ["Hi ", "there"])).toEqual([[0.7, 0.9], [1.0, 1.5]]);
  });

  it("take each repeated word in turn", () => {
    expect(times(timeline("no no no"), ["no ", "no ", "no"])).toEqual([[0, 0.2], [0.3, 0.5], [0.6, 0.8]]);
  });

  it("wait for characters that haven't come yet", () => {
    expect(times(timeline("Hi"), ["Hi ", "there"])).toEqual([[0, 0.2], null]);
  });
});
