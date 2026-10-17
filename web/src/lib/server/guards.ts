/**
 * Cheap request gates that run before any paid work:
 *  1. same-origin check (Sec-Fetch-Site is browser-set and cannot be forged by scripts;
 *     Origin must match the host, which also works on Vercel preview URLs)
 *  2. BotID (Vercel's free bot detection; a no-op under `next dev`)
 */
import "server-only";

import { checkBotId } from "botid/server";

import { env } from "./env";
import { ApiError, MESSAGES } from "./errors";

export function assertSameOrigin(request: Request): void {
  const site = request.headers.get("sec-fetch-site");
  if (site && site !== "same-origin" && site !== "same-site") throw new ApiError("forbidden", MESSAGES.forbidden, 403);
  const origin = request.headers.get("origin");
  const host = request.headers.get("x-forwarded-host") ?? request.headers.get("host");
  if (origin && host) {
    let originHost: string;
    try {
      originHost = new URL(origin).host;
    } catch {
      throw new ApiError("forbidden", MESSAGES.forbidden, 403);
    }
    if (originHost !== host) throw new ApiError("forbidden", MESSAGES.forbidden, 403);
  }
  // No browser headers at all (curl and friends): refuse on any deployment, allow in development for testing.
  if (!site && !origin && env.isDeployed) throw new ApiError("forbidden", MESSAGES.forbidden, 403);
}

export async function assertNotBot(): Promise<void> {
  try {
    const { isBot } = await checkBotId();
    if (isBot) throw new ApiError("forbidden", MESSAGES.forbidden, 403);
  } catch (e) {
    if (e instanceof ApiError) throw e;
    // BotID unavailable (not on Vercel, or failing): let the request through, as the daily caps still apply; on a
    // deployment say so, so a broken BotID doesn't go unnoticed.
    if (env.isDeployed) console.warn("[guards] BotID check failed, request let through:", e instanceof Error ? e.message.slice(0, 200) : e);
  }
}

/** Both gates, in order. */
export async function guard(request: Request): Promise<void> {
  assertSameOrigin(request);
  await assertNotBot();
}
