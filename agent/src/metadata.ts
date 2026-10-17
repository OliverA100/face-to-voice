/**
 * The job metadata the web server signs into the LiveKit token (web/src/lib/server/characterPrompt.ts TalkMetadata).
 * Only that server can sign a token that dispatches this agent, but the agent still checks the shape, and applies its
 * own hard limits: the metadata can shorten a conversation, never lengthen it past HARD_MAX_SECONDS.
 */
import { z } from "zod";

export const HARD_MAX_SECONDS = 300;

// an audio tag's words: a "[" or "]" in them would end the tag early, and the rest would be spoken
const Tag = z.string().max(80).regex(/^[^[\]]*$/);
const Tags = z.tuple([Tag, Tag, Tag]);

export const MetadataSchema = z.object({
  v: z.literal(1),
  name: z.string().min(1).max(60),
  voiceId: z.string().regex(/^[A-Za-z0-9_-]{4,64}$/),
  instructions: z.string().min(1).max(12_000),
  greeting: z.string().min(1).max(400),
  again: z.boolean().default(false), // a later chat in the same visit: open with a new line, not the greeting
  startMood: z.object({ emotion: z.string().max(24), strength: z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(3)]) }),
  moodTags: z.record(z.string().max(24), Tags),
  maxSeconds: z.number().int().min(10).transform((s) => Math.min(s, HARD_MAX_SECONDS)),
});
export type TalkMetadata = z.infer<typeof MetadataSchema>;

export function parseMetadata(raw: string): TalkMetadata {
  return MetadataSchema.parse(JSON.parse(raw));
}
