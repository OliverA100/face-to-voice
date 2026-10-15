import { afterEach, describe, expect, it, vi } from "vitest";

const SAFARI = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15";
const CHROME = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36";
const IPHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Mobile/15E148 Safari/604.1";

/** A browser at a user agent and query, with just enough DOM for the route's <audio> element. */
function browser(ua: string, search = "", maxTouchPoints = 0) {
  const els: { srcObject: unknown; played: number; paused: boolean; style: Record<string, string> }[] = [];
  vi.stubGlobal("navigator", { userAgent: ua, maxTouchPoints });
  vi.stubGlobal("window", { location: { search } });
  vi.stubGlobal("document", {
    createElement: () => {
      const el = { srcObject: null as unknown, played: 0, paused: true, style: {}, play() {
        this.played++;
        this.paused = false;
        return Promise.resolve();
      }, pause() {
        this.paused = true;
      } };
      els.push(el);
      return el;
    },
    body: { append: () => {} },
  });
  const ctx = { destination: { kind: "destination" }, createMediaStreamDestination: () => ({ kind: "stream", stream: { id: "s" } }), suspend: () => Promise.resolve() } as unknown as AudioContext;
  return { ctx, els };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe("output route", () => {
  it("desktop Safari: sound goes to a MediaStream an <audio> element plays (made once per context), 75 ms later", async () => {
    const { ctx, els } = browser(SAFARI);
    const { outputOf, restOutput, routeDelay, wakeOutput } = await import("../output");
    const node = outputOf(ctx) as unknown as { kind: string };
    expect(node.kind).toBe("stream");
    expect(outputOf(ctx)).toBe(node);
    expect(els).toHaveLength(1);
    expect(els[0].srcObject).toEqual({ id: "s" });
    expect(els[0].played).toBe(1);
    expect(routeDelay(ctx)).toBeCloseTo(0.075, 5);
    els[0].paused = true; // Safari paused it on its own
    wakeOutput(ctx);
    expect(els[0].played).toBe(2);
    // resting: the element pauses with the context (else it loops its last few ms), and wakes in the next tap
    await restOutput(ctx);
    expect(els[0].paused).toBe(true);
    wakeOutput(ctx);
    expect(els[0].played).toBe(3);
  });

  it("Chrome and the iPhone keep the context's own destination; ?audioRoute= overrides", async () => {
    for (const [ua, search, touch, want] of [[CHROME, "", 0, "destination"], [IPHONE, "", 5, "destination"], [SAFARI, "?audioRoute=direct", 0, "destination"], [CHROME, "?audioRoute=element", 0, "stream"]] as const) {
      vi.resetModules();
      const { ctx } = browser(ua, search, touch);
      const { outputOf, routeDelay } = await import("../output");
      expect((outputOf(ctx) as unknown as { kind: string }).kind).toBe(want);
      expect(routeDelay(ctx)).toBe(want === "stream" ? 0.075 : 0);
    }
  });
});
