/**
 * GET /api/limits  -> Limits (lib/limits/types.ts)
 * What this visitor has used of their own limits today (voices picked; invite code tries are counted but never shown)
 * and when they reset. The site-wide daily caps are hidden ceilings, not shown. Read-only: asking counts nothing.
 * Same-origin only (no BotID: nothing here costs money).
 */
import { errorResponse } from "@/lib/server/errors";
import { assertSameOrigin } from "@/lib/server/guards";
import { LIMITS, nextResetMs, requireStore, visitorUsage, type Route } from "@/lib/server/ratelimit";
import type { Limits } from "@/lib/limits/types";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    assertSameOrigin(request);
    requireStore();
    const yours = await visitorUsage(request);
    const body: Limits = {
      resetAt: new Date(nextResetMs()).toISOString(),
      // invite code tries are never shown (they stop guessing; visitors needn't know): only the voices picked
      yours: (Object.keys(yours) as Route[]).filter((id) => id !== "invite").map((id) => ({ id, label: LIMITS[id]!.label, ...yours[id] })),
    };
    return Response.json(body, { headers: { "cache-control": "no-store" } });
  } catch (e) {
    return errorResponse(e);
  }
}
