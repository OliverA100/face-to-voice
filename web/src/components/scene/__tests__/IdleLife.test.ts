import gsap from "gsap";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { IDLE } from "@/lib/idle";

// IdleLife's blink and saccade scheduling on GSAP's own clock, driven by hand (no React, no three).
const hooks = vi.hoisted(() => ({
  effects: [] as (() => void | (() => void))[],
  state: null as null | { blink: number; eyeYaw: number; eyePitch: number },
  setLayerValue: (() => {}) as (layer: string, target: string, value: number) => void,
}));
vi.mock("react", () => ({
  useState: (init: () => unknown) => [(hooks.state = init() as typeof hooks.state)],
  useEffect: (fn: () => void | (() => void)) => void hooks.effects.push(fn),
}));
vi.mock("@react-three/fiber", () => ({ useFrame: () => {}, useThree: (sel: (s: unknown) => unknown) => sel({ gl: { domElement: {} } }) }));
vi.mock("@/lib/data", () => ({ visemes: { roles: { blinkLeft: { lidL: 1 }, blinkRight: { lidR: 1 } } } }));
vi.mock("@/lib/debugView", () => ({ idleDebug: { still: false } }));
vi.mock("@/lib/headMorph", () => ({ headMorph: { yaw: 0, pitch: 0 } }));
vi.mock("@/lib/lipsync/state", () => ({ lipsyncState: { energy: 0 } }));
vi.mock("@/lib/morphs/store", () => ({ morphs: { setLayerValue: (...a: [string, string, number]) => hooks.setLayerValue(...a), clearLayer: () => {} } }));
vi.mock("@/lib/pose", () => ({ currentPose: () => ({}), POSE: { lidFollow: 0 }, stepFollow: () => {}, trackPointer: () => () => {} }));
vi.mock("@/lib/reducedMotion", () => ({ reducedMotion: { on: false } }));
vi.mock("../Head", () => ({ headRig: {}, NECK: { y: 0 } }));

let now = 0;
/** Run GSAP's clock forward up to `seconds` in 1/60 s frames, calling `each` after every frame; it returns true to stop. */
function run(seconds: number, each?: () => boolean | void) {
  for (const end = now + seconds; now < end; ) {
    now += 1 / 60;
    gsap.updateRoot(now);
    if (each?.()) return;
  }
}
/** Mount IdleLife; returns its cleanup. */
async function mount() {
  hooks.effects.length = 0;
  const { IdleLife } = await import("../IdleLife"); // imported once: a module reset would load a second GSAP
  IdleLife();
  const cleanups = hooks.effects.map((fn) => fn());
  return () => cleanups.forEach((c) => c?.());
}

const doubleChance = IDLE.blink.doubleChance;
beforeEach(() => {
  gsap.ticker.remove(gsap.updateRoot); // the test is the clock
  now = gsap.globalTimeline.time();
  hooks.setLayerValue = () => {};
});
afterEach(() => {
  (IDLE.blink as { doubleChance: number }).doubleChance = doubleChance;
  gsap.globalTimeline.clear();
  gsap.ticker.add(gsap.updateRoot);
  vi.restoreAllMocks();
});

describe("IdleLife", () => {
  it("keeps nothing from the blinks and saccades that are over (an hour of idle life)", async () => {
    const contexts: gsap.Context[] = [];
    const context = gsap.context.bind(gsap);
    vi.spyOn(gsap, "context").mockImplementation((...args: Parameters<typeof gsap.context>) => {
      const c = context(...args);
      contexts.push(c);
      return c;
    });
    let blinks = 0;
    hooks.setLayerValue = () => void blinks++;
    const cleanup = await mount();
    let most = 0;
    run(3600, () => void (most = Math.max(most, gsap.globalTimeline.getChildren(false).length)));
    expect(blinks).toBeGreaterThan(0); // it did blink
    expect(most).toBeLessThanOrEqual(3); // the blink's step, the saccade's wait and its move
    expect(contexts.reduce((n, c) => n + c.data.length, 0)).toBeLessThan(10); // ~1000 blinks + ~2300 saccades
    cleanup();
  });

  it("unmount kills whatever is pending, the second blink of a double too", async () => {
    (IDLE.blink as { doubleChance: number }).doubleChance = 1;
    const cleanup = await mount();
    const state = hooks.state!;
    // wait for a blink to close and open again: its second blink is then waiting to start
    let closed = false;
    run(20, () => {
      if (state.blink > 0) closed = true;
      return closed && state.blink === 0;
    });
    expect(closed && state.blink === 0).toBe(true);
    cleanup();
    let writes = 0;
    hooks.setLayerValue = () => void writes++;
    run(30);
    expect(writes).toBe(0);
    expect([state.blink, state.eyeYaw, state.eyePitch]).toEqual([0, 0, 0]);
    expect(gsap.globalTimeline.getChildren(false).length).toBe(0);
  });
});
