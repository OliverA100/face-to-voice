import { afterEach, describe, expect, it, vi } from "vitest";

// The loader's sphere is drawn in a worker; if the worker fails after its first frame (the poster has already faded),
// the page draws it instead: once (a "failed" message and an error can both arrive), with the poster back meanwhile.
const made = vi.hoisted(() => ({ gl: 0 }));
vi.mock("../chromeGl", () => ({
  createChromeGl: () => (made.gl++, { dispose: () => {}, draw: () => false, width: () => 1 }),
  createChromeFlow: () => ({ step: () => {}, frame: { polish: 0 }, settled: () => false }),
}));

/** Just enough of an element for chromeMotion: Web Animations that can be cancelled. */
function element() {
  const animations: { cancelled: boolean; cancel(): void }[] = [];
  return {
    style: {} as Record<string, string>,
    className: "",
    clientWidth: 100,
    clientHeight: 100,
    animations,
    animate: () => {
      const a = { cancelled: false, cancel: () => void (a.cancelled = true) };
      animations.push(a);
      return a;
    },
    getAnimations: () => animations.filter((a) => !a.cancelled),
    setAttribute: () => {},
    addEventListener: () => {},
    append: () => {},
    remove: () => {},
    transferControlToOffscreen: () => ({}),
  };
}

let worker: { onmessage: ((e: { data: unknown }) => void) | null; onerror: (() => void) | null } | null = null;
vi.stubGlobal(
  "Worker",
  class {
    onmessage = null;
    onerror = null;
    constructor() {
      worker = this; // eslint-disable-line @typescript-eslint/no-this-alias
    }
    postMessage() {}
    terminate() {}
  },
);
vi.stubGlobal("HTMLCanvasElement", class { transferControlToOffscreen() {} });
vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
const canvases = vi.hoisted(() => ({ made: 0 }));
vi.stubGlobal("document", { createElement: () => (canvases.made++, element()) });
vi.stubGlobal("devicePixelRatio", 1);

import { chromeMotion } from "../chrome";

afterEach(() => vi.clearAllMocks());

describe("the loader's sphere when its worker fails after the first frame", () => {
  it("falls back to the page once, with the poster back", async () => {
    const box = element();
    const still = element();
    const root = {
      querySelector: (sel: string) => (sel === "[data-chrome]" ? box : sel === "[data-chrome-still]" ? still : null),
      closest: () => null,
    } as unknown as HTMLElement;
    const motion = chromeMotion(root);
    worker!.onmessage!({ data: { type: "shown" } }); // the poster fades out
    expect(still.getAnimations()).toHaveLength(1);
    worker!.onmessage!({ data: { type: "failed" } });
    worker!.onerror!();
    await vi.waitFor(() => expect(made.gl).toBeGreaterThan(0));
    await new Promise((r) => setTimeout(r, 10));
    expect(canvases.made).toBe(2); // the worker's canvas, then one for the page: one GL context, not two
    expect(still.getAnimations()).toHaveLength(0); // the poster shows until the page's sphere fades in
    motion.dispose();
  });
});
