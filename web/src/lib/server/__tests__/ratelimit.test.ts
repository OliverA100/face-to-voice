import { describe, expect, it, vi } from "vitest";

// The in-memory fallback used without Redis (local development): 10× the production limits.
const env = vi.hoisted(() => ({ hasRedis: false, isDeployed: false, rateLimitSalt: "test-salt", caps: { castingsPerDay: 3, designsPerDay: 2, savesPerDay: 1, speakCharsPerDay: 100 } }));
vi.mock("server-only", () => ({}));
vi.mock("next/server", () => ({ after: vi.fn() }));
vi.mock("../env", () => ({ env }));

import { checkVisitorLimit, consumeDailyCap, dailyUsage, refundDailyCap, requireStore, visitorId } from "../ratelimit";

const from = (ip: string) => new Request("http://localhost/api/voice/select", { method: "POST", headers: { "x-forwarded-for": `${ip}, 10.0.0.1` } });

describe("visitor limits without Redis", () => {
  it("allow 10× the per-visitor limit, per visitor", async () => {
    for (let i = 0; i < 30; i++) await checkVisitorLimit(from("1.1.1.1"), "select"); // select: 3 per day
    await expect(checkVisitorLimit(from("1.1.1.1"), "select")).rejects.toMatchObject({ code: "visitor_limit", status: 429 });
    await expect(checkVisitorLimit(from("2.2.2.2"), "select")).resolves.toBeUndefined();
    await expect(checkVisitorLimit(from("1.1.1.1"), "speak")).resolves.toBeUndefined();
  });
});

describe("daily caps without Redis", () => {
  it("count units up to 10× the cap, refuse past it without counting, and report usage", async () => {
    expect(await consumeDailyCap("speakChars", 600)).toEqual({ used: 600, limit: 1000 });
    await expect(consumeDailyCap("speakChars", 401)).rejects.toMatchObject({ code: "daily_cap", status: 429 });
    expect(await consumeDailyCap("speakChars", 400)).toEqual({ used: 1000, limit: 1000 });
    expect(await dailyUsage()).toEqual({ castings: { used: 0, limit: 3 }, designs: { used: 0, limit: 2 }, saves: { used: 0, limit: 1 }, speakChars: { used: 1000, limit: 100 } });
  });
});

describe("refundDailyCap without Redis", () => {
  it("gives reserved units back, never below zero", async () => {
    const before = (await dailyUsage()).designs.used;
    await consumeDailyCap("designs", 3);
    await refundDailyCap("designs", 3);
    expect((await dailyUsage()).designs.used).toBe(before);
    await refundDailyCap("designs", 99);
    expect((await dailyUsage()).designs.used).toBe(0);
  });
});

describe("requireStore without Redis", () => {
  it("runs in development and fails closed on any Vercel deployment (Production or Preview)", () => {
    expect(() => requireStore()).not.toThrow();
    env.isDeployed = true;
    expect(() => requireStore()).toThrow(expect.objectContaining({ code: "unavailable", status: 503 }));
    env.isDeployed = false;
  });
});

describe("visitorId", () => {
  it("is a stable, salted hash of the IP, and refuses without a salt", () => {
    expect(visitorId(from("1.1.1.1"))).toBe(visitorId(from("1.1.1.1")));
    expect(visitorId(from("1.1.1.1"))).not.toBe(visitorId(from("2.2.2.2")));
    env.rateLimitSalt = "";
    expect(() => visitorId(from("1.1.1.1"))).toThrow(expect.objectContaining({ code: "unavailable", status: 503 }));
    env.rateLimitSalt = "test-salt";
  });
});
