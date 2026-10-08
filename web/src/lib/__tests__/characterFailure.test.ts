import { afterEach, describe, expect, it, vi } from "vitest";

// A Random character whose new piece fails to attach (a download error) must still land: the piece-fade batch is
// closed (or later Style-tab swaps would wait for a fade that never runs), and characterSettled resolves (the voice
// screenshot and the export wait on it).
const fade = vi.hoisted(() => ({ open: false }));
vi.mock("@/components/scene/Capture", () => ({ precompile: async () => {} }));
vi.mock("@/lib/headLoad", () => ({ preload: async () => {} }));
vi.mock("@/lib/pieceFade", () => ({
  finishPieceFade: () => void (fade.open = false),
  openPieceFade: () => void (fade.open = true),
  pieceFade: { arriving: [] },
  runPieceFade: async () => void (fade.open = false),
}));
vi.mock("@/lib/morphs/random", () => ({ clearRandomFace: () => {}, randomFace: () => ({}) }));
vi.mock("@/lib/morphs/store", () => ({ morphs: { tweenTo: () => {}, reset: () => {}, onChange: () => () => {}, onSettle: () => () => {} } }));
vi.mock("@/lib/pose", () => ({ centrePose: () => {} }));
vi.mock("@/lib/emotion", () => ({ NEUTRAL: "neutral", setEmotion: () => {}, setIntensity: () => {} }));
vi.mock("@/lib/skin", async (real) => ({ ...(await real<object>()), setSkinTone: () => {} }));
vi.mock("@/lib/eyes", async (real) => ({ ...(await real<object>()), setEyeColour: () => {} }));
vi.mock("@/lib/hair", async (real) => ({ ...(await real<object>()), setHairColour: () => {}, setHairStyle: async () => Promise.reject(new Error("offline")) }));
vi.mock("@/lib/addons", async (real) => ({ ...(await real<object>()), setAddonStyle: async () => {}, setFacialHairColour: () => {} }));

import { CHARACTER, characterSettled, randomCharacter } from "@/lib/character";

afterEach(() => vi.restoreAllMocks());

describe("Random character when a piece fails", () => {
  it("closes the piece fade and still settles", async () => {
    CHARACTER.duration = 0;
    vi.spyOn(Math, "random").mockReturnValue(0.5); // hair on: the failing setHairStyle runs
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const outcome = await randomCharacter().then(
      () => "landed",
      () => "rejected",
    );
    expect(fade.open).toBe(false);
    expect(outcome).toBe("landed"); // the Toolbar's .finally() would leave a rejection unhandled
    await expect(characterSettled()).resolves.toBeUndefined();
  });
});
