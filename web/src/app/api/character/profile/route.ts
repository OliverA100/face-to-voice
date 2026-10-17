/**
 * POST /api/character/profile   body: { faceKey, descKey, regenerate? }  -> { profile, own }
 * The character's profile for a voice: the saved one (free), or one Claude writes from this visitor's cached casting
 * (lib/server/characterProfile.ts). `regenerate` writes another, kept as this visitor's own. No browser text reaches
 * the prompt: the keys pick server data (the casting and the look it was made from).
 */
import { z } from "zod";

import { profileFor } from "@/lib/server/characterProfile";
import { errorResponse, jsonBody } from "@/lib/server/errors";
import { guard } from "@/lib/server/guards";
import { checkVisitorLimit, requireStore, visitorId } from "@/lib/server/ratelimit";
import { Key } from "@/lib/server/schemas";

export const maxDuration = 60;

const Body = z.object({ faceKey: Key, descKey: Key, regenerate: z.boolean().default(false) });

export async function POST(request: Request) {
  try {
    await guard(request);
    requireStore();
    const body = Body.parse(await jsonBody(request));
    const result = await profileFor({ ...body, visitor: visitorId(request), chargeVisitor: () => checkVisitorLimit(request, "profile") });
    return Response.json(result, { headers: { "cache-control": "no-store" } });
  } catch (e) {
    return errorResponse(e);
  }
}
