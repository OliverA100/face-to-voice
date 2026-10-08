/**
 * DEVELOPMENT MOCK (FTV_MOCK_CLAUDE=1): a casting built from the request instead of from Claude's reading of the
 * screenshot, so a fresh clone runs the whole voice flow with no Anthropic key. Deterministic: the same request
 * always gives the same casting. It goes through the same schema and sanitising as a real one (claude.ts).
 *
 * Pure module (no server-only import) so it can be unit-tested.
 */
import type { Casting } from "./castingSchema";
import { quantiseIntensity, NEUTRAL } from "./emotion";
import type { Look } from "./look";
import { AGE_RANGES, type DescriptionFields } from "./prompt";

type Mood = DescriptionFields["mood1"];

/** How each expression is heard: the two moods and the energy (unknown ids and a zero intensity read as neutral). */
const EXPRESSION: Record<string, { moods: [Mood, Mood]; energy: DescriptionFields["energy"] }> = {
  [NEUTRAL]: { moods: ["warm", "friendly"], energy: "relaxed" },
  happy: { moods: ["cheerful", "jovial"], energy: "lively" },
  sad: { moods: ["melancholic", "weary"], energy: "calm" },
  angry: { moods: ["menacing", "gruff"], energy: "intense" },
  surprised: { moods: ["curious", "boisterous"], energy: "lively" },
  afraid: { moods: ["nervous", "timid"], energy: "intense" },
  disgusted: { moods: ["haughty", "sardonic"], energy: "relaxed" },
  contempt: { moods: ["haughty", "smug"], energy: "calm" },
  confused: { moods: ["curious", "thoughtful"], energy: "relaxed" },
  suspicious: { moods: ["sly", "wry"], energy: "calm" },
  worried: { moods: ["nervous", "serious"], energy: "lively" },
  tired: { moods: ["weary", "gentle"], energy: "calm" },
  pain: { moods: ["stern", "weary"], energy: "intense" },
};

/** Two sentences, 29 words: long enough (over 100 characters) to be the Voice Design preview line, as a real one is. */
export const MOCK_LINE = "Welcome, traveller, you look like you have come a long way today. Sit by the fire, rest your feet, and tell me what news you carry from the road.";

const worn = (look: Look, key: string) => !!look[key] && look[key] !== "none";
/** Styling that makes a character (the expression and the pose are read separately). */
const STYLED_KEYS = ["hair", "eyebrows", "eyelashes", "facialHair", "glasses"];

export function mockCasting(input: { ageSlider?: number; lookIds: Look }): Casting {
  const look = input.lookIds;
  const intensity = quantiseIntensity(Number(look.emotionIntensity ?? 0));
  const expression = (intensity > 0 && EXPRESSION[look.emotion ?? NEUTRAL]) || EXPRESSION[NEUTRAL];
  // The Age slider (−1 … +1) spread evenly over the age ranges.
  const age = Math.max(-1, Math.min(1, input.ageSlider ?? 0));
  const ageRange = AGE_RANGES[Math.min(AGE_RANGES.length - 1, Math.floor(((age + 1) / 2) * AGE_RANGES.length))];
  const presentation = worn(look, "facialHair") ? "masculine" : "neutral";
  const everyday = intensity === 0 && !STYLED_KEYS.some((k) => worn(look, k));
  const persona = worn(look, "glasses") ? "bookish town archivist" : worn(look, "facialHair") ? "bearded harbour keeper" : "friendly village shopkeeper";
  return {
    presentation,
    ageRange,
    character: everyday ? "everyday" : "distinct",
    build: "average",
    energy: expression.energy,
    pacing: "measured",
    pitch: presentation === "masculine" ? "medium-low" : "medium",
    mood1: expression.moods[0],
    mood2: expression.moods[1],
    accents: ["general american", "irish", "yorkshire"],
    accentStrength: everyday ? "slight" : "moderate",
    ethnicity: "unclear",
    persona,
    timbre: "clear, warm",
    quirk: "",
    line: MOCK_LINE,
  };
}
