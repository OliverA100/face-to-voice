import { describe, expect, it } from "vitest";

import { HeardLine } from "../heard";

describe("the chat's \"You:\" line", () => {
  it("keeps everything said since the character last spoke, across pauses, with a capital", () => {
    const h = new HeardLine();
    h.add("a", "well i was thinking", true);
    h.add("b", "maybe we could go fishing", true);
    expect(h.text).toBe("Well i was thinking maybe we could go fishing");
  });

  it("shows each turn once though it comes final twice, formatted and plain", () => {
    const h = new HeardLine();
    h.add("a", "Yeah, I am.", true);
    h.add("b", "yeah i am", true);
    expect(h.text).toBe("Yeah, I am.");
    h.add("c", "What about it?", true);
    h.add("d", "what about it", true);
    expect(h.text).toBe("Yeah, I am. What about it?");
  });

  it("never drops the start for a shorter repeat, and lets a fuller version replace a shorter one", () => {
    const h = new HeardLine();
    h.add("a", "Good from afar. So I thought I'd come say hello.", true);
    h.add("b", "hello", true); // only repeats words already shown
    expect(h.text).toBe("Good from afar. So I thought I'd come say hello.");
    const g = new HeardLine();
    g.add("a", "so i thought", true);
    g.add("b", "So I thought I'd come say hello.", true);
    expect(g.text).toBe("So I thought I'd come say hello.");
  });

  it("compares whole words, adds the draft being spoken, and starts again when the character speaks", () => {
    const h = new HeardLine();
    h.add("a", "I know", true);
    h.add("b", "no", true);
    expect(h.text).toBe("I know no");
    h.add("c", "and then", false);
    expect(h.text).toBe("I know no and then");
    h.clear();
    expect(h.text).toBe("");
  });
});
