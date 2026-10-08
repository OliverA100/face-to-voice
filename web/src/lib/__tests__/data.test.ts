import { describe, expect, it } from "vitest";

import { addonIndex, emotionDefs, hairIndex, manifest, sectionOf, sliders, visemePreset, visemes } from "../data";

describe("pipeline data contract", () => {
  it("looks visemes up by the cue engine's upper-case ids", () => {
    const [id, weights] = Object.entries(visemes.visemes)[0];
    expect(visemePreset(id.toUpperCase())).toEqual(weights);
    expect(visemePreset("no-such-viseme")).toEqual({});
  });

  it("puts sliders without a section in Advanced", () => {
    expect(sectionOf({})).toBe("advanced");
    expect(sectionOf({ section: "pose" })).toBe("pose");
  });

  it("has both parts of every emotion among the head's morph targets", () => {
    const targets = new Set(manifest.targets.map((t) => t.name));
    expect(emotionDefs.length).toBeGreaterThan(0);
    for (const e of emotionDefs) {
      expect(targets.has(e.upper), e.upper).toBe(true);
      expect(targets.has(e.lower), e.lower).toBe(true);
    }
    expect(sliders.emotions.intensity.default).toBeGreaterThan(0);
  });

  // lib/hair.ts and lib/addons.ts draw every hair style, brow and lash as strands and every glasses style from its
  // generated look; a style of another kind would need its drawing path back.
  it("ships hair, brows and lashes as strands and glasses with a generated look", () => {
    for (const s of hairIndex.styles) expect(s.kind === "strands" && !!s.strands, s.id).toBe(true);
    for (const c of ["eyebrows", "eyelashes"] as const) for (const s of addonIndex[c].styles) expect(s.kind === "strands" && !!s.strands, s.id).toBe(true);
    for (const s of addonIndex.glasses.styles) expect(!!s.glasses, s.id).toBe(true);
  });
});
