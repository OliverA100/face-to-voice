import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The production path: ratelimit.ts with Redis, through the real @upstash/ratelimit. Only the Upstash client is a fake,
// an in-memory store that answers the commands the app sends: the fixed window's two Lua scripts (count one use; read
// what is left), done here in JavaScript as the scripts do them, and the daily caps' INCRBY/EXPIRE/DECRBY/GET.
const env = vi.hoisted(() => ({ hasRedis: true, isDeployed: true, rateLimitSalt: "test-salt", caps: { castingsPerDay: 3, designsPerDay: 2, savesPerDay: 1, speakCharsPerDay: 100, profilesPerDay: 5, talksPerDay: 2 } }));
const redis = vi.hoisted(() => {
  const data = new Map<string, number>();
  const expiry = new Map<string, number>(); // key → ms it was given to live
  const state = { hang: false }; // a Redis that never answers
  const script = (source: string, keys: string[], args: (string | number)[]) => {
    if (state.hang) return new Promise(() => {});
    const [key] = keys;
    if (source.includes('redis.call("INCRBY"')) {
      // fixedWindowLimitScript: INCRBY the window's key, PEXPIRE it the first time, return {used, limit}
      const by = Number(args[2]);
      const used = (data.get(key) ?? 0) + by;
      data.set(key, used);
      if (used === by) expiry.set(key, Number(args[1]));
      return Promise.resolve([used, Number(args[0])]);
    }
    if (source.includes("usedTokens")) return Promise.resolve([Number(args[0]) - (data.get(key) ?? 0), Number(args[0])]); // {remaining, limit}
    throw new Error(`unexpected script: ${source.slice(0, 80)}`);
  };
  const client = {
    evalsha: async () => {
      throw new Error("NOSCRIPT No matching script"); // the library then sends the script itself
    },
    eval: script,
    get: async (key: string) => data.get(key) ?? null,
    decrby: async (key: string, by: number) => {
      data.set(key, (data.get(key) ?? 0) - by);
      return data.get(key);
    },
    pipeline: () => {
      const queue: (() => number)[] = [];
      const p = {
        incrby: (key: string, by: number) => (queue.push(() => (data.set(key, (data.get(key) ?? 0) + by), data.get(key)!)), p),
        expire: (key: string, seconds: number) => (queue.push(() => (expiry.set(key, seconds * 1000), 1)), p),
        exec: async () => queue.map((run) => run()),
      };
      return p;
    },
  };
  return { data, expiry, state, client };
});
const later = vi.hoisted(() => [] as Promise<unknown>[]);

vi.mock("server-only", () => ({}));
vi.mock("next/server", () => ({ after: (fn: () => unknown) => void later.push(Promise.resolve(fn())) }));
vi.mock("@upstash/redis", () => ({ Redis: { fromEnv: () => redis.client } }));
vi.mock("../env", () => ({ env }));

import { checkVisitorLimit, consumeDailyCap, dailyUsage, refundDailyCap, requireStore, visitorUsage } from "../ratelimit";
import { browserId, networkId, newVisitorCookie } from "../visitor";

const from = (ip: string, cookie?: string) =>
  new Request("http://localhost/api/voice/select", { method: "POST", headers: { "x-real-ip": ip, ...(cookie ? { cookie: `ftv_visitor=${cookie}` } : {}) } });
const browser = () => newVisitorCookie()!;
const pick = (ip: string, cookie?: string) => checkVisitorLimit(from(ip, cookie), "select");
const day = () => Math.floor(Date.now() / 86_400_000); // the fixed window's bucket: the UTC day
const NETWORK_MESSAGE = "Picking voices is paused here for today. It comes back at midnight UTC.";
const MIDNIGHT = new Date((day() + 1) * 86_400_000).toISOString();

beforeEach(() => {
  redis.data.clear();
  redis.expiry.clear();
  redis.state.hang = false;
});
afterEach(() => {
  vi.useRealTimers();
});

