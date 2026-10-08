import { afterEach, describe, expect, it, vi } from "vitest";

// Without the caps worker the caps are worked out here, one animation per idle slice. Asked before the limiter's lazy
// chunk has loaded, they must still be worked out once it is in, not dropped for good.
const lim = vi.hoisted(() => ({ ready: false, asked: 0 }));
vi.mock("@/lib/morphs/capsClient", () => ({ requestCaps: () => false })); // no worker
vi.mock("@/lib/morphs/limiter", () => ({
  BLINK_STAGES: [0.5, 1],
  limiter: {
    get ready() {
      return lim.ready;
    },
    caps: () => (lim.asked++, {}),
  },
}));
vi.mock("@/lib/headMorph", () => ({ headMorph: { t: 1 } }));
vi.mock("@/lib/morphs/fxReach", () => ({ fxSpread: () => ({}) }));
vi.mock("@/lib/morphs/store", () => ({
  morphs: {
    base: {},
    emotionGain: 1,
    layerValue: () => 0,
    userValue: () => 0,
    comboOf: () => undefined,
    layerScales: () => ({}),
    setLayerScales: () => {},
    markShapeChanged: () => {},
  },
}));

import { scheduleAnimCaps } from "@/lib/morphs/animCaps";

afterEach(() => vi.useRealTimers());

describe("animation caps on the main thread", () => {
  it("wait for the limiter to load instead of giving up", () => {
    vi.useFakeTimers();
    scheduleAnimCaps();
    vi.advanceTimersByTime(500); // the limiter is still loading
    expect(lim.asked).toBe(0);
    lim.ready = true;
    vi.advanceTimersByTime(5000);
    expect(lim.asked).toBeGreaterThan(0);
  });
});
