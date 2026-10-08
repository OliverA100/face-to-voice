import { describe, expect, it } from "vitest";

import { CASTING_JSON_SCHEMA, DescriptionSchema } from "../castingSchema";
import { MOODS, PRESENTATIONS } from "../prompt";

type Prop = { type?: string; enum?: string[]; items?: { type?: string } };
const props = CASTING_JSON_SCHEMA.properties as Record<string, Prop>;

describe("casting schema sent to Claude", () => {
  it("holds every list field to its values with a JSON Schema enum (constrained decoding)", () => {
    for (const [key, field] of Object.entries(DescriptionSchema.shape)) {
      if (!("options" in field)) continue; // free-text and array fields
      expect(props[key].enum, key).toEqual(field.options);
    }
    expect(props.mood1.enum).toEqual([...MOODS]);
    expect(props.presentation.enum).toEqual([...PRESENTATIONS]);
  });

  it("is a closed object with every field required, and no $schema line", () => {
    expect(CASTING_JSON_SCHEMA.additionalProperties).toBe(false);
    expect(new Set(CASTING_JSON_SCHEMA.required as string[])).toEqual(new Set(Object.keys(DescriptionSchema.shape)));
    expect(CASTING_JSON_SCHEMA).not.toHaveProperty("$schema");
  });

  it("still rejects a word outside a list when the answer is checked", () => {
    const answer = Object.fromEntries(
      Object.entries(DescriptionSchema.shape).map(([key, field]) => [key, "options" in field ? field.options[0] : key === "accents" ? ["texan"] : "x"]),
    );
    expect(DescriptionSchema.safeParse(answer).success).toBe(true);
    expect(DescriptionSchema.safeParse({ ...answer, mood1: "anxious" }).success).toBe(false);
  });
});
