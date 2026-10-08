/**
 * The voice description. Claude casts the character like a video-game voice director: enum fields
 * plus short free-text fields (accent, persona, timbre, quirk, and the line the character says);
 * the final ElevenLabs prompt is assembled from a fixed template, never from free-form model output.
 *
 * The voice is cast from the whole look of the character. That includes the gender (read from the
 * look), an accent (always one, free text) and an ethnicity label the model picks from how the
 * character looks; the free text is not filtered by topic. Voices are stereotypical on purpose, and
 * only as plain as the character looks ("character": everyday / distinct / larger than life). Age is
 * one of the strongest cues and gets its own sentence (AGE_VOICE). One guard holds: the model must
 * not name or guess a real person (that would be face recognition, and a real name in the prompt
 * would make ElevenLabs imitate that person's voice).
 *
 * The expression on the face is the emotion the voice is designed in: it opens the prompt's "Emotion:"
 * (emotionVoice), the character's line is written in it, and it is part of the voice's cache identity.
 *
 * Pure module (no server-only import) so it can be unit-tested.
 */

import { emotionVoice, emotionWords, NEUTRAL } from "./emotion";

export const AGE_RANGES = ["late teens", "20s", "30s", "40s", "50s", "60s", "70s", "80s+"] as const;
export const PRESENTATIONS = ["neutral", "feminine", "masculine"] as const;
export const BUILDS = ["slight", "average", "sturdy", "heavy"] as const;
export const ENERGIES = ["calm", "relaxed", "lively", "intense"] as const;
export const PACINGS = ["slow", "measured", "brisk"] as const;
export const PITCHES = ["low", "medium-low", "medium", "medium-high", "high"] as const;
/** How much of a character the face reads as. "everyday" only for plain, unremarkable looks. */
export const CHARACTER_LEVELS = ["everyday", "distinct", "larger than life"] as const;
export const ACCENT_STRENGTHS = ["slight", "moderate", "thick"] as const;
/**
 * Accents are free text (the model can be as specific as the look suggests). This list is only quoted
 * in the brief as examples; add or remove freely.
 */
export const ACCENT_EXAMPLES = [
  "american", "british", "australian", "irish", "scottish", "canadian", "south african", "indian", "nigerian",
  "jamaican", "french", "german", "italian", "spanish", "portuguese", "russian", "polish", "swedish", "turkish",
  "arabic", "chinese", "japanese", "korean", "filipino", "mexican", "brazilian",
  "cockney", "posh british", "yorkshire", "west country", "welsh", "glaswegian", "texan", "southern american",
  "new york", "boston", "louisiana cajun", "caribbean", "ghanaian", "kenyan", "egyptian", "persian", "greek",
  "dutch", "eastern european", "vietnamese", "thai",
] as const;
/**
 * Claude names three accents that each fit the character; one is picked per face for variety (the same face always
 * gets the same one). Relative odds of Claude's 1st, 2nd and 3rd choice: equal = most variety, raise the first to
 * lean on Claude's favourite.
 */
const ACCENT_ODDS = [1, 1, 1];

/** One of Claude's accents, picked by `key` (a sha256 hex face key) with ACCENT_ODDS. */
export function pickAccent(accents: string[], key: string): string {
  const options = accents.map((a) => a.trim()).filter(Boolean).slice(0, ACCENT_ODDS.length);
  if (!options.length) return "";
  const odds = ACCENT_ODDS.slice(0, options.length);
  let r = (parseInt(key.slice(8, 16), 16) / 0x100000000) * odds.reduce((a, b) => a + b, 0);
  for (const [i, w] of odds.entries()) if ((r -= w) < 0) return options[i];
  return options[options.length - 1];
}

export const MOODS = [
  "warm", "friendly", "cheerful", "serious", "thoughtful", "playful", "confident", "gentle",
  "wry", "curious", "melancholic", "bold", "dreamy", "stern", "mischievous", "weary",
  "gruff", "smug", "jovial", "haughty", "sly", "nervous", "menacing", "grumpy",
  "boisterous", "sinister", "whimsical", "brooding", "sardonic", "pompous", "timid",
] as const;

