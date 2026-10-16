import { describe, expect, it, vi } from "vitest";

// The in-memory fallback used without Redis (local development): 10× the production limits.
const env = vi.hoisted(() => ({ hasRedis: false, isDeployed: false, rateLimitSalt: "test-salt", caps: { castingsPerDay: 3, designsPerDay: 2, savesPerDay: 1, speakCharsPerDay: 100, profilesPerDay: 5, talksPerDay: 2 } }));
vi.mock("server-only", () => ({}));
vi.mock("next/server", () => ({ after: vi.fn() }));
vi.mock("../env", () => ({ env }));

import { checkVisitorLimit, consumeDailyCap, dailyUsage, nextResetMs, refundDailyCap, requireStore, visitorId, visitorUsage } from "../ratelimit";

const from = (ip: string) => new Request("http://localhost/api/voice/select", { method: "POST", headers: { "x-forwarded-for": `${ip}, 10.0.0.1` } });

describe("visitor limits without Redis", () => {
  it("allow 10× the per-visitor limit, per visitor", async () => {
    for (let i = 0; i < 100; i++) await checkVisitorLimit(from("1.1.1.1"), "select"); // select: 10 per day
    await expect(checkVisitorLimit(from("1.1.1.1"), "select")).rejects.toMatchObject({ code: "visitor_limit", status: 429 });
    await expect(checkVisitorLimit(from("2.2.2.2"), "select")).resolves.toBeUndefined();
    await expect(checkVisitorLimit(from("1.1.1.1"), "speak")).resolves.toBeUndefined();
  });
});

describe("what a refusal says", () => {
  it("names the visitor's own allowance, or the whole site's budget, and when it comes back", async () => {
    for (let i = 0; i < 100; i++) await checkVisitorLimit(from("3.3.3.3"), "select"); // voices picked: 10 per day
    await expect(checkVisitorLimit(from("3.3.3.3"), "select")).rejects.toMatchObject({ message: "You've picked all 10 of your voices for today. More come back at midnight UTC." });
    expect(await visitorUsage(from("3.3.3.3"))).toEqual({ select: { used: 100, limit: 100 }, invite: { used: 0, limit: 300 } });
    await consumeDailyCap("talks", 20);
    await expect(consumeDailyCap("talks")).rejects.toMatchObject({ message: expect.stringContaining("paused for everyone") });
    await refundDailyCap("talks", 20);
  });

  it("limits nothing else per visitor: chats, lines, profiles, voice searches and switches (2026-10-16)", async () => {
    for (const route of ["talk", "speak", "profile", "design", "switch"] as const) for (let i = 0; i < 1500; i++) await checkVisitorLimit(from("4.4.4.4"), route);
  });

  it("resets at the next midnight UTC", () => {
    expect(new Date(nextResetMs(Date.parse("2026-10-15T17:40:00Z"))).toISOString()).toBe("2026-10-16T00:00:00.000Z");
  });
});

describe("daily caps without Redis", () => {
  it("count units up to 10× the cap, refuse past it without counting, and report usage", async () => {
    expect(await consumeDailyCap("speakChars", 600)).toEqual({ used: 600, limit: 1000 });
    await expect(consumeDailyCap("speakChars", 401)).rejects.toMatchObject({ code: "daily_cap", status: 429 });
    expect(await consumeDailyCap("speakChars", 400)).toEqual({ used: 1000, limit: 1000 });
    expect(await dailyUsage()).toEqual({ castings: { used: 0, limit: 3 }, designs: { used: 0, limit: 2 }, saves: { used: 0, limit: 1 }, speakChars: { used: 1000, limit: 100 }, profiles: { used: 0, limit: 5 }, talks: { used: 0, limit: 2 } });
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
