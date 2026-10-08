import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { sliders, type SliderDef } from "@/lib/data";
import { canVary, clearRandomFace, RANDOM, randomFace, randomState, strikingFeatures, VARIATION, variationNotches, varyFace } from "@/lib/morphs/random";

// The limiter is not loaded here, so it answers as it does before the head loads: no limits. These tests cover what
// Random face does on its own: the draw, Distinctiveness and edits made by hand.
const defs = sliders.sliders;
const def = (t: string) => defs.find((d) => d.target === t)!;
const isFeature = (d: SliderDef) => d.kind === "semantic" && !d.combo && d.group !== "sem_age";

/** A seeded Math.random (mulberry32), so every draw is the same on every run. */
function seeded(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

beforeEach(() => {
  vi.spyOn(Math, "random").mockImplementation(seeded(7));
  clearRandomFace();
});
afterEach(() => vi.restoreAllMocks());

describe("Distinctiveness notches", () => {
  it("lists every value the slider can stop at, nearest first", () => {
    const notches = variationNotches(1);
    expect(notches).toHaveLength(Math.round(VARIATION.max / VARIATION.notch) + 1);
    expect(notches[0]).toBe(1);
    expect(notches).toContain(0);
    expect(notches).toContain(VARIATION.max);
    for (let i = 1; i < notches.length; i++) expect(Math.abs(notches[i] - 1)).toBeGreaterThanOrEqual(Math.abs(notches[i - 1] - 1));
  });
});

describe("random face", () => {
  it("draws a face within every slider's range, leaving age, expression and pose at rest", () => {
    const face = randomFace(defs, 1);
    for (const [t, v] of Object.entries(face)) {
      const d = def(t);
      expect(v).toBeGreaterThanOrEqual(d.min);
      expect(v).toBeLessThanOrEqual(d.max);
      if (d.kind === "expression" || t === "sem_age") expect(v).toBe(d.default);
    }
    expect(defs.filter((d) => d.kind === "pose" || d.kind === "control").some((d) => d.target in face)).toBe(false);
    expect(defs.filter((d) => d.kind === "identity").some((d) => Math.abs(face[d.target]) > 0.01)).toBe(true);
  });

  it("picks 2–4 striking Feature sliders from different areas", () => {
    randomFace(defs, 1);
    const picked = strikingFeatures().map(def);
    expect(picked.length).toBeGreaterThanOrEqual(RANDOM.striking[0]);
    expect(picked.length).toBeLessThanOrEqual(RANDOM.striking[1]);
    expect(picked.every(isFeature)).toBe(true);
    expect(new Set(picked.map((d) => d.group)).size).toBe(picked.length);
  });

  it("is the same face for the same draw", () => {
    const a = randomFace(defs, 1);
    vi.spyOn(Math, "random").mockImplementation(seeded(7));
    expect(randomFace(defs, 1)).toEqual(a);
  });
});

describe("Distinctiveness", () => {
  it("at 0 is the average face", () => {
    const face = randomFace(defs, 1);
    const out = varyFace(defs, 0, face)!;
    expect(Object.keys(out).length).toBeGreaterThan(0);
    for (const [t, v] of Object.entries(out)) expect(v).toBeCloseTo(def(t).default, 12);
  });

  it("above 1 moves only the striking features, each strikingReach of the way to one of its ends", () => {
    const face = randomFace(defs, 1);
    const out = varyFace(defs, VARIATION.max, face)!;
    const striking = new Set(strikingFeatures());
    for (const t of striking) {
      const { min, max } = def(t);
      const toward = (end: number) => face[t] + RANDOM.strikingReach * (end - face[t]);
      expect([toward(min), toward(max)].some((w) => Math.abs(out[t] - w) < 1e-9)).toBe(true);
    }
    for (const [t, v] of Object.entries(out)) if (!striking.has(t)) expect(v).toBeCloseTo(face[t], 12);
    expect(randomState.lastFit.striking.map((s) => s.target)).toEqual([...striking]);
  });

  it("keeps a change made by hand since the draw", () => {
    const face = randomFace(defs, 1);
    const t = defs.find((d) => isFeature(d) && !strikingFeatures().includes(d.target))!.target;
    const step = face[t] + 0.1 <= def(t).max ? 0.1 : -0.1;
    const out = varyFace(defs, 1, { ...face, [t]: face[t] + step })!;
    expect(out[t]).toBeCloseTo(face[t] + step, 12);
  });

  it("eases a face made by hand toward the average face below 1, and has nothing to vary on the reset face", () => {
    const t = defs.find(isFeature)!.target;
    expect(canVary(defs, {})).toBe(false);
    expect(canVary(defs, { sem_age: 0.5 })).toBe(false); // age is not part of the face Distinctiveness varies
    expect(canVary(defs, { [t]: 0.5 })).toBe(true);
    expect(varyFace(defs, 0.5, {})).toBeNull();
    expect(varyFace(defs, 0.5, { [t]: 0.5 })![t]).toBeCloseTo(0.25, 12);
  });
});
