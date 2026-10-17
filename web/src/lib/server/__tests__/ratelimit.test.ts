import { describe, expect, it, vi } from "vitest";

// The in-memory fallback used without Redis (local development): 10× the production limits.
const env = vi.hoisted(() => ({ hasRedis: false, isDeployed: false, rateLimitSalt: "test-salt", caps: { castingsPerDay: 3, designsPerDay: 2, savesPerDay: 1, speakCharsPerDay: 100, profilesPerDay: 5, talksPerDay: 2 } }));
vi.mock("server-only", () => ({}));
vi.mock("next/server", () => ({ after: vi.fn() }));
vi.mock("../env", () => ({ env }));

import { checkVisitorLimit, consumeDailyCap, dailyUsage, nextResetMs, refundDailyCap, requireStore, visitorId, visitorUsage } from "../ratelimit";
import { newVisitorCookie } from "../visitor";

/** A request from `ip`, from the browser holding `cookie` (a visitor cookie value), or from one without cookies. */
const from = (ip: string, cookie?: string) =>
  new Request("http://localhost/api/voice/select", { method: "POST", headers: { "x-forwarded-for": `${ip}, 10.0.0.1`, ...(cookie ? { cookie: `ftv_visitor=${cookie}` } : {}) } });
const browser = () => newVisitorCookie()!;
const NETWORK_MESSAGE = "Picking voices is paused here for today. It comes back at midnight UTC.";

describe("visitor limits without Redis", () => {
  it("allow 10× the per-visitor limit, per browser: two browsers on one network have one each", async () => {
    const [a, b] = [browser(), browser()];
    for (let i = 0; i < 100; i++) await checkVisitorLimit(from("1.1.1.1", a), "select"); // select: 10 per day
    await expect(checkVisitorLimit(from("1.1.1.1", a), "select")).rejects.toMatchObject({ code: "visitor_limit", status: 429 });
    await expect(checkVisitorLimit(from("2.2.2.2", a), "select")).rejects.toMatchObject({ code: "visitor_limit" }); // another network: still that browser
    await expect(checkVisitorLimit(from("1.1.1.1", b), "select")).resolves.toBeUndefined();
  });

  it("stop a loop that clears its cookie at the network's ceiling (30 a day, 10× here)", async () => {
    for (let i = 0; i < 300; i++) await checkVisitorLimit(from("5.5.5.5", browser()), "select");
    await expect(checkVisitorLimit(from("5.5.5.5", browser()), "select")).rejects.toMatchObject({ code: "visitor_limit", status: 429, message: NETWORK_MESSAGE });
    await expect(checkVisitorLimit(from("5.5.5.5"), "select")).rejects.toMatchObject({ message: NETWORK_MESSAGE });
    await expect(checkVisitorLimit(from("5.5.5.6", browser()), "select")).resolves.toBeUndefined();
  });

  it("don't count a browser's refused picks against its network", async () => {
    const spent = browser();
    for (let i = 0; i < 100; i++) await checkVisitorLimit(from("6.6.6.6", spent), "select");
    for (let i = 0; i < 50; i++) await expect(checkVisitorLimit(from("6.6.6.6", spent), "select")).rejects.toMatchObject({ code: "visitor_limit" });
    for (let i = 0; i < 200; i++) await checkVisitorLimit(from("6.6.6.6", browser()), "select"); // the network has 200 of its 300 left
  });

  it("count an IPv6 network by its /64: rotating addresses don't make a new one", async () => {
    for (let i = 0; i < 300; i++) await checkVisitorLimit(from(`2001:db8:7:7::${i.toString(16)}`, browser()), "select");
    await expect(checkVisitorLimit(from("2001:db8:7:7:abcd::1", browser()), "select")).rejects.toMatchObject({ message: NETWORK_MESSAGE });
    await expect(checkVisitorLimit(from("2001:db8:7:8::1", browser()), "select")).resolves.toBeUndefined();
  });

  it("count only the network without a cookie", async () => {
    for (let i = 0; i < 300; i++) await checkVisitorLimit(from("8.8.8.8"), "select"); // past one browser's 100
    await expect(checkVisitorLimit(from("8.8.8.8"), "select")).rejects.toMatchObject({ message: NETWORK_MESSAGE });
    const { per, usage } = await visitorUsage(from("8.8.8.8")); // the dialog shows the network's count
    expect({ per, select: usage.select }).toEqual({ per: "network", select: { used: 300, limit: 300, network: { used: 300, limit: 300 } } });
  });
});

describe("what a refusal says", () => {
  it("names the visitor's own allowance, or the whole site's budget, and when it comes back", async () => {
    const mine = browser();
    for (let i = 0; i < 100; i++) await checkVisitorLimit(from("3.3.3.3", mine), "select"); // voices picked: 10 per day
    await expect(checkVisitorLimit(from("3.3.3.3", mine), "select")).rejects.toMatchObject({ message: "You've picked all 10 of your voices for today. More come back at midnight UTC." });
    expect(await visitorUsage(from("3.3.3.3", mine))).toEqual({
      per: "browser",
      usage: { select: { used: 100, limit: 100, network: { used: 100, limit: 300 } }, invite: { used: 0, limit: 300, network: { used: 0, limit: 600 } } },
    });
    expect((await visitorUsage(from("3.3.3.3", browser()))).usage.select).toEqual({ used: 0, limit: 100, network: { used: 100, limit: 300 } }); // another browser there
    await consumeDailyCap("talks", 20);
    await expect(consumeDailyCap("talks")).rejects.toMatchObject({ message: expect.stringContaining("paused for everyone") });
    await refundDailyCap("talks", 20);
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
  it("is the browser's id, or without a cookie a stable, salted hash of the network; refuses without a salt", async () => {
    const mine = browser();
    expect(visitorId(from("1.1.1.1", mine))).toBe(visitorId(from("2.2.2.2", mine)));
    expect(visitorId(from("1.1.1.1"))).toBe(visitorId(from("1.1.1.1")));
    expect(visitorId(from("1.1.1.1"))).not.toBe(visitorId(from("2.2.2.2")));
    env.rateLimitSalt = "";
    expect(() => visitorId(from("1.1.1.1"))).toThrow(expect.objectContaining({ code: "unavailable", status: 503 }));
    await expect(checkVisitorLimit(from("1.1.1.1", mine), "select")).rejects.toMatchObject({ code: "unavailable", status: 503 });
    env.rateLimitSalt = "test-salt";
  });
});
