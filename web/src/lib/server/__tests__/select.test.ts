import { beforeEach, describe, expect, it, vi } from "vitest";

// selectPreview with ElevenLabs, the cache and the daily cap replaced by in-memory fakes.
const el = vi.hoisted(() => ({
  slots: 10,
  limit: 10,
  edits: 11,
  maxEdits: 65,
  voices: [] as { voiceId: string; createdAt: number }[],
  deleted: [] as string[],
  created: [] as string[],
}));
const store = vi.hoisted(() => new Map<string, unknown>());
const studio = vi.hoisted(() => ({ voices: [] as { slot: string; voiceId: string }[] }));

vi.mock("server-only", () => ({}));
vi.mock("../env", () => ({
  env: {
    get studioVoices() {
      return studio.voices;
    },
    voicePoolSize: 8,
  },
}));
vi.mock("../ratelimit", () => ({ consumeDailyCap: vi.fn(async () => ({ used: 1, limit: 2 })), refundDailyCap: vi.fn(async () => {}) }));
vi.mock("../claude", () => ({ describeFace: vi.fn() }));
vi.mock("../cache", () => ({
  acquireLock: async () => true,
  releaseLock: async () => {},
  cacheDel: async (k: string) => void store.delete(k),
  poolRefresh: async () => {},
  cacheGet: async (k: string) => store.get(k) ?? null,
  cacheSet: async (k: string, v: unknown) => void store.set(k, v),
  storeAudio: vi.fn(),
  poolList: async () => (store.get("pool") as { voiceId: string }[] | undefined) ?? [],
  poolTouch: async (descKey: string, voiceId: string) => void store.set("pool", [{ descKey, voiceId, lastUsed: Date.now() }]),
  poolEvictions: async () => (store.get("evict") as unknown[] | undefined) ?? [],
  poolRemove: vi.fn(),
}));
vi.mock("../elevenlabs", () => ({
  UpstreamError: class extends Error {
    constructor(readonly upstreamStatus = 500, readonly upstreamCode = "") {
      super("upstream");
    }
  },
  DESIGN_SETTINGS: { modelId: "eleven_ttv_v3", guidanceScale: 8, loudness: 0.5, outputFormat: "mp3_44100_128" },
  designVoice: vi.fn(),
  subscription: async () => ({ tier: "starter", characterCount: 0, characterLimit: 1, voiceSlotsUsed: el.slots, voiceLimit: el.limit, voiceAddEditCounter: el.edits, maxVoiceAddEdits: el.maxEdits }),
  listAppVoices: async () => el.voices,
  deleteVoice: async (id: string) => {
    el.deleted.push(id);
    el.voices = el.voices.filter((v) => v.voiceId !== id);
    el.slots -= 1;
  },
  createVoice: async (name: string) => {
    el.slots += 1;
    el.created.push(name);
    return el.created.length === 1 ? "new-voice" : `new-voice-${el.created.length}`;
  },
}));

import { ApiError } from "../errors";
import { consumeDailyCap } from "../ratelimit";
import { describeFace } from "../claude";
import { DESIGN_SETTINGS, designVoice } from "../elevenlabs";
import { closestStudioVoice, designForFace, selectPreview, takeVoice, type VoiceRecord } from "../voice";

const DESC = "abcdef0123456789";
const HOUR = 60 * 60_000;

beforeEach(() => {
  Object.assign(el, { slots: 10, limit: 10, edits: 11, maxEdits: 65, deleted: [], created: [] });
  el.voices = Array.from({ length: 10 }, (_, i) => ({ voiceId: `old-${i}`, createdAt: Date.now() - (10 - i) * HOUR }));
  store.clear();
  studio.voices = [];
  const previews = [0, 1, 2].map((i) => ({ generatedVoiceId: `g${i}`, url: "u", durationSecs: 1 }));
  const record: VoiceRecord = { descKey: DESC, description: "d", previews, seed: 1, cast: { presentation: "masculine", ageRange: "40s" }, design: { ...DESIGN_SETTINGS, text: "t" }, takes: {}, voiceId: null, createdAt: 0 };
  store.set(`ftv:desc:${DESC}`, record);
});

