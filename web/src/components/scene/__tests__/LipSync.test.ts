import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// LipSync's frame loop against the real player, cues and evaluator (fake Web Audio; no React, no three).
const hooks = vi.hoisted(() => ({ frame: null as null | ((s: unknown, dt: number) => void) }));
vi.mock("react", () => ({ useMemo: (fn: () => unknown) => fn(), useEffect: (fn: () => void) => fn() }));
vi.mock("@react-three/fiber", () => ({ useFrame: (fn: (s: unknown, dt: number) => void) => void (hooks.frame = fn) }));
vi.mock("@/lib/data", () => ({ visemePreset: () => ({ jaw: 1 }), visemes: { roles: { jawOpen: { jaw: 1 } } } }));
vi.mock("@/lib/emotion", () => ({ setSpeechActivity: () => {} }));
vi.mock("@/lib/morphs/animCaps", () => ({ visemeCap: () => 1 }));
vi.mock("@/lib/morphs/store", () => ({ morphs: { setLayerValue: () => {}, userValue: () => 0, clearLayer: () => {} } }));

class FakeContext {
  state = "running";
  currentTime = 0;
  sampleRate = 48000;
  outputLatency = 0.01;
  destination = {};
  resume = () => Promise.resolve();
  createBuffer = (_: number, n: number, r: number) => {
    const data = new Float32Array(n);
    return { length: n, sampleRate: r, duration: n / r, getChannelData: () => data };
  };
  createBufferSource = () => ({ buffer: null, connect() {}, start() {}, stop() {}, onended: null });
}
let ctx: FakeContext;
class FakeAudioContext {
  constructor() {
    ctx = new FakeContext();
    return ctx;
  }
}

/** 24 kHz 16-bit PCM: a tone where `loud(t)`, silence elsewhere. */
function pcm(seconds: number, loud: (t: number) => boolean): string {
  const n = Math.round(seconds * 24000);
  const b = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) b.writeInt16LE(loud(i / 24000) ? Math.round(Math.sin(i / 3) * 12000) : 0, i * 2);
  return b.toString("base64");
}

beforeEach(() => {
  vi.resetModules();
  vi.stubGlobal("AudioContext", FakeAudioContext);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("LipSync", () => {
  it("snaps a closure in the last quarter second of a line to the audio once the stream has ended", async () => {
    const { speechPlayer } = await import("@/lib/lipsync/player");
    const { LipSync } = await import("../LipSync");
    LipSync();
    // "apa": the voice drops out for the p at 0.85–0.92 s, in a 1 s line; the p is stamped at 0.80–0.85 s.
    const line = JSON.stringify({
      audio_base64: pcm(1, (t) => t < 0.85 || t >= 0.92),
      normalized_alignment: { characters: ["a", "p", "a"], character_start_times_seconds: [0, 0.8, 0.85], character_end_times_seconds: [0.8, 0.85, 1] },
    });
    await speechPlayer.speak(async () => new Response(line + "\n"));
    const p = speechPlayer.cues.find((c) => c.viseme === "PP")!;
    const stamped = [p.start, p.end];
    ctx.currentTime = 0.5; // half way through the line
    hooks.frame!({}, 1 / 60);
    expect([p.start, p.end]).not.toEqual(stamped);
    expect(p.end).toBeGreaterThan(0.85); // the lips part at the burst (0.92 s, less closureOffShift), not at the stamp
  });

  it("keeps ?lipsyncOffsetMs= to ±500 ms", async () => {
    const { mouthLead, LIPSYNC } = await import("@/lib/lipsync/evaluator");
    expect(mouthLead("2000")).toBe(0.5);
    expect(mouthLead("-9000")).toBe(-0.5);
    expect(mouthLead("40")).toBe(0.04);
    expect(mouthLead(null)).toBe(LIPSYNC.lead);
    expect(mouthLead("abc")).toBe(LIPSYNC.lead);
  });

  it("LipSync reads its lead through the clamp", async () => {
    vi.stubGlobal("window", { location: { search: "?lipsyncOffsetMs=100000" } });
    const { lipsyncState } = await import("@/lib/lipsync/state");
    const { LipSync } = await import("../LipSync");
    LipSync();
    expect(lipsyncState.leadMs).toBe(500);
  });
});
