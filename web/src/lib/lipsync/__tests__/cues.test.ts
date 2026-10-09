import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { alignmentToCues, mergeAlignments, numberToWords, VISEME_IDS, type Alignment, type Cue } from "../cues";
import { audioClosureAt, closureSpan, placeLine, roundingAt, snapVowels, emptyActivations, LIPSYNC, smoothTowards, snapClosures, targetsAt, sealWeight, windowedLoudness } from "../evaluator";
import { wordToVisemes } from "../lipsync-en";
import { visemePreset } from "@/lib/data";

// Real ElevenLabs stream recorded by `uv run el-probe` (Flash v2.5, "Peter Piper picked a peck…").
const fixture = readFileSync(path.resolve(__dirname, "../../../../../pipeline/tests/fixtures/stream.ndjson"), "utf8");
const chunks = fixture.split("\n").filter(Boolean).map((l) => JSON.parse(l) as { alignment: Alignment | null; normalized_alignment: Alignment | null });
const alignment = mergeAlignments(chunks.map((c) => c.normalized_alignment ?? c.alignment).filter((a): a is Alignment => !!a));

describe("letter-to-viseme rules", () => {
  it("map plosive and vowel words to sensible visemes with character spans", () => {
    expect(wordToVisemes("Bob").map((v) => v.viseme)).toEqual(["PP", "aa", "PP"]);
    expect(wordToVisemes("peppers")[0]).toMatchObject({ viseme: "PP", charStart: 0, charEnd: 1 });
    const vs = wordToVisemes("through");
    expect(vs.map((v) => v.viseme)).toEqual(["TH", "RR", "U"]);
    expect(vs[0].charStart).toBe(0);
    expect(vs[2].charEnd).toBe(7);
  });
  it("make a 'w' with rounded lips, not the lower lip on the teeth (we, one, quick); f/v stay labiodental", () => {
    for (const w of ["we", "what", "window", "one", "quick", "language"]) expect(wordToVisemes(w).map((v) => v.viseme)).not.toContain("FF");
    expect(wordToVisemes("we")[0].viseme).toBe("U");
    for (const w of ["five", "of", "phone"]) expect(wordToVisemes(w).map((v) => v.viseme)).toContain("FF");
  });
  it("say numbers as words so the mouth moves for them", () => {
    expect(numberToWords("21")).toBe("twenty one");
    expect(numberToWords("1984")).toBe("nineteen eighty four");
    expect(numberToWords("2,000")).toBe("two thousand");
    expect(numberToWords("3rd")).toBe("third");
    const chars = [..."Test 1 2"];
    const cues = alignmentToCues({ characters: chars, character_start_times_seconds: chars.map((_, i) => i * 0.1), character_end_times_seconds: chars.map((_, i) => (i + 1) * 0.1) });
    expect(cues.filter((c) => c.start >= 0.45).length).toBeGreaterThan(2);
  });
  it("round the lips for 'u' after t/s/r/d/l/z/n/j (blue, rule, true, June), keep 'y+oo' elsewhere (music, few)", () => {
    for (const w of ["blue", "rule", "true", "June", "flute"]) expect(wordToVisemes(w).map((v) => v.viseme)).toContain("U");
    for (const w of ["blue", "rule", "true", "June", "flute"]) expect(wordToVisemes(w).map((v) => v.viseme)).not.toContain("I");
    expect(wordToVisemes("music").map((v) => v.viseme).slice(0, 3)).toEqual(["PP", "I", "U"]);
  });
});

