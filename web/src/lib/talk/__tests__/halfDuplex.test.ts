import { afterEach, describe, expect, it, vi } from "vitest";

const IPHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Mobile/15E148 Safari/604.1";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe("an iPhone chat (no echo canceller)", () => {
  it("keeps the microphone off when unmuted while the character speaks; duplex turns it on after", async () => {
    vi.stubGlobal("navigator", { userAgent: IPHONE, maxTouchPoints: 5, mediaDevices: {} });
    const { TalkSession } = await import("../session");
    const session = new TalkSession(null);
    const enable = vi.spyOn(session.room.localParticipant, "setMicrophoneEnabled").mockResolvedValue(undefined);
    (session as unknown as { agentState: string }).agentState = "speaking";
    await session.setMuted(false);
    expect(enable).not.toHaveBeenCalled();
    expect(session.snapshot().muted).toBe(false);
    (session as unknown as { agentState: string }).agentState = "listening";
    await session.setMuted(false);
    expect(enable).toHaveBeenCalledWith(true);
  });
});
