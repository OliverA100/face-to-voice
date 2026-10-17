/**
 * POST /api/voice/speak   body: { descKey, take?: 0..2, text, emotion?: "neutral"|"happy"|…, intensity?: 0..1 }
 * -> newline-delimited JSON stream: first {phonemes: {word: "HH AH0 L OW1"}} (lib/server/pronounce.ts), then the
 *    line's times from forced alignment, {aligned: {characters, …}|null} (lib/server/alignSpeech.ts; missing when it
 *    could not be asked), then {audio_base64 (pcm_24000), alignment|null, normalized_alignment|null}
 */
import { after } from "next/server";
import { z } from "zod";

import { captureClip, type ClipMeta } from "@/lib/server/devClips";
import { ApiError, errorResponse, jsonBody } from "@/lib/server/errors";
import { UpstreamError } from "@/lib/server/elevenlabs";
import { guard } from "@/lib/server/guards";
import { SpeakEmotion, spokenText } from "@/lib/server/emotion";
import { checkVisitorLimit, consumeDailyCap, refundDailyCap, requireStore } from "@/lib/server/ratelimit";
import { withPhonemes } from "@/lib/server/pronounce";
import { Key, Take } from "@/lib/server/schemas";
import { cachedSpeech, generateSpeech, speechHeaders } from "@/lib/server/speech";
import { env } from "@/lib/server/env";
import { closestStudioVoice, takeVoice, voiceGone, voiceRecord, voiceSpoken } from "@/lib/server/voice";

export const maxDuration = 60;

const Body = SpeakEmotion.extend({
  descKey: Key,
  take: Take.optional(), // the preview the visitor chose (each take has its own voice)
  text: z.string().trim().min(1).max(300),
});

/** The take's voice was retired (the pool makes room for newer ones, or it was deleted): saved again on choosing it. */
const RETIRED = "This voice was removed to make room for newer ones. Choose it again to bring it back.";

export async function POST(request: Request) {
  try {
    await guard(request);
    requireStore();
    await checkVisitorLimit(request, "speak");
    const body = Body.parse(await jsonBody(request));
    const record = await voiceRecord(body.descKey);
    const voiceId = record ? takeVoice(record, body.take) : null;
    if (!voiceId) throw new ApiError(record ? "expired" : "bad_request", record ? RETIRED : "Pick a voice first.", record ? 410 : 400);
    after(() => voiceSpoken(record!, body.take, voiceId)); // in use: the pool evicts it last
    // development with FTV_SAVED_VOICES: a fake design's voice can't speak, so the saved studio voice nearest the cast does
    const speaker = env.mockElevenLabs && env.savedVoices ? (closestStudioVoice(record!.cast, body.descKey) ?? voiceId) : voiceId;
    const text = spokenText(body.text, body.emotion, body.intensity); // "[happy] Hello there."
    if (!text.replace(/^\[[^\]]*\]\s*/, "")) throw new ApiError("bad_request", "Type a line to say.", 400);
    // development: the line is saved for /dev/lipsync too (lib/server/devClips.ts)
    const meta = (cached: boolean): ClipMeta => ({ text: body.text, spoken: text, voiceId: speaker, descKey: body.descKey, take: body.take ?? null, emotion: body.emotion, intensity: body.intensity, cached });
    const cached = await cachedSpeech(speaker, text);
    if (cached) return new Response(captureClip(withPhonemes(cached, text), meta(true)), { headers: speechHeaders(true) }); // cache hits are free
    // A generation is paid: its characters (the tag counts: it is billed) are reserved against the daily cap before
    // ElevenLabs is called, so a visitor over the cap gets nothing generated, and given back if the call fails.
    await consumeDailyCap("speakChars", text.length);
    let stream: ReadableStream<Uint8Array>;
    try {
      stream = await generateSpeech(speaker, text);
    } catch (e) {
      await refundDailyCap("speakChars", text.length);
      if (e instanceof UpstreamError && e.upstreamStatus === 404) {
        // the voice was deleted upstream (outside the pool): forget it, so choosing this take again saves a new one
        await voiceGone(body.descKey, voiceId);
        throw new ApiError("expired", RETIRED, 410);
      }
      throw e;
    }
    return new Response(captureClip(withPhonemes(stream, text), meta(false)), { headers: speechHeaders(false) });
  } catch (e) {
    return errorResponse(e);
  }
}
