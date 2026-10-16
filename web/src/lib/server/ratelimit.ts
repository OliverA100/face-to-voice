/**
 * Per-visitor limits (per route) and site-wide daily caps, backed by Upstash Redis. Both reset at midnight UTC, so
 * the limits dialog (GET /api/limits) can show one countdown. Visitors are identified by an HMAC of their IP: raw IPs
 * never touch Redis or logs.
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

export type Route = "design" | "select" | "switch" | "speak" | "profile" | "talk" | "invite";

/** Per visitor, per UTC day: only picking a voice (each one is a new voice saved at ElevenLabs, in a pool of 30
 *  slots) and invite code tries (no guessing at them). Everything else has no limit per visitor (2026-10-16, the
 *  owner's call): the daily caps below are hidden ceilings for a runaway day. `label` names the allowance in the limits
 *  dialog, `message` the error when it runs out. */
export const LIMITS: Partial<Record<Route, { tokens: number; label: string; message: (tokens: number) => string }>> = {
  select: { tokens: 10, label: "voices picked", message: (n) => `You've picked all ${n} of your voices for today. More come back at midnight UTC.` },
  invite: {
    tokens: 30,
    label: "invite code tries",
    message: (n) => `You've used all ${n} of your invite code tries for today. They come back at midnight UTC.`,
  },
};

const DAY_MS = 86_400_000;
/** The next midnight UTC: when every limit and cap resets. */
export const nextResetMs = (now = Date.now()) => (Math.floor(now / DAY_MS) + 1) * DAY_MS;

const visitorLimitMessage = (route: Route) => LIMITS[route]!.message(LIMITS[route]!.tokens);

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
      // A fixed 1-day window starts at midnight UTC (windows are counted from the epoch), like the daily caps
      limiter: Ratelimit.fixedWindow(LIMITS[route]!.tokens, "1 d"),
      prefix: `ftv:rl:${route}`,
      timeout: 2000, // treat a slow Redis as a deny (see below), never as a free pass
    });
    limiters.set(route, l);
  }
  return l;
}

// --- dev fallback (per process) ---------------------------------------------------------
// Without Redis (local development) every limit is 10× the production value, so iterating on the
// UI doesn't hit the caps meant for strangers. Counters reset whenever the dev server reloads this
// module (edit this file to reset them).
const DEV_MULTIPLIER = 10;
const memHits = new Map<string, number>();
const memCounters = new Map<string, number>();
const memHitKey = (route: Route, id: string) => `${new Date().toISOString().slice(0, 10)}:${route}:${id}`;

export async function checkVisitorLimit(request: Request, route: Route): Promise<void> {
  if (!LIMITS[route]) return; // no limit per visitor on this step
  const id = visitorId(request);
  const r = getRedis();
  if (!r) {
    const key = memHitKey(route, id);
    const hits = (memHits.get(key) ?? 0) + 1;
    memHits.set(key, hits);
    if (hits > LIMITS[route]!.tokens * DEV_MULTIPLIER) throw new ApiError("visitor_limit", visitorLimitMessage(route), 429, { resetAt: new Date(nextResetMs()).toISOString() });
    return;
  }
  const res = await limiterFor(route, r).limit(id);
  after(() => res.pending);
  if (res.reason === "timeout") throw new ApiError("busy", MESSAGES.busy_store, 503);
  if (!res.success) throw new ApiError("visitor_limit", visitorLimitMessage(route), 429, { resetAt: new Date(res.reset).toISOString() });
}

/** What this visitor has used of each limit today (the limits dialog). Reading counts nothing. */
export async function visitorUsage(request: Request): Promise<Record<Route, { used: number; limit: number }>> {
  const id = visitorId(request);
  const r = getRedis();
  const routes = Object.keys(LIMITS) as Route[];
  const rows = await Promise.all(
    routes.map(async (route) => {
      if (!r) {
        const limit = LIMITS[route]!.tokens * DEV_MULTIPLIER;
        return { used: Math.min(limit, memHits.get(memHitKey(route, id)) ?? 0), limit };
      }
      const { remaining, limit } = await limiterFor(route, r).getRemaining(id);
      return { used: Math.max(0, limit - remaining), limit };
    }),
  );
  return Object.fromEntries(routes.map((route, i) => [route, rows[i]])) as Record<Route, { used: number; limit: number }>;
}

export type CapKind = "castings" | "designs" | "saves" | "speakChars" | "profiles" | "talks";
const CAP_KINDS: readonly CapKind[] = ["castings", "designs", "saves", "speakChars", "profiles", "talks"];
/** What each site-wide cap counts: `label` for the limits dialog, `budget` for its message. */
export const CAP_LABELS: Record<CapKind, { label: string; budget: string }> = {
  castings: { label: "faces read", budget: "reading faces" },
  designs: { label: "new voice designs", budget: "designing new voices" },
  saves: { label: "voices picked", budget: "picking voices" },
  speakChars: { label: "characters spoken", budget: "speech" },
  profiles: { label: "character profiles", budget: "character profiles" },
  talks: { label: "live chats", budget: "live chats" },
};
const capMessage = (kind: CapKind) =>
  `The site is very busy today, so ${CAP_LABELS[kind].budget} is paused for everyone until midnight UTC. It isn't anything you did.`;
const capLimit = (kind: CapKind) =>
  ({ castings: env.caps.castingsPerDay, designs: env.caps.designsPerDay, saves: env.caps.savesPerDay, speakChars: env.caps.speakCharsPerDay, profiles: env.caps.profilesPerDay, talks: env.caps.talksPerDay })[kind];
const todayKey = (kind: CapKind) => `ftv:cap:${new Date().toISOString().slice(0, 10)}:${kind}`;

/** Reserve `units` of a daily global cap; throws (and rolls back) when the cap would be exceeded. */
export async function consumeDailyCap(kind: CapKind, units = 1): Promise<{ used: number; limit: number }> {
  const limit = capLimit(kind);
  const key = todayKey(kind);
  const r = getRedis();
  if (!r) {
    const used = (memCounters.get(key) ?? 0) + units;
    if (used > limit * DEV_MULTIPLIER) throw new ApiError("daily_cap", capMessage(kind), 429, { resetAt: new Date(nextResetMs()).toISOString() });
    memCounters.set(key, used);
    return { used, limit: limit * DEV_MULTIPLIER };
  }
  const [used] = await r.pipeline().incrby(key, units).expire(key, 60 * 60 * 26).exec<[number, number]>();
  if (used > limit) {
    after(() => r.decrby(key, units));
    throw new ApiError("daily_cap", capMessage(kind), 429, { resetAt: new Date(nextResetMs()).toISOString() });
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
export async function dailyUsage(): Promise<Record<CapKind, { used: number; limit: number }>> {
  const r = getRedis();
  const out = {} as Record<CapKind, { used: number; limit: number }>;
  for (const k of CAP_KINDS) {
    const used = r ? ((await r.get<number>(todayKey(k))) ?? 0) : (memCounters.get(todayKey(k)) ?? 0);
    out[k] = { used, limit: capLimit(k) };
  }
  return out;
}
