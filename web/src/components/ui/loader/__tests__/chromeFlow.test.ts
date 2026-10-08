import { describe, expect, it } from "vitest";

import { type ChromeDrive, type ChromeFinish, type ChromeFlowConfig, createChromeFlow, polishUniforms, swingBack } from "../chromeGl";
import { listen } from "../wave";

const FLOW: ChromeFlowConfig = { start: 12, speed: 0.2, restSpeed: 0.3, period: 3, dwell: 0.25, settleSpeed: 1.2, maxStep: 1 / 30 };
const SWING: ChromeDrive = { moving: true, settling: false, through: null, hold: null };
const FINISH: ChromeFinish = { rest: 0.03, restSpeed: 0.3, rough: 0.06, metal: 0.7, halo: 1, irid: 1, base: [1, 1, 1], shape: { kind: "pebble", k: 0.12 } };

/** Advance the flow `seconds` in frames of `dt`. */
const run = (flow: ReturnType<typeof createChromeFlow>, seconds: number, drive: ChromeDrive, dt = 1 / 60) => {
  for (let t = 0; t < seconds - 1e-9; t += dt) flow.step(dt, drive);
};

describe("polishUniforms", () => {
  it("is the matte blob at 0 and the finish at 1", () => {
    expect(polishUniforms(0, 0.4, FINISH)).toEqual({ amp: 0.4, shape: 0, rough: 0.2, metal: 0, halo: 0, irid: 0, fin: 0 });
    const end = polishUniforms(1, 0.4, FINISH);
    expect(end.amp).toBeCloseTo(FINISH.rest);
    expect(end.shape).toBeCloseTo(0.12);
    expect(end.rough).toBeCloseTo(FINISH.rough);
    expect(end).toMatchObject({ metal: 0.7, halo: 1, irid: 1, fin: 1 });
  });
});

describe("swingBack", () => {
  it("runs from the finish (1) to the blob (0), never turning back", () => {
    expect(swingBack(0, 0.25)).toBe(1);
    expect(swingBack(1, 0.25)).toBeCloseTo(0);
    let last = 1;
    for (let x = 0.05; x <= 1; x += 0.05) {
      const p = swingBack(x, 0.25);
      expect(p).toBeLessThan(last);
      last = p;
    }
  });
});

describe("createChromeFlow", () => {
  it("opens on the poster's frame and holds it until it may move", () => {
    const flow = createChromeFlow(FLOW);
    expect(flow.frame).toEqual({ time: 12, drift: 12 * 0.2, polish: 0 });
    run(flow, 1, { ...SWING, moving: false });
    expect(flow.frame).toEqual({ time: 12, drift: 12 * 0.2, polish: 0 });
  });

  it("swings blob → finish → blob once per period", () => {
    const flow = createChromeFlow(FLOW);
    run(flow, FLOW.period / 2, SWING, FLOW.maxStep);
    expect(flow.frame.polish).toBeCloseTo(1, 5);
    run(flow, FLOW.period / 2, SWING, FLOW.maxStep);
    expect(flow.frame.polish).toBeCloseTo(0, 5);
    expect(flow.settled()).toBe(false);
  });

  it("advances at most maxStep per frame, so a stall pauses instead of jumping", () => {
    const flow = createChromeFlow(FLOW);
    flow.step(0.5, SWING);
    expect(flow.frame.time).toBeCloseTo(FLOW.start + FLOW.maxStep);
  });

  it("settles on the finish from mid-swing and stays there", () => {
    const flow = createChromeFlow(FLOW);
    run(flow, 2, SWING); // on its way back to the blob
    const settle = { ...SWING, settling: true };
    run(flow, 3, settle);
    expect(flow.settled()).toBe(true);
    expect(flow.frame.polish).toBe(1);
    run(flow, 1, settle);
    expect(flow.frame.polish).toBe(1);
  });

  it("with `through`, turns round on the finish and runs back to the blob in that time", () => {
    const flow = createChromeFlow(FLOW);
    const drive = { ...SWING, settling: true, through: 0.7 };
    for (let i = 0; i < 600 && !flow.settled(); i++) flow.step(1 / 60, drive);
    expect(flow.settled()).toBe(true);
    run(flow, 0.7 + 1 / 60, drive);
    expect(flow.frame.polish).toBeCloseTo(0);
  });

  it("pins the polish while held (the lab)", () => {
    const flow = createChromeFlow(FLOW);
    run(flow, 1, { ...SWING, hold: 0.4 });
    expect(flow.frame.polish).toBe(0.4);
  });
});

describe("listen", () => {
  it("stays within 0.55..1", () => {
    for (let t = 0; t < 120; t += 0.37) {
      const v = listen(t);
      expect(v).toBeGreaterThanOrEqual(0.55);
      expect(v).toBeLessThanOrEqual(1);
    }
  });
});
