import { describe, expect, it, vi } from "vitest";

// extraReady (the voice screenshot waits for it) belongs to the head mounted now: a load aborted by an unmount must not
// resolve the next mount's promise before that one has merged its targets.
const revealed = vi.hoisted(() => {
  let open: () => void = () => {};
  return { gate: new Promise<void>((r) => (open = r)), open: () => open() };
});
vi.mock("@/lib/data", () => ({ manifest: { extra: { file: "head.extra.glb" } }, MODELS_BASE: "/models/" }));
vi.mock("@/lib/hair", () => ({ gltfLoader: async () => ({ parseAsync: async () => ({ scene: { traverse: () => {} } }) }) }));
vi.mock("@/lib/headLoad", () => ({ partDone: () => {}, takePrefetched: () => undefined, whenRevealed: () => revealed.gate }));
vi.mock("@/lib/morphs/store", () => ({ morphs: { settleNow: () => {} } }));

describe("extraReady after a remount", () => {
  it("waits for the new mount's merge, not the aborted load", async () => {
    vi.stubGlobal("fetch", vi.fn(() => new Promise(() => {}))); // the new mount's download is still on its way
    const extra = await import("../headExtra");
    const first = extra.loadHeadExtra([], {} as never);
    first(); // unmounted while waiting for the reveal
    extra.loadHeadExtra([], {} as never);
    let ready = false;
    void extra.extraReady.then(() => (ready = true));
    revealed.open(); // the aborted load wakes up and stops
    await new Promise((r) => setTimeout(r, 20));
    expect(ready).toBe(false);
    vi.unstubAllGlobals();
  });
});
