import { afterEach, describe, expect, it, vi } from "vitest";

const SAFARI = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15";
const IPHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Mobile/15E148 Safari/604.1";
const CHROME = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36";

/** A page with a visibility the test can flip, at a given user agent and touch points. */
function page(ua: string, maxTouchPoints = 0) {
  let state = "visible";
  let onChange: (() => void) | null = null;
  vi.stubGlobal("navigator", { userAgent: ua, maxTouchPoints });
  vi.stubGlobal("window", { location: { search: "" } });
  vi.stubGlobal("document", {
    get visibilityState() {
      return state;
    },
    addEventListener: (_: string, fn: () => void) => (onChange = fn),
  });
  return (s: "visible" | "hidden") => {
    state = s;
    onChange?.();
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  vi.resetModules();
});

describe("isAppleTouch", () => {
  it("is every browser on an iPhone or iPad, and nothing else", async () => {
    const appleTouch = async (ua: string, maxTouchPoints: number) => {
      vi.stubGlobal("navigator", { userAgent: ua, maxTouchPoints });
      return (await import("../staleTab")).isAppleTouch();
    };
    expect(await appleTouch(IPHONE, 5)).toBe(true);
    expect(await appleTouch(IPHONE.replace("Version/26.0", "CriOS/141.0.0.0"), 5)).toBe(true); // Chrome on an iPhone
    expect(await appleTouch(SAFARI, 5)).toBe(true); // an iPad, which says it is a Mac
    expect(await appleTouch(SAFARI, 0)).toBe(false); // a Mac
    // Chrome says "AppleWebKit" everywhere: a touchscreen laptop and an Android phone aren't Apple touch devices
    expect(await appleTouch(CHROME.replace("Macintosh; Intel Mac OS X 10_15_7", "Windows NT 10.0; Win64; x64"), 10)).toBe(false);
    expect(await appleTouch("Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Mobile Safari/537.36", 5)).toBe(false);
  });
});

describe("staleTab", () => {
  it("on an iPhone: tells the player once per return from 2 minutes hidden to start its audio over", async () => {
    vi.useFakeTimers();
    const show = page(IPHONE, 5);
    const { takeLongHide } = await import("../staleTab");
    expect(takeLongHide()).toBe(false); // watching from here
    show("hidden");
    vi.advanceTimersByTime(30_000);
    show("visible");
    expect(takeLongHide()).toBe(false); // a short look away
    show("hidden");
    vi.advanceTimersByTime(3 * 60_000);
    show("visible");
    expect(takeLongHide()).toBe(true);
    expect(takeLongHide()).toBe(false); // once
    show("hidden");
    vi.advanceTimersByTime(3 * 60_000);
    show("visible");
    expect(takeLongHide()).toBe(true); // and again after the next long time away
  });

  it("never on a computer: Safari on a Mac (its idle trouble is the player's resting context) or Chrome", async () => {
    vi.useFakeTimers();
    for (const ua of [SAFARI, CHROME]) {
      vi.resetModules();
      const show = page(ua);
      const { takeLongHide } = await import("../staleTab");
      takeLongHide();
      show("hidden");
      vi.advanceTimersByTime(3 * 60_000);
      show("visible");
      expect(takeLongHide()).toBe(false);
    }
  });
});
