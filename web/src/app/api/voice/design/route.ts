/**
 * POST /api/voice/design
 * body: { image: "data:image/jpeg;base64,…", weights: {target: value}, look: { hair: "short01", hairColour: "natural", … } }
 * The slider line Claude reads is built on the server from the validated `weights` (lib/voice/sliderSummary.ts).
 * -> DesignResult (description fields, the ElevenLabs prompt, 3 preview URLs, cached voiceId if any)
 */
import { z } from "zod";

import { errorResponse, jsonBody } from "@/lib/server/errors";
import { guard } from "@/lib/server/guards";
import { LookSchema } from "@/lib/server/look";
import { checkVisitorLimit, requireStore, visitorId } from "@/lib/server/ratelimit";
import { DESIGN_BUDGET_MS, designForFace } from "@/lib/server/voice";

export const maxDuration = 120; // Fluid compute (300 s on every plan); voice.ts DESIGN_BUDGET_MS keeps the work inside it

const Body = z.object({
  image: z.string().regex(/^data:image\/jpeg;base64,[A-Za-z0-9+/=]+$/).max(1_500_000),
  weights: z.record(z.string().max(64), z.number().min(-1).max(1)),
  look: LookSchema.default({}),
});

export async function POST(request: Request) {
  const deadline = Date.now() + DESIGN_BUDGET_MS;
  try {
    await guard(request);
    requireStore();
    await checkVisitorLimit(request, "design");
    const body = Body.parse(await jsonBody(request));
    const result = await designForFace({
      weights: body.weights,
      imageJpegBase64: body.image.split(",")[1],
      look: body.look,
      visitor: visitorId(request),
      deadline,
    });
    return Response.json(result, { headers: { "cache-control": "no-store" } });
  } catch (e) {
    return errorResponse(e);
  }
}
