/**
 * Claude writes a character's profile from its casting (text only, no image): a structured output held to a schema
 * (profileSchema.ts), as the casting is (claude.ts). FTV_MOCK_CLAUDE=1 swaps it for a development
 * stand-in (mockProfile.ts).
 */
import "server-only";

import { randomInt } from "node:crypto";

import { getClient, safeJson } from "./claude";
import { env } from "./env";
import { ApiError, MESSAGES } from "./errors";
import { mockProfile } from "./mockProfile";
import type { CharacterProfile } from "@/lib/character/profile";

import { clampProfile, PROFILE_JSON_SCHEMA, ProfileSchema, TRAITS } from "./profileSchema";
import { emotionWords, NEUTRAL } from "./emotion";
import type { DescriptionFields } from "./prompt";

const PROFILE_SYSTEM = `You write character profiles for a video game. Each character already has a face and a voice; the profile says who they are, so they can hold a conversation in character. Meeting them should feel like walking up to a character in a game: someone with a title, a life going on, and something they want right now.

The character is made up. Never use the name of a real person, living or dead, or of a famous fictional character, and never describe a real person. Invent a fresh name that fits their age, persona and the way they speak.

Set them in the world their persona belongs to: an everyday town for a baker, a world of magic for a witch or wizard. A fantasy character is fully part of that world (spells, potions, dragons, enchanted woods), never a person in costume.

Write from the casting below. The profile must match the voice: their age, energy, pace, moods and accent should all be felt in it. Lean into the persona the way games do, with specific, vivid details rather than generic ones.

Fields:
- name: an invented first name, optionally with a surname or a nickname. At most 4 words.
- title: their title, as a game shows it under a character's name: a few vivid words saying who they are ("retired chip-shop king", "lighthouse keeper of Gull Rock", "the market's worst fortune teller"). At most 6 words, lowercase except names.
- backstory: 2-3 short sentences (at most 60 words) about where they come from, what they do and one thing that shaped them.
- traits: exactly three personality traits from the list.
- habits: two small everyday habits (at most 10 words each).
- quirks: one or two odd little things about them (at most 10 words each).
- interests: two or three things they love talking about (1-4 words each).
- dislikes: one or two things they can't stand (1-4 words each): things, habits or situations, played for character ("soggy chips", "people who whistle", "calm seas"). Never a group of people.
- pace: how fast they talk, from the list; usually the casting's pacing.
- vocabulary: the kind of words they use, from the list.
- catchphrases: one or two short things they often say (at most 8 words each), in plain spelling. New words: not taken from their introduction line.
- mood: their mood right now, from the list; the expression on their face decides it when they have one.
- want: what they want right now, as they would say it, starting "to" (at most 25 words): a specific goal, problem or errand from their life that a stranger could help with or have an opinion on ("to find whoever keeps moving my lobster pots", "to get the town to taste my new pickled-egg recipe"). Small and everyday or a little adventurous, never dangerous, and nothing they need from the visitor in real life (no money, details or meetings).
- greeting: their first words when a stranger walks up to them: one or two short sentences, at most 25 words. It is a real hello, in their own way ("Well, hello there!", "Oi, you!", "Ah, a visitor!", "Oh! Hello..."), then something about them that makes sense to someone who knows nothing about them yet (who they are, what they're up to, how their day is going), usually ending with a question or an invitation to the visitor. They may give their name. Only spoken words: no narration, actions or stage directions, and no people or things the visitor can't know about ("this fella", "that shadow", "the clause"). Not an offer to help ("What can I do for you?") unless helping people is their job, and not their introduction line or a rewording of it.

Everything is family-friendly, contains no slurs, says nothing about the character's skin colour or ethnicity, and mentions no real people or brands. Plain English, standard spelling (no phonetic dialect spelling: the accent is in the voice). Use the enum values exactly as given.`;

export interface ProfileInput {
  fields: DescriptionFields; // the visitor's casting for this face (voice.ts castingFor)
  look: string; // lookText(): built server-side from the validated look ids
  /** Recast: the profile they have now. The new one is a different person for the same face and voice. */
  previous?: CharacterProfile;
}

