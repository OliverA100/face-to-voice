/**
 * Per-visitor limits (per route) and site-wide daily caps, backed by Upstash Redis. Both reset at midnight UTC, so
 * the limits dialog (GET /api/limits) can show one countdown. A visitor is their browser (a signed cookie), with a
 * ceiling per network on top (an HMAC of the IP): visitor.ts. Raw IPs never touch Redis or logs.
 *
 * Without Redis: an in-memory fallback is used in development, and every Vercel deployment (Production
 * and Preview) refuses the paid routes (fail closed) because per-instance memory cannot enforce a shared cap.
 */
import "server-only";

import { Ratelimit } from "@upstash/ratelimit";
import { Redis } from "@upstash/redis";
import { after } from "next/server";

import { env } from "./env";
import { ApiError, MESSAGES } from "./errors";
import { browserId, networkId } from "./visitor";

export { visitorId } from "./visitor";

export type Route = "design" | "select" | "switch" | "speak" | "profile" | "talk" | "invite";

/** Per visitor, per UTC day: only picking a voice (each one is a new voice saved at ElevenLabs, in a pool of 30
 *  slots) and invite code tries (no guessing at them). Everything else has no limit per visitor (2026-10-16, the
 *  owner's call): the daily caps below are hidden ceilings for a runaway day. `label` names the allowance in the limits
 *  dialog, `message` the error when it runs out.
 *
 *  Each is counted twice: `tokens` per browser, `network` per network (visitor.ts). The network count is the ceiling
 *  that stops someone clearing cookies for a fresh allowance, set well above one browser's so a few people on the
 *  same Wi-Fi rarely meet it; without a cookie it is the only count. Tune `network` here. */
export const VISITOR_LIMITS: Partial<Record<Route, { tokens: number; network: number; label: string; message: (tokens: number) => string; networkMessage: string }>> = {
  select: {
    tokens: 10,
    network: 30,
    label: "voices picked",
    message: (n) => `You've picked all ${n} of your voices for today. More come back at midnight UTC.`,
    networkMessage: "So many voices were picked on your network today that picking is paused here until midnight UTC.",
  },
  invite: {
    tokens: 30,
    network: 60,
    label: "invite code tries",
    message: (n) => `You've used all ${n} of your invite code tries for today. They come back at midnight UTC.`,
    networkMessage: "So many invite codes were tried on your network today that trying is paused here until midnight UTC.",
  },
};

const DAY_MS = 86_400_000;
/** The next midnight UTC: when every limit and cap resets. */
export const nextResetMs = (now = Date.now()) => (Math.floor(now / DAY_MS) + 1) * DAY_MS;

/** The two counts of a limit: per browser (the visitor's own allowance) and per network (the ceiling). */
type Scope = "browser" | "network";
const allowance = (route: Route, scope: Scope) => (scope === "browser" ? VISITOR_LIMITS[route]!.tokens : VISITOR_LIMITS[route]!.network);
const limitMessage = (route: Route, scope: Scope) => (scope === "browser" ? VISITOR_LIMITS[route]!.message(VISITOR_LIMITS[route]!.tokens) : VISITOR_LIMITS[route]!.networkMessage);

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

const limiters = new Map<string, Ratelimit>();
function limiterFor(route: Route, scope: Scope, r: Redis): Ratelimit {
  // ftv:rl:<route>:<browser id> per browser (the prefix the IP hashes had before the cookie), ftv:rl:net:<route>:<network id>
  const prefix = scope === "browser" ? `ftv:rl:${route}` : `ftv:rl:net:${route}`;
  let l = limiters.get(prefix);
  if (!l) {
    l = new Ratelimit({
      redis: r,
      // A fixed 1-day window starts at midnight UTC (windows are counted from the epoch), like the daily caps
      limiter: Ratelimit.fixedWindow(allowance(route, scope), "1 d"),
      prefix,
      timeout: 2000, // treat a slow Redis as a deny (see below), never as a free pass
    });
    limiters.set(prefix, l);
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
const memHitKey = (route: Route, scope: Scope, id: string) => `${new Date().toISOString().slice(0, 10)}:${scope}:${route}:${id}`;

/** Count one use of `route` against one of its counts; throws visitor_limit once that count is spent. */
async function hit(route: Route, scope: Scope, id: string): Promise<void> {
  const r = getRedis();
  if (!r) {
    const key = memHitKey(route, scope, id);
    const hits = (memHits.get(key) ?? 0) + 1;
    memHits.set(key, hits);
    if (hits > allowance(route, scope) * DEV_MULTIPLIER) throw new ApiError("visitor_limit", limitMessage(route, scope), 429, { resetAt: new Date(nextResetMs()).toISOString() });
    return;
  }
  const res = await limiterFor(route, scope, r).limit(id);
  after(() => res.pending);
  if (res.reason === "timeout") throw new ApiError("busy", MESSAGES.busy_store, 503);
  if (!res.success) throw new ApiError("visitor_limit", limitMessage(route, scope), 429, { resetAt: new Date(res.reset).toISOString() });
}

/**
 * Count one use of a limited step: this browser's allowance first, then its network's ceiling. A browser that has
 * spent its own allowance never adds to the network count. When the network count refuses, the browser's use is
 * already counted; that is fine, as both come back at the same midnight. Without a cookie only the network counts.
 */
export async function checkVisitorLimit(request: Request, route: Route): Promise<void> {
  if (!VISITOR_LIMITS[route]) return; // no limit per visitor on this step
  const network = networkId(request); // first: throws (503) without a salt
  const browser = browserId(request);
  if (browser) await hit(route, "browser", browser);
  await hit(route, "network", network);
}

type Usage = { used: number; limit: number };

/** What this visitor has used of each limit today (the limits dialog): `per` says whose count `used` is, their
 *  browser's, or their network's without a cookie; `network` is the network's count either way. Reading counts nothing. */
export async function visitorUsage(request: Request): Promise<{ per: Scope; usage: Record<Route, Usage & { network: Usage }> }> {
  const network = networkId(request);
  const browser = browserId(request);
  const r = getRedis();
  const count = async (route: Route, scope: Scope, id: string): Promise<Usage> => {
    if (!r) {
      const limit = allowance(route, scope) * DEV_MULTIPLIER;
      return { used: Math.min(limit, memHits.get(memHitKey(route, scope, id)) ?? 0), limit };
    }
    const { remaining, limit } = await limiterFor(route, scope, r).getRemaining(id);
    return { used: Math.max(0, limit - remaining), limit };
  };
  const routes = Object.keys(VISITOR_LIMITS) as Route[];
  const rows = await Promise.all(
    routes.map(async (route) => {
      const net = await count(route, "network", network);
      return { ...(browser ? await count(route, "browser", browser) : net), network: net };
    }),
  );
  return { per: browser ? "browser" : "network", usage: Object.fromEntries(routes.map((route, i) => [route, rows[i]])) as Record<Route, Usage & { network: Usage }> };
}

export type CapKind = "castings" | "designs" | "saves" | "speakChars" | "profiles" | "talks";
const CAP_KINDS: readonly CapKind[] = ["castings", "designs", "saves", "speakChars", "profiles", "talks"];
/** What each site-wide cap pauses, for its message. */
const CAP_BUDGETS: Record<CapKind, string> = {
  castings: "reading faces",
  designs: "designing new voices",
  saves: "picking voices",
  speakChars: "speech",
  profiles: "character profiles",
  talks: "live chats",
};
const capMessage = (kind: CapKind) => `The site is very busy today, so ${CAP_BUDGETS[kind]} is paused for everyone until midnight UTC. It isn't anything you did.`;
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
