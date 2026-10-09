import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Random character downloads the next look's hair while the face morphs, so the cross-fade has it in time. In
// production the hair loader fetches strand files from Vercel Blob (data/hairBlob.json), so that is what must be
// downloaded ahead; the same path under /models is not deployed.
vi.mock("@/components/scene/Capture", () => ({ precompile: async () => {} }));
vi.mock("@/lib/headLoad", () => ({ preload: vi.fn(async () => {}) }));
vi.mock("@/lib/pieceFade", () => ({ finishPieceFade: () => {}, openPieceFade: () => {}, pieceFade: { arriving: [] }, runPieceFade: async () => {} }));
vi.mock("@/lib/morphs/random", () => ({ clearRandomFace: () => {}, randomFace: () => ({}), randomFaceAsync: async () => ({}) }));
vi.mock("@/lib/morphs/capsClient", () => ({ askLimiter: async () => false }));
vi.mock("@/lib/morphs/store", () => ({ morphs: { tweenTo: () => {}, reset: () => {}, onChange: () => () => {}, onSettle: () => () => {} } }));
vi.mock("@/lib/pose", () => ({ centrePose: () => {} }));
vi.mock("@/lib/emotion", () => ({ NEUTRAL: "neutral", setEmotion: () => {}, setIntensity: () => {} }));
vi.mock("@/lib/skin", async (real) => ({ ...(await real<object>()), setSkinTone: () => {} }));
vi.mock("@/lib/eyes", async (real) => ({ ...(await real<object>()), setEyeColour: () => {} }));
vi.mock("@/lib/hair", async (real) => ({ ...(await real<object>()), setHairColour: () => {}, setHairStyle: vi.fn(async () => {}) }));
vi.mock("@/lib/addons", async (real) => ({ ...(await real<object>()), setAddonStyle: async () => {}, setFacialHairColour: () => {} }));

import hairBlob from "@/data/hairBlob.json";
import { CHARACTER, characterSettled, prepareNext, randomCharacter } from "@/lib/character";
import { HAIR_STYLES, setHairStyle } from "@/lib/hair";
import { preload } from "@/lib/headLoad";

beforeEach(() => {
  CHARACTER.duration = 0;
  vi.stubGlobal("requestIdleCallback", () => 0); // no roll-ahead between tests unless a test asks for one
  vi.stubGlobal("fetch", vi.fn(async () => new Response(new ArrayBuffer(0)))); // the small side files warmed ahead
  vi.mocked(preload).mockClear();
  vi.mocked(setHairStyle).mockClear();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const preloaded = () => vi.mocked(preload).mock.calls.map(([url]) => url);

describe("Random character in production", () => {
  it("downloads the new hair from where the hair loader will fetch it", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.spyOn(Math, "random").mockReturnValue(0.5); // hair on, the middle style
    const style = HAIR_STYLES[Math.floor(0.5 * HAIR_STYLES.length)];
    const blobPath = (hairBlob.files as Record<string, string>)[style.id];
    expect(blobPath).toBeTruthy();
    const change = randomCharacter();
    expect(preloaded()).toContain(hairBlob.base + blobPath);
    await change;
    await characterSettled();
  });
});

describe("Random character rolled ahead", () => {
  it("downloads the next character's files at low priority, and the click wears that style", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    prepareNext();
    const ahead = HAIR_STYLES[Math.floor(0.5 * HAIR_STYLES.length)];
    expect(vi.mocked(preload).mock.calls.find(([url]) => url.endsWith(ahead.file))?.[1]).toBe("low");
    const files = preloaded().length;
    prepareNext(); // one waiting is enough
    expect(preloaded().length).toBe(files);

    vi.spyOn(Math, "random").mockReturnValue(0.01); // a click roll would now pick the first style (and stay young)
    await randomCharacter();
    expect(vi.mocked(setHairStyle).mock.calls[0][0]).toBe(ahead.id);
    expect(preloaded().slice(files)).toEqual(preloaded().slice(0, files)); // the click asks for the same files: already in
    await characterSettled();
  });

  it("waits while a change is under way, so the next files never compete with the current ones", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    const change = randomCharacter();
    const during = preloaded().length;
    prepareNext(); // the pointer is still on the button
    expect(preloaded().length).toBe(during);
    await change;
    await characterSettled();
    prepareNext(); // landed: now it may
    expect(vi.mocked(preload).mock.calls.at(-1)?.[1]).toBe("low");
    await randomCharacter(); // (uses it up)
    await characterSettled();
  });

  it("downloads nothing ahead when the browser asks to save data", () => {
    vi.stubGlobal("navigator", { connection: { saveData: true } });
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    prepareNext();
    expect(preload).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });
});
