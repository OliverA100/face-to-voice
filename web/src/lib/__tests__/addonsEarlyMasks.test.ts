import { Group, Object3D, Texture } from "three";
import { afterEach, describe, expect, it, vi } from "vitest";

// Stubble and shell beards read their mask by URL (loadKtx2, loadShellMask), not from the early download: those bytes
// must still be taken (and so freed) rather than held for the whole session. And a strand beard whose under-stubble
// mask fails to load reports it, never leaving an unhandled rejection.
const early = vi.hoisted(() => ({ taken: [] as string[] }));
vi.mock("@/lib/headLoad", () => ({
  partDone: () => {},
  prefetchPart: () => {},
  takePrefetched: (url: string) => (early.taken.push(url), Promise.resolve(new ArrayBuffer(8))),
}));
vi.mock("@/lib/textures", () => ({
  TEXTURES_BASE: "/textures/",
  loadKtx2: async (url: string) => {
    if (url.includes("full-beard")) throw new TypeError("Failed to fetch"); // the strand beard's under-stubble mask
    return new Texture();
  },
}));
vi.mock("@/lib/beardShells", () => ({
  loadShellMask: async () => ({ texture: new Texture(), pixels: null }),
  mountShells: () => null,
}));
vi.mock("@/lib/groom", () => ({
  buildGroom: async (_s: unknown, _b: unknown, colours: unknown) => Object.assign(new Group(), { userData: { colours } }),
}));
vi.mock("@/lib/skinShader", () => ({ skinUniforms: { uStubbleColour: { value: null } }, enableStubble: () => {}, disableStubble: () => {} }));
vi.mock("@/lib/skin", () => ({ skinRig: { material: {} } }));

import { MODELS_BASE } from "@/lib/data";
import { addonStyleById, mountAddons, setAddonStyle } from "../addons";

const unhandled: unknown[] = [];
const onUnhandled = (reason: unknown) => unhandled.push(reason);
afterEach(() => void process.off("unhandledRejection", onUnhandled));
mountAddons(new Object3D());

describe("facial hair masks", () => {
  it("take the early download of a stubble or shell mask", async () => {
    for (const id of ["stubble", "short-beard"]) {
      await setAddonStyle("facialHair", id);
      expect(early.taken).toContain(MODELS_BASE + addonStyleById("facialHair", id)!.file);
    }
  });

  it("report a strand beard's under-stubble mask that fails to load", async () => {
    process.on("unhandledRejection", onUnhandled);
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    await setAddonStyle("facialHair", "full-beard");
    await new Promise((r) => setTimeout(r, 20));
    expect(unhandled).toEqual([]);
    expect(error).toHaveBeenCalled();
  });
});