export type Presentation = (typeof PRESENTATIONS)[number];

export interface DescriptionFields {
  presentation: Presentation; // the gender, read from the look
  ageRange: (typeof AGE_RANGES)[number];
  character: (typeof CHARACTER_LEVELS)[number];
  build: (typeof BUILDS)[number];
  energy: (typeof ENERGIES)[number];
  pacing: (typeof PACINGS)[number];
  pitch: (typeof PITCHES)[number];
  mood1: (typeof MOODS)[number];
  mood2: (typeof MOODS)[number];
  accent: string; // 1-4 words, e.g. "glaswegian", "louisiana cajun"
  accentStrength: (typeof ACCENT_STRENGTHS)[number];
  ethnicity: string; // 1-3 words, the character's apparent ethnicity or heritage; "unclear" when it is not apparent
  persona: string; // 2-6 words, a game-character archetype, e.g. "grizzled sea captain"
  timbre: string; // 1-4 words, e.g. "gravelly, weathered"
  quirk: string; // 0-8 words, a delivery trait, e.g. "chuckles between sentences"; may be empty
  line: string; // 1-3 sentences the character says; the Voice Design preview text
  // Set by the server from the validated look, not by Claude: the expression the voice is designed in.
  emotion: string; // "neutral", "happy", "angry", …
  emotionIntensity: number; // 0..1 in quarter steps
}

/** The fields Claude fills (the expression is added by the server). */
export type CastFields = Omit<DescriptionFields, "emotion" | "emotionIntensity">;

/** Words that must never reach the voice prompt (none today; add any you want blocked). Matched
 *  case-insensitively on word boundaries. */
const DENY: string[] = [];
const DENY_RE = DENY.length ? new RegExp(`\\b(${DENY.join("|")})\\b`, "i") : null;

export function violatesPolicy(text: string): string | null {
  const m = DENY_RE?.exec(text);
  return m ? m[1].toLowerCase() : null;
}

