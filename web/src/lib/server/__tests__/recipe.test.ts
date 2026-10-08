import { beforeEach, describe, expect, it, vi } from "vitest";

// The export's voice recipe (lib/server/voice.ts): what was sent to Voice Design and which preview became the voice.
// ElevenLabs runs in its own mock mode (env.mockElevenLabs), so the real designVoice path is exercised for free.
const store = vi.hoisted(() => new Map<string, unknown>());

vi.mock("server-only", () => ({}));
vi.mock("../env", () => ({ env: { mockElevenLabs: true, studioVoices: [{ slot: "masculine-40s", voiceId: "studio-m40" }], voicePoolSize: 8 } }));
vi.mock("../ratelimit", () => ({ consumeDailyCap: vi.fn(async () => ({ used: 1, limit: 2 })), refundDailyCap: vi.fn(async () => {}) }));
vi.mock("../claude", () => ({ describeFace: vi.fn() }));
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

import { ApiError } from "../errors";
import { describeFace } from "../claude";
import { DESIGN_SETTINGS } from "../elevenlabs";
import { consumeDailyCap } from "../ratelimit";
import { designForFace, selectPreview } from "../voice";

const LINE = "Listen to me. We have one shot at this, and everything comes down to the next ten minutes. Stay sharp, stay close.";
const face = { weights: { sem_age: 0.2 }, imageJpegBase64: "", look: { hair: "none" }, visitor: "visitor-a" };

beforeEach(() => {
  store.clear();
  vi.mocked(describeFace).mockResolvedValue({
    fields: { presentation: "masculine", ageRange: "40s", character: "distinct", build: "stocky", energy: "intense", pacing: "fast", pitch: "low", mood1: "urgent", mood2: "steady", accent: "scottish", accentStrength: "moderate", ethnicity: "white", persona: "harbour pilot", timbre: "gravelly", quirk: "", line: LINE },
    replaced: [],
  } as never);
});

describe("the voice recipe", () => {
  it("is the exact Voice Design request: prompt, the line as sent, seed and settings", async () => {
    const r = await designForFace(face);
    expect(r.recipe).toEqual({ ...DESIGN_SETTINGS, voiceDescription: r.description, text: LINE, seed: expect.any(Number) });
    expect(r.recipe.seed).toBe(parseInt(r.descKey.slice(0, 8), 16) % 2147483647);
    expect(r).toMatchObject({ voiceId: null, chosenIndex: null, studioFallback: false });
  });

  it("remembers which preview was saved; another take gets its own voice, and the latest pick is the default", async () => {
    const first = await designForFace(face);
    const two = await selectPreview(first.descKey, 2);
    expect(two).toMatchObject({ saved: true, chosenIndex: 2 });
    expect(await designForFace(face)).toMatchObject({ voiceId: two.voiceId, chosenIndex: 2, savedTakes: [2], studioFallback: false, recipe: first.recipe });
    // Choosing another take (switching) saves that one too; the first stays saved.
    const zero = await selectPreview(first.descKey, 0);
    expect(zero).toMatchObject({ saved: true, chosenIndex: 0 });
    const again = await designForFace(face);
    expect(again).toMatchObject({ voiceId: zero.voiceId, chosenIndex: 0, studioFallback: false, recipe: first.recipe });
    expect(again.savedTakes.sort()).toEqual([0, 2]);
  });

  it("flags a studio stand-in but keeps the take the visitor picked", async () => {
    const first = await designForFace(face);
    vi.mocked(consumeDailyCap).mockRejectedValueOnce(new ApiError("daily_cap", "cap", 429));
    expect(await selectPreview(first.descKey, 1)).toMatchObject({ voiceId: "studio-m40", saved: false, chosenIndex: 1 });
    expect(await designForFace(face)).toMatchObject({ voiceId: "studio-m40", studioFallback: true, chosenIndex: 1 });
  });
});
