import { describe, expect, it, vi } from "vitest";

// Production starts the head loader's sphere from an inline script in the page's HTML (ChromeBootScript), before any of
// the app's JS: it waits for the stylesheet, starts the worker file, and the app then takes that sphere on (one worker).
vi.mock("../chromeGl", () => ({}));

function element(extra: Record<string, unknown> = {}) {
  return {
    style: {} as Record<string, string>,
    clientWidth: 100,
    clientHeight: 100,
    animate: () => ({ cancel() {} }),
    getAnimations: () => [],
    closest: () => null,
    remove: vi.fn(),
    transferControlToOffscreen: () => ({}),
    ...extra,
  };
}

const workers: { url: string; onmessage: ((e: { data: unknown }) => void) | null; terminated: boolean }[] = [];
vi.stubGlobal(
  "Worker",
  class {
    onmessage = null;
    onerror = null;
    terminated = false;
    url: string;
    constructor(url: string) {
      this.url = String(url);
      workers.push(this);
    }
    postMessage() {}
    terminate() {
      this.terminated = true;
    }
  },
);
vi.stubGlobal("HTMLCanvasElement", class { transferControlToOffscreen() {} });
vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
vi.stubGlobal("devicePixelRatio", 1);
vi.stubGlobal("matchMedia", () => ({ matches: false }));
const win: { setTimeout: typeof setTimeout; __chromeBoot?: unknown } = { setTimeout };
vi.stubGlobal("window", win);

const still = element();
const box = element({ querySelector: () => still });
const bootCanvas = element({ parentElement: box });
const listeners: Record<string, () => void> = {};
const stylesheet = { sheet: null, addEventListener: (type: string, fn: () => void) => (listeners[type] = fn) };
vi.stubGlobal("document", {
  readyState: "loading",
  querySelector: (sel: string) => (sel === "canvas[data-chrome-boot]" ? bootCanvas : null),
  querySelectorAll: (sel: string) => (sel === 'link[rel="stylesheet"]' ? [stylesheet] : []),
  createElement: () => element(),
});
const root = { querySelector: (sel: string) => (sel === "[data-chrome]" ? box : sel === "[data-chrome-still]" ? still : null), closest: () => null } as unknown as HTMLElement;

import { bootChrome, chromeBootJs, chromeMotion } from "../chrome";

describe("the inline start script", () => {
  it("starts the worker file once the stylesheet is in, and the app takes that sphere on", () => {
    new Function(chromeBootJs("/chrome/worker.test.js"))();
    expect(workers).toHaveLength(0); // the loader has no size before the stylesheet
    listeners.load();
    expect(workers.map((w) => w.url)).toEqual(["/chrome/worker.test.js"]);
    expect(win.__chromeBoot).toBeTruthy();
    workers[0].onmessage!({ data: { type: "shown" } });

    bootChrome(); // the app's first scripts
    const motion = chromeMotion(root); // hydration
    expect(workers).toHaveLength(1); // no second worker
    expect(workers[0].terminated).toBe(false);
    motion.dispose();
  });
});