describe("selectPreview when the voice slots are full", () => {
  it("deletes the oldest voice the pool forgot, then saves", async () => {
    const r = await selectPreview(DESC, 0);
    expect(r).toEqual({ voiceId: "new-voice", saved: true, chosenIndex: 0 });
    expect(el.deleted).toEqual(["old-0"]);
  });

  it("keeps pooled and very new voices", async () => {
    store.set("pool", [{ descKey: "x", voiceId: "old-0", lastUsed: 0 }]);
    el.voices[1].createdAt = Date.now() - 60_000;
    await selectPreview(DESC, 0);
    expect(el.deleted).toEqual(["old-2"]);
  });

  it("says the slots are full (not 'tomorrow') when nothing can be freed", async () => {
    el.voices = [];
    await expect(selectPreview(DESC, 0)).rejects.toThrow("There's no room for a new voice right now");
  });

  it("names the month when the add/edit budget is spent", async () => {
    el.slots = 0;
    el.edits = 64;
    await expect(selectPreview(DESC, 0)).rejects.toThrow("This month's new voices are used up");
  });

  it("names the day when the daily save cap is hit", async () => {
    el.slots = 0;
    vi.mocked(consumeDailyCap).mockRejectedValueOnce(new ApiError("daily_cap", "cap", 429));
    await expect(selectPreview(DESC, 0)).rejects.toThrow("Today's new voices are used up");
  });
});

describe("closestStudioVoice", () => {
  const six = ["masculine-20s", "masculine-40s", "masculine-70s", "feminine-20s", "feminine-40s", "feminine-70s"].map((slot) => ({ slot, voiceId: slot }));

  it("matches gender first, then the nearest age", () => {
    studio.voices = six;
    expect(closestStudioVoice({ presentation: "feminine", ageRange: "80s+" }, DESC)).toBe("feminine-70s");
    expect(closestStudioVoice({ presentation: "masculine", ageRange: "late teens" }, DESC)).toBe("masculine-20s");
    expect(closestStudioVoice({ presentation: "masculine", ageRange: "50s" }, DESC)).toBe("masculine-40s");
  });

  it("lets a neutral cast take either gender at the nearest age", () => {
    studio.voices = six;
    expect(["masculine-70s", "feminine-70s"]).toContain(closestStudioVoice({ presentation: "neutral", ageRange: "70s" }, DESC));
  });

  it("falls back to the hash for bare ids", () => {
    studio.voices = [{ slot: "", voiceId: "x" }, { slot: "", voiceId: "y" }];
    expect(["x", "y"]).toContain(closestStudioVoice({ presentation: "feminine", ageRange: "20s" }, DESC));
  });

  it("is what selectPreview returns once the cap is hit", async () => {
    studio.voices = six;
    store.set(`ftv:desc:${DESC}`, { ...(store.get(`ftv:desc:${DESC}`) as object), cast: { presentation: "feminine", ageRange: "60s" } });
    el.slots = 0;
    vi.mocked(consumeDailyCap).mockRejectedValueOnce(new ApiError("daily_cap", "cap", 429));
    expect(await selectPreview(DESC, 0)).toMatchObject({ voiceId: "feminine-70s", saved: false });
  });
});

describe("designForFace keeps the accent of the face at rest", () => {
  it("a new expression or pose recasts the face but keeps its first accent", async () => {
    store.clear();
    const cast = (accent: string) => ({
      fields: { presentation: "masculine", ageRange: "80s+", character: "larger than life", build: "slight", energy: "calm", pacing: "slow", pitch: "low", mood1: "gentle", mood2: "thoughtful", accent, accentStrength: "thick", ethnicity: "white", persona: "ancient wizard", timbre: "wheezy", quirk: "", line: "" },
      replaced: [],
    });
    vi.mocked(describeFace).mockResolvedValueOnce(cast("posh british") as never).mockResolvedValueOnce(cast("scottish") as never).mockResolvedValueOnce(cast("welsh") as never);
    vi.mocked(designVoice).mockResolvedValue({ previews: [], text: "" } as never);
    const face = { weights: { sem_age: 0.9 }, imageJpegBase64: "", visitor: "visitor-a" };
    const atRest = await designForFace({ ...face, look: { hair: "none" } });
    const scared = await designForFace({ ...face, look: { hair: "none", emotion: "afraid", emotionIntensity: "0.75", poseRoll: "10" } });
    const otherFace = await designForFace({ ...face, look: { hair: "none", glasses: "round-wire" } });
    expect([atRest.fields.accent, scared.fields.accent, otherFace.fields.accent]).toEqual(["posh british", "posh british", "welsh"]);
    expect(scared.fields.emotion).toBe("afraid");
  });
});

