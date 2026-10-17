import { beforeEach, describe, expect, it, vi } from "vitest";

// A lost casting redone for the same voice (voice.ts recastFor): castings are per visitor (per IP), so a phone that
// changed networks has none. Claude reads the face again; the voice's identity is kept, so the voice never changes.
const env = vi.hoisted(() => ({
  hasRedis: false, hasBlob: false, isDeployed: false, rateLimitSalt: "s", studioVoices: [], voicePoolSize: 8,
  caps: { castingsPerDay: 50, designsPerDay: 50, savesPerDay: 50, speakCharsPerDay: 1000 },
}));

vi.mock("server-only", () => ({}));
vi.mock("next/server", () => ({ after: (fn: () => unknown) => void fn() }));
vi.mock("../env", () => ({ env }));
vi.mock("../claude", () => ({ describeFace: vi.fn() }));
vi.mock("../elevenlabs", () => ({
  UpstreamError: class extends Error {},
  designVoice: vi.fn(async () => ({ text: "line", settings: {}, previews: [0, 1, 2].map((i) => ({ generatedVoiceId: `g-${i}`, audio: new Uint8Array([i]), mediaType: "audio/mpeg", durationSecs: 1 })) })),
  createVoice: vi.fn(),
  deleteVoice: async () => {},
  listAppVoices: async () => [],
  subscription: async () => null,
}));

import { cacheDel } from "../cache";
import { describeFace } from "../claude";
import { descriptionKey } from "../keys";
import { descriptionIdentity } from "../prompt";
import { castingFor, designForFace, recastFor } from "../voice";

const cast = (over: Record<string, string>) => ({
  fields: { presentation: "feminine", ageRange: "30s", character: "everyday", build: "average", energy: "calm", pacing: "measured", pitch: "medium", mood1: "warm", mood2: "wry", accent: "irish", accentStrength: "slight", ethnicity: "white", persona: "baker", timbre: "clear", quirk: "", line: "Hello.", ...over },
  replaced: [],
});

let n = 0;
async function found(character = "everyday") {
  const weights = { sem_age: (n++ % 19) / 20 };
  const look = { hair: "none" };
  vi.mocked(describeFace).mockResolvedValueOnce(cast({ character, persona: "baker" }) as never);
  const design = await designForFace({ weights, look, imageJpegBase64: "", visitor: "on-wifi" });
  vi.mocked(describeFace).mockClear(); // count only the recast's readings
  return { weights, look, design };
}
const recast = (f: Awaited<ReturnType<typeof found>>, over: Partial<Parameters<typeof recastFor>[0]> = {}) =>
  recastFor({ visitor: "on-cellular", faceKey: f.design.faceKey, descKey: f.design.descKey, weights: f.weights, look: f.look, imageJpegBase64: "", ...over });

beforeEach(() => vi.mocked(describeFace).mockReset());

describe("recastFor", () => {
  it("casts the face again for the same voice: what makes the voice is kept, the rest is Claude's new reading", async () => {
    const f = await found();
    expect(await castingFor("on-cellular", f.design.faceKey)).toBeNull();
    vi.mocked(describeFace).mockResolvedValueOnce(cast({ accent: "texan", pitch: "low", persona: "lighthouse keeper", line: "Ahoy." }) as never);
    await recast(f);
    const fields = (await castingFor("on-cellular", f.design.faceKey))!;
    expect(descriptionKey(descriptionIdentity(fields))).toBe(f.design.descKey);
    expect(fields).toMatchObject({ accent: "irish", pitch: "medium", persona: "lighthouse keeper", line: "Ahoy." }); // an everyday persona is the visitor's own
    // Claude is told the voice it is casting for
    expect(vi.mocked(describeFace).mock.calls[0][0].voice).toContain("accent: irish");
  });

  it("keeps the persona of a character above everyday (it is part of the voice)", async () => {
    const f = await found("distinct");
    vi.mocked(describeFace).mockResolvedValueOnce(cast({ character: "distinct", persona: "lighthouse keeper" }) as never);
    await recast(f);
    expect(await castingFor("on-cellular", f.design.faceKey)).toMatchObject({ persona: "baker" });
  });

  it("does nothing when the visitor has the casting", async () => {
    const f = await found();
    await recast(f, { visitor: "on-wifi" });
    expect(describeFace).not.toHaveBeenCalled();
  });

  it("casts without a picture (the face on screen changed): Claude gets the sliders and look alone", async () => {
    const f = await found();
    vi.mocked(describeFace).mockResolvedValueOnce(cast({ persona: "lighthouse keeper" }) as never);
    await recast(f, { imageJpegBase64: undefined });
    expect(vi.mocked(describeFace).mock.calls[0][0]).toMatchObject({ imageJpegBase64: undefined, sliderSummary: expect.any(String) });
    expect(descriptionKey(descriptionIdentity((await castingFor("on-cellular", f.design.faceKey))!))).toBe(f.design.descKey);
  });

  it("refuses sliders and look that aren't the voice's face, before asking Claude", async () => {
    const f = await found();
    await expect(recast(f, { weights: { sem_age: 0.99 } })).rejects.toMatchObject({ code: "stale", status: 409 });
    expect(describeFace).not.toHaveBeenCalled();
  });

  it("refuses a voice whose identity was never kept (found before recasting existed)", async () => {
    const f = await found();
    await cacheDel(`ftv:identity:${f.design.descKey}`);
    await expect(recast(f)).rejects.toMatchObject({ code: "stale", status: 410 });
    expect(describeFace).not.toHaveBeenCalled();
  });
});
