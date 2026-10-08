import { describe, expect, it } from "vitest";

import { emotionDefs } from "../data";
import { applyEmotion, configureEmotions, currentEmotion, EMOTION, emotionRig, setSpeechActivity } from "../emotion";
import { morphs } from "../morphs/store";

describe("emotion mix", () => {
  configureEmotions(0.8);
  const happy = emotionDefs.find((e) => e.id === "happy")!;
  const k = Math.pow(0.8, EMOTION.curve); // intensity 0.8 through the response curve

  it("writes weight × intensity^curve to both parts at rest", () => {
    emotionRig.weights.happy = 1;
    applyEmotion();
    expect(morphs.effective(happy.upper)).toBeCloseTo(k);
    expect(morphs.effective(happy.lower)).toBeCloseTo(k);
    expect(k).toBeGreaterThan(0.8); // the curve lifts the low and middle range
  });

  it("keeps the upper part and turns the lower part down while speaking", () => {
    setSpeechActivity(1);
    expect(morphs.effective(happy.upper)).toBeCloseTo(k);
    expect(morphs.effective(happy.lower)).toBeCloseTo(k * EMOTION.lowerWhileSpeaking);
    setSpeechActivity(0.5);
    expect(morphs.effective(happy.lower)).toBeCloseTo(k * (1 - (1 - EMOTION.lowerWhileSpeaking) * 0.5));
    setSpeechActivity(0);
    expect(morphs.effective(happy.lower)).toBeCloseTo(k);
  });

  it("clamps each target to 0..1 and reports intensity in quarter steps", () => {
    emotionRig.intensity = 2;
    applyEmotion();
    expect(morphs.effective(happy.upper)).toBe(1);
    emotionRig.intensity = 0.6;
    emotionRig.current = "happy";
    expect(currentEmotion()).toEqual({ emotion: "happy", intensity: 0.5 });
    emotionRig.intensity = 0.1; // the slider's "a hint" end: still a hint for the voice
    expect(currentEmotion()).toEqual({ emotion: "happy", intensity: 0.25 });
  });
});

describe("mix sliders", () => {
  it("spread their value over real targets and add to the raw slider", () => {
    const store = new (morphs.constructor as new () => typeof morphs)();
    store.configure([
      { id: "head_000", target: "head_000", kind: "identity", region: "head", name: "", description: "", lowLabel: "", highLabel: "", group: "", min: -1, max: 1, default: 0, hidden: false },
      { id: "sem_size", target: "sem_size", kind: "semantic", region: "semantic", name: "", description: "", lowLabel: "", highLabel: "", group: "", min: -1, max: 1, default: 0, hidden: false, combo: { head_000: -0.5 } },
    ]);
    store.set("head_000", 0.2);
    store.set("sem_size", 1);
    expect(store.userValue("head_000")).toBeCloseTo(-0.3);
    expect(store.effective("head_000")).toBeCloseTo(-0.3);
    expect(store.base.head_000).toBeCloseTo(0.2); // the raw slider keeps its own value
    store.set("sem_size", 0);
    expect(store.effective("head_000")).toBeCloseTo(0.2);
  });

  it("use their own weights below zero when two-sided", () => {
    const store = new (morphs.constructor as new () => typeof morphs)();
    const def = { region: "", name: "", description: "", lowLabel: "", highLabel: "", group: "", min: -1, max: 1, default: 0, hidden: false } as const;
    store.configure([
      { ...def, id: "a", target: "a", kind: "expression" },
      { ...def, id: "b", target: "b", kind: "expression" },
      { ...def, id: "fx_lips", target: "fx_lips", kind: "control", combo: { a: 0.5 }, comboNeg: { b: 0.4 } },
    ]);
    store.set("fx_lips", 1);
    expect([store.effective("a"), store.effective("b")]).toEqual([0.5, 0]);
    store.set("fx_lips", -0.5);
    expect(store.effective("a")).toBeCloseTo(0);
    expect(store.effective("b")).toBeCloseTo(0.2);
  });
});