describe("designForFace keeps castings per visitor", () => {
  const cast = (accent: string, persona: string) => ({
    fields: { presentation: "feminine", ageRange: "30s", character: "distinct", build: "average", energy: "lively", pacing: "brisk", pitch: "medium", mood1: "warm", mood2: "wry", accent, accentStrength: "moderate", ethnicity: "unclear", persona, timbre: "bright", quirk: "", line: "" },
    replaced: [],
  });

  it("two visitors with the same face are cast separately; each hits its own cache; the voice record stays shared", async () => {
    store.clear();
    vi.mocked(describeFace).mockReset().mockResolvedValueOnce(cast("irish", "harbour pilot") as never).mockResolvedValueOnce(cast("welsh", "crafted persona") as never);
    vi.mocked(designVoice).mockReset().mockResolvedValue({ previews: [], text: "" } as never);
    const face = { weights: { sem_age: 0.1 }, imageJpegBase64: "", look: { hair: "none" } };
    const a = await designForFace({ ...face, visitor: "visitor-a" });
    const b = await designForFace({ ...face, visitor: "visitor-b" });
    expect(describeFace).toHaveBeenCalledTimes(2);
    expect([a.fields.persona, b.fields.persona]).toEqual(["harbour pilot", "crafted persona"]);
    expect(b.fields.accent).toBe("welsh"); // the accent memory is per visitor too
    expect(a.faceKey).toBe(b.faceKey);

    const again = await designForFace({ ...face, visitor: "visitor-a" });
    expect(describeFace).toHaveBeenCalledTimes(2);
    expect(again).toMatchObject({ descKey: a.descKey, fields: a.fields, cached: { description: true, previews: true } });

    // Another visitor whose casting matches shares the voice record: no second Voice Design call.
    vi.mocked(describeFace).mockResolvedValueOnce(cast("irish", "harbour pilot") as never);
    const c = await designForFace({ ...face, visitor: "visitor-c" });
    expect(c).toMatchObject({ descKey: a.descKey, cached: { description: false, previews: true } });
    expect(designVoice).toHaveBeenCalledTimes(2);
  });
});

describe("switching between the three takes", () => {
  const rec = () => store.get(`ftv:desc:${DESC}`) as VoiceRecord;
  beforeEach(() => {
    el.slots = 2; // room to save
  });

  it("saves another take as its own voice and keeps the first", async () => {
    const a = await selectPreview(DESC, 0);
    const b = await selectPreview(DESC, 2);
    expect(a.voiceId).not.toBe(b.voiceId);
    expect(b).toMatchObject({ saved: true, chosenIndex: 2 });
    expect(el.created).toHaveLength(2);
    expect(takeVoice(rec(), 0)).toBe(a.voiceId);
    expect(takeVoice(rec(), 2)).toBe(b.voiceId);
    expect(rec().voiceId).toBe(b.voiceId); // the latest choice is the record's default
  });

  it("switching back to a saved take is free", async () => {
    const a = await selectPreview(DESC, 0);
    await selectPreview(DESC, 1);
    const again = await selectPreview(DESC, 0);
    expect(again).toMatchObject({ voiceId: a.voiceId, saved: true, chosenIndex: 0 });
    expect(el.created).toHaveLength(2);
    expect(consumeDailyCap).toHaveBeenCalledTimes(2);
  });

  it("an eviction drops only the evicted take", async () => {
    const a = await selectPreview(DESC, 0);
    const b = await selectPreview(DESC, 1);
    store.set("evict", [{ descKey: `${DESC}#0`, voiceId: a.voiceId, lastUsed: 0 }]);
    await selectPreview(DESC, 2);
    expect(el.deleted).toContain(a.voiceId);
    expect(takeVoice(rec(), 0)).toBeNull();
    expect(takeVoice(rec(), 1)).toBe(b.voiceId);
    expect(takeVoice(rec(), 2)).not.toBeNull();
  });
});
