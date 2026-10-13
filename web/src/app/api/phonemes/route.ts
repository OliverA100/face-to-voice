/**
 * GET /api/phonemes?w=hello,world → { phonemes: { hello: "HH AH0 L OW1", world: "W ER1 L D" } }
 *
 * The CMU Pronouncing Dictionary's entries for a few words, for a live conversation's mouth: its words come from the
 * agent as it speaks (lib/lipsync/live.ts), not with the speak route's line, so the browser asks for them here. Public
 * dictionary data (BSD-2, NOTICE), no paid work: cached by the browser and the CDN like a static file. Words the
 * dictionary doesn't know are left out (the letter rules shape them).
 */
import { phonemesFor } from "@/lib/server/pronounce";

const MAX_WORDS = 80;

export async function GET(request: Request) {
  const raw = new URL(request.url).searchParams.get("w") ?? "";
  const words = raw.split(",").filter((w) => /^[a-z']{1,40}$/.test(w)).slice(0, MAX_WORDS);
  return Response.json({ phonemes: phonemesFor(words.join(" ")) }, { headers: { "cache-control": "public, max-age=86400, s-maxage=31536000, immutable" } });
}
