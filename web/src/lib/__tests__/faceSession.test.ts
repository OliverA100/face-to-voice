import { describe, expect, it, vi } from "vitest";

// A saved intensity outside the Intensity slider's range (an older save, or edited by hand) comes back inside it, so
// the slider and the face agree.
const rig = vi.hoisted(() => ({ intensity: 0.8, current: "neutral", weights: {} as Record<string, number> }));
vi.mock("@/lib/emotion", () => ({ emotionRig: rig, applyEmotion: () => {} }));
vi.mock("@/lib/headLoad", () => ({ prefetchPart: () => {} }));
vi.mock("@/lib/morphs/store", () => ({
  morphs: { targets: () => [], kinds: {}, ranges: {}, base: {}, defaults: {}, effective: () => 0, set: () => {}, onSettle: () => () => {} },
}));
vi.stubGlobal("window", { sessionStorage: { getItem: () => JSON.stringify({ intensity: 0.05 }), setItem: () => {} } });

import { sliders } from "@/lib/data";
import { restoreFace } from "@/lib/faceSession";

describe("restored intensity", () => {
  it("is kept within the Intensity slider's range", () => {
    restoreFace();
    expect(rig.intensity).toBe(sliders.emotions.intensity.min);
  });
});
