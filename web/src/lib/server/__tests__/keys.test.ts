import { describe, expect, it } from "vitest";

import { descriptionKey, ttsKey } from "../keys";
import { restingLook } from "../look";

describe("descriptionKey", () => {
  it("ignores field order, case and the order inside lists", () => {
    const a = descriptionKey({ pitch: "Low", mood: ["warm", "Gruff"], accent: "scottish" });
    expect(descriptionKey({ accent: "Scottish", mood: ["gruff", "warm"], pitch: "low" })).toBe(a);
    expect(descriptionKey({ accent: "irish", mood: ["gruff", "warm"], pitch: "low" })).not.toBe(a);
    expect(a).toMatch(/^[a-f0-9]{64}$/);
  });
});

describe("ttsKey", () => {
  it("collapses whitespace but keeps the voice, the model and the words apart", () => {
    const k = ttsKey("v1", "m", "Hello  there.");
    expect(ttsKey("v1", "m", " Hello\nthere. ")).toBe(k);
    expect(ttsKey("v2", "m", "Hello there.")).not.toBe(k);
    expect(ttsKey("v1", "m2", "Hello there.")).not.toBe(k);
    expect(ttsKey("v1", "m", "hello there.")).not.toBe(k);
  });
});

describe("restingLook", () => {
  it("drops the expression and the head pose, keeps the styling", () => {
    expect(restingLook({ hair: "none", glasses: "round-wire", emotion: "afraid", emotionIntensity: "0.75", poseYaw: "10", poseRoll: "-20" })).toEqual({ hair: "none", glasses: "round-wire" });
  });
});
