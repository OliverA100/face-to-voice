/**
 * GET /api/limits  -> Limits (lib/limits/types.ts)
 * What this visitor has used of their own limits today, what the whole site has used of its daily budget, and when
 * both reset. Read-only: asking counts nothing. Same-origin only (no BotID: nothing here costs money).
 */
import { errorResponse } from "@/lib/server/errors";
import { assertSameOrigin } from "@/lib/server/guards";
import { CAP_LABELS, dailyUsage, LIMITS, nextResetMs, requireStore, visitorUsage, type CapKind, type Route } from "@/lib/server/ratelimit";
import { env } from "@/lib/server/env";
import type { Limits } from "@/lib/limits/types";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    assertSameOrigin(request);
    requireStore();
    const [yours, site] = await Promise.all([visitorUsage(request), dailyUsage()]);
    const body: Limits = {
      resetAt: new Date(nextResetMs()).toISOString(),
      yours: (Object.keys(yours) as Route[])
        .filter((id) => id !== "invite" || !env.talk.public) // invite tries only matter while chats are invite-only
        .map((id) => ({ id, label: LIMITS[id].label, ...yours[id] })),
      site: (Object.keys(site) as CapKind[]).map((id) => ({ id, label: CAP_LABELS[id].label, ...site[id] })),
    };
    return Response.json(body, { headers: { "cache-control": "no-store" } });
  } catch (e) {
    return errorResponse(e);
  }
}
