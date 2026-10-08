import { describe, expect, it, vi } from "vitest";

// FTV_MOCK_CLAUDE=1 with FTV_MOCK_ELEVENLABS=1: the whole voice flow with no keys. Anthropic must never be reached.
const store = vi.hoisted(() => new Map<string, unknown>());

vi.mock("server-only", () => ({}));
vi.mock("next/server", () => ({ after: vi.fn() }));
vi.mock("@anthropic-ai/sdk", () => ({
  default: class {
    constructor() {
      throw new Error("the mock casting must not create an Anthropic client");
    }
  },
}));
vi.mock("../env", () => ({
  env: { mockClaude: true, mockElevenLabs: true, anthropicKey: () => "", elevenLabsKey: () => "", hasBlob: false, studioVoices: [], voicePoolSize: 3 },
}));
vi.mock("../ratelimit", () => ({ consumeDailyCap: vi.fn(async () => ({ used: 1, limit: 2 })), refundDailyCap: vi.fn(async () => {}) }));
vi.mock("../cache", () => ({
  acquireLock: async () => true,
  releaseLock: async () => {},
  cacheDel: async (k: string) => void store.delete(k),
  poolRefresh: async () => {},
  cacheGet: async (k: string) => store.get(k) ?? null,
  cacheSet: async (k: string, v: unknown) => void store.set(k, v),
  storeAudio: async (path: string) => `blob:${path}`,
  poolList: async () => [],
  poolTouch: async () => {},
  poolEvictions: async () => [],
  poolRemove: async () => {},
}));

import { describeFace } from "../claude";
import { MOCK_LINE } from "../mockCasting";
import { previewText } from "../prompt";
import { generateSpeech } from "../speech";
import { designForFace, selectPreview } from "../voice";

const input = (ageSlider: number, lookIds: Record<string, string> = {}) => ({ imageJpegBase64: "", sliderSummary: "", ageSlider, expression: "", look: "", pickKey: "0".repeat(64), lookIds });

describe("the development casting (FTV_MOCK_CLAUDE=1)", () => {
  it("is deterministic and built from the request: age from the Age slider, moods and energy from the expression", async () => {
    const a = await describeFace(input(0.3, { emotion: "angry", emotionIntensity: "0.75" }));
    expect(await describeFace(input(0.3, { emotion: "angry", emotionIntensity: "0.75" }))).toEqual(a);
    expect(a.fields).toMatchObject({ ageRange: "60s", mood1: "menacing", mood2: "gruff", energy: "intense", character: "distinct", presentation: "neutral" });
    expect((await describeFace(input(-1))).fields).toMatchObject({ ageRange: "late teens", mood1: "warm", energy: "relaxed", character: "everyday", accentStrength: "slight" });
    expect((await describeFace(input(1, { facialHair: "long-beard" }))).fields).toMatchObject({ ageRange: "80s+", presentation: "masculine", persona: "bearded harbour keeper" });
  });

  it("goes through the real sanitising: one of three accents, and a two-sentence line of 24-30 words that the preview uses", async () => {
    const { fields, replaced } = await describeFace(input(0));
    expect(replaced).toEqual([]);
    expect(["general american", "irish", "yorkshire"]).toContain(fields.accent);
    expect(fields.line).toBe(MOCK_LINE);
    expect(MOCK_LINE.split(/\s+/).length).toBeGreaterThanOrEqual(24);
    expect(MOCK_LINE.split(/\s+/).length).toBeLessThanOrEqual(30);
    expect(MOCK_LINE.match(/[.!?]/g)).toHaveLength(2);
    expect(previewText({ ...fields, emotion: "neutral", emotionIntensity: 0 })).toBe(MOCK_LINE);
  });

  it("with the ElevenLabs mock, runs design → select → speak without any key", async () => {
    const design = await designForFace({ weights: { sem_age: 0.5 }, imageJpegBase64: "", look: { glasses: "round-wire" }, visitor: "v" });
    expect(design.previews).toHaveLength(3);
    expect(design.fields.persona).toBe("bookish town archivist");
    const chosen = await selectPreview(design.descKey, 1);
    expect(chosen).toMatchObject({ saved: true, chosenIndex: 1 });
    const speech = await new Response(await generateSpeech(chosen.voiceId, "Hello there.")).text();
    expect(speech.trim().split("\n").length).toBeGreaterThan(0);
  });
});
