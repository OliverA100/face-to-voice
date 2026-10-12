/**
 * DEVELOPMENT MOCK (FTV_MOCK_CLAUDE=1): a character profile built from the casting instead of by Claude, so the profile
 * card and the conversation run with no Anthropic key. Deterministic (the same casting gives the same profile) and
 * held to the same schema as a real one (profileClaude.ts clamps both).
 *
 * Pure module (no server-only import) so it can be unit-tested.
 */
import type { GeneratedProfile } from "./profileSchema";
import type { DescriptionFields } from "./prompt";

const NAMES = ["Maren Holloway", "Tobias Fenn", "Ada Quill", "Rufus Marlowe", "Iris Penhallow", "Bram Okafor", "Nell Ashdown", "Silas Crane"];

/** A small stable hash of the persona: picks the name, so different personas get different names. */
const pick = (s: string, n: number) => [...s].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7) % n;

export function mockProfile(f: DescriptionFields): GeneratedProfile {
  const persona = f.persona || "village shopkeeper";
  return {
    name: NAMES[pick(persona, NAMES.length)],
    title: `the ${persona} who knows everyone`,
    backstory: `A ${persona} in their ${f.ageRange} who has seen more of the world than they let on. They keep a notebook of every stranger's story and swear one day it will be a book.`,
    traits: ["curious", "witty", "stubborn"],
    habits: ["taps the table while thinking", "names every stray cat in town"],
    quirks: ["answers questions with a question first"],
    interests: ["old maps", "weather", "a good mystery"],
    dislikes: ["being rushed", "lukewarm tea"],
    pace: f.pacing,
    vocabulary: "colourful",
    catchphrases: ["Well, isn't that something."],
    mood: f.mood1,
    greeting: "Oh, hello there. You look like someone with a story. Come on, sit down and tell me.",
    want: "to find out who keeps leaving riddles under the shop door every morning",
  };
}
