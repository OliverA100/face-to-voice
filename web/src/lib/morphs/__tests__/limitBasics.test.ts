import { describe, expect, it } from "vitest";

import type { SliderDef } from "@/lib/data";
import { plainStore } from "@/lib/morphs/limitBasics";
import { eyePivots, placePart } from "@/lib/morphs/limitPositions";

describe("plainStore (a face as plain weights, for the limiter)", () => {
  const defs: Pick<SliderDef, "target" | "combo" | "comboNeg">[] = [
    { target: "a" },
    { target: "mix", combo: { a: 0.5, b: 2 } }, // one-sided mix: reverses below zero
    { target: "two", combo: { a: 1 }, comboNeg: { b: 3 } }, // two-sided mix: its own weights below zero
  ];

  it("adds every mix slider's spread to a target's own value", () => {
    const store = plainStore({ a: 0.2, mix: 0.4, two: -0.5 }, defs);
    expect(store.userValue("a")).toBeCloseTo(0.2 + 0.4 * 0.5);
    expect(store.userValue("b")).toBeCloseTo(0.4 * 2 + 0.5 * 3);
    expect(plainStore({ mix: -1 }, defs).userValue("b")).toBeCloseTo(-2);
    expect(plainStore({}, defs).userValue("missing")).toBe(0);
  });

  it("hands the limiter each mix as the store does", () => {
    const store = plainStore({}, defs);
    expect(store.comboOf("two")).toEqual({ pos: { a: 1 }, neg: { b: 3 } });
    expect(store.comboOf("mix")).toEqual({ pos: { a: 0.5, b: 2 }, neg: null });
    expect(store.comboOf("a")).toBeUndefined();
  });
});

describe("limiter vertex positions (shared by the page and the caps worker)", () => {
  it("moves each eye pivot by its basis, or gives only the change", () => {
    const pivot = [[1, 2, 3], [4, 5, 6]];
    const basis: [string, number[]][][] = [[["s", [1, 0, 0]]], [["s", [0, 2, 0]], ["t", [0, 0, 1]]]];
    const weight = (t: string) => ({ s: 0.5, t: 2 })[t] ?? 0;
    expect(eyePivots(pivot, basis, weight, true)).toEqual([[1.5, 2, 3], [4, 6, 8]]);
    expect(eyePivots(pivot, basis, weight, false)).toEqual([[0.5, 0, 0], [0, 1, 2]]);
    expect(pivot).toEqual([[1, 2, 3], [4, 5, 6]]); // the rest pivots are not touched
  });

  it("places a part's vertices in head space at their slots, translation only at rest", () => {
    const m = Float32Array.from([2, 0, 0, 0, 0, 2, 0, 0, 0, 0, 2, 0, 10, 20, 30, 1]); // scale 2, then move (column-major)
    const s = Float32Array.from([1, 1, 1, 0, 0, -1]);
    const out = new Float32Array(9);
    placePart(Int32Array.from([2, 0]), m, [0.5, 0, 0], s, out, true);
    expect([...out]).toEqual([10.5, 20, 28, 0, 0, 0, 12.5, 22, 32]);
    placePart(Int32Array.from([2, 0]), m, [0.5, 0, 0], s, out, false); // a direction: no translation
    expect([...out]).toEqual([0.5, 0, -2, 0, 0, 0, 2.5, 2, 2]);
  });
});