describe("cues from the recorded stream", () => {
  const cues = alignmentToCues(alignment);
  const clipEnd = Math.max(...alignment.character_end_times_seconds);

  it("produces a dense, ordered, in-range cue list", () => {
    expect(cues.length).toBeGreaterThan(30);
    for (let i = 1; i < cues.length; i++) expect(cues[i].start).toBeGreaterThanOrEqual(cues[i - 1].start - 1e-6);
    for (const c of cues) {
      expect(VISEME_IDS).toContain(c.viseme);
      expect(c.start).toBeGreaterThanOrEqual(0);
      expect(c.end).toBeLessThanOrEqual(clipEnd + 0.1);
      if (c.viseme !== "PP" && c.viseme !== "DD") expect(c.end - c.start).toBeGreaterThanOrEqual(0.08 - 1e-6);
    }
  });

  it("starts 'Peter' with a lip closure that releases right at the burst", () => {
    expect(cues[0].viseme).toBe("PP");
    expect(cues[0].start).toBeLessThan(0.02);
    expect(cues[0].end).toBeLessThan(0.1); // not held through the vowel
  });

  it("puts a closure on every 'b'/'p' word onset (Bob, bought, big, blue, bat, before, breakfast)", () => {
    const chars = alignment.characters;
    const text = chars.join("");
    for (const word of ["Bob", "bought", "big", "blue", "bat", "before", "breakfast"]) {
      const idx = text.indexOf(word);
      const onset = alignment.character_start_times_seconds[idx];
      const hit = cues.find((c) => c.viseme === "PP" && Math.abs(c.start - (onset - 0.06)) < 0.03 && Math.abs(c.end - (onset + 0.02)) < 0.03);
      expect(hit, word).toBeTruthy();
    }
  });
});

describe("evaluator", () => {
  it("anticipates onsets, lets closures dominate vowels and caps the group", () => {
    const cues = [
      { viseme: "aa" as const, start: 0.5, end: 0.9, text: "a" },
      { viseme: "PP" as const, start: 0.8, end: 0.95, text: "p" },
    ];
    const out = emptyActivations();
    targetsAt(cues, 0.46, out); // 40 ms before the vowel: ramping in
    expect(out.aa).toBeGreaterThan(0);
    expect(out.aa).toBeLessThan(0.9);
    targetsAt(cues, 0.7, out); // a long vowel reaches full strength
    expect(out.aa).toBeCloseTo(1, 5);
    targetsAt(cues, 0.85, out); // closure overlapping the vowel
    expect(out.PP).toBeCloseTo(LIPSYNC.peak.PP, 5);
    expect(out.aa).toBeLessThan(0.1);
    expect(VISEME_IDS.reduce((s, v) => s + out[v], 0)).toBeLessThanOrEqual(LIPSYNC.maxGroupSum + 1e-9);
  });

  it("smoothing is frame-rate independent", () => {
    const target = emptyActivations();
    target.aa = 1;
    const slow = emptyActivations();
    const fast = emptyActivations();
    smoothTowards(slow, target, 0.1);
    for (let i = 0; i < 10; i++) smoothTowards(fast, target, 0.01);
    expect(Math.abs(slow.aa - fast.aa)).toBeLessThan(0.02);
  });
});

describe("presets", () => {
  it("every viseme the cue engine emits has weights in visemes.json (keys are lowercase there)", () => {
    for (const v of VISEME_IDS) expect(Object.keys(visemePreset(v)).length, v).toBeGreaterThan(0);
  });
});

describe("sealWeight", () => {
  it("suppresses the open shapes only once a closure has formed", () => {
    const act = emptyActivations();
    act.aa = 0.5;
    expect(sealWeight(act)).toBe(1);
    act.PP = 0.45;
    expect(sealWeight(act)).toBeCloseTo(0.5, 1);
    act.PP = 0.9;
    expect(sealWeight(act)).toBe(0);
  });
});

describe("windowedLoudness", () => {
  it("averages the blocks around t without shifting them", () => {
    const step = (t: number) => (t >= 0.495 ? 1 : 0);
    expect(windowedLoudness(step, 0.5, 0)).toBe(1); // width 0 = the single block
    expect(windowedLoudness(step, 0.5, 0.06)).toBeCloseTo(4 / 7, 5); // 7 blocks, 4 at or after the step
    expect(windowedLoudness(step, 0.4, 0.06)).toBe(0);
  });
});

describe("audio tags in the alignment", () => {
  it("are dropped before the cues are built (v4 returns the tag's characters)", async () => {
    const { stripTags, alignmentToCues } = await import("../cues");
    const text = "[happy] Hi Bob";
    const chars = [...text];
    const a = { characters: chars, character_start_times_seconds: chars.map((_, i) => i * 0.05), character_end_times_seconds: chars.map((_, i) => (i + 1) * 0.05) };
    const s = stripTags(a);
    expect(s.characters.join("")).toBe("Hi Bob");
    expect(s.character_start_times_seconds[0]).toBeCloseTo(0.4); // "H" keeps its own time
    const plain = "Hi Bob";
    const b = { characters: [...plain], character_start_times_seconds: [...plain].map((_, i) => (i + 8) * 0.05), character_end_times_seconds: [...plain].map((_, i) => (i + 9) * 0.05) };
    expect(alignmentToCues(a)).toEqual(alignmentToCues(b));
  });
});

