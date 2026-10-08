import { Object3D, Texture } from "three";
import { describe, expect, it, vi } from "vitest";

// Two stubble styles picked in quick succession: the newer one stays on the skin even when the older one's files
// arrive last (the older load is superseded and must not touch the skin).
const files = vi.hoisted(() => new Map<string, (t: unknown) => void>());
const shader = vi.hoisted(() => ({ on: [] as string[], off: 0, uniforms: { uStubbleColour: { value: null as unknown } } }));
vi.mock("@/lib/textures", () => ({
  TEXTURES_BASE: "/textures/",
  loadKtx2: (url: string) => (url.includes("stubble_detail") ? Promise.resolve(new Texture()) : new Promise((r) => files.set(url, r))),
}));
vi.mock("@/lib/skinShader", () => ({
  skinUniforms: shader.uniforms,
  enableStubble: (_m: unknown, mask: Texture, _d: unknown, _l: unknown, colour: unknown) => {
    shader.on.push(mask.name);
    shader.uniforms.uStubbleColour.value = colour;
  },
  disableStubble: () => void shader.off++,
}));
vi.mock("@/lib/skin", () => ({ skinRig: { material: {} } }));
vi.mock("@/lib/headLoad", () => ({ partDone: () => {}, prefetchPart: () => {}, takePrefetched: () => undefined }));

describe("facial hair: stubble A, then stubble B before A has loaded", () => {
  it("keeps B on the skin when A's mask arrives last", async () => {
    const addons = await import("../addons");
    addons.mountAddons(new Object3D());
    const a = addons.setAddonStyle("facialHair", "stubble");
    const b = addons.setAddonStyle("facialHair", "heavy-stubble");
    const mask = (name: string) => Object.assign(new Texture(), { name });
    const resolve = (id: string) => [...files].find(([u]) => u.includes(`/${id}.`))![1];
    resolve("heavy-stubble")(mask("B"));
    await b;
    resolve("stubble")(mask("A")); // the older style's file lands last
    await a;
    await new Promise((r) => setTimeout(r, 0));
    expect(shader.on.at(-1)).toBe("B");
    expect(shader.off).toBe(0);
  });
});
