import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { phonemesFor } from "@/lib/server/pronounce";

import { alignmentToCues, FOLD, wordShapes } from "../cues";
import { GET } from "@/app/api/phonemes/route";

import { addPhonemes, PHONEMES, phonemesOf, phonemesToVisemes, requestPhonemes, spokenWords } from "../phonemes";

const shapes = (word: string) => wordShapes(word).map((v) => FOLD[v.viseme] + (v.viseme === "AX" ? "~" : ""));
const timed = (text: string) => {
  const chars = [...text];
  return { characters: chars, character_start_times_seconds: chars.map((_, i) => i * 0.06), character_end_times_seconds: chars.map((_, i) => (i + 1) * 0.06) };
};

afterEach(() => {
  PHONEMES.enabled = true;
});

describe("phonemes", () => {
  it("shape words as they are said: diphthongs end on their glide, an h takes its vowel, a schwa is weak", () => {
    expect(phonemesToVisemes("maybe", ["M", "EY1", "B", "IY0"]).map((v) => v.viseme)).toEqual(["PP", "E", "I", "PP", "I"]);
    expect(phonemesToVisemes("who", ["HH", "UW1"]).map((v) => v.viseme)).toEqual(["U", "U"]);
    expect(phonemesToVisemes("water", ["W", "AO1", "T", "ER0"]).map((v) => v.viseme)).toEqual(["U", "O", "DD", "AX"]);
    // shares of the word in spoken order, covering it exactly
    const v = phonemesToVisemes("five", ["F", "AY1", "V"]);
    expect(v[0].from).toBe(0);
    expect(v.at(-1)!.to).toBeCloseTo(1, 9);
    for (let k = 1; k < v.length; k++) expect(v[k].from).toBeCloseTo(v[k - 1].to, 9);
  });

  it("replace the letter rules for the words a line brings, and leave the rest (and ?lipsync=v1) to them", () => {
    addPhonemes({ maybe: "M EY1 B IY0", all: "AO1 L" });
    expect(shapes("maybe")).toEqual(["PP", "E", "I", "PP", "I"]); // the letters said "PP E PP": no "ee" after the b
    expect(shapes("all")).toEqual(["O", "DD"]); // rounded, not a wide "aa"
    PHONEMES.enabled = false;
    expect(shapes("all")).toEqual(["aa", "DD"]);
    PHONEMES.enabled = true;
    expect(shapes("aoife")).toEqual(wordShapes("aoife").map((v) => FOLD[v.viseme])); // not in the dictionary: letters
  });

  it("flag an m as nasal and r/w/y as glides from the phoneme, not the spelling", () => {
    addPhonemes({ comb: "K OW1 M", write: "R AY1 T" });
    const comb = alignmentToCues(timed("comb"));
    expect(comb.filter((c) => c.viseme === "PP").map((c) => c.nasal)).toEqual([true]); // the b is silent: one closure, an m
    const write = alignmentToCues(timed("write"));
    expect(write[0].glide).toBe(true);
    expect(write[0].viseme).toBe("U");
  });

  it("mark an l (from its phoneme or its letters) so the tongue tip shows, and not a t, d or n", () => {
    addPhonemes({ little: "L IH1 T AH0 L" });
    const little = alignmentToCues(timed("little")).filter((c) => c.viseme === "DD");
    expect(little.map((c) => !!c.lateral)).toEqual([true, false, true]);
    PHONEMES.enabled = false;
    expect(alignmentToCues(timed("lid")).filter((c) => c.viseme === "DD").map((c) => !!c.lateral)).toEqual([true, false]);
  });

  it("are sent per line: the words as said, numbers spelled out, audio tags left out", () => {
    expect(spokenWords("[happy] Hello, 42 worlds!")).toEqual(["hello", "forty", "two", "worlds"]);
    const p = phonemesFor("[happy] Hello, 42 worlds!");
    expect(Object.keys(p).sort()).toEqual(["forty", "hello", "two", "worlds"]);
    expect(p.hello).toBe("HH AH0 L OW1");
    expect(p.happy).toBeUndefined();
  });
});

describe("live words' phonemes", () => {
  it("are looked up once each, from the dictionary route, and kept", async () => {
    const calls: string[] = [];
    vi.stubGlobal("fetch", async (url: string) => {
      calls.push(url);
      return GET(new Request("https://face.example" + url));
    });
    expect(await requestPhonemes(["quixotic", "zephyr", "notaword"])).toBe(true);
    expect(phonemesOf("quixotic")).toEqual(["K W IH0 K S AA1 T IH0 K"].join(" ").split(" "));
    expect(await requestPhonemes(["quixotic", "notaword"])).toBe(false); // asked already: no second request
    expect(calls).toHaveLength(1);
    vi.unstubAllGlobals();
  });

  it("the route answers only plain lower-case words, a bounded number of them, cacheable", async () => {
    const res = await GET(new Request("https://face.example/api/phonemes?w=hello,<script>,WORLD,world"));
    expect(res.headers.get("cache-control")).toContain("immutable");
    expect(Object.keys((await res.json()).phonemes).sort()).toEqual(["hello", "world"]);
  });
});
