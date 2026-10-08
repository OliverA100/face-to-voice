import { beforeEach, describe, expect, it, vi } from "vitest";

// POST /api/voice/speak with the real daily cap (in-memory) and speech cache; ElevenLabs, the gates and the voice
// record are fakes. A generation is charged before ElevenLabs is called, refunded when it fails; a cache hit is free.
const env = vi.hoisted(() => ({ hasRedis: false, hasBlob: false, isDeployed: false, rateLimitSalt: "test-salt", caps: { designsPerDay: 1, savesPerDay: 1, speakCharsPerDay: 6 } }));
const store = vi.hoisted(() => new Map<string, unknown>());
const pending = vi.hoisted(() => [] as Promise<unknown>[]);

vi.mock("server-only", () => ({}));
vi.mock("next/server", () => ({ after: (fn: () => Promise<unknown>) => void pending.push(fn()) }));
vi.mock("@/lib/server/env", () => ({ env }));
vi.mock("@/lib/server/guards", () => ({ guard: async () => {} }));
vi.mock("@/lib/server/cache", () => ({
  cacheGet: async (k: string) => store.get(k) ?? null,
  cacheSet: async (k: string, v: unknown) => void store.set(k, v),
  storeAudio: vi.fn(),
}));
vi.mock("@/lib/server/elevenlabs", () => ({
  TTS_MODEL: "tts-model",
  streamSpeech: vi.fn(),
  UpstreamError: class extends Error {
    constructor(
      readonly upstreamStatus = 500,
      readonly upstreamCode = "",
    ) {
      super("upstream");
    }
  },
}));
vi.mock("@/lib/server/voice", () => ({ voiceRecord: async () => ({ voiceId: "voice-1" }), takeVoice: vi.fn((r: { voiceId: string }) => r.voiceId), voiceSpoken: vi.fn(async () => {}), voiceGone: vi.fn(async () => {}) }));

import { POST } from "@/app/api/voice/speak/route";
import { streamSpeech, UpstreamError } from "@/lib/server/elevenlabs";
import { takeVoice, voiceGone, voiceSpoken } from "@/lib/server/voice";
import { ApiError } from "@/lib/server/errors";
import { dailyUsage } from "@/lib/server/ratelimit";

const DESC = "a".repeat(64);
const say = (text: string) => POST(new Request("http://localhost/api/voice/speak", { method: "POST", body: JSON.stringify({ descKey: DESC, text }) }));
const speakChars = async () => (await dailyUsage()).speakChars.used;
const ndjson = (s: string) => new Response(s).body!;
/** A whole (silent) clip of `text`: only complete streams are cached (speech.ts completeClip). */
const clip = (text: string) => ndjson(JSON.stringify({ audio_base64: "", alignment: { characters: [...text], character_start_times_seconds: [...text].map(() => 0), character_end_times_seconds: [...text].map(() => 0) } }) + "\n");

beforeEach(async () => {
  await Promise.all(pending.splice(0));
  vi.mocked(streamSpeech).mockReset().mockImplementation(async (_voice: string, text: string) => clip(text));
});

describe("POST /api/voice/speak and the daily character cap (60 characters in development)", () => {
  it("charges a generation, serves a repeat from the cache for free", async () => {
    const line = "Hello there, traveller."; // 23 characters
    const first = await say(line);
    expect(first.headers.get("x-ftv-cache")).toBe("miss");
    await first.text();
    await Promise.all(pending.splice(0)); // the cache write
    expect(await speakChars()).toBe(23);
    vi.mocked(streamSpeech).mockClear();
    const again = await say(line);
    expect(again.headers.get("x-ftv-cache")).toBe("hit");
    expect(streamSpeech).not.toHaveBeenCalled();
    expect(await speakChars()).toBe(23);
  });

  it("gives the characters back when ElevenLabs fails", async () => {
    vi.mocked(streamSpeech).mockRejectedValueOnce(new ApiError("upstream", "down", 502));
    const res = await say("This one fails upstream.");
    expect(res.status).toBe(502);
    expect(await speakChars()).toBe(23);
  });

  it("over the cap: 429 without calling ElevenLabs", async () => {
    const res = await say("A line far too long for what is left of today's budget, by design."); // 23 + 66 > 60
    expect(res.status).toBe(429);
    expect(await res.json()).toMatchObject({ error: "daily_cap" });
    expect(streamSpeech).not.toHaveBeenCalled();
    expect(await speakChars()).toBe(23);
  });

  it("answers a body that isn't JSON with 400 bad_request", async () => {
    const res = await POST(new Request("http://localhost/api/voice/speak", { method: "POST", body: "{not json" }));
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "bad_request" });
  });
});

describe("POST /api/voice/speak and a voice that is gone", () => {
  it("a take whose voice was retired (evicted): 410 with what to do, not 'pick a voice first'", async () => {
    vi.mocked(takeVoice).mockReturnValueOnce(null);
    const res = await say("Hello again.");
    expect(res.status).toBe(410);
    expect(await res.json()).toMatchObject({ error: "expired", message: expect.stringContaining("Choose it again") });
  });

  it("a voice deleted upstream (404): forgotten, so choosing the take again saves a new one; the characters come back", async () => {
    const before = await speakChars();
    vi.mocked(streamSpeech).mockRejectedValueOnce(new UpstreamError(404, "voice_not_found"));
    const res = await say("Is anyone there?");
    expect(res.status).toBe(410);
    expect(voiceGone).toHaveBeenCalledWith(DESC, "voice-1");
    expect(await speakChars()).toBe(before);
  });

  it("speaking tells the pool the voice is in use", async () => {
    vi.mocked(voiceSpoken).mockClear();
    await (await say("Still here.")).text();
    expect(voiceSpoken).toHaveBeenCalledWith(expect.anything(), undefined, "voice-1");
  });
});
