import { Object3D } from "three";
import { afterEach, describe, expect, it, vi } from "vitest";

// A strand file that fails at once (offline) while the strand builder's module is still loading: the failure is
// reported by the loader, never left as an unhandled rejection.
vi.mock("@/lib/groom", async () => {
  await new Promise((r) => setTimeout(r, 20)); // the builder's chunk arrives after the download has failed
  return { buildGroom: async () => new Object3D() };
});
vi.mock("@/lib/headLoad", () => ({ partDone: () => {}, prefetchPart: () => {}, takePrefetched: () => undefined }));
vi.stubGlobal("window", { sessionStorage: { getItem: () => null, setItem: () => {} } });
vi.stubGlobal("fetch", () => Promise.reject(new TypeError("Failed to fetch")));

import { HAIR_STYLES, mountHair, setHairStyle } from "../hair";

const unhandled: unknown[] = [];
const onUnhandled = (reason: unknown) => unhandled.push(reason);
afterEach(() => void process.off("unhandledRejection", onUnhandled));

describe("a hair download that fails before the strand builder has loaded", () => {
  it("leaves no unhandled rejection", async () => {
    process.on("unhandledRejection", onUnhandled);
    vi.spyOn(console, "error").mockImplementation(() => {});
    mountHair(new Object3D());
    await setHairStyle(HAIR_STYLES[0].id);
    await new Promise((r) => setTimeout(r, 50));
    expect(unhandled).toEqual([]);
  });
});
