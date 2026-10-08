import { describe, expect, it } from "vitest";

import { towards } from "../rangeFill";

// What a screen reader hears for a slider's value (aria-valuetext).
describe("towards", () => {
  it("names the end the value leans to", () => {
    expect(towards("+0.40", 0.4, "narrow skull", "wide skull")).toBe("+0.40, toward wide skull");
    expect(towards("-0.40", -0.4, "narrow skull", "wide skull")).toBe("-0.40, toward narrow skull");
  });

  it("says middle at zero, or the low end of a one-sided slider", () => {
    expect(towards("+0.00", 0.004, "narrow", "wide")).toBe("+0.00, middle");
    expect(towards("0.00", 0, "young", "old", true)).toBe("0.00, young");
  });

  it("gives the bare value for raw sliders, whose ends have no names", () => {
    expect(towards("+0.40", 0.4, "−", "+")).toBe("+0.40");
    expect(towards("+0.40", 0.4, "-", "+")).toBe("+0.40");
  });
});
