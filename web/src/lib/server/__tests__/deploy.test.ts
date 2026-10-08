import { afterEach, describe, expect, it, vi } from "vitest";

// Fail closed on Vercel: env.ts reads the deployment from process.env, and requireStore refuses without Redis or without
// RATE_LIMIT_SALT on every deployment, Preview included. Development keeps its fallbacks.
vi.mock("server-only", () => ({}));
vi.mock("next/server", () => ({ after: vi.fn() }));
vi.mock("@upstash/redis", () => ({ Redis: { fromEnv: () => ({}) } }));

async function load(vars: Record<string, string>) {
  vi.resetModules();
  for (const name of ["VERCEL", "VERCEL_ENV", "RATE_LIMIT_SALT", "FTV_MOCK_ELEVENLABS", "FTV_MOCK_CLAUDE", "UPSTASH_REDIS_REST_URL", "UPSTASH_REDIS_REST_TOKEN", "KV_REST_API_URL", "KV_REST_API_TOKEN"]) vi.stubEnv(name, "");
  for (const [name, value] of Object.entries(vars)) vi.stubEnv(name, value);
  return { ...(await import("../env")), ...(await import("../ratelimit")) };
}

const REDIS = { UPSTASH_REDIS_REST_URL: "https://redis.example", UPSTASH_REDIS_REST_TOKEN: "t" };

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("on a Vercel deployment", () => {
  it("a Preview fails closed without Redis, like Production", async () => {
    for (const VERCEL_ENV of ["preview", "production"]) {
      const { env, requireStore } = await load({ VERCEL: "1", VERCEL_ENV, RATE_LIMIT_SALT: "s" });
      expect(env.isDeployed).toBe(true);
      expect(() => requireStore()).toThrow(expect.objectContaining({ code: "unavailable", status: 503 }));
    }
  });

  it("requires RATE_LIMIT_SALT: no development salt, 503 until it is set", async () => {
    const without = await load({ VERCEL: "1", VERCEL_ENV: "production", ...REDIS });
    expect(without.env.rateLimitSalt).toBe("");
    expect(() => without.requireStore()).toThrow(expect.objectContaining({ code: "unavailable", status: 503 }));
    const withSalt = await load({ VERCEL: "1", VERCEL_ENV: "preview", RATE_LIMIT_SALT: "s", ...REDIS });
    expect(() => withSalt.requireStore()).not.toThrow();
  });
});

describe("mock flags", () => {
  it("work in development and are ignored on any deployment", async () => {
    const dev = await load({ FTV_MOCK_ELEVENLABS: "1", FTV_MOCK_CLAUDE: "1" });
    expect(dev.env).toMatchObject({ mockElevenLabs: true, mockClaude: true });
    const deployed = await load({ VERCEL: "1", VERCEL_ENV: "preview", FTV_MOCK_ELEVENLABS: "1", FTV_MOCK_CLAUDE: "1" });
    expect(deployed.env).toMatchObject({ mockElevenLabs: false, mockClaude: false });
  });
});

describe("in development", () => {
  it("runs without Redis or a salt", async () => {
    const { env, requireStore } = await load({});
    expect(env).toMatchObject({ isDeployed: false, rateLimitSalt: "dev-only-salt" });
    expect(() => requireStore()).not.toThrow();
  });
});
