import { afterEach, describe, expect, it, vi } from "vitest";

import type { DesignResult } from "@/lib/voice/client";

const design = { descKey: "a".repeat(64), previews: [{ generatedVoiceId: "g1", url: "https://x/1.mp3", durationSecs: 4 }] } as unknown as DesignResult;

function storage(initial: Record<string, string> = {}) {
  const store = new Map(Object.entries(initial));
  vi.stubGlobal("window", { sessionStorage: { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => store.set(k, v), removeItem: (k: string) => store.delete(k) } });
  return store;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe("voiceSession", () => {
  it("keeps the voice step for the next page load in this tab", async () => {
    const store = storage();
    const { saveVoiceSession } = await import("@/lib/voice/voiceSession");
    saveVoiceSession({ design, selection: { voiceId: "v1", saved: true, chosenIndex: 0 }, chosen: 0, designedFace: "f" });
    vi.resetModules();
    storage(Object.fromEntries(store));
    const { voiceSession } = await import("@/lib/voice/voiceSession");
    expect(voiceSession()).toMatchObject({ design: { descKey: design.descKey }, selection: { voiceId: "v1" }, chosen: 0, designedFace: "f" });
    expect(voiceSession()).toBe(voiceSession()); // the same object every call (useSyncExternalStore)
  });

  it("starts over on nothing saved, or on something it cannot read", async () => {
    storage({ "ftv-voice": "{not json" });
    const { voiceSession } = await import("@/lib/voice/voiceSession");
    expect(voiceSession()).toBeNull();
  });
});
