/**
 * Small JSON records live in Upstash Redis (face → description, description → previews/voice,
 * the LRU voice pool); audio bytes live in Vercel Blob as public, content-addressed files.
 * Without Redis/Blob (local dev) everything falls back to process memory and data: URLs.
 */
import "server-only";

import { put } from "@vercel/blob";

import { env } from "./env";
import { getRedis } from "./ratelimit";

const TTL_SECONDS = 60 * 60 * 24 * 30;
const mem = new Map<string, unknown>();

export async function cacheGet<T>(key: string): Promise<T | null> {
  const r = getRedis();
  if (!r) return (mem.get(key) as T | undefined) ?? null;
  return (await r.get<T>(key)) ?? null;
}

export async function cacheSet(key: string, value: unknown, ttl = TTL_SECONDS): Promise<void> {
  const r = getRedis();
  if (!r) {
    mem.set(key, value);
    return;
  }
  await r.set(key, value, { ex: ttl });
}

export async function cacheDel(key: string): Promise<void> {
  const r = getRedis();
  if (!r) mem.delete(key);
  else await r.del(key);
}

// --- locks: one request at a time does a paid job (a design, a save) that others would only repeat ---------------------

const memLocks = new Map<string, { token: string; until: number }>(); // key → its holder and expiry (ms)

/** Release only if `token` still holds the key: a holder that outran its ttl must not free the next holder's lock. */
const RELEASE_IF_HELD = `if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("del", KEYS[1]) end return 0`;

/**
 * Take `key` for `ttl` seconds: a token to release it with, or null when another request holds it. Expires on its own if
 * the holder dies.
 */
export async function acquireLock(key: string, ttl: number): Promise<string | null> {
  const token = crypto.randomUUID();
  const r = getRedis();
  if (!r) {
    if ((memLocks.get(key)?.until ?? 0) > Date.now()) return null;
    memLocks.set(key, { token, until: Date.now() + ttl * 1000 });
    return token;
  }
  return (await r.set(key, token, { nx: true, ex: ttl })) === "OK" ? token : null;
}

export async function releaseLock(key: string, token: string): Promise<void> {
  const r = getRedis();
  if (!r) {
    if (memLocks.get(key)?.token === token) memLocks.delete(key);
    return;
  }
  await r.eval(RELEASE_IF_HELD, [key], [token]);
}

/**
 * Store a small audio clip. Returns a URL the browser can play: a public Blob URL on Vercel,
 * a data: URL in local dev (previews are ~100 KB each, fine for a few of them).
 */
export async function storeAudio(pathname: string, bytes: Uint8Array, contentType: string): Promise<string> {
  if (!env.hasBlob) return `data:${contentType};base64,${Buffer.from(bytes).toString("base64")}`;
  try {
    const blob = await put(pathname, Buffer.from(bytes), {
      access: "public",
      addRandomSuffix: false,
      allowOverwrite: false,
      contentType,
      cacheControlMaxAge: 60 * 60 * 24 * 365,
    });
    return blob.url;
  } catch (e) {
    // Same content-addressed pathname already stored: reuse it.
    if (e instanceof Error && /already exists|allowOverwrite/i.test(e.message)) {
      const { head } = await import("@vercel/blob");
      return (await head(pathname)).url;
    }
    throw e;
  }
}

// --- LRU pool of saved ElevenLabs voices (keyed by description and take) -------------------
// One hash field per take, so requests touching different takes at the same time can't drop each other's entries (a
// voice the pool forgets is never evicted, fills a slot, and is later deleted while its record still speaks with it).

const POOL_KEY = "ftv:voices:takes";
type PoolEntry = { descKey: string; voiceId: string; lastUsed: number };
type PoolValue = Omit<PoolEntry, "descKey">;
const memPool = new Map<string, PoolValue>();

export async function poolList(): Promise<PoolEntry[]> {
  const r = getRedis();
  const all = r ? ((await r.hgetall<Record<string, PoolValue>>(POOL_KEY)) ?? {}) : Object.fromEntries(memPool);
  return Object.entries(all).map(([descKey, v]) => ({ descKey, voiceId: v.voiceId, lastUsed: v.lastUsed }));
}

export async function poolTouch(descKey: string, voiceId: string): Promise<void> {
  const value: PoolValue = { voiceId, lastUsed: Date.now() };
  const r = getRedis();
  if (!r) {
    memPool.set(descKey, value);
    return;
  }
  await r.pipeline().hset(POOL_KEY, { [descKey]: value }).expire(POOL_KEY, TTL_SECONDS * 12).exec();
}

/** The voice was used again (spoken with): move it to the back of the queue, if the pool still holds it for this take. */
export async function poolRefresh(descKey: string, voiceId: string): Promise<void> {
  const r = getRedis();
  const now = r ? await r.hget<PoolValue>(POOL_KEY, descKey) : memPool.get(descKey);
  if (now?.voiceId === voiceId) await poolTouch(descKey, voiceId); // an evicted voice is not brought back
}

/** Entries beyond the pool size, oldest first: the caller deletes those voices upstream. */
export async function poolEvictions(): Promise<PoolEntry[]> {
  const list = (await poolList()).sort((a, b) => a.lastUsed - b.lastUsed);
  const excess = list.length - env.voicePoolSize;
  return excess > 0 ? list.slice(0, excess) : [];
}

export async function poolRemove(voiceId: string): Promise<void> {
  const keys = (await poolList()).filter((e) => e.voiceId === voiceId).map((e) => e.descKey);
  if (!keys.length) return;
  const r = getRedis();
  if (r) await r.hdel(POOL_KEY, ...keys);
  else for (const k of keys) memPool.delete(k);
}