describe("closures from the audio", () => {
  // vowel, a 60 ms closure (quiet from 0.50 to 0.56), the burst at 0.56, vowel again
  const loud = (t: number) => (t >= 0.495 && t < 0.555 ? 0.01 : 0.8);
  it("span the quiet stretch: lips shut where the sound drops, part at the burst", () => {
    const span = closureSpan(loud, 0.53)!;
    expect(span[0]).toBeCloseTo(0.5, 2);
    expect(span[1]).toBeCloseTo(0.56, 2);
    expect(closureSpan(() => 0.5, 0.53)).toBeNull(); // no dip: not trusted
  });
  it("move a p cue onto the closure and let it past the closure gate only up to the burst", () => {
    const cues = [{ viseme: "PP" as const, start: 0.46, end: 0.54, text: "p" }];
    snapClosures(cues, loud, 2, new WeakSet());
    expect(cues[0].end).toBeCloseTo(0.56 - LIPSYNC.closureOffShift, 2);
    expect(cues[0].end - cues[0].start).toBeGreaterThanOrEqual(LIPSYNC.closureMinDur - 1e-9);
    expect(audioClosureAt(cues, 0.52, loud)).toBe(1);
    expect(audioClosureAt(cues, cues[0].end + 0.01, loud)).toBe(0);
  });
  it("let an f/v span its whole hiss, back to the vowel before it", () => {
    // vowel until 0.30, a 170 ms hiss (quieter, not silent), vowel again from 0.47
    const hiss = (t: number) => (t >= 0.295 && t < 0.465 ? 0.06 : 0.8);
    const cues = [{ viseme: "FF" as const, start: 0.42, end: 0.5, text: "f" }]; // stamped at the hiss's tail
    snapClosures(cues, hiss, 2, new WeakSet());
    expect(cues[0].start).toBeLessThanOrEqual(0.3);
    expect(cues[0].end).toBeCloseTo(0.47 - LIPSYNC.closureOffShift, 2);
  });
  it("never put two closures on the same dip", () => {
    const cues = [{ viseme: "PP" as const, start: 0.46, end: 0.54, text: "b" }, { viseme: "PP" as const, start: 0.48, end: 0.56, text: "b" }];
    snapClosures(cues, loud, 2, new WeakSet());
    expect(Math.abs(cues[0].start - cues[1].start)).toBeGreaterThan(0.03);
  });
});

describe("vowels from the audio", () => {
  // two syllables: loud peaks at 0.40 and 0.70, quiet between
  const loud = (t: number) => Math.max(0.02, Math.exp(-(((t - 0.4) / 0.05) ** 2)), Math.exp(-(((t - 0.7) / 0.05) ** 2)));
  it("centre each vowel on its own syllable's peak, one vowel per peak", () => {
    const cues = [
      { viseme: "aa" as const, start: 0.42, end: 0.5, text: "a" }, // stamped 60 ms late
      { viseme: "E" as const, start: 0.54, end: 0.62, text: "e" }, // stamped 120 ms early
    ];
    snapVowels(cues, loud, 2, new WeakSet());
    expect((cues[0].start + cues[0].end) / 2).toBeCloseTo(0.4 + LIPSYNC.vowelShift, 2);
    expect((cues[1].start + cues[1].end) / 2).toBeCloseTo(0.7 + LIPSYNC.vowelShift, 2);
  });
});

describe("placing the line on the voice", () => {
  it("moves the first word to where the voice starts, fading out over the line", () => {
    // stamps start at 0.16 (a silent tag took 0–0.16), the voice starts at 0.06
    const voice = (t: number) => (t >= 0.06 && t < 1.8 ? 0.6 : 0.0);
    const chars = [..."Test hello again"];
    const a = { characters: chars, character_start_times_seconds: chars.map((_, i) => 0.16 + i * 0.1), character_end_times_seconds: chars.map((_, i) => 0.26 + i * 0.1) };
    const cues = alignmentToCues(a);
    const firstBefore = cues[0].start;
    placeLine(cues, voice, 3);
    expect(cues[0].start).toBeCloseTo(Math.max(0, firstBefore - 0.1), 2);
    const last = cues.filter((c) => c.ws! >= 0.16 + 1.5)[0];
    if (last) expect(last.start).toBeGreaterThan(1.6); // beyond lineFade: unmoved
  });
});

