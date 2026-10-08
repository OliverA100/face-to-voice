import { describe, expect, it } from "vitest";

import { quantiseFace } from "@/lib/voice/faceSignature";

describe("face signature (what makes two faces the same face for the voice)", () => {
  it("rounds sliders to the step, drops the ones near rest, and sorts by name", () => {
    const [sliders, look] = quantiseFace({ b: 0.26, a: 0.01, c: -0.124 }, { hair: "bob", eyes: "blue" });
    expect(sliders).toEqual([["b", 5 * 0.05], ["c", -2 * 0.05]]); // a: under half a step, so not part of the face
    expect(look).toEqual([["eyes", "blue"], ["hair", "bob"]]);
  });

  it("ignores tiny drags and the order values were set in", () => {
    const sig = (w: Record<string, number>, l?: Record<string, string>) => JSON.stringify(quantiseFace(w, l));
    expect(sig({ jaw: 0.26, nose: -0.5 })).toBe(sig({ nose: -0.51, jaw: 0.27 }));
    expect(sig({ jaw: 0.26 })).not.toBe(sig({ jaw: 0.31 }));
    expect(sig({ jaw: 0.26 }, { hair: "bob" })).not.toBe(sig({ jaw: 0.26 }, { hair: "bun" }));
    expect(quantiseFace({})).toEqual([[], []]);
  });
});
