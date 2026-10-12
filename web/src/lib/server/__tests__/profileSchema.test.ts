import { describe, expect, it } from "vitest";

import { mockProfile } from "../mockProfile";
import { clampProfile, cleanText, LIMITS, PROFILE_JSON_SCHEMA, ProfileSchema, TRAITS, VOCABULARIES, type GeneratedProfile } from "../profileSchema";
import { MOODS, PACINGS, type DescriptionFields } from "../prompt";

type Prop = { type?: string; enum?: string[]; items?: { type?: string; enum?: string[] } };
const props = PROFILE_JSON_SCHEMA.properties as Record<string, Prop>;

const FIELDS = { persona: "grizzled sea captain", ageRange: "70s", pacing: "slow", mood1: "gruff" } as DescriptionFields;

const ANSWER: GeneratedProfile = {
  name: "Maren Holloway",
  title: "ferry captain of Gull Harbour",
  backstory: "Ran the harbour ferry for forty years.",
  traits: ["stubborn", "kind", "witty"],
  habits: ["checks the sky before every sentence"],
  quirks: ["names her boots"],
  interests: ["knots", "tides"],
  dislikes: ["calm seas"],
  pace: "slow",
  vocabulary: "colourful",
  catchphrases: ["Mind the tide."],
  mood: "gruff",
  greeting: "Well now, who washed up on my dock?",
  want: "to find out who keeps untying her mooring lines at night",
};

describe("profile schema sent to Claude", () => {
  it("holds traits, pace, vocabulary and mood to their lists with JSON Schema enums", () => {
    expect(props.traits.items?.enum).toEqual([...TRAITS]);
    expect(props.pace.enum).toEqual([...PACINGS]);
    expect(props.vocabulary.enum).toEqual([...VOCABULARIES]);
    expect(props.mood.enum).toEqual([...MOODS]);
  });

  it("is a closed object with every field required, without the constraints structured outputs refuse", () => {
    expect(PROFILE_JSON_SCHEMA.additionalProperties).toBe(false);
    expect(PROFILE_JSON_SCHEMA).not.toHaveProperty("$schema");
    expect(JSON.stringify(PROFILE_JSON_SCHEMA)).not.toMatch(/maxLength|minLength|minItems|maxItems/);
    expect(new Set(PROFILE_JSON_SCHEMA.required as string[])).toEqual(new Set(Object.keys(ProfileSchema.shape)));
  });

  it("the development mock is a valid answer", () => {
    expect(ProfileSchema.safeParse(mockProfile(FIELDS)).success).toBe(true);
  });
});

describe("clamping Claude's answer", () => {
  it("keeps a well-formed answer as it is", () => {
    expect(clampProfile(ANSWER)).toEqual(ANSWER);
  });

  it("clips long texts at a word and cuts lists to size", () => {
    const p = clampProfile({ ...ANSWER, traits: ["kind", "kind", "witty", "brave", "shy"], backstory: "word ".repeat(200), habits: ["a", "b", "c", "d", "e"], catchphrases: [] });
    expect(p.backstory.length).toBeLessThanOrEqual(LIMITS.backstory);
    expect(p.backstory.endsWith("word")).toBe(true);
    expect(p.traits).toEqual(["kind", "witty", "brave"]);
    expect(p.habits).toHaveLength(LIMITS.habits);
    expect(p.catchphrases).toHaveLength(1); // an empty list gets a filler
  });

  it("cleans text of markup and audio tags, so the greeting is spoken as words", () => {
    expect(cleanText('  Ann <b>"Bee"</b> [whispers] {x} `y`\n\tz\u0000 ')).toBe("Ann bBee/b whispers x y z");
    expect(clampProfile({ ...ANSWER, greeting: "Hello [laughs] there\nfriend" }).greeting).toBe("Hello laughs there friend");
  });
});
