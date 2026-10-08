import { beforeEach, describe, expect, it, vi } from "vitest";

// The voice flow with the real in-memory cache, locks, pool and daily caps; Claude and ElevenLabs are fakes. Covers the
// global casting cap, the design's time budget, one design / one save at a time, previews that can no longer become a
// voice, the free take switch, and the speak route keeping its voice alive.
const env = vi.hoisted(() => ({
  hasRedis: false, hasBlob: false, isDeployed: false, rateLimitSalt: "s", studioVoices: [], voicePoolSize: 8,
  caps: { castingsPerDay: 50, designsPerDay: 50, savesPerDay: 50, speakCharsPerDay: 1000 },
}));

vi.mock("server-only", () => ({}));
vi.mock("next/server", () => ({ after: (fn: () => unknown) => void fn() }));
vi.mock("../env", () => ({ env }));
vi.mock("../claude", () => ({ describeFace: vi.fn() }));
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

import { cacheGet, poolList, poolTouch } from "../cache";
import { describeFace } from "../claude";
import { createVoice, designVoice, UpstreamError } from "../elevenlabs";
import { dailyUsage } from "../ratelimit";
import { designForFace, selectPreview, voiceGone, voiceSpoken, type VoiceRecord } from "../voice";

let n = 0;
const face = () => ({ weights: { sem_age: (n++ % 19) / 20 }, imageJpegBase64: "", look: { hair: "none" }, visitor: "visitor-a" }); // a new face each time
const used = async (kind: "castings" | "designs" | "saves") => (await dailyUsage())[kind].used;
const cast = (persona: string) => ({
  fields: { presentation: "feminine", ageRange: "30s", character: "distinct", build: "average", energy: "calm", pacing: "measured", pitch: "medium", mood1: "warm", mood2: "wry", accent: "irish", accentStrength: "slight", ethnicity: "white", persona, timbre: "clear", quirk: "", line: "" },
  replaced: [],
});
const designed = (tag: string) => ({
  text: "line",
  settings: {},
  previews: [0, 1, 2].map((i) => ({ generatedVoiceId: `${tag}-${i}`, audio: new Uint8Array([i]), mediaType: "audio/mpeg", durationSecs: 1 })),
});
const later = <T>(v: T, ms = 50) => new Promise<T>((r) => setTimeout(() => r(v), ms));
const record = async (descKey: string) => (await cacheGet<VoiceRecord>(`ftv:desc:${descKey}`))!;

beforeEach(() => {
  vi.mocked(describeFace).mockReset().mockImplementation(async () => cast(`persona ${n}`) as never);
  vi.mocked(designVoice).mockReset().mockImplementation(async () => designed(`d${n}`) as never);
  vi.mocked(createVoice).mockReset().mockImplementation(async (name: string) => `voice ${name}`);
});

describe("Claude castings", () => {
  it("stop at the global daily cap, before Claude is called", async () => {
    env.caps.castingsPerDay = (await used("castings")) / 10 + 1; // development counts 10× the cap: one casting left
    await Promise.all(Array.from({ length: 10 - ((await used("castings")) % 10) }, () => designForFace(face()))).catch(() => {});
    const calls = vi.mocked(describeFace).mock.calls.length;
    await expect(designForFace(face())).rejects.toMatchObject({ code: "daily_cap" });
    expect(describeFace).toHaveBeenCalledTimes(calls);
    env.caps.castingsPerDay = 50;
  });

  it("give the casting back when Claude fails", async () => {
    const before = await used("castings");
    vi.mocked(describeFace).mockRejectedValueOnce(new Error("overloaded"));
    await expect(designForFace(face())).rejects.toThrow("overloaded");
    expect(await used("castings")).toBe(before);
  });
});

