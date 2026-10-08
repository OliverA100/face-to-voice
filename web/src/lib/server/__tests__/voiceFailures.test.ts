import { beforeEach, describe, expect, it, vi } from "vitest";

// designForFace / selectPreview when ElevenLabs fails, with the real (in-memory) daily caps, and a Blob store that keeps
// the first file written to a path (storeAudio never overwrites).
const env = vi.hoisted(() => ({ hasRedis: false, hasBlob: false, isDeployed: false, rateLimitSalt: "s", studioVoices: [], voicePoolSize: 8, caps: { castingsPerDay: 50, designsPerDay: 5, savesPerDay: 5, speakCharsPerDay: 100 } }));
const store = vi.hoisted(() => new Map<string, unknown>());
const blobs = vi.hoisted(() => new Map<string, Uint8Array>());

vi.mock("server-only", () => ({}));
vi.mock("next/server", () => ({ after: (fn: () => unknown) => void fn() }));
vi.mock("../env", () => ({ env }));
vi.mock("../claude", () => ({ describeFace: vi.fn() }));
vi.mock("../cache", () => ({
  acquireLock: async () => true,
  releaseLock: async () => {},
  cacheDel: async (k: string) => void store.delete(k),
  poolRefresh: async () => {},
  cacheGet: async (k: string) => store.get(k) ?? null,
  cacheSet: async (k: string, v: unknown) => void store.set(k, v),
  storeAudio: async (path: string, bytes: Uint8Array) => {
    if (!blobs.has(path)) blobs.set(path, bytes);
    return `blob:${path}`;
  },
  poolList: async () => [],
  poolTouch: async () => {},
  poolEvictions: async () => [],
  poolRemove: async () => {},
}));
vi.mock("../elevenlabs", () => ({
  UpstreamError: class extends Error {
    constructor(readonly upstreamStatus = 500, readonly upstreamCode = "") {
      super("upstream");
    }
  },
  DESIGN_SETTINGS: { modelId: "eleven_ttv_v3", guidanceScale: 8, loudness: 0.5, outputFormat: "mp3_44100_128" },
  designVoice: vi.fn(),
  createVoice: vi.fn(),
  deleteVoice: async () => {},
  listAppVoices: async () => [],
  subscription: async () => null,
}));

import { describeFace } from "../claude";
import { createVoice, designVoice } from "../elevenlabs";
import { ApiError } from "../errors";
import { dailyUsage } from "../ratelimit";
import { designForFace, selectPreview } from "../voice";

const face = { weights: { sem_age: 0.3 }, imageJpegBase64: "", look: { hair: "none" }, visitor: "visitor-a" };
const used = async (kind: "designs" | "saves") => (await dailyUsage())[kind].used;
const design = (tag: string) => ({
  text: "line",
  settings: {},
  previews: [0, 1, 2].map((i) => ({ generatedVoiceId: `${tag}-${i}`, audio: new TextEncoder().encode(`${tag} take ${i}`), mediaType: "audio/mpeg", durationSecs: 1 })),
});

beforeEach(() => {
  store.clear();
  blobs.clear();
  vi.mocked(describeFace).mockReset().mockResolvedValue({
    fields: { presentation: "feminine", ageRange: "30s", character: "everyday", build: "average", energy: "calm", pacing: "measured", pitch: "medium", mood1: "warm", mood2: "wry", accent: "irish", accentStrength: "slight", ethnicity: "unclear", persona: "baker", timbre: "clear", quirk: "", line: "" },
    replaced: [],
  } as never);
});

describe("a failed paid call gives its daily cap back", () => {
  it("Voice Design fails: the design is not counted", async () => {
    const before = await used("designs");
    vi.mocked(designVoice).mockRejectedValue(new ApiError("upstream", "down", 502));
    await expect(designForFace(face)).rejects.toThrow("down");
    expect(await used("designs")).toBe(before);
  });

  it("saving the voice fails: the save is not counted", async () => {
    vi.mocked(designVoice).mockResolvedValue(design("a") as never);
    const { descKey } = await designForFace(face);
    const before = await used("saves");
    vi.mocked(createVoice).mockRejectedValue(new ApiError("upstream", "down", 502));
    await expect(selectPreview(descKey, 0)).rejects.toThrow("down");
    expect(await used("saves")).toBe(before);
  });
});

describe("previews of a description designed again", () => {
  it("play the new design's takes, not the files of the earlier one", async () => {
    vi.mocked(designVoice).mockResolvedValueOnce(design("first") as never).mockResolvedValueOnce(design("second") as never);
    const first = await designForFace(face);
    store.delete(`ftv:desc:${first.descKey}`); // the record expired (30 days); the Blob files did not
    const again = await designForFace({ ...face, visitor: "visitor-b" });
    expect(again.descKey).toBe(first.descKey);
    const heard = again.previews.map((p) => new TextDecoder().decode(blobs.get(p.url.slice("blob:".length))));
    expect(heard).toEqual(["second take 0", "second take 1", "second take 2"]);
    expect(again.previews.map((p) => p.generatedVoiceId)).toEqual(["second-0", "second-1", "second-2"]);
  });
});
