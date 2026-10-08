import { afterEach, describe, expect, it, vi } from "vitest";

// Distinctiveness is worked out ahead only while the caps worker answers: once it has failed, askLimiter answers on the
// main thread without yielding, and working out every notch that way would freeze a phone for seconds.
let workerAlive = true;
vi.mock("@/lib/morphs/capsClient", () => ({ canAsk: () => workerAlive }));

import { sliders } from "@/lib/data";
import { clearRandomFace, precomputeVariations, randomFace, variationNotches, type LimitAsk } from "@/lib/morphs/random";

const defs = sliders.sliders;
afterEach(() => {
  clearRandomFace();
  workerAlive = true;
});

describe("precomputeVariations", () => {
  it("stops when the caps worker can no longer answer", async () => {
    randomFace(defs, 1);
    let asked = 0;
    const ask = async (_defs: unknown, a: LimitAsk) => {
      asked++;
      workerAlive = false; // the worker failed while answering this one
      return a.kind === "broken" ? false : a.end;
    };
    await precomputeVariations(defs, {}, variationNotches(1), "", ask);
    expect(asked).toBe(1);
  });

  it("works every notch out while the worker answers", async () => {
    randomFace(defs, 1);
    let asked = 0;
    const ask = async (_defs: unknown, a: LimitAsk) => (asked++, a.kind === "broken" ? false : a.end);
    await precomputeVariations(defs, {}, variationNotches(1), "", ask);
    expect(asked).toBeGreaterThan(variationNotches(1).length);
  });
});
