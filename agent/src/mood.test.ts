import { describe, expect, it } from "vitest";

import { audioTag, MoodTag } from "./mood.ts";

const KNOWN = new Set(["neutral", "happy", "sad", "angry"]);
const TAGS = { happy: ["cheerful", "happy, bright and bouncy", "overjoyed"] as [string, string, string] };

/** Feed `pieces` through a MoodTag; the text passed on and the mood found. */
function run(pieces: string[]) {
  const m = new MoodTag(KNOWN);
  const text = pieces.map((p) => m.push(p)).join("") + m.flush();
  return { text, mood: m.mood };
}

describe("the mood tag at the start of a reply", () => {
  it("is taken off the front, whole or split across pieces", () => {
    expect(run(["[happy 2] Oh, now that's a story!"])).toEqual({ text: "Oh, now that's a story!", mood: { emotion: "happy", strength: 2 } });
    expect(run(["[ha", "ppy", " 3]", " Ha!"])).toEqual({ text: "Ha!", mood: { emotion: "happy", strength: 3 } });
    expect(run(["[sad] Oh."])).toEqual({ text: "Oh.", mood: { emotion: "sad", strength: 2 } }); // no strength: clear
    expect(run(["[neutral 3] Fine."])).toEqual({ text: "Fine.", mood: { emotion: "neutral", strength: 0 } });
  });

  it("passes a reply without a tag through untouched, without waiting for the end", () => {
    const m = new MoodTag(KNOWN);
    expect(m.push("Well now")).toBe("Well now");
    expect(m.push(", hello.")).toBe(", hello.");
    expect(m.mood).toBeNull();
  });

  it("ignores an unknown mood and drops every other bracket, even one split across pieces", () => {
    expect(run(["[ecstatic 2] Hi."])).toEqual({ text: "Hi.", mood: null });
    expect(run(["[happy 1] I [whis", "pers] know a secret [laughs]."])).toEqual({ text: "I  know a secret .", mood: { emotion: "happy", strength: 1 } });
  });

  it("becomes the v4 audio tag from the server's table", () => {
    expect(audioTag({ emotion: "happy", strength: 1 }, TAGS)).toBe("[cheerful] ");
    expect(audioTag({ emotion: "neutral", strength: 0 }, TAGS)).toBe("");
    expect(audioTag(null, TAGS)).toBe("");
  });
});
