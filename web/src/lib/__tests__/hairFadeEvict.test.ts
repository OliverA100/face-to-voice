import { Group, Object3D } from "three";
import { describe, expect, it, vi } from "vitest";

// Hair styles stay built in a small cache. One that leaves the cache while it fades out (Random character's cross-fade,
// with several new styles chosen meanwhile) can't be freed then; it must be freed when its fade ends.
const disposed = vi.hoisted(() => [] as string[]);
vi.mock("@/lib/groom", () => ({
  buildGroom: async (_strands: unknown, _bytes: unknown, colours: unknown) => {
    const group = new Group();
    group.userData.colours = colours;
    group.userData.dispose = () => disposed.push(group.userData.style as string);
    return group;
  },
}));
vi.mock("@/lib/headLoad", () => ({ partDone: () => {}, prefetchPart: () => {}, takePrefetched: () => undefined }));
// A batch that stays open until finishPieceFade() (the fade still running).
const batch = vi.hoisted(() => ({ open: false, leaving: [] as { node: unknown; remove: () => void }[] }));
vi.mock("@/lib/pieceFade", () => ({
  pieceFade: batch,
  swapPiece: (leaving: unknown, _arriving: unknown, remove: () => void) => {
    if (!batch.open) return false;
    if (leaving) batch.leaving.push({ node: leaving, remove });
    return true;
  },
  finishPieceFade: () => {
    for (const l of batch.leaving.splice(0)) l.remove();
    batch.open = false;
  },
}));
vi.stubGlobal("window", { sessionStorage: { getItem: () => null, setItem: () => {} } });
vi.stubGlobal("fetch", async () => new Response(new ArrayBuffer(8)));

import { finishPieceFade } from "@/lib/pieceFade";
import { HAIR_STYLES, hairSnapshot, mountHair, setHairStyle, unmountHair } from "../hair";

describe("a hair style evicted while it fades out", () => {
  it("is freed when the fade ends", async () => {
    const [a, ...others] = HAIR_STYLES.slice(0, 6).map((s) => s.id);
    mountHair(new Object3D());
    await setHairStyle(a);
    batch.open = true; // Random character: a cross-fade starts
    for (const id of others) await setHairStyle(id, true); // a, then the next ones, leave the cache meanwhile
    expect(hairSnapshot().style).toBe(others.at(-1)); // every one attached
    expect(disposed).not.toContain(a); // still drawn in the fade's "before" image
    finishPieceFade();
    expect(disposed.filter((id) => id === a)).toHaveLength(1);
    unmountHair();
    expect(disposed.filter((id) => id === a)).toHaveLength(1); // once
  });
});
