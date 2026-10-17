import { afterEach, describe, expect, it, vi } from "vitest";

import { BLUETOOTH } from "@/lib/lipsync/clock";
import { LIVE, LiveSpeech } from "@/lib/lipsync/live";
import { speechPlayer } from "@/lib/lipsync/player";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("chat audio", () => {
  it('"Tap to hear them" wakes the lip sync\'s own audio as well as livekit-client\'s', async () => {
    vi.stubGlobal("navigator", { userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/141.0.0.0", maxTouchPoints: 0, mediaDevices: {} });
    const { TalkSession } = await import("../session");
    const ctx = { resume: vi.fn(async () => {}) } as unknown as AudioContext;
    const session = new TalkSession(ctx);
    const startAudio = vi.spyOn(session.room, "startAudio").mockResolvedValue(undefined);
    session.resumeAudio();
    expect(ctx.resume).toHaveBeenCalled();
    expect(startAudio).toHaveBeenCalled();
  });

  it("captions wait as long as the voice: held back, the speakers' delay and the Sync setting", () => {
    const ctx = { currentTime: 0, outputLatency: 0.17 } as unknown as AudioContext; // AirPods
    vi.spyOn(speechPlayer, "syncDelayMs", "get").mockReturnValue(40);
    const live = new LiveSpeech(ctx);
    (live as unknown as { delay: number }).delay = LIVE.delay; // as attach() holds the chat's voice back
    expect(live.heardDelay()).toBeCloseTo(0.17 + BLUETOOTH.extra + LIVE.delay + 0.04, 6);
  });
});