describe("Voice Design within the request's time", () => {
  it("is given only the time left before the deadline", async () => {
    await designForFace({ ...face(), deadline: Date.now() + 30_000 });
    const timeout = vi.mocked(designVoice).mock.calls[0][3];
    expect(timeout).toBeDefined();
    expect(timeout!).toBeLessThanOrEqual(30_000);
  });

  it("is not tried again after a timeout (only after a refusal)", async () => {
    vi.mocked(designVoice).mockRejectedValueOnce(new DOMException("timed out", "TimeoutError"));
    await expect(designForFace(face())).rejects.toThrow("timed out");
    expect(designVoice).toHaveBeenCalledTimes(1);
    vi.mocked(designVoice).mockReset().mockRejectedValueOnce(new UpstreamError(422, "invalid")).mockResolvedValueOnce(designed("plain") as never);
    await designForFace(face());
    expect(designVoice).toHaveBeenCalledTimes(2);
    expect(vi.mocked(designVoice).mock.calls[1][0]).not.toMatch(/White/);
  });
});

describe("one paid job at a time", () => {
  it("two visitors cast the same way at once: one Voice Design, the same previews for both", async () => {
    vi.mocked(describeFace).mockImplementation(async () => cast("twin") as never);
    vi.mocked(designVoice).mockImplementation(() => later(designed("twin")) as never);
    const f = face();
    const [a, b] = await Promise.all([designForFace({ ...f, visitor: "v1" }), designForFace({ ...f, visitor: "v2" })]);
    expect(designVoice).toHaveBeenCalledTimes(1);
    expect(b.previews).toEqual(a.previews);
  });

  it("the same take chosen twice at once is saved once", async () => {
    const { descKey } = await designForFace(face());
    vi.mocked(createVoice).mockImplementation(() => later("the-voice") as never);
    const [a, b] = await Promise.all([selectPreview(descKey, 1), selectPreview(descKey, 1)]);
    expect(createVoice).toHaveBeenCalledTimes(1);
    expect([a.voiceId, b.voiceId]).toEqual(["the-voice", "the-voice"]);
  });
});

describe("previews that can no longer become a voice", () => {
  it("a choice from previews designed again since is refused", async () => {
    const { descKey, previews } = await designForFace(face());
    await expect(selectPreview(descKey, 0, { generatedVoiceId: "something-else" })).rejects.toMatchObject({ code: "expired", status: 409 });
    expect((await selectPreview(descKey, 0, { generatedVoiceId: previews[0].generatedVoiceId })).saved).toBe(true);
  });

  it("an unknown or expired record says so (Find again), not 'invalid request'", async () => {
    await expect(selectPreview("f".repeat(64), 0)).rejects.toMatchObject({ code: "expired", status: 410 });
  });

  it("previews ElevenLabs no longer has: the record goes, the save is given back", async () => {
    const { descKey } = await designForFace(face());
    const before = await used("saves");
    vi.mocked(createVoice).mockRejectedValueOnce(new UpstreamError(404, "voice_not_found"));
    await expect(selectPreview(descKey, 2)).rejects.toMatchObject({ code: "expired" });
    expect(await cacheGet(`ftv:desc:${descKey}`)).toBeNull();
    expect(await used("saves")).toBe(before);
  });
});

describe("the visitor's limit on new voices", () => {
  it("counts a new save, not going back to a saved take", async () => {
    const { descKey } = await designForFace(face());
    const charge = vi.fn(async () => {});
    await selectPreview(descKey, 0, { chargeVisitor: charge });
    await selectPreview(descKey, 1, { chargeVisitor: charge });
    await selectPreview(descKey, 0, { chargeVisitor: charge });
    expect(charge).toHaveBeenCalledTimes(2);
  });
});

describe("a voice in use", () => {
  it("speaking moves it to the back of the eviction queue; an evicted one is not brought back", async () => {
    const { descKey } = await designForFace(face());
    const { voiceId } = await selectPreview(descKey, 0);
    const entry = async () => (await poolList()).find((e) => e.voiceId === voiceId);
    const first = (await entry())!.lastUsed;
    await later(null, 5);
    await voiceSpoken(await record(descKey), 0, voiceId);
    expect((await entry())!.lastUsed).toBeGreaterThan(first);
    await voiceGone(descKey, voiceId); // deleted upstream
    expect(await entry()).toBeUndefined();
    expect((await record(descKey)).takes[0]).toBeUndefined();
    await voiceSpoken({ ...(await record(descKey)), takes: { 0: { voiceId } } }, 0, voiceId);
    expect(await entry()).toBeUndefined();
    await poolTouch("x#0", "unrelated"); // the pool still works
  });
});
