/**
 * The shape of Claude's casting, and the JSON Schema sent as its structured output. The schema comes from zod's own
 * converter, which keeps every list as a JSON Schema `enum`, so the API's constrained decoding holds Claude to it.
 * (The SDK's zodOutputFormat helper turns enums into a plain string with the list in its description: Claude is only
 * asked to pick from it, and an off-list word failed the parse.)
 */
import { z } from "zod";

import {
  ACCENT_STRENGTHS, AGE_RANGES, BUILDS, CHARACTER_LEVELS, ENERGIES, MOODS, PACINGS, PITCHES, PRESENTATIONS,
} from "./prompt";

export const DescriptionSchema = z.object({
  presentation: z.enum(PRESENTATIONS),
  ageRange: z.enum(AGE_RANGES),
  character: z.enum(CHARACTER_LEVELS),
  build: z.enum(BUILDS),
  energy: z.enum(ENERGIES),
  pacing: z.enum(PACINGS),
  pitch: z.enum(PITCHES),
  mood1: z.enum(MOODS),
  mood2: z.enum(MOODS),
  accents: z.array(z.string()),
  accentStrength: z.enum(ACCENT_STRENGTHS),
  ethnicity: z.string(),
  persona: z.string(),
  timbre: z.string(),
  quirk: z.string(),
  line: z.string(),
});
/** Claude's answer as the schema returns it, before sanitising and the accent pick. */
export type Casting = z.infer<typeof DescriptionSchema>;

/** `output_config.format.schema` for the casting request (without the `$schema` dialect line). */
export const CASTING_JSON_SCHEMA: Record<string, unknown> = Object.fromEntries(
  Object.entries(z.toJSONSchema(DescriptionSchema)).filter(([key]) => key !== "$schema"),
);
