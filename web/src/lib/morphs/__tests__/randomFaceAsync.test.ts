import { afterEach, describe, expect, it, vi } from "vitest";

// Random character fits its face with the caps worker answering the limiter (randomFaceAsync), so the page doesn't
// stop at the click. The face must be the one randomFace makes from the same draw, and a fit overtaken by Reset or
// another random face must not land.
vi.mock("@/lib/morphs/capsClient", () => ({ canAsk: () => true }));

import { sliders } from "@/lib/data";
import { limiter, plainStore } from "@/lib/morphs/limiter";
import { clearRandomFace, randomFace, randomFaceAsync, randomState, type LimitAsk } from "@/lib/morphs/random";
import type { SliderDef } from "@/lib/data";

const defs = sliders.sliders;
/** What fitted() asks the limiter, answered the same way but a turn later (as the worker does). */
const answerLater = async (d: SliderDef[], a: LimitAsk) =>
  a.kind === "broken" ? limiter.broken(plainStore(a.face, d)) : limiter.reach(plainStore(a.face, d), a.target, a.end);

/** Math.random from a fixed sequence (mulberry32). */
function seed(s: number) {
  let a = s >>> 0;
  vi.spyOn(Math, "random").mockImplementation(() => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  });
}

afterEach(() => {
  vi.restoreAllMocks();
  clearRandomFace();
});

describe("randomFaceAsync", () => {
  it("makes the face randomFace makes from the same draw", async () => {
    for (const variation of [1, 2.25]) {
      seed(1234);
      const here = randomFace(defs, variation, { age: 0.3 });
      const fitHere = structuredClone(randomState.lastFit);
      seed(1234);
      const later = await randomFaceAsync(defs, answerLater, variation, { age: 0.3 });
      expect(later).toEqual(here);
      expect(randomState.lastFit).toEqual(fitHere);
    }
  });

  it("gives up when Reset or another random face takes over meanwhile", async () => {
    let release = () => {};
    const gate = new Promise<void>((r) => (release = r));
    const slow = async (d: SliderDef[], a: LimitAsk) => (await gate, answerLater(d, a));
    const pending = randomFaceAsync(defs, slow, 1);
    clearRandomFace(); // Reset
    release();
    expect(await pending).toBeNull();
  });
});
