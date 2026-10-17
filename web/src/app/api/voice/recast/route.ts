/**
 * POST /api/voice/recast   body: { image?, weights, look, faceKey, descKey }  -> { ok: true }
 * Casts the face again for a voice this visitor already has, when their casting is missing (lib/server/voice.ts
 * recastFor). The browser calls it when the profile or talk route answers "recast", then asks again. Like a design,
 * it costs one Claude reading of the face (the site-wide daily castings cap). `weights` and `look` are the ones the
 * voice was found with; `image` is sent only while the face on screen is still that face (without it, Claude casts
 * from the sliders and look alone).
 */
import { z } from "zod";

import { errorResponse, jsonBody } from "@/lib/server/errors";
import { guard } from "@/lib/server/guards";
import { LookSchema } from "@/lib/server/look";
import { requireStore, visitorId } from "@/lib/server/ratelimit";
import { JpegDataUrl, Key, Weights } from "@/lib/server/schemas";
import { recastFor } from "@/lib/server/voice";

export const maxDuration = 60;

const Body = z.object({
  image: JpegDataUrl.optional(),
  weights: Weights,
  look: LookSchema.default({}),
  faceKey: Key,
  descKey: Key,
});

export async function POST(request: Request) {
  try {
    await guard(request);
    requireStore();
    const body = Body.parse(await jsonBody(request));
    await recastFor({
      visitor: visitorId(request),
      faceKey: body.faceKey,
      descKey: body.descKey,
      weights: body.weights,
      look: body.look,
      imageJpegBase64: body.image?.split(",")[1],
    });
    return Response.json({ ok: true }, { headers: { "cache-control": "no-store" } });
  } catch (e) {
    return errorResponse(e);
  }
}
