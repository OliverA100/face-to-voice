import { describe, expect, it } from "vitest";

import { KEEP_TURNS, Turns } from "../turns";

const said = (t: Turns) => t.value.map((x) => `${x.who}: ${x.text}`);

describe("the chat card's turns", () => {
  it("grows a reply as it is heard, and your line as you speak, in the order they were said", () => {
    const t = new Turns();
    t.character("r1", "Oh! Hello");
    t.character("r1", "Oh! Hello there.");
    t.you("Hi");
    t.you("Hi, what are you up to?");
    t.closeYou(); // the character answers
    t.character("r2", "Mending nets.");
    t.you("Nice");
    expect(said(t)).toEqual(["character: Oh! Hello there.", "you: Hi, what are you up to?", "character: Mending nets.", "you: Nice"]);
  });

  it("starts a new turn of yours only after the character has spoken", () => {
    const t = new Turns();
    t.you("Hello");
    t.you("Hello?");
    expect(said(t)).toEqual(["you: Hello?"]);
    t.closeYou();
    t.you("Anyone there?");
    expect(said(t)).toEqual(["you: Hello?", "you: Anyone there?"]);
  });

  it(`keeps only the last ${KEEP_TURNS} turns, and the snapshot is a copy`, () => {
    const t = new Turns();
    for (let i = 0; i < KEEP_TURNS + 3; i++) {
      t.character(`r${i}`, `Reply ${i}.`);
      t.you(`Answer ${i}`);
      t.closeYou();
    }
    const v = t.value;
    expect(v).toHaveLength(KEEP_TURNS);
    expect(v.at(-1)).toMatchObject({ who: "you", text: `Answer ${KEEP_TURNS + 2}` });
    v[0].text = "changed";
    expect(t.value[0].text).not.toBe("changed");
  });
});