describe("visitor limits with Redis", () => {
  it("runs: a deployment with Redis and a salt doesn't fail closed", () => {
    expect(() => requireStore()).not.toThrow();
  });

  it("counts 10 a day per browser and 30 per network, under keys that hold no IP", async () => {
    const [a, b] = [browser(), browser()];
    for (let i = 0; i < 10; i++) await pick("1.1.1.1", a);
    await expect(pick("1.1.1.1", a)).rejects.toMatchObject({
      code: "visitor_limit",
      status: 429,
      message: "You've picked all 10 of your voices for today. More come back at midnight UTC.",
      extra: { resetAt: MIDNIGHT },
    });
    await pick("1.1.1.1", b); // another browser on the same Wi-Fi has its own 10
    const net = networkId(from("1.1.1.1"));
    expect(redis.data.get(`ftv:rl:select:${browserId(from("1.1.1.1", a))}:${day()}`)).toBe(11);
    expect(redis.data.get(`ftv:rl:select:${browserId(from("1.1.1.1", b))}:${day()}`)).toBe(1);
    expect(redis.data.get(`ftv:rl:net:select:${net}:${day()}`)).toBe(11); // a's refused pick never reached the network
    expect([...redis.data.keys()].join()).not.toContain("1.1.1.1");
    expect([...redis.expiry.values()].every((ms) => ms === 86_400_000)).toBe(true); // each window lives a day
  });

  it("stops a loop that clears its cookie at the network's 30", async () => {
    for (let i = 0; i < 30; i++) await pick("5.5.5.5", browser());
    await expect(pick("5.5.5.5", browser())).rejects.toMatchObject({ code: "visitor_limit", status: 429, message: NETWORK_MESSAGE, extra: { resetAt: MIDNIGHT } });
    await expect(pick("5.5.5.5")).rejects.toMatchObject({ message: NETWORK_MESSAGE }); // and without a cookie
    await pick("5.5.5.6", browser()); // another network is untouched
  });

  it("counts only the network without a cookie", async () => {
    for (let i = 0; i < 30; i++) await pick("8.8.8.8"); // past one browser's 10
    await expect(pick("8.8.8.8")).rejects.toMatchObject({ message: NETWORK_MESSAGE });
    expect([...redis.data.keys()].filter((k) => k.startsWith("ftv:rl:select:"))).toEqual([]);
  });

  it("counts an IPv6 network by its /64", async () => {
    for (let i = 0; i < 30; i++) await pick(`2001:db8:7:7::${i.toString(16)}`, browser());
    await expect(pick("2001:db8:7:7:abcd::1", browser())).rejects.toMatchObject({ message: NETWORK_MESSAGE });
    await pick("2001:db8:7:8::1", browser());
  });

  it("comes back at midnight UTC", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-16T23:59:00Z"));
    const mine = browser();
    for (let i = 0; i < 10; i++) await pick("9.9.9.9", mine);
    await expect(pick("9.9.9.9", mine)).rejects.toMatchObject({ extra: { resetAt: "2026-10-17T00:00:00.000Z" } });
    vi.setSystemTime(new Date("2026-10-17T00:00:01Z"));
    await pick("9.9.9.9", mine);
  });

  it("reads usage for the limits dialog without counting anything", async () => {
    const mine = browser();
    for (let i = 0; i < 3; i++) await pick("4.4.4.4", mine);
    await pick("4.4.4.4", browser());
    const before = new Map(redis.data);
    expect(await visitorUsage(from("4.4.4.4", mine))).toEqual({
      per: "browser",
      usage: { select: { used: 3, limit: 10, network: { used: 4, limit: 30 } }, invite: { used: 0, limit: 30, network: { used: 0, limit: 60 } } },
    });
    expect((await visitorUsage(from("4.4.4.4"))).usage.select).toEqual({ used: 4, limit: 30, network: { used: 4, limit: 30 } });
    expect(redis.data).toEqual(before);
  });

  it("refuses (503 busy) when Redis doesn't answer within 2 s, never lets the pick through", async () => {
    vi.useFakeTimers();
    redis.state.hang = true;
    const res = expect(pick("3.3.3.3", browser())).rejects.toMatchObject({ code: "busy", status: 503 });
    await vi.advanceTimersByTimeAsync(2000);
    await res;
  });
});

describe("daily caps with Redis", () => {
  it("count units, refuse past the cap and roll the refused units back, refund, and report", async () => {
    expect(await consumeDailyCap("speakChars", 60)).toEqual({ used: 60, limit: 100 });
    await expect(consumeDailyCap("speakChars", 41)).rejects.toMatchObject({ code: "daily_cap", status: 429 });
    await Promise.all(later.splice(0)); // the rollback runs after the response
    expect((await dailyUsage()).speakChars).toEqual({ used: 60, limit: 100 });
    await refundDailyCap("speakChars", 60);
    expect((await dailyUsage()).speakChars.used).toBe(0);
    const key = `ftv:cap:${new Date().toISOString().slice(0, 10)}:speakChars`;
    expect(redis.expiry.get(key)).toBe(26 * 60 * 60 * 1000); // outlives the day it counts
  });
});
