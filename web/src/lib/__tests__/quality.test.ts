import { describe, expect, it, vi } from "vitest";

/** A WebGL context that only answers the renderer query (no debug-renderer extension). */
const gl = (renderer: string) => ({ RENDERER: 0x1f01, getExtension: () => null, getParameter: () => renderer }) as unknown as WebGLRenderingContext;

// quality.ts is a module-level store that probes once: each case gets a fresh copy.
const fresh = () => {
  vi.resetModules();
  return import("../quality");
};

describe("quality tiers", () => {
  it("starts a desktop with a real GPU at high, a software renderer at low", async () => {
    expect((await fresh()).probeTier(gl("ANGLE (Apple, Apple M2, OpenGL 4.1)"))).toBe("high");
    expect((await fresh()).probeTier(gl("Google SwiftShader"))).toBe("low");
    expect((await fresh()).probeTier(gl("Mali-G52 MC2"))).toBe("low");
  });

  it("probes once, then steps down one tier at a time and stops at low", async () => {
    const q = await fresh();
    const seen: string[] = [];
    q.onTier((t) => seen.push(t));
    expect(q.probeTier(gl("ANGLE (Apple, Apple M2, OpenGL 4.1)"))).toBe("high");
    expect(q.probeTier(gl("Google SwiftShader"))).toBe("high");
    expect(q.dropTier()).toBe(true);
    expect(q.dropTier()).toBe(true);
    expect(q.dropTier()).toBe(false);
    expect(seen).toEqual(["high", "medium", "low"]);
    expect(q.tierSettings()).toBe(q.TIERS.low);
  });
});