/**
 * What a reimagined character's life centres on, one picked at random: sent the same request again, Claude wrote a
 * close variant of the same person (same job and setting from the casting's persona, a few details changed).
 */
const LIVES = [
  "animals", "a trade they do with their hands", "the sea", "the stage or music", "science or invention", "food and cooking",
  "the outdoors", "a shop, stall or market", "travel and far-off places", "the law (on either side of it)", "a sport",
  "art or craft", "the past (collecting, history, old things)", "machines and engines", "a small town where everyone knows them",
  "a big city at night", "teaching or looking after others", "games, puzzles and contests", "the sky (flying, weather, stars)",
  "a family business", "magic, spells and potions", "myths, monsters and legends",
] as const;

function reimagineBrief(previous: CharacterProfile, life: string): string {
  return (
    `Reimagine this character: write a completely different person for the same face and voice. A new name, a different ` +
    `line of work and setting, a different backstory, and new traits, habits, quirks, interests, dislikes, catchphrases ` +
    `and greeting. Keep only what the voice decides (gender of the voice, age, accent, energy, pace, moods); the persona ` +
    `in the casting was a first guess, so take them somewhere else. This time their life centres on: ${life}.\n` +
    `The profile they had, to share nothing with:\n<previous_profile>${JSON.stringify(previous)}</previous_profile>`
  );
}

/** The casting as Claude reads it: every field the voice was designed from, said in plain words. */
function castingBrief(f: DescriptionFields, look: string): string {
  const heritage = f.ethnicity && f.ethnicity !== "unclear" ? `\nHeritage (as cast): ${f.ethnicity}` : "";
  const quirk = f.quirk ? `\nDelivery quirk: ${f.quirk}` : "";
  return (
    `Persona: ${f.persona}\nGender of the voice: ${f.presentation}\nAge: ${f.ageRange}\nCharacter level: ${f.character}` +
    `\nAccent: ${f.accentStrength} ${f.accent}${heritage}\nVoice: ${f.pitch} pitch, ${f.timbre} timbre, ${f.energy} energy, ${f.pacing} pacing, ${f.build} build` +
    `\nMoods: ${f.mood1} and ${f.mood2}${quirk}\nExpression on the face: ${emotionWords(f.emotion ?? NEUTRAL, f.emotionIntensity ?? 0) || "neutral"}` +
    `\nStyling: ${look || "none"}\nThe line they say when introduced: ${f.line}`
  );
}

/**
 * One try, inside the route's 60 s with time to spare: a request cut off there never gives its daily cap back, and
 * outlives the lock that keeps a second writer out (characterProfile.ts).
 */
const PROFILE_REQUEST = { timeout: 40_000, maxRetries: 0 };

/** A new profile for this casting. */
export async function writeProfile(input: ProfileInput): Promise<CharacterProfile> {
  if (env.mockClaude) return clampProfile(mockProfile(input.fields));
  const ask = input.previous ? reimagineBrief(input.previous, LIVES[randomInt(LIVES.length)]) : "Write this character's profile.";
  const user = `${castingBrief(input.fields, input.look)}\nTraits to choose from: ${TRAITS.join(", ")}.\n${ask}`;
  let response;
  try {
    response = await getClient().messages.create({
      model: env.claudeModel,
      max_tokens: 1024,
      thinking: { type: "disabled" },
      system: PROFILE_SYSTEM,
      messages: [{ role: "user", content: user }],
      output_config: { format: { type: "json_schema", schema: PROFILE_JSON_SCHEMA } },
    }, PROFILE_REQUEST);
  } catch (e) {
    console.warn("[claude] profile failed:", e instanceof Error ? e.message.slice(0, 200) : e);
    throw new ApiError("upstream", MESSAGES.upstream_profile, 502);
  }
  const text = response.content.find((b) => b.type === "text")?.text;
  const parsed = response.stop_reason === "end_turn" && text ? ProfileSchema.safeParse(safeJson(text)) : null;
  if (!parsed?.success) {
    console.warn(`[claude] profile returned no profile (stop: ${response.stop_reason})`);
    throw new ApiError("upstream", MESSAGES.upstream_profile, 502);
  }
  return clampProfile(parsed.data);
}
