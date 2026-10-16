import { beforeEach, describe, expect, it, vi } from "vitest";

// POST /api/character/profile with the real keys, limits (in memory) and cache (a Map); Claude and the visitor's cached
// casting are fakes. A profile is written once and shared; "Recast" stays with the visitor who asked for it.
const env = vi.hoisted(() => ({ hasRedis: false, hasBlob: false, isDeployed: false, rateLimitSalt: "test-salt", caps: { profilesPerDay: 3 } }));
const store = vi.hoisted(() => new Map<string, unknown>());
const casting = vi.hoisted(() => ({ value: null as unknown, look: {} as Record<string, string> }));
const locks = vi.hoisted(() => new Set<string>());

vi.mock("server-only", () => ({}));
vi.mock("next/server", () => ({ after: (fn: () => Promise<unknown>) => void fn() }));
vi.mock("@/lib/server/env", () => ({ env }));
vi.mock("@/lib/server/guards", () => ({ guard: async () => {} }));
vi.mock("@/lib/server/cache", () => ({
  cacheGet: async (k: string) => store.get(k) ?? null,
  cacheSet: async (k: string, v: unknown) => void store.set(k, v),
  acquireLock: async (k: string) => (locks.has(k) ? null : (locks.add(k), "token")),
  releaseLock: async (k: string) => void locks.delete(k),
}));
vi.mock("@/lib/server/voice", () => ({
  castingFor: vi.fn(async () => casting.value),
  castingLook: async () => casting.look,
  keepIdentity: async () => {},
  waitFor: async <T,>(get: () => Promise<T | null>) => {
    for (let i = 0; i < 50; i++) {
      await new Promise((r) => setTimeout(r, 1));
      const v = await get();
      if (v) return v;
    }
    return null;
  },
}));
vi.mock("@/lib/server/profileClaude", () => ({ writeProfile: vi.fn() }));

import { POST as profile } from "@/app/api/character/profile/route";
import { mockProfile } from "@/lib/server/mockProfile";
import { writeProfile } from "@/lib/server/profileClaude";
import { clampProfile } from "@/lib/server/profileSchema";
import { descriptionKey } from "@/lib/server/keys";
import { descriptionIdentity, type DescriptionFields } from "@/lib/server/prompt";
import { dailyUsage } from "@/lib/server/ratelimit";
import { newVisitorCookie } from "@/lib/server/visitor";

const FIELDS: DescriptionFields = {
  presentation: "feminine", ageRange: "70s", character: "distinct", build: "average", energy: "calm", pacing: "slow", pitch: "medium-low",
  mood1: "gruff", mood2: "warm", accent: "cornish", accentStrength: "moderate", ethnicity: "white", persona: "retired ferry captain",
  timbre: "weathered", quirk: "", line: "Mind the tide.", emotion: "neutral", emotionIntensity: 0,
};
const DESC = descriptionKey(descriptionIdentity(FIELDS));
const FACE = "f".repeat(64);
const GENERATED = clampProfile(mockProfile(FIELDS));

const call = (route: typeof profile, body: object, ip = "1.1.1.1", cookie?: string) =>
  route(
    new Request("http://localhost/api/character/profile", {
      method: "POST",
      headers: { "x-real-ip": ip, ...(cookie ? { cookie: `ftv_visitor=${cookie}` } : {}) },
      body: JSON.stringify({ faceKey: FACE, descKey: DESC, ...body }),
    }),
  );
const json = async (r: Response) => ({ status: r.status, body: await r.json() });
const used = async () => (await dailyUsage()).profiles.used;

beforeEach(() => {
  store.clear();
  locks.clear();
  casting.value = FIELDS;
  casting.look = {};
  vi.mocked(writeProfile).mockReset().mockImplementation(async () => GENERATED);
});

describe("POST /api/character/profile", () => {
  it("writes a profile once, charges it, and shares it with the next visitor for free", async () => {
    const before = await used();
    const first = await json(await call(profile, {}));
    expect(first).toEqual({ status: 200, body: { profile: GENERATED, own: false } });
    expect(await used()).toBe(before + 1);
    const other = await json(await call(profile, {}, "2.2.2.2"));
    expect(other.body).toEqual({ profile: GENERATED, own: false });
    expect(writeProfile).toHaveBeenCalledTimes(1);
    expect(await used()).toBe(before + 1);
  });

  it("asks for a recast without this visitor's casting for the face (410), refuses another voice (400)", async () => {
    casting.value = null;
    expect(await json(await call(profile, {}))).toMatchObject({ status: 410, body: { error: "recast" } }); // the browser recasts and asks again
    casting.value = FIELDS;
    expect((await call(profile, { descKey: "a".repeat(64) })).status).toBe(400);
    expect(writeProfile).not.toHaveBeenCalled();
  });

  it("'Recast' is kept as this visitor's own; others keep the shared one", async () => {
    await call(profile, {});
    const another = { ...GENERATED, name: "Tamsin Rowe" };
    vi.mocked(writeProfile).mockResolvedValueOnce(another);
    expect((await json(await call(profile, { regenerate: true }))).body).toEqual({ profile: another, own: true });
    expect((await json(await call(profile, {}))).body).toEqual({ profile: another, own: true });
    expect((await json(await call(profile, {}, "3.3.3.3"))).body).toEqual({ profile: GENERATED, own: false });
  });

  it("keeps a 'Recast' with the browser that asked: another browser on the same Wi-Fi meets the shared one", async () => {
    const [mine, theirs] = [newVisitorCookie()!, newVisitorCookie()!];
    await call(profile, {}, "1.1.1.1", mine);
    const another = { ...GENERATED, name: "Tamsin Rowe" };
    vi.mocked(writeProfile).mockResolvedValueOnce(another);
    expect((await json(await call(profile, { regenerate: true }, "1.1.1.1", mine))).body).toEqual({ profile: another, own: true });
    expect((await json(await call(profile, {}, "1.1.1.1", theirs))).body).toEqual({ profile: GENERATED, own: false });
    expect((await json(await call(profile, {}, "1.1.1.1"))).body).toEqual({ profile: GENERATED, own: false }); // no cookie: the network's
    expect((await json(await call(profile, {}, "9.9.9.9", mine))).body).toEqual({ profile: another, own: true }); // a new network: still theirs
  });

  it("gives the charge back when Claude fails", async () => {
    const before = await used();
    vi.mocked(writeProfile).mockRejectedValueOnce(new Error("down"));
    expect((await call(profile, {})).status).toBe(502);
    expect(await used()).toBe(before);
  });

  it("writes a shared profile once when two visitors meet the character at the same moment", async () => {
    let finish!: () => void;
    vi.mocked(writeProfile).mockImplementationOnce(() => new Promise((r) => (finish = () => r(GENERATED))));
    const first = call(profile, {});
    await new Promise((r) => setTimeout(r, 5)); // the first one holds the lock and is writing
    const second = call(profile, {}, "2.2.2.2");
    finish();
    expect((await json(await first)).body).toEqual({ profile: GENERATED, own: false });
    expect((await json(await second)).body).toEqual({ profile: GENERATED, own: false });
    expect(writeProfile).toHaveBeenCalledTimes(1);
  });

  it("takes the look from the server's copy of the casting, not from the request", async () => {
    casting.look = { glasses: "round" };
    await call(profile, { look: { glasses: "none" } });
    expect(vi.mocked(writeProfile).mock.calls[0][0].look).toMatch(/round/i);
  });
});
