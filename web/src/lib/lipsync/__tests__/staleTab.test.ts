import { afterEach, describe, expect, it, vi } from "vitest";

const SAFARI = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15";
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

describe("staleTab", () => {
  it("knows Safari on a Mac from Chrome, an iPhone and an iPad (which says it is a Mac)", async () => {
    const { isDesktopSafari } = await import("../staleTab");
    page(SAFARI);
    expect(isDesktopSafari()).toBe(true);
    page(CHROME);
    expect(isDesktopSafari()).toBe(false);
    page(SAFARI, 5);
    expect(isDesktopSafari()).toBe(false);
  });

  it("turns on after desktop Safari has hidden the tab for 2 minutes, not after a short look away", async () => {
    vi.useFakeTimers();
    const show = page(SAFARI);
    const { staleTabSnapshot, subscribeStaleTab } = await import("../staleTab");
    const seen = vi.fn();
    subscribeStaleTab(seen);
    show("hidden");
    vi.advanceTimersByTime(30_000);
    show("visible");
    expect(staleTabSnapshot()).toBe(false);
    show("hidden");
    vi.advanceTimersByTime(2 * 60_000);
    show("visible");
    expect(staleTabSnapshot()).toBe(true);
    expect(seen).toHaveBeenCalledTimes(1);
  });

  it("never turns on in Chrome", async () => {
    vi.useFakeTimers();
    const show = page(CHROME);
    const { staleTabSnapshot, subscribeStaleTab } = await import("../staleTab");
    subscribeStaleTab(() => {});
    show("hidden");
    vi.advanceTimersByTime(60 * 60_000);
    show("visible");
    expect(staleTabSnapshot()).toBe(false);
  });
});
