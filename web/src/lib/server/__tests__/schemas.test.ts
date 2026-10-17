import { describe, expect, it } from "vitest";

import { sliders } from "@/lib/data";
import { configureEmotions } from "@/lib/emotion";
import { morphs } from "@/lib/morphs/store";
import { Weights } from "@/lib/server/schemas";

describe("Weights", () => {
  it("accepts every slider the panel sends", () => {
    morphs.configure(sliders.sliders);
    configureEmotions(0.8);
    const sent = Object.fromEntries(morphs.targets().map((t) => [t, 0.5]));
    expect(Object.keys(sent).length).toBeGreaterThan(100);
    expect(Weights.safeParse(sent).success).toBe(true);
  });

  it("refuses a name that isn't a slider (it would make a new casting of the same face)", () => {
    expect(Weights.safeParse({ sem_age: 0.5, x1: 0.05 }).success).toBe(false);
    expect(Weights.safeParse({ sem_age: 1.5 }).success).toBe(false);
  });
});
