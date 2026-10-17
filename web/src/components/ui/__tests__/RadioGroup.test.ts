import { afterEach, describe, expect, it, vi } from "vitest";

import { nextRadio, rove } from "../RadioGroup";

// Every chip row (swatches, hair, add-ons, emotions, Line chips) is one Tab stop with arrow keys: if this breaks, a
// keyboard user can't reach or change any of them.
afterEach(() => vi.unstubAllGlobals());

describe("arrow keys in a radio group", () => {
  it("move to the next and previous radio, wrapping round", () => {
    expect(nextRadio("ArrowRight", 0, 3)).toBe(1);
    expect(nextRadio("ArrowDown", 2, 3)).toBe(0);
    expect(nextRadio("ArrowLeft", 0, 3)).toBe(2);
    expect(nextRadio("ArrowUp", 1, 3)).toBe(0);
  });

  it("Home and End go to the ends; other keys are left alone (Tab, Space, letters)", () => {
    expect(nextRadio("Home", 2, 3)).toBe(0);
    expect(nextRadio("End", 0, 3)).toBe(2);
    for (const key of ["Tab", " ", "Enter", "a"]) expect(nextRadio(key, 1, 3)).toBe(-1);
  });
});

describe("the group's one Tab stop", () => {
  const radio = (checked: boolean, disabled = false) => ({ disabled, tabIndex: 0, getAttribute: () => String(checked) });
  const group = (radios: ReturnType<typeof radio>[]) => ({ querySelectorAll: () => radios }) as unknown as HTMLElement;

  it("is the chosen radio, skipping disabled ones; every other radio is out of the Tab order", () => {
    vi.stubGlobal("document", { activeElement: null });
    const radios = [radio(false, true), radio(false), radio(true), radio(false)];
    rove(group(radios));
    expect(radios.map((r) => r.tabIndex)).toEqual([-1, -1, 0, -1]);
  });

  it("is the first enabled radio when none is chosen, and the focused one while the arrows move", () => {
    const radios = [radio(false, true), radio(false), radio(false)];
    vi.stubGlobal("document", { activeElement: null });
    rove(group(radios));
    expect(radios.map((r) => r.tabIndex)).toEqual([-1, 0, -1]);
    vi.stubGlobal("document", { activeElement: radios[2] });
    rove(group(radios));
    expect(radios.map((r) => r.tabIndex)).toEqual([-1, -1, 0]);
  });

  it("goes back to the chosen radio when focus leaves the group (arrows that don't choose: hair, add-ons)", () => {
    const radios = [radio(false), radio(true), radio(false)];
    vi.stubGlobal("document", { activeElement: radios[2] }); // arrowed onto the third, Enter not pressed
    rove(group(radios), false);
    expect(radios.map((r) => r.tabIndex)).toEqual([-1, 0, -1]);
  });
});
