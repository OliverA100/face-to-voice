/**
 * Claude casts the voice from a screenshot of the face plus the slider values, like a video-game
 * voice director. Model: Sonnet 5 with thinking off (fast, ~1 ¢ per call). Structured outputs
 * hold every list field to its values (castingSchema.ts); the prompt states the image is a synthetic
 * render, that the whole look (hair, add-ons, expression, pose, age) shapes the voice, and the one
 * thing that stays out (naming or guessing a real person). FTV_MOCK_CLAUDE=1 swaps Claude for a fixed development casting (mockCasting.ts).
 */
import "server-only";

import Anthropic from "@anthropic-ai/sdk";

import { CASTING_JSON_SCHEMA, type Casting, DescriptionSchema } from "./castingSchema";
import { env } from "./env";
import { ApiError, MESSAGES } from "./errors";
import type { Look } from "./look";
import { mockCasting } from "./mockCasting";
import { ACCENT_EXAMPLES, ageLine, pickAccent, sanitiseFields, type CastFields } from "./prompt";

const SYSTEM = `You are the voice casting director for a video game. Each character gets a voice as distinctive as the way it looks.

The image is a screenshot of a synthetic 3D head from a statistical head model, shaped with sliders and styled by the visitor. It is not a photograph and not a real person. Cast the voice this character would have in a game and fill in the fields.

Cast the way games do: lean into stereotypes, exaggerate, make the voice memorable. Everything you can see is part of the character, and every cue should be heard:
- Age is one of the strongest cues. The age must be obvious in the voice: older means slower, creakier, grainier, thinner or wheezier; young means brighter, quicker and lighter. Judge the age from the face and the Age slider line below, and exaggerate it the way games do: when a face sits between two ranges, pick the one further from the 30s.
- Face shape: a broad, heavy jaw sounds gruff and big; a long, narrow face sounds haughty, reedy or nasal; a round, soft face sounds jolly; hollow cheeks sound gaunt or wheezy; a large head and heavy features sound booming.
- The expression on the face is the emotion the voice is designed in, and it should be clearly heard: mood1 expresses it (angry: menacing or gruff; happy: jovial or cheerful; sad: melancholic or weary; afraid: nervous or timid; surprised: curious or boisterous; disgusted: haughty or sardonic), energy and pitch follow it, and the line is said in that state. A strong expression pushes the character level up. A neutral face is the character's resting temperament. The expression changes how they sound right now, not who they are: cast the persona, accents, ethnicity and timbre as you would for the same face at rest.
- Skin tone and apparent heritage suggest a specific regional accent; hair and facial hair suggest a type (a grey bun reads as a grandmother, a viking beard as a booming northerner, a buzz cut as a soldier); glasses suggest a scholar or a snob; the head pose adds attitude (chin up is haughty, a tilt is playful or curious).
These are examples, not rules. Stack the cues: every strong feature, style choice, expression or pose should push the voice further. Only a plain, unremarkable face with no strong features or styling gets an ordinary voice.

This is a made-up character: never name or guess a real person, and never write a real person's name in any field.

Fields:
- presentation: the gender the voice should have, read from the whole look (face shape, hair, facial hair, eyelashes, styling). Commit to feminine or masculine; use neutral only when the character truly reads as neither.
- ageRange: the age the character looks.
- character: "everyday" only when the character looks plain and generic (close to the default head, little styling, a calm face). "distinct" when one thing stands out (a styled look, a strong feature, a clear expression, an old or very young face). "larger than life" when strong cues stack up (for example a beard with long wild hair and an angry face, or a very old face with glasses and a stern look) or any single cue is extreme.
- persona: 2-6 words, the character's archetype as a game would cast it ("grizzled sea captain", "snooty art dealer", "cheerful village baker", "street-smart hustler").
- timbre: 1-4 vivid words about the sound ("gravelly, weathered", "nasal", "silky", "booming", "reedy", "wheezy", "husky").
- quirk: 0-8 words, one delivery trait ("slow Southern drawl", "clipped military cadence", "chuckles between sentences", "sniffs disapprovingly"); empty for an everyday character with none.
- mood1 / mood2: two different moods from the list.
- accents: three different accents (1-4 words each) this character could speak English with, judged from the whole look; one of them is picked at random for variety, so each of the three must suit the character. Be specific and regional where the look allows. Examples: ${ACCENT_EXAMPLES.join(", ")}. These are a starting point, not a limit. When you name an ethnicity, the accents normally follow that heritage. A heritage spans many accents. Skin tone alone doesn't say where someone grew up: a dark-skinned character may as well be African American, Black British, Caribbean or from anywhere in Africa. Choose from the whole look and the persona, spread the three across the places this character could plausibly be from, and don't default to the most common accent of a region. When heritage is unclear, still pick regional varieties (Texan, New York, Midwestern, Californian, Cockney, Yorkshire, Irish…) that fit the character; a plain "american" or "british" is the last resort. Always give three.
- accentStrength: how strong the accent is; by default "thick" for larger-than-life characters, "moderate" for distinct ones and "slight" for everyday ones.
- ethnicity: 1-3 words for the character's apparent ethnicity or heritage as it looks to you; "unclear" when it is not apparent. Skin tone and features alone point to a broad group (e.g. "black", "white", "east asian", "south asian"), not a country or region; name a region only when the styling or persona points there. All three accents should fit it.
- line: exactly 2 sentences, 24-30 words in total (never fewer than 24 words), that this character would say when introduced in the game, in their own voice, so it sounds their age, mood and type. Plain standard spelling (no phonetic dialect spelling; the accent comes from the voice), though a few character words are fine ("aye", "mate", "y'all"). Family-friendly, no slurs, not about the character's skin or ethnicity, no real people.
Use the enum values exactly as given (lower-case).`;

