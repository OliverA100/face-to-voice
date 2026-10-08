import { afterEach, describe, expect, it, vi } from "vitest";

// Random character downloads the next look's hair while the face morphs, so the cross-fade has it in time. In
// production the hair loader fetches strand files from Vercel Blob (data/hairBlob.json), so that is what must be
// downloaded ahead; the same path under /models is not deployed.
vi.mock("@/components/scene/Capture", () => ({ precompile: async () => {} }));
vi.mock("@/lib/headLoad", () => ({ preload: vi.fn(async () => {}) }));
vi.mock("@/lib/pieceFade", () => ({ finishPieceFade: () => {}, openPieceFade: () => {}, pieceFade: { arriving: [] }, runPieceFade: async () => {} }));
vi.mock("@/lib/morphs/random", () => ({ clearRandomFace: () => {}, randomFace: () => ({}) }));
vi.mock("@/lib/morphs/store", () => ({ morphs: { tweenTo: () => {}, reset: () => {}, onChange: () => () => {}, onSettle: () => () => {} } }));
vi.mock("@/lib/pose", () => ({ centrePose: () => {} }));
vi.mock("@/lib/emotion", () => ({ NEUTRAL: "neutral", setEmotion: () => {}, setIntensity: () => {} }));
vi.mock("@/lib/skin", async (real) => ({ ...(await real<object>()), setSkinTone: () => {} }));
vi.mock("@/lib/eyes", async (real) => ({ ...(await real<object>()), setEyeColour: () => {} }));
vi.mock("@/lib/hair", async (real) => ({ ...(await real<object>()), setHairColour: () => {}, setHairStyle: async () => {} }));
vi.mock("@/lib/addons", async (real) => ({ ...(await real<object>()), setAddonStyle: async () => {}, setFacialHairColour: () => {} }));

import hairBlob from "@/data/hairBlob.json";
import { randomCharacter } from "@/lib/character";
import { HAIR_STYLES } from "@/lib/hair";
import { preload } from "@/lib/headLoad";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("Random character in production", () => {
  it("downloads the new hair from where the hair loader will fetch it", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.spyOn(Math, "random").mockReturnValue(0.5); // hair on, the middle style
    const style = HAIR_STYLES[Math.floor(0.5 * HAIR_STYLES.length)];
    const blobPath = (hairBlob.files as Record<string, string>)[style.id];
    expect(blobPath).toBeTruthy();
    void randomCharacter();
    expect(vi.mocked(preload).mock.calls.map(([url]) => url)).toContain(hairBlob.base + blobPath);
  });
});
