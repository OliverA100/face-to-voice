/**
 * GET /api/usage  (Authorization: Bearer USAGE_ADMIN_TOKEN)
 * Today's caps, the saved-voice pool and, if the key allows it, the ElevenLabs quotas.
 * Answers 404 without a valid token so the route is not advertised.
 */
import { timingSafeEqual } from "node:crypto";

import { poolList } from "@/lib/server/cache";
import { subscription } from "@/lib/server/elevenlabs";
import { env } from "@/lib/server/env";
import { dailyUsage } from "@/lib/server/ratelimit";

export const dynamic = "force-dynamic";

function authorized(request: Request): boolean {
  const expected = Buffer.from(env.usageAdminToken);
  const got = Buffer.from(request.headers.get("authorization")?.replace(/^Bearer /, "") ?? "");
  // Bytes, not characters: timingSafeEqual throws on buffers of different lengths (a non-ASCII token would be a 500).
  if (!expected.length || got.length !== expected.length) return false;
  return timingSafeEqual(got, expected);
}

export async function GET(request: Request) {
  if (!authorized(request)) return new Response("Not found", { status: 404 });
  const [usage, pool, sub] = await Promise.all([dailyUsage(), poolList(), subscription()]);
  return Response.json(
    {
      day: new Date().toISOString().slice(0, 10),
      store: env.hasRedis ? "redis" : "memory (dev)",
      blob: env.hasBlob,
      caps: usage,
      voicePool: pool.map((p) => ({ voiceId: p.voiceId, lastUsed: new Date(p.lastUsed).toISOString() })),
      elevenlabs: sub,
    },
    { headers: { "cache-control": "no-store" } },
  );
}