let client: Anthropic | null = null;
function getClient(): Anthropic {
  if (!env.anthropicKey()) throw new ApiError("unavailable", MESSAGES.unavailable, 503);
  return (client ??= new Anthropic({ apiKey: env.anthropicKey(), timeout: 30_000, maxRetries: 1 }));
}

export interface DescribeInput {
  imageJpegBase64: string;
  sliderSummary: string; // "Jaw width: +0.60, Smile ↔ frown: -0.20, …" (named sliders only)
  ageSlider?: number; // the Age slider (sem_age), from the validated weights
  expression: string; // expressionLine(): built server-side from the validated look
  look: string; // "hair style: crop; hair colour: natural" (built server-side from ids)
  pickKey: string; // picks one of Claude's three accents: the resting face's key, so expressions and poses keep it
  lookIds: Look; // the validated look itself: only the development mock reads it (Claude gets `look`)
}

/** The cast for one face; `replaced` names the free-text fields the policy replaced with a default. */
export async function describeFace(input: DescribeInput): Promise<{ fields: CastFields; replaced: string[] }> {
  const casting = env.mockClaude ? DescriptionSchema.parse(mockCasting(input)) : await castWithClaude(input);
  const { accents, ...cast } = casting;
  const { fields, replaced } = sanitiseFields({ ...cast, accent: pickAccent(accents, input.pickKey) });
  if (fields.mood1 === fields.mood2) fields.mood2 = fields.mood1 === "warm" ? "friendly" : "warm";
  return { fields, replaced };
}

async function castWithClaude(input: DescribeInput): Promise<Casting> {
  const api = getClient();
  const user = `${input.expression}\n${ageLine(input.ageSlider)}\nSlider values the user set (weight -1..1, name: value): ${input.sliderSummary || "all at rest"}.\nStyling the visitor chose (also visible in the image): ${input.look || "none"}.\nCast the voice for this character.`;
  let response;
  try {
    response = await api.messages.create({
      model: env.claudeModel,
      max_tokens: 1024,
      thinking: { type: "disabled" },
      system: SYSTEM,
      messages: [
        {
          role: "user",
          content: [
            { type: "image", source: { type: "base64", media_type: "image/jpeg", data: input.imageJpegBase64 } },
            { type: "text", text: user },
          ],
        },
      ],
      output_config: { format: { type: "json_schema", schema: CASTING_JSON_SCHEMA } },
    });
  } catch (e) {
    console.warn("[claude] describe failed:", e instanceof Error ? e.message.slice(0, 200) : e);
    throw new ApiError("upstream", MESSAGES.upstream, 502);
  }
  // A refusal or a cut-off answer may not match the schema; anything else is held to it by constrained decoding.
  const text = response.content.find((b) => b.type === "text")?.text;
  const parsed = response.stop_reason === "end_turn" && text ? DescriptionSchema.safeParse(safeJson(text)) : null;
  if (!parsed?.success) {
    console.warn(`[claude] describe returned no casting (stop: ${response.stop_reason})`);
    throw new ApiError("upstream", MESSAGES.upstream, 502);
  }
  return parsed.data;
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
