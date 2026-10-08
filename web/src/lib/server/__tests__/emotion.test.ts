import { describe, expect, it } from "vitest";

import { EMOTION_IDS, emotionTag, emotionWords, quantiseIntensity, SpeakEmotion, spokenText } from "../emotion";
import { faceKey, ttsKey } from "../keys";
import { LookSchema, lookText } from "../look";

describe("speak route emotion fields", () => {
  it("accepts the panel's emotions and defaults to neutral", () => {
    expect(SpeakEmotion.parse({})).toEqual({ emotion: "neutral", intensity: 0 });
    for (const id of EMOTION_IDS) expect(SpeakEmotion.parse({ emotion: id, intensity: 0.5 }).emotion).toBe(id);
    expect(EMOTION_IDS).toEqual(expect.arrayContaining(["neutral", "happy", "sad", "angry", "surprised", "afraid", "disgusted"]));
  });

  it("rejects unknown emotions, audio tags and out-of-range intensity", () => {
    for (const bad of ["furious", "[whispers]", "Happy", ""]) expect(() => SpeakEmotion.parse({ emotion: bad })).toThrow();
    expect(() => SpeakEmotion.parse({ emotion: "happy", intensity: 1.5 })).toThrow();
    expect(() => SpeakEmotion.parse({ emotion: "happy", intensity: -0.1 })).toThrow();
  });
});

describe("audio tags (eleven_v4_turbo)", () => {
  it("adds no tag for neutral or zero intensity", () => {
    expect(emotionTag("neutral", 1)).toBe("");
    expect(emotionTag("happy", 0)).toBe("");
    expect(emotionTag("happy", 0.1)).toBe(""); // quantised to 0
    expect(spokenText("Hello  there.", "neutral", 1)).toBe("Hello there.");
  });

  it("builds the tag from the id: a hint, clear and full", () => {
    expect(emotionTag("afraid", 0.25)).toBe("[nervous, a little shaky] ");
    expect(emotionTag("afraid", 0.5)).toBe("[nervous, a little shaky] ");
    expect(emotionTag("afraid", 0.75)).toBe("[scared, shaky and breathless] ");
    expect(emotionTag("afraid", 1)).toBe("[terrified, voice shaking, gasping for breath] ");
    expect(emotionTag("angry", 1)).toBe("[furious, almost shouting, hard and clipped] ");
    for (const id of EMOTION_IDS.filter((e) => e !== "neutral")) expect(emotionTag(id, 1)).toMatch(/^\[[a-z ,]+\] $/);
    expect(quantiseIntensity(0.62)).toBe(0.5);
    expect(quantiseIntensity(0.63)).toBe(0.75);
  });

  it("removes brackets the visitor typed, so only our tags reach the model", () => {
    expect(spokenText("[whispers] psst [laughs]", "sad", 1)).toBe("[heartbroken, voice cracking, holding back sobs] whispers psst laughs");
  });

  it("keys the same line in another mood as another clip", () => {
    const key = (e: string) => ttsKey("voice", "eleven_v4_turbo", spokenText("Hello there", e, 1));
    expect(key("happy")).not.toBe(key("neutral"));
    expect(key("sad")).not.toBe(key("happy"));
  });
});

describe("expression in the look", () => {
  it("is said in words and is part of the face key", () => {
    const look = LookSchema.parse({ hair: "none", emotion: "happy", emotionIntensity: "0.75" });
    expect(lookText(look)).toBe("hair style: none; expression: happy (strong)");
    expect(emotionWords("neutral", 1)).toBe("");
    expect(faceKey({}, look)).not.toBe(faceKey({}, { hair: "none" }));
  });

  it("rejects values outside the allow-list", () => {
    expect(() => LookSchema.parse({ emotion: "furious" })).toThrow();
    expect(() => LookSchema.parse({ emotion: "happy", emotionIntensity: "0.6" })).toThrow();
  });
});

describe("head pose in the look", () => {
  it("is said in words, in 10° steps", () => {
    const look = LookSchema.parse({ hair: "none", poseYaw: "20", posePitch: "-10" });
    expect(lookText(look)).toBe("hair style: none; head pose: turned 20° right, bent 10° forward");
  });

  it("rejects angles that are not 10° steps within the limits", () => {
    expect(() => LookSchema.parse({ poseYaw: "15" })).toThrow();
    expect(() => LookSchema.parse({ posePitch: "40" })).toThrow();
    expect(() => LookSchema.parse({ poseRoll: "0" })).toThrow(); // straight is left out, never sent
  });
});
