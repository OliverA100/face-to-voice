import { LinearSRGBColorSpace } from "three";
import { describe, expect, it } from "vitest";

import { blendStrands, HAIR_COLOURS, hairChipHex, hairColourById, HAIR_STYLES, mixHex, naturalHex, rampOf, strandColours, tintStrands } from "../hair";
import { NATURAL_HAIR } from "../swatches";

const hex = (n: number) => "#" + n.toString(16).padStart(6, "0");

describe("hair colour", () => {
  it("mixes sRGB hex colours per channel", () => {
    expect(hex(mixHex("#204060", "#000000", 0))).toBe("#204060");
    expect(hex(mixHex("#204060", "#000000", 1))).toBe("#000000");
    expect(hex(mixHex("#000000", "#ffffff", 0.5))).toBe("#808080");
  });

  it("takes a painted colour toward its own grey for the Natural chip, leaving greys alone", () => {
    expect(naturalHex("#808080")).toBe("#808080");
    const [r, , b] = [1, 3, 5].map((i) => parseInt(naturalHex("#c08040").slice(i, i + 2), 16));
    expect(r).toBeLessThan(0xc0);
    expect(b).toBeGreaterThan(0x40);
  });

  it("falls back to Natural for unknown ids, and only Natural has no ramp", () => {
    expect(hairColourById("no-such-colour")).toBe(NATURAL_HAIR);
    for (const c of HAIR_COLOURS) expect(rampOf(c) === null).toBe(c.id === "natural");
  });

  it("shows a swatch's own chip, and Natural as the style's painted colour", () => {
    const black = HAIR_COLOURS.find((c) => c.id === "black")!;
    expect(hairChipHex("black", "none")).toBe(black.hex);
    expect(hairChipHex("natural", "none")).toBe(naturalHex(NATURAL_HAIR.hex));
    const style = HAIR_STYLES[0];
    if (style) expect(hairChipHex("natural", style.id)).toBe(naturalHex(style.natural));
  });

  it("tints a colour set with a ramp, darkened toward black or the ramp's shadow, and leaves it alone for null", () => {
    const ramp = { shadow: "#402010", highlight: "#c08040" };
    const set = strandColours();
    tintStrands(set, ramp);
    expect(set.uniforms.uHairShadow.value.getHex(LinearSRGBColorSpace)).toBe(0x402010); // raw sRGB, no conversion
    expect(set.uniforms.uHairHighlight.value.getHex(LinearSRGBColorSpace)).toBe(0xc08040);
    tintStrands(set, ramp, 1, "black");
    expect(set.uniforms.uHairHighlight.value.getHex(LinearSRGBColorSpace)).toBe(0x000000);
    tintStrands(set, ramp, 1, "shadow");
    expect(set.uniforms.uHairHighlight.value.getHex(LinearSRGBColorSpace)).toBe(0x402010);
    tintStrands(set, null);
    expect(set.uniforms.uHairHighlight.value.getHex(LinearSRGBColorSpace)).toBe(0x402010);
  });

  // Random character with a stubble or shell beard on Natural, following a bald head: the ramp is null.
  it("blends a colour set toward a ramp, and leaves it alone for null", async () => {
    const ramp = { shadow: "#402010", highlight: "#c08040" };
    const kept = strandColours();
    tintStrands(kept, ramp);
    blendStrands(kept, 0.01, null);
    const blended = strandColours();
    blendStrands(blended, 0.01, ramp);
    await new Promise((resolve) => setTimeout(resolve, 100));
    for (const set of [kept, blended]) {
      expect(set.uniforms.uHairShadow.value.getHex(LinearSRGBColorSpace)).toBe(0x402010);
      expect(set.uniforms.uHairHighlight.value.getHex(LinearSRGBColorSpace)).toBe(0xc08040);
    }
  });
});
