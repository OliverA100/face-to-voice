/**
 * A character's profile: who the voice is, written by Claude from the casting once a voice is chosen, and the brief
 * the live conversation agent plays (lib/server/characterPrompt.ts).
 *
 * ProfileSchema is Claude's structured output. The fixed fields (traits, pace, vocabulary, mood) are JSON Schema enums
 * through zod's converter, as castingSchema.ts does. The API's constrained decoding doesn't take string lengths or array
 * sizes, so those are clamped afterwards (clampProfile), and the text is cleaned of anything that could read as markup
 * or an audio tag when the greeting is spoken.
 *
 * Pure module (no server-only import) so it can be unit-tested.
 */
import { z } from "zod";

import type { CharacterProfile } from "@/lib/character/profile";

import { MOODS, PACINGS } from "./prompt";

/** Personality traits Claude picks three of. Add or remove freely: they are only the generated profile's vocabulary. */
export const TRAITS = [
  "adventurous", "anxious", "blunt", "boastful", "brave", "cautious", "charming", "cheeky", "competitive", "curious",
  "cynical", "dramatic", "dreamy", "earnest", "eccentric", "fussy", "generous", "gloomy", "gossipy", "grumpy",
  "honest", "hot-headed", "idealistic", "impatient", "kind", "loyal", "meticulous", "mischievous", "nostalgic", "optimistic",
  "patient", "pompous", "practical", "proud", "secretive", "sentimental", "shy", "stubborn", "superstitious", "witty",
] as const;
export const VOCABULARIES = ["plain", "casual", "colourful", "formal", "technical", "old-fashioned", "poetic"] as const;

export const ProfileSchema = z.object({
  name: z.string(),
  title: z.string(),
  backstory: z.string(),
  traits: z.array(z.enum(TRAITS)),
  habits: z.array(z.string()),
  quirks: z.array(z.string()),
  interests: z.array(z.string()),
  dislikes: z.array(z.string()),
  pace: z.enum(PACINGS),
  vocabulary: z.enum(VOCABULARIES),
  catchphrases: z.array(z.string()),
  mood: z.enum(MOODS),
  greeting: z.string(),
  want: z.string(),
});
/** Claude's answer as the schema returns it, before clamping. */
export type GeneratedProfile = z.infer<typeof ProfileSchema>;

/** `output_config.format.schema` for the profile request (without the `$schema` dialect line). */
export const PROFILE_JSON_SCHEMA: Record<string, unknown> = Object.fromEntries(
  Object.entries(z.toJSONSchema(ProfileSchema)).filter(([key]) => key !== "$schema"),
);

/** Lengths (characters) and how many items each list keeps. */
export const PROFILE_LIMITS = {
  name: 40,
  title: 48,
  backstory: 400,
  want: 180,
  greeting: 160,
  trait: 24,
  traits: 3,
  habit: 80,
  habits: 3,
  quirk: 80,
  quirks: 2,
  interest: 40,
  interests: 3,
  dislike: 40,
  dislikes: 2,
  catchphrase: 60,
  catchphrases: 2,
} as const;

/**
 * Text made safe to show, quote in a prompt and speak: control characters and line breaks become spaces, and brackets,
 * braces, angle brackets, backticks and double quotes are dropped (so a greeting can't carry an audio tag like
 * "[whispers]"). Spaces collapse; the result is trimmed.
 */
export function cleanText(s: string): string {
  return s
    .normalize("NFKC")
    .replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, " ")
    .replace(/[<>{}[\]`"\\]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** Spoken text without stage directions: "*chuckles*" and "(sighs)" are left out whole (the voice would read them). */
function withoutActions(s: string): string {
  return s.replace(/\*[^*]*\*|\([^)]*\)/g, " ");
}

/** `s` cleaned and cut to `max` characters, at a word boundary when one is near (a generated sentence can run long). */
function clip(s: string, max: number): string {
  const t = cleanText(s);
  if (t.length <= max) return t;
  const cut = t.slice(0, max);
  const space = cut.lastIndexOf(" ");
  return (space > max * 0.6 ? cut.slice(0, space) : cut).replace(/[\s,;:–-]+$/, "");
}

/** Spoken text cut to `max` characters at the end of a sentence, when one fits: a greeting cut mid-sentence is said
 *  that way ("…you ain't here to tell me, are"). Otherwise as `clip`. */
function clipSentences(s: string, max: number): string {
  const t = cleanText(s);
  if (t.length <= max) return t;
  const end = Math.max(...[...t.slice(0, max + 1).matchAll(/[.!?…](?=\s|$)/g)].map((m) => m.index! + 1), 0);
  return end > 0 ? t.slice(0, end) : clip(t, max);
}

/** Claude's answer held to PROFILE_LIMITS: texts cleaned and clipped, lists cut to size (a list Claude left empty gets a filler). */
export function clampProfile(p: GeneratedProfile): CharacterProfile {
  const items = (xs: string[], max: number, most: number, filler: string) => {
    const kept = xs.map((x) => clip(x, max)).filter(Boolean).slice(0, most);
    return kept.length ? kept : [filler];
  };
  return {
    name: clip(p.name, PROFILE_LIMITS.name) || "Unnamed",
    title: clip(p.title, PROFILE_LIMITS.title),
    backstory: clip(p.backstory, PROFILE_LIMITS.backstory),
    traits: items([...new Set(p.traits)], PROFILE_LIMITS.trait, PROFILE_LIMITS.traits, "curious"),
    habits: items(p.habits, PROFILE_LIMITS.habit, PROFILE_LIMITS.habits, "hums while thinking"),
    quirks: items(p.quirks, PROFILE_LIMITS.quirk, PROFILE_LIMITS.quirks, "repeats the last word of a question"),
    interests: items(p.interests, PROFILE_LIMITS.interest, PROFILE_LIMITS.interests, "a good story"),
    dislikes: items(p.dislikes, PROFILE_LIMITS.dislike, PROFILE_LIMITS.dislikes, "being rushed"),
    pace: p.pace,
    vocabulary: p.vocabulary,
    catchphrases: items(p.catchphrases, PROFILE_LIMITS.catchphrase, PROFILE_LIMITS.catchphrases, "Well, there it is."),
    mood: p.mood,
    greeting: clipSentences(withoutActions(p.greeting), PROFILE_LIMITS.greeting) || "Oh, hello there.",
    want: clip(p.want, PROFILE_LIMITS.want),
  };
}
