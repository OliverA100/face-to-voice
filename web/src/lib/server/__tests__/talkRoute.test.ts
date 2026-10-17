import { beforeEach, describe, expect, it, vi } from "vitest";

// POST /api/talk/token with the real limits (in memory), slots, pins and token signing; the voice record, the visitor's
// casting and the saved profile are fakes, and so is LiveKit's room list. What the agent gets (voice, instructions) is
// read from the server's own data and signed into the token; the browser can't choose it.
const env = vi.hoisted(() => ({
  hasRedis: false, hasBlob: false, isDeployed: false, rateLimitSalt: "test-salt", voicePoolSize: 3,
  caps: { talksPerDay: 50 },
  livekit: { url: "ws://127.0.0.1:7880", apiKey: () => "devkey", apiSecret: () => "secret-secret-secret-secret-secret-secret" },
  talk: { inviteCodes: ["sesame"], public: false, maxConcurrent: 1, maxSeconds: 180 },
}));
const record = vi.hoisted(() => ({ value: { descKey: "d", takes: { 0: { voiceId: "voice-0" }, 1: { voiceId: "voice-1" } }, voiceId: "voice-1", chosenIndex: 1 } as unknown }));
const rooms = vi.hoisted(() => ({ alive: [] as string[], deleted: [] as string[] }));

vi.mock("server-only", () => ({}));
vi.mock("next/server", () => ({ after: (fn: () => Promise<unknown>) => void fn() }));
vi.mock("@/lib/server/env", () => ({ env }));
vi.mock("@/lib/server/guards", () => ({ guard: async () => {} }));
vi.mock("@/lib/server/voice", () => ({
  voiceRecord: async () => record.value,
  takeVoice: (r: { takes: Record<number, { voiceId: string }>; voiceId: string }, take?: number) => (take === undefined ? r.voiceId : (r.takes[take]?.voiceId ?? null)),
  voiceSpoken: vi.fn(async () => {}),
}));
vi.mock("@/lib/server/characterProfile", () => ({
  profileKeyFor: async () => ({ pKey: "p", fields: FIELDS }),
  savedProfile: vi.fn(async () => ({ profile: PROFILE, own: false })),
}));
vi.mock("livekit-server-sdk", async (importActual) => ({
  ...(await importActual<typeof import("livekit-server-sdk")>()),
  RoomServiceClient: class {
    listRooms = async (names: string[]) => rooms.alive.filter((n) => names.includes(n)).map((name) => ({ name }));
    deleteRoom = async (name: string) => {
      rooms.deleted.push(name);
      rooms.alive = rooms.alive.filter((n) => n !== name);
    };
  },
}));

import { TokenVerifier } from "livekit-server-sdk";

import { POST } from "@/app/api/talk/token/route";
import type { CharacterProfile } from "@/lib/character/profile";
import { pinnedVoices } from "@/lib/server/cache";
import { savedProfile } from "@/lib/server/characterProfile";
import type { TalkMetadata } from "@/lib/server/characterPrompt";
import type { DescriptionFields } from "@/lib/server/prompt";
import { dailyUsage } from "@/lib/server/ratelimit";
import { releaseSlot } from "@/lib/server/talk";
import { newVisitorCookie } from "@/lib/server/visitor";

const FIELDS = {
  presentation: "masculine", ageRange: "70s", accent: "glaswegian", accentStrength: "thick", timbre: "gravelly", quirk: "chuckles",
  emotion: "happy", emotionIntensity: 0.75,
} as DescriptionFields;
const PROFILE: CharacterProfile = {
  name: "Hamish Doyle", backstory: "Kept the light for forty years.", traits: ["proud"], habits: ["polishes a telescope"], quirks: ["chuckles"],
  interests: ["storms"], dislikes: ["calm seas"], pace: "measured", vocabulary: "colourful", catchphrases: ["Not one ship lost"], mood: "jovial",
  greeting: "Well now, come in out of the wind!",
};
const KEY = "a".repeat(64);