describe("word shapes", () => {
  it("give an 'h' the next vowel's shape, never a spread 'ee' of its own (honestly, hello, have)", () => {
    const honestly = wordToVisemes("honestly");
    expect(honestly[0]).toMatchObject({ viseme: "O", charStart: 0 });
    expect(honestly.filter((v) => v.charStart === 0).map((v) => v.viseme)).not.toContain("I");
    expect(wordToVisemes("hello")[0]).toMatchObject({ viseme: "E", charStart: 0 });
    expect(wordToVisemes("have")[0].viseme).toBe("aa");
    const chars = [..."Honestly"];
    const a = { characters: chars, character_start_times_seconds: chars.map((_, i) => (i ? 0.3 + i * 0.035 : 0)), character_end_times_seconds: chars.map((_, i) => 0.335 + i * 0.035) };
    const first = alignmentToCues(a)[0];
    expect(first).toMatchObject({ viseme: "O", start: 0, text: "Ho" }); // the h's silent lead is the "o", not an "ee"
  });
  it("make unstressed vowels weak (a, the, of, -ably) and keep stressed ones full", () => {
    const chars = [..."a probably"];
    const a = { characters: chars, character_start_times_seconds: chars.map((_, i) => i * 0.06), character_end_times_seconds: chars.map((_, i) => (i + 1) * 0.06) };
    const cues = alignmentToCues(a);
    expect(cues.find((c) => c.text === "a")?.weak).toBe(true);
    expect(cues.find((c) => c.text === "o")?.weak).toBeUndefined();
    expect(cues.filter((c) => c.text === "ably" && c.viseme === "aa").every((c) => c.weak)).toBe(true);
    for (const w of ["the", "of", "an", "possibly"]) expect(wordToVisemes(w).map((v) => v.viseme)).toContain("AX");
    const out = targetsAt([{ viseme: "aa", start: 0, end: 0.3, text: "a", weak: true }], 0.15, emptyActivations());
    expect(out.aa).toBeCloseTo(LIPSYNC.weakPeak, 5);
  });
  it("leave an 'r' where it is stamped: it is not a syllable, so it takes no vowel's peak", () => {
    const chars = [..."pro"];
    const a = { characters: chars, character_start_times_seconds: [0, 0.05, 0.1], character_end_times_seconds: [0.05, 0.1, 0.15] };
    const cues = alignmentToCues(a);
    const r = cues.find((c) => c.text === "r")!;
    expect(r.glide).toBe(true);
    const at = r.start;
    snapVowels(cues, (t) => Math.max(0.02, Math.exp(-(((t - 0.12) / 0.03) ** 2))), Infinity, new WeakSet());
    expect(r.start).toBe(at);
  });
  it("keep 'probably' in order: o between p and b, each b on its own dip, the lips open between the b's", () => {
    // p closure .10–.16 (burst .16), "r" quieter to .28 with a small dip at .28, "o" .29–.35, b .36–.40 (voiced, not silent),
    // a schwa .41–.45, b .46–.51, "ly" .52–.70
    const loud = (t: number) => {
      const x = Math.round(t * 100) / 100;
      if (x >= 0.1 && x < 0.16) return 0.005;
      if (x < 0.1) return 0.6;
      if (x < 0.28) return 0.1;
      if (x < 0.29) return 0.04;
      if (x < 0.36) return 0.8;
      if (x < 0.41) return 0.15;
      if (x < 0.46) return 0.5;
      if (x < 0.52) return 0.08;
      return 0.6;
    };
    const cue = (viseme: Cue["viseme"], start: number, text: string, n: number, extra: Partial<Cue> = {}): Cue => ({ viseme, start, end: start + 0.08, text, n, ...extra });
    // stamped evenly, as eleven_v4_turbo does: the first b lands on the "r" dip
    const cues = [cue("PP", 0.09, "p", 0), cue("U", 0.18, "r", 1, { glide: true }), cue("aa", 0.23, "o", 2), cue("PP", 0.25, "b", 3), cue("aa", 0.31, "a", 4, { weak: true }), cue("PP", 0.37, "b", 5), cue("I", 0.45, "y", 6)];
    const snapped = new WeakSet<Cue>();
    snapClosures(cues, loud, Infinity, snapped);
    snapVowels(cues, loud, Infinity, snapped);
    const [p, , o, b1, schwa, b2] = [0, 1, 2, 3, 4, 5].map((n) => cues.find((c) => c.n === n)!);
    expect(p.end).toBeLessThan(0.16);
    expect(b1.start).toBeGreaterThan(0.3); // not on the "r"
    expect(b1.end).toBeCloseTo(0.41 - LIPSYNC.closureOffShift, 2);
    const oc = (o.start + o.end) / 2, sc = (schwa.start + schwa.end) / 2;
    expect(oc).toBeGreaterThan(p.end);
    expect(oc).toBeLessThan(b1.start + LIPSYNC.closureOnShift);
    expect(sc).toBeGreaterThan(b1.end);
    expect(b2.start - b1.end).toBeGreaterThanOrEqual(Math.min(LIPSYNC.closureGapMin, b2.end - LIPSYNC.closureKeep - b1.end) - 1e-9);
  });
});

