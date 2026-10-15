/**
 * POST /api/voice/recast   body: { image?, weights, look, faceKey, descKey }  -> { ok: true }
 * Casts the face again for a voice this visitor already has, when their casting is missing (lib/server/voice.ts
 * recastFor). The browser calls it when the profile or talk route answers "recast", then asks again. Charged like a
 * design: one Claude reading of the face. `weights` and `look` are the ones the voice was found with; `image` is sent
 * only while the face on screen is still that face (without it, Claude casts from the sliders and look alone).
 */
import { z } from "zod";

import { errorResponse, jsonBody } from "@/lib/server/errors";
import { guard } from "@/lib/server/guards";
import { LookSchema } from "@/lib/server/look";
import { checkVisitorLimit, requireStore, visitorId } from "@/lib/server/ratelimit";
import { recastFor } from "@/lib/server/voice";

export const maxDuration = 60;

const Hex = z.string().regex(/^[a-f0-9]{64}$/);
const Body = z.object({
  image: z.string().regex(/^data:image\/jpeg;base64,[A-Za-z0-9+/=]+$/).max(1_500_000).optional(),
  weights: z.record(z.string().max(64), z.number().min(-1).max(1)),
  look: LookSchema.default({}),
  faceKey: Hex,
  descKey: Hex,
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
      chargeVisitor: () => checkVisitorLimit(request, "design"),
    });
    return Response.json({ ok: true }, { headers: { "cache-control": "no-store" } });
  } catch (e) {
    return errorResponse(e);
  }
}