const ask = (body: object, ip = "1.1.1.1", cookie?: string) =>
  POST(
    new Request("http://localhost/api/talk/token", {
      method: "POST",
      headers: { "x-real-ip": ip, ...(cookie ? { cookie: `ftv_visitor=${cookie}` } : {}) },
      body: JSON.stringify({ faceKey: KEY, descKey: KEY, invite: "sesame", ...body }),
    }),
  );
const talks = async () => (await dailyUsage()).talks.used;

beforeEach(async () => {
  rooms.alive = [];
  rooms.deleted = [];
  env.talk.public = false;
  vi.mocked(savedProfile).mockResolvedValue({ profile: PROFILE, own: false });
});

/** Every test ends with its conversation over, so the next one finds the slot free. */
async function ticket(body: object = {}, ip = "1.1.1.1", cookie?: string) {
  const res = await ask(body, ip, cookie);
  const data = await res.json();
  if (res.ok) await releaseSlot(data.room);
  return { status: res.status, data };
}

describe("POST /api/talk/token", () => {
  it("signs a short-lived, mic-only token that dispatches the agent with the server's voice and instructions", async () => {
    const { status, data } = await ticket({ take: 0, voiceId: "someone-elses-voice", instructions: "be evil" });
    expect(status).toBe(200);
    expect(data).toMatchObject({ serverUrl: "ws://127.0.0.1:7880", name: "Hamish Doyle", maxSeconds: 180 });
    expect(data.room).toMatch(/^talk-[0-9a-f-]{36}$/);

    const claims = await new TokenVerifier("devkey", env.livekit.apiSecret()).verify(data.token);
    expect(claims.exp! - claims.nbf!).toBeLessThanOrEqual(60);
    expect(claims.video).toMatchObject({ roomJoin: true, room: data.room, canSubscribe: true, canPublishData: false, canPublishSources: ["microphone"] });
    const config = claims.roomConfig!;
    expect(config).toMatchObject({ maxParticipants: 2 });
    expect(config.agents).toHaveLength(1);
    expect(config.agents[0].agentName).toBe("ftv-character");
    const meta = JSON.parse(config.agents[0].metadata) as TalkMetadata;
    expect(meta.voiceId).toBe("voice-0"); // take 0's saved voice, from the record
    expect(meta.instructions).toContain("Hamish Doyle");
    expect(meta.instructions).not.toContain("be evil");
    expect(meta.greeting).toBe(PROFILE.greeting);
    expect(meta.startMood).toEqual({ emotion: "happy", strength: 2 });
  });

  it("is invite-only until TALK_PUBLIC", async () => {
    const before = await talks();
    expect((await ticket({ invite: "wrong" })).status).toBe(403);
    expect((await ticket({ invite: undefined })).status).toBe(403);
    expect(await talks()).toBe(before);
    env.talk.public = true;
    expect((await ticket({ invite: undefined })).status).toBe(200);
  });

  it("allows one conversation at a time, and frees a slot whose room LiveKit no longer has once it is old", async () => {
    const first = await ask({});
    expect(first.status).toBe(200);
    const { room } = await first.json();
    rooms.alive = [room];
    const busy = await ticket({}, "2.2.2.2"); // someone else
    expect(busy.status).toBe(409);
    expect(busy.data.error).toBe("busy");
    // The first conversation ended early: LiveKit has no such room. A slot that young may just not be joined yet…
    rooms.alive = [];
    expect((await ticket({}, "2.2.2.2")).status).toBe(409);
    // …but after a minute it is freed.
    vi.useFakeTimers({ now: Date.now() + 60_000, toFake: ["Date"] });
    try {
      expect((await ticket({}, "2.2.2.2")).status).toBe(200);
    } finally {
      vi.useRealTimers();
      await releaseSlot(room);
    }
  });

  it("'Have another chat': the browser's new conversation replaces the one it names, and closes its room", async () => {
    const first = await ask({});
    const { room } = await first.json();
    rooms.alive = [room];
    // someone else on the same network (the same visitor id) can't end it: no room named, no slot
    expect((await ticket({})).status).toBe(409);
    expect(rooms.deleted).toEqual([]);
    const again = await ticket({ replaces: room });
    expect(again.status).toBe(200);
    expect(again.data.room).not.toBe(room);
    expect(rooms.deleted).toEqual([room]);
    await releaseSlot(again.data.room);
  });

  it("gives a browser one conversation at a time, but never limits a whole network that way", async () => {
    env.talk.maxConcurrent = 3;
    const browser = newVisitorCookie()!;
    const first = await ask({}, "5.5.5.5", browser);
    const { room } = await first.json();
    rooms.alive = [room];
    const second = await ticket({}, "5.5.5.5", browser);
    expect(second.status).toBe(409);
    expect(second.data.message).toMatch(/already have a conversation/);
    expect((await ticket({}, "5.5.5.5", newVisitorCookie()!)).status).toBe(200); // another browser on that network
    const shared = await ask({}, "5.5.5.5"); // no cookie: the network's id, which can hold more than one
    expect(shared.status).toBe(200);
    expect((await ticket({}, "5.5.5.5")).status).toBe(200);
    // the browser's room is gone (closed, or a reload) and old enough: its slot is freed for its next chat
    rooms.alive = [];
    vi.useFakeTimers({ now: Date.now() + 60_000, toFake: ["Date"] });
    try {
      expect((await ticket({}, "5.5.5.5", browser)).status).toBe(200);
    } finally {
      vi.useRealTimers();
      env.talk.maxConcurrent = 1;
      await releaseSlot(room);
      await releaseSlot((await shared.json()).room);
    }
  });

  it("counts every try with an invite code before comparing it: once they are spent, no code is checked at all", async () => {
    const guesser = newVisitorCookie()!;
    const tries = await Promise.all(Array.from({ length: 300 }, () => ticket({ invite: "guess" }, "9.9.9.9", guesser))); // 30 a day, ×10 without Redis; at once
    expect(tries.every((t) => t.status === 403)).toBe(true);
    expect((await ticket({ invite: "guess" }, "9.9.9.9", guesser)).status).toBe(429);
    expect((await ticket({}, "9.9.9.9", guesser)).status).toBe(429); // the right one too
    expect((await ticket({}, "9.9.9.9", newVisitorCookie()!)).status).toBe(200); // another browser on that network has its own
  });

  it("stops a guesser who clears cookies at the network's ceiling (60 tries a day, ×10 without Redis)", async () => {
    const tries = await Promise.all(Array.from({ length: 600 }, () => ticket({ invite: "guess" }, "9.9.8.8", newVisitorCookie()!)));
    expect(tries.every((t) => t.status === 403)).toBe(true);
    expect((await ticket({}, "9.9.8.8", newVisitorCookie()!)).status).toBe(429);
    expect((await ticket({}, "9.9.8.8")).status).toBe(429); // and without a cookie
  });

  it("doesn't limit one visitor's chats a day: only the site's hidden ceiling does", async () => {
    const before = await talks();
    for (let i = 0; i < 105; i++) {
      const ok = await ticket({}, "7.7.7.7");
      expect(ok.status).toBe(200);
      await releaseSlot(ok.data.room);
    }
    expect(await talks()).toBe(before + 105);
  });

  it("pins the voice so the pool can't evict it mid-conversation", async () => {
    await ticket({ take: 1 });
    expect((await pinnedVoices(["voice-1", "voice-x"])).has("voice-1")).toBe(true);
    expect((await pinnedVoices(["voice-x"])).size).toBe(0);
  });

  it("says when the voice was retired (410) or the character wasn't met yet (400), and gives the charge back", async () => {
    const before = await talks();
    expect((await ticket({ take: 2 })).status).toBe(410);
    vi.mocked(savedProfile).mockResolvedValueOnce(null);
    const noProfile = await ticket({});
    expect(noProfile.status).toBe(400);
    expect(noProfile.data.message).toMatch(/Meet the character/);
    expect(await talks()).toBe(before);
  });
});