describe("m closures and rounding", () => {
  it("mark an 'm' closure nasal and a 'w' or 'r' as a glide; only real oo/oh round a closure", () => {
    const chars = [..."we make muffins"];
    const a = { characters: chars, character_start_times_seconds: chars.map((_, i) => i * 0.05), character_end_times_seconds: chars.map((_, i) => (i + 1) * 0.05) };
    const cues = alignmentToCues(a);
    expect(cues.find((c) => c.text === "w")?.glide).toBe(true);
    expect(cues.filter((c) => c.viseme === "PP").every((c) => c.nasal)).toBe(true);
    const m = cues.find((c) => c.text === "m" && c.start > 0.1)!;
    expect(roundingAt(cues, m.start)).toBe(0); // "we" no longer puckers the m of "make"
    const blue: Cue[] = [{ viseme: "PP", start: 0, end: 0.06, text: "b" }, { viseme: "U", start: 0.08, end: 0.2, text: "ue" }];
    expect(roundingAt(blue, 0.03)).toBe(1); // "blue" still does
    expect(roundingAt([{ viseme: "U", start: 0.08, end: 0.2, text: "r", glide: true }], 0.03)).toBe(0);
  });
  it("find an 'm' in the treble when its hum keeps the loudness up", () => {
    // vowel, m (hum: as loud, but no treble) .40–.47, vowel
    const loud = () => 0.7;
    const treble = (t: number) => (t >= 0.395 && t < 0.465 ? 0.02 : 0.6);
    const cues: Cue[] = [{ viseme: "PP", start: 0.36, end: 0.44, text: "m", nasal: true }];
    snapClosures(cues, loud, Infinity, new WeakSet(), treble);
    expect(cues[0].end).toBeCloseTo(0.47 - LIPSYNC.closureOffShift, 2);
    expect(audioClosureAt(cues, 0.43, loud, "PP", treble)).toBeGreaterThan(0.9); // past the closure gate, the hum is loud
    const plain: Cue[] = [{ viseme: "PP", start: 0.36, end: 0.44, text: "m", nasal: true }];
    snapClosures(plain, loud, Infinity, new WeakSet()); // no treble: no dip, so not anchored
    expect(audioClosureAt(plain, 0.43, loud)).toBe(0);
  });
  it("keep the lips shut through the silence and the hum of an 'm' that starts the line", () => {
    // silence to .03, hum (no treble) .03–.09, vowel from .10
    const loud = (t: number) => (t < 0.03 ? 0.001 : 0.6);
    const treble = (t: number) => (t < 0.03 ? 0.001 : t < 0.095 ? 0.05 : 0.6);
    const span = closureSpan(treble, 0.01, LIPSYNC.closureSearch, true)!;
    expect(span[0]).toBeLessThanOrEqual(0.01);
    expect(span[1]).toBeGreaterThanOrEqual(0.09);
    expect(span[1]).toBeLessThanOrEqual(0.11);
    expect(closureSpan(loud, 0.01, LIPSYNC.closureSearch, false)).toBeNull(); // the old rule had nothing to hold on to
  });
});

