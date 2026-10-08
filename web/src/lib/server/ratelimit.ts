/**
 * Per-visitor limits (sliding window per route) and global daily caps, backed by Upstash Redis.
 * Visitors are identified by an HMAC of their IP: raw IPs never touch Redis or logs.
 *
 * Without Redis: an in-memory fallback is used in development, and every Vercel deployment (Production
 * and Preview) refuses the paid routes (fail closed) because per-instance memory cannot enforce a shared cap.
 */
import "server-only";

import { Ratelimit } from "@upstash/ratelimit";
import { Redis } from "@upstash/redis";
import { after } from "next/server";
import { createHmac } from "node:crypto";

import { env } from "./env";
import { ApiError, MESSAGES } from "./errors";

export type Route = "design" | "select" | "switch" | "speak";

/** Per visitor. Tweak freely; the daily caps below protect the wallet either way. */
const LIMITS: Record<Route, { tokens: number; window: "1 m" | "10 m" | "1 h" | "1 d"; ms: number }> = {
  design: { tokens: 5, window: "1 d", ms: 86_400_000 },
  select: { tokens: 3, window: "1 d", ms: 86_400_000 }, // saving a new voice (paid)
  switch: { tokens: 30, window: "1 d", ms: 86_400_000 }, // choosing a take that is already saved (free)
  speak: { tokens: 30, window: "1 d", ms: 86_400_000 },
};

let redis: Redis | null | undefined;
/** The shared Upstash client, or null without Redis (local dev). Also the store behind cache.ts. */
export function getRedis(): Redis | null {
  if (redis === undefined) redis = env.hasRedis ? Redis.fromEnv() : null;
  return redis;
}

/**
 * Paid routes call this first. Deployed on Vercel they refuse (503) rather than run without shared limits (no Redis)
 * or with visitor ids anyone could recompute from an IP (no RATE_LIMIT_SALT).
 */
export function requireStore(): void {
  if (env.isDeployed && (!getRedis() || !env.rateLimitSalt)) throw new ApiError("unavailable", MESSAGES.unavailable, 503);
}

/** The visitor's IP, HMAC'd with RATE_LIMIT_SALT: stable per visitor, never reversible to the IP. */
export function visitorId(request: Request): string {
  if (!env.rateLimitSalt) throw new ApiError("unavailable", MESSAGES.unavailable, 503);
  const ip = request.headers.get("x-real-ip") ?? request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "127.0.0.1";
  return createHmac("sha256", env.rateLimitSalt).update(ip).digest("base64url").slice(0, 24);
}

const limiters = new Map<Route, Ratelimit>();
function limiterFor(route: Route, r: Redis): Ratelimit {
  let l = limiters.get(route);
  if (!l) {
    l = new Ratelimit({
      redis: r,
      limiter: Ratelimit.slidingWindow(LIMITS[route].tokens, LIMITS[route].window),
      prefix: `ftv:rl:${route}`,
      timeout: 2000, // treat a slow Redis as a deny (see below), never as a free pass
    });
    limiters.set(route, l);
  }
  return l;
}

// --- dev fallback (per process) ---------------------------------------------------------
// Without Redis (local development) every limit is 10× the production value and the visitor
// window is at most 10 minutes, so iterating on the UI doesn't hit the caps meant for strangers.
// Counters reset whenever the dev server reloads this module (edit this file to reset them).
const DEV_MULTIPLIER = 10;
const DEV_MAX_WINDOW_MS = 10 * 60_000;
const memHits = new Map<string, number[]>();
const memCounters = new Map<string, number>();

export async function checkVisitorLimit(request: Request, route: Route): Promise<void> {
  const id = visitorId(request);
  const r = getRedis();
  if (!r) {
    const { tokens, ms } = LIMITS[route];
    const now = Date.now();
    const hits = (memHits.get(`${route}:${id}`) ?? []).filter((t) => now - t < Math.min(ms, DEV_MAX_WINDOW_MS));
    hits.push(now);
    memHits.set(`${route}:${id}`, hits);
    if (hits.length > tokens * DEV_MULTIPLIER) throw new ApiError("visitor_limit", MESSAGES.visitor_limit, 429);
    return;
  }
  const res = await limiterFor(route, r).limit(id);
  after(() => res.pending);
  if (!res.success || res.reason === "timeout") {
    throw new ApiError("visitor_limit", MESSAGES.visitor_limit, 429, { resetAt: new Date(res.reset).toISOString() });
  }
}

type CapKind = "castings" | "designs" | "saves" | "speakChars";
const CAP_KINDS: readonly CapKind[] = ["castings", "designs", "saves", "speakChars"];
const capLimit = (kind: CapKind) =>
  ({ castings: env.caps.castingsPerDay, designs: env.caps.designsPerDay, saves: env.caps.savesPerDay, speakChars: env.caps.speakCharsPerDay })[kind];
const todayKey = (kind: CapKind) => `ftv:cap:${new Date().toISOString().slice(0, 10)}:${kind}`;

/** Reserve `units` of a daily global cap; throws (and rolls back) when the cap would be exceeded. */
export async function consumeDailyCap(kind: CapKind, units = 1): Promise<{ used: number; limit: number }> {
  const limit = capLimit(kind);
  const key = todayKey(kind);
  const r = getRedis();
  if (!r) {
    const used = (memCounters.get(key) ?? 0) + units;
    if (used > limit * DEV_MULTIPLIER) throw new ApiError("daily_cap", MESSAGES.daily_cap, 429);
    memCounters.set(key, used);
    return { used, limit: limit * DEV_MULTIPLIER };
  }
  const [used] = await r.pipeline().incrby(key, units).expire(key, 60 * 60 * 26).exec<[number, number]>();
  if (used > limit) {
    after(() => r.decrby(key, units));
    throw new ApiError("daily_cap", MESSAGES.daily_cap, 429);
  }
  return { used, limit };
}

/** Give back units reserved with consumeDailyCap when the paid call they were reserved for failed. */
export async function refundDailyCap(kind: CapKind, units: number): Promise<void> {
  const key = todayKey(kind);
  const r = getRedis();
  if (!r) {
    memCounters.set(key, Math.max(0, (memCounters.get(key) ?? 0) - units));
    return;
  }
  await r.decrby(key, units);
}

/** Read-only view for /api/usage. */
export async function dailyUsage(): Promise<Record<string, { used: number; limit: number }>> {
  const r = getRedis();
  const out: Record<string, { used: number; limit: number }> = {};
  for (const k of CAP_KINDS) {
    const used = r ? ((await r.get<number>(todayKey(k))) ?? 0) : (memCounters.get(todayKey(k)) ?? 0);
    out[k] = { used, limit: capLimit(k) };
  }
  return out;
}
