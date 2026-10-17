/**
 * POST /api/talk/token   body: { faceKey, descKey, take?, invite?, replaces? }  -> { serverUrl, token, room, name, maxSeconds }
 * A short-lived LiveKit token for a live conversation with this visitor's character (lib/server/talk.ts). The same
 * guards as every paid route, plus the invite-only switch and one conversation at a time. The browser names the face
 * and the voice; the voice id, the profile and the instructions the agent gets are the server's own.
 */
import { z } from "zod";

import { ApiError, errorResponse, jsonBody } from "@/lib/server/errors";
import { guard } from "@/lib/server/guards";
import { checkVisitorLimit, consumeDailyCap, refundDailyCap, requireStore, visitorId } from "@/lib/server/ratelimit";
import { browserId } from "@/lib/server/visitor";
import { inviteOk, startTalk, TALK_MESSAGES, talkIsPublic } from "@/lib/server/talk";

const Hex = z.string().regex(/^[a-f0-9]{64}$/);
const Body = z.object({
  faceKey: Hex,
  descKey: Hex,
  take: z.number().int().min(0).max(2).optional(),
  invite: z.string().max(128).optional(),
  replaces: z.string().regex(/^talk-[0-9a-f-]{36}$/).optional(), // this browser's previous conversation
});

export async function POST(request: Request) {
  try {
    await guard(request);
    requireStore();
    const body = Body.parse(await jsonBody(request));
    // Invite codes can't be guessed at: every try is counted before the code is compared (so many at once count too).
    if (!talkIsPublic()) {
      await checkVisitorLimit(request, "invite");
      if (!inviteOk(body.invite)) throw new ApiError("forbidden", TALK_MESSAGES.invite, 403);
    }
    await consumeDailyCap("talks");
    try {
      const ticket = await startTalk({
        visitor: visitorId(request),
        faceKey: body.faceKey,
        descKey: body.descKey,
        take: body.take,
        replaces: body.replaces,
        ownBrowser: browserId(request) !== null,
        chargeVisitor: () => checkVisitorLimit(request, "talk"),
      });
      return Response.json(ticket, { headers: { "cache-control": "no-store" } });
    } catch (e) {
      await refundDailyCap("talks", 1);
      throw e;
    }
  } catch (e) {
    return errorResponse(e);
  }
}
