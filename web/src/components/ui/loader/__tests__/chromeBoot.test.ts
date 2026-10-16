import { describe, expect, it, vi } from "vitest";

// The head loader's sphere can start before the app hydrates (bootChrome); the loader then adopts that worker instead
// of starting a second one, and React's dev-only remount (StrictMode) adopts it again instead of restarting it.
vi.mock("../chromeGl", () => ({}));

/** Just enough of an element: Web Animations, a parent, a style. */
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

const workers: { terminated: boolean; onmessage: ((e: { data: unknown }) => void) | null }[] = [];
vi.stubGlobal(
  "Worker",
  class {
    terminated = false;
    onmessage = null;
    onerror = null;
    constructor() {
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
vi.stubGlobal("window", { setTimeout });

const still = element();
const box = element({ querySelector: () => still });
const bootCanvas = element({ parentElement: box });
vi.stubGlobal("document", {
  readyState: "complete",
  querySelector: (sel: string) => (sel === "canvas[data-chrome-boot]" ? bootCanvas : null),
  createElement: () => element(),
});
const root = { querySelector: (sel: string) => (sel === "[data-chrome]" ? box : sel === "[data-chrome-still]" ? still : null), closest: () => null } as unknown as HTMLElement;

import { bootChrome, chromeMotion } from "../chrome";

describe("the head loader's sphere started before hydration", () => {
  it("is adopted, kept over a StrictMode remount, and stopped once the loader is gone", async () => {
    bootChrome();
    expect(workers).toHaveLength(1);
    workers[0].onmessage!({ data: { type: "shown" } }); // up and fading in before the app hydrates

    const first = chromeMotion(root);
    expect(workers).toHaveLength(1); // adopted: no second worker
    first.dispose(); // StrictMode: unmount…
    const second = chromeMotion(root); // …and mount again, in the same task
    expect(workers).toHaveLength(1);
    await new Promise((r) => setTimeout(r, 5));
    expect(workers[0].terminated).toBe(false); // still drawing

    second.dispose();
    await new Promise((r) => setTimeout(r, 5));
    expect(workers[0].terminated).toBe(true);
    expect(bootCanvas.style.visibility).toBe("hidden"); // the server's canvas stays in React's markup
    expect(bootCanvas.remove).not.toHaveBeenCalled();
  });

  it("no longer starts once the app is up", () => {
    bootChrome();
    expect(workers).toHaveLength(1);
  });
});