/** Letters and light punctuation only, at most `words` words and `max` characters, never cut mid-word. */
const cleanWords = (s: string, max: number, words = 6) => {
  const kept: string[] = [];
  for (const w of s.replace(/[^a-zA-Z ,'-]/g, " ").replace(/\s+/g, " ").trim().split(" ")) {
    if (kept.length >= words || [...kept, w].join(" ").length > max) break;
    kept.push(w);
  }
  return kept.join(" ").replace(/[ ,'-]+$/, "");
};

// Voice Design charges about one credit per character of this line (ElevenLabs needs at least 100). Claude is asked
// for 24-30 words (~140-175 chars); the slack above that keeps a slightly long line from being cut to one short sentence.
export const LINE_MAX = 200;

/**
 * The in-character line: plain sentences, at most LINE_MAX characters, ending on a complete sentence.
 * Code-like tokens ("possible.'.split.join") are dropped; trailing fragments after the last sentence go too.
 */
const cleanLine = (s: string) => {
  let t = s
    .replace(/[^a-zA-Z0-9 .,!?';:-]/g, " ")
    .split(/\s+/)
    .filter((w) => !/[a-z]\.'?\.?[a-z]/i.test(w))
    .join(" ")
    .trim()
    .replace(/^'+|'+$/g, "");
  if (t.length > LINE_MAX) t = t.slice(0, LINE_MAX);
  const end = Math.max(t.lastIndexOf("."), t.lastIndexOf("!"), t.lastIndexOf("?"));
  return end > 0 ? t.slice(0, end + 1) : t;
};

/** Free text is sanitised; a policy hit replaces the field with a neutral default. */
export function sanitiseFields<T extends CastFields>(f: T): { fields: T; replaced: string[] } {
  const replaced: string[] = [];
  const persona = cleanWords(f.persona, 50) || "everyday speaker";
  const timbre = cleanWords(f.timbre, 36, 4) || "clear";
  const quirk = cleanWords(f.quirk ?? "", 60, 8);
  const accent = cleanWords(f.accent ?? "", 32, 4).toLowerCase() || "general american";
  const ethnicity = cleanWords(f.ethnicity ?? "", 30, 3).toLowerCase() || "unclear";
  const line = cleanLine(f.line ?? "");
  const out = { ...f, persona, timbre, quirk, accent, ethnicity, line };
  for (const key of ["persona", "timbre", "quirk", "accent", "line"] as const) {
    if (!violatesPolicy(out[key])) continue;
    out[key] = { persona: "everyday speaker", timbre: "clear", quirk: "", accent: "general american", line: "" }[key];
    replaced.push(key);
  }
  return { fields: out, replaced };
}

const PITCH_PHRASE: Record<DescriptionFields["pitch"], string> = {
  low: "A low pitch",
  "medium-low": "A medium-low pitch",
  medium: "A medium pitch",
  "medium-high": "A medium-high pitch",
  high: "A high pitch",
};
const BUILD_PHRASE: Record<DescriptionFields["build"], string> = {
  slight: "a light, slender-sounding voice",
  average: "", // nothing: "even, natural-sounding" flattened theatrical characters
  sturdy: "a full, grounded-sounding voice",
  heavy: "a big, weighty-sounding voice",
};

/** Age is one of the strongest cues, so it gets a word on the noun and a sentence of its own. */
const AGE_VOICE: Record<DescriptionFields["ageRange"], { word: string; voice: string }> = {
  "late teens": { word: "Young", voice: "a young, bright voice that is still maturing" },
  "20s": { word: "Young", voice: "a youthful, fresh voice" },
  "30s": { word: "", voice: "a voice in its prime" },
  "40s": { word: "", voice: "a mature, settled voice" },
  "50s": { word: "", voice: "a seasoned voice with some weight and grain" },
  "60s": { word: "Older", voice: "an older voice, grainier and a little thinner at the top" },
  "70s": { word: "Elderly", voice: "an elderly voice, thin and creaky, with a slight tremble" },
  "80s+": { word: "Very old", voice: "a very old voice, frail, creaky and breathy, with a tremble" },
};
const PERSON: Record<Presentation, { noun: string; pronoun: string }> = {
  neutral: { noun: "person", pronoun: "their" },
  feminine: { noun: "woman", pronoun: "her" },
  masculine: { noun: "man", pronoun: "his" },
};
const CHARACTER_PHRASE: Record<DescriptionFields["character"], string> = {
  everyday: "An ordinary, down-to-earth character voice: natural, but alive and engaged, like a person in a scene, not a narrator.",
  distinct: "A memorable, characterful voice.",
  "larger than life": "A larger-than-life video game character voice: exaggerated, theatrical and full of personality.",
};

const titleCase = (s: string) => s.replace(/\b[a-z]/g, (c) => c.toUpperCase());
const capitalise = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
/** Every voice in this app speaks English; the accent is how it speaks it ("a thick Glaswegian accent"). */
const languagePhrase = (f: DescriptionFields) => `English with a ${f.accentStrength} ${titleCase(f.accent)} accent.`;

/**
 * ElevenLabs Voice Design prompt in the documented shape:
 * "<Language/accent>. <Gender>, <age>. <Quality>. Persona: … Emotion: … <timbre/pacing/delivery sentence>" plus
 * one sentence for how much of a character the voice is.
 */
export function buildVoiceDescription(f: DescriptionFields, options = { ethnicity: true }): string {
  const age = AGE_VOICE[f.ageRange];
  const person = PERSON[f.presentation];
  const decade = f.ageRange === "late teens" ? "late teens" : f.ageRange === "80s+" ? "80s" : f.ageRange;
  const who = options.ethnicity && f.ethnicity !== "unclear" ? `${f.persona}, ${titleCase(f.ethnicity)}` : f.persona;
  const text =
    `${languagePhrase(f)} ${capitalise(age.word ? `${age.word} ${person.noun}` : person.noun)} in ${person.pronoun} ${decade}: ${age.voice}. Studio quality. ` +
    `Persona: ${who}. Emotion: ${[emotionVoice(f.emotion, f.emotionIntensity), f.mood1, f.mood2].filter(Boolean).join(", ")}. ` +
    `${PITCH_PHRASE[f.pitch]} with a ${f.timbre} timbre, ${BUILD_PHRASE[f.build] ? `${BUILD_PHRASE[f.build]}, ` : ""}${f.energy} energy and a ${f.pacing} pace${f.quirk ? `; ${f.quirk}` : ""}. ` +
    CHARACTER_PHRASE[f.character];
  // API limits: 20-1000 characters.
  return text.length > 1000 ? text.slice(0, 997) + "..." : text;
}

/**
 * Fallback preview lines, matched to the energy, for when the character's own line is too short: a game character
 * greeting the player, so the voice is designed in a scene, not as a narrator. Any age, gender or persona can say them.
 */
const ENERGY_LINES: Record<DescriptionFields["energy"], string> = {
  calm: "Ah, there you are. Sit down, take a breath, nobody is chasing you in here. Now then, tell me what brings you to my door.",
  relaxed: "Oh hey, come on in, mind the mess. I was just about to put the kettle on, so you picked a good moment. What can I do for you?",
  lively: "Oh, finally, someone new! Come in, come in, I have been waiting all day for a bit of excitement. So, what is the plan? Tell me everything!",
  intense: "Stop right there. Nobody gets past this point without answering to me first. So talk fast, stranger, because my patience is running out.",
};

/**
 * Preview line ElevenLabs speaks for the three candidates: the character's own line (100 to LINE_MAX chars), else the
 * energy line. The bounds hold for any fields (cleanLine already caps Claude's line), so the design cost is bounded.
 */
export function previewText(f: DescriptionFields): string {
  return f.line && f.line.length >= 100 && f.line.length <= LINE_MAX ? f.line : ENERGY_LINES[f.energy];
}

/** "Expression on the face: angry (strong). …" or the resting-face sentence. Built from the validated look. */
export function expressionLine(emotion: string | undefined, intensity: number | undefined): string {
  const words = emotionWords(emotion ?? NEUTRAL, intensity ?? 0);
  return words
    ? `Expression on the face: ${words}. The voice is designed in this emotional state: mood1 must express it, the energy and pitch should follow it, and the line is said in it.`
    : "Expression on the face: neutral (the character's resting temperament).";
}

/** "Age slider: +0.80 (much older than the base head)". Built here from the validated number, never from browser text. */
export function ageLine(value: number | undefined): string {
  const v = Math.max(-1, Math.min(1, value ?? 0));
  const words = v <= -0.6 ? "much younger than" : v <= -0.2 ? "younger than" : v < 0.2 ? "about the same age as" : v < 0.6 ? "older than" : "much older than";
  return `Age slider (-1 younger .. +1 older): ${v >= 0 ? "+" : ""}${v.toFixed(2)} (${words} the base head).`;
}

const norm = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();

/**
 * Attributes that identify the *voice*, used as the cache key so similar faces share a voice. Everyday
 * characters share voices on the enums alone; a characterful face also keys on its persona, timbre and
 * quirk, so every such character gets a voice of its own.
 */
export function descriptionIdentity(f: DescriptionFields): Record<string, string | string[]> {
  const identity: Record<string, string | string[]> = {
    presentation: f.presentation,
    ageRange: f.ageRange,
    character: f.character,
    build: f.build,
    energy: f.energy,
    pacing: f.pacing,
    pitch: f.pitch,
    mood: [f.mood1, f.mood2],
    emotion: f.emotion === NEUTRAL || !f.emotionIntensity ? NEUTRAL : `${f.emotion} ${f.emotionIntensity}`,
    accent: norm(f.accent),
    accentStrength: f.accentStrength,
    ethnicity: f.ethnicity,
  };
  if (f.character !== "everyday") Object.assign(identity, { persona: norm(f.persona), timbre: norm(f.timbre), quirk: norm(f.quirk) });
  return identity;
}
