/**
 * POST /api/voice/select   body: { descKey, previewIndex, generatedVoiceId? }  -> { voiceId, saved, message? }
 * Saves the chosen preview as a real ElevenLabs voice (or hands out a studio fallback). Going back to a take that is
 * already saved is free and counts against the looser "switch" limit; only a new save counts against "select".
 */
import { z } from "zod";

import { errorResponse, jsonBody } from "@/lib/server/errors";
import { guard } from "@/lib/server/guards";
import { checkVisitorLimit, requireStore } from "@/lib/server/ratelimit";
import { selectPreview } from "@/lib/server/voice";

export const maxDuration = 120; // a save may wait up to 30 s for the same take being saved by another request

const Body = z.object({
  descKey: z.string().regex(/^[a-f0-9]{64}$/),
  previewIndex: z.number().int().min(0).max(2),
  generatedVoiceId: z.string().max(128).optional(), // the preview the visitor heard
});

export async function POST(request: Request) {
  try {
    await guard(request);
    requireStore();
    await checkVisitorLimit(request, "switch");
    const body = Body.parse(await jsonBody(request));
    const result = await selectPreview(body.descKey, body.previewIndex, {
      generatedVoiceId: body.generatedVoiceId,
      chargeVisitor: () => checkVisitorLimit(request, "select"),
    });
    return Response.json(result, { headers: { "cache-control": "no-store" } });
  } catch (e) {
    return errorResponse(e);
  }
}
