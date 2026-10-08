import { Object3D } from "three";
import { afterEach, describe, expect, it, vi } from "vitest";

// A fresh clone: the strand files are not installed, so every one of them answers 404.
describe("a hair style whose file is missing", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it("goes back to the style on the head, stores that, and (in development) flags the missing files", async () => {
    const stored = new Map<string, string>();
    const sessionStorage = { getItem: (k: string) => stored.get(k) ?? null, setItem: (k: string, v: string) => void stored.set(k, v) };
    vi.stubGlobal("window", { sessionStorage });
    // Answered a moment later, as a real request would be (the strand builder's module loads first).
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>((resolve) => setTimeout(() => resolve(new Response(null, { status: 404 })), 10))));
    vi.spyOn(console, "error").mockImplementation(() => {});
    await import("../groom");
    const hair = await import("../hair");

    hair.mountHair(new Object3D());
    await hair.setHairStyle(hair.HAIR_STYLES[0].id);

    expect(hair.hairSnapshot().style).toBe("none");
    expect(JSON.parse(stored.get("ftv-hair") ?? "{}").style).toBe("none");
    await vi.waitFor(() => expect(hair.hairSnapshot().filesMissing).toBe(true));
    hair.unmountHair();
  }, 20_000); // importing three and the strand builder is slow when the whole suite runs in parallel
});
