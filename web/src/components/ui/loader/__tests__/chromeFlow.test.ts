import { describe, expect, it } from "vitest";

import { evenBumped, type ChromeDrive, type ChromeFinish, type ChromeFlowConfig, createChromeFlow, polishUniforms, swingBack } from "../chromeGl";
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

describe("createChromeFlow voice", () => {
  const STYLE = { swing: false, dip: 0, swell: 0.2, flow: 1, pulse: 0.1, curve: 1, attack: 0.04, release: 0.2, ease: 0.4 };
  const voiced = (level: number, polish = 1): ChromeDrive => ({ ...SWING, voice: { polish, level } });

  it("holds the voice's polish, and the bumps, size and drift follow the loudness", () => {
    const flow = createChromeFlow({ ...FLOW, voice: STYLE });
    run(flow, 1, voiced(0));
    expect(flow.frame.polish).toBeCloseTo(1, 2);
    expect(flow.frame.swell).toBeCloseTo(0, 3);
    const drift = flow.frame.drift;
    run(flow, 0.3, voiced(1));
    expect(flow.frame.swell).toBeCloseTo(0.2, 2);
    expect(flow.frame.scale).toBeCloseTo(1.1, 2);
    expect(flow.frame.drift - drift).toBeGreaterThan(0.3 * 1); // rolling faster than at rest (0.3 / s)
    run(flow, 1.5, voiced(0));
    expect(flow.frame.swell).toBeLessThan(0.01); // released
  });

  it("rises fast and falls slowly (attack, release)", () => {
    const flow = createChromeFlow({ ...FLOW, voice: STYLE });
    run(flow, 0.04, voiced(1));
    const up = flow.frame.swell!;
    run(flow, 0.5, voiced(1));
    run(flow, 0.04, voiced(0));
    expect(up).toBeGreaterThan(0.1); // ~63 % in one attack time
    expect(flow.frame.swell!).toBeGreaterThan(0.15); // ~18 % gone in the same time falling
  });

  it("swings again from where the voice left the polish, without a jump", () => {
    const flow = createChromeFlow({ ...FLOW, voice: STYLE });
    run(flow, 1, voiced(0, 0.7));
    const held = flow.frame.polish;
    flow.step(1 / 60, SWING); // the voice lets go (thinking)
    expect(Math.abs(flow.frame.polish - held)).toBeLessThan(0.03);
    let last = flow.frame.polish, biggest = 0;
    for (let i = 0; i < 180; i++) {
      flow.step(1 / 60, SWING);
      biggest = Math.max(biggest, Math.abs(flow.frame.polish - last));
      last = flow.frame.polish;
    }
    expect(biggest).toBeLessThan(0.03); // the swing moves ≤ ~0.025 per frame at 60 fps
  });

  it("swings at the voice's pace with its rainbow (a chat's thinking: the busy spinner)", () => {
    const flow = createChromeFlow({ ...FLOW, dwell: 0, voice: STYLE });
    const think: ChromeDrive = { ...SWING, voice: { polish: 0, level: 0, swing: true, pace: 2, rainbow: 0.3 } };
    run(flow, FLOW.period / 4, think); // a quarter period at 2×: blob → bubble
    expect(flow.frame.polish).toBeCloseTo(1, 1);
    run(flow, FLOW.period / 4, think); // and back
    expect(flow.frame.polish).toBeCloseTo(0, 1);
    expect(flow.frame.rainbow).toBeCloseTo(0.3, 1);
    run(flow, 2, voiced(0)); // a voice again: the finish's own rainbow
    expect(flow.frame.rainbow).toBeCloseTo(1, 2);
  });

  it("holdColour: the bumps keep the whole swing while the colour holds at the talker's polish, without a jump", () => {
    const flow = createChromeFlow({ ...FLOW, voice: { ...STYLE, swing: true, holdColour: true, swell: 0 } });
    const run3 = (polish: number) => {
      let lo = 1, hi = 0, mLo = 1, mHi = 0, jump = 0, last = flow.frame.material ?? flow.frame.polish;
      for (let i = 0; i < 4 * 60; i++) {
        flow.step(1 / 60, voiced(0, polish));
        const m = flow.frame.material!;
        if (i > 90) [lo, hi, mLo, mHi] = [Math.min(lo, flow.frame.polish), Math.max(hi, flow.frame.polish), Math.min(mLo, m), Math.max(mHi, m)];
        jump = Math.max(jump, Math.abs(m - last));
        last = m;
      }
      return { lo, hi, mLo, mHi, jump };
    };
    const white = run3(0.4); // the character
    expect(white.lo).toBeLessThan(0.05); // the bumps: blob …
    expect(white.hi).toBeGreaterThan(0.95); // … to bubble, as E
    expect(white.mLo).toBeGreaterThan(0.38); // the colour: held near 0.4
    expect(white.mHi).toBeLessThan(0.42);
    const colour = run3(1); // you
    expect(colour.mLo).toBeGreaterThan(0.98);
    expect(white.jump).toBeLessThan(0.05); // eases in from the swing's colour
    expect(colour.jump).toBeLessThan(0.05); // and from one talker's to the other's
    flow.step(1 / 60, { ...SWING, voice: { polish: 0, level: 0, swing: true } }); // thinking: the colour follows the swing again
    run(flow, 3, { ...SWING, voice: { polish: 0, level: 0, swing: true } });
    expect(Math.abs(flow.frame.material! - flow.frame.polish)).toBeLessThan(0.01);
  });

  it("holdColour without swing: smooth in silence and as bumpy for every talker; only the colour differs", () => {
    const style = { ...STYLE, holdColour: true, pulse: 0 };
    const talk = (polish: number) => {
      const flow = createChromeFlow({ ...FLOW, voice: style });
      run(flow, 3, voiced(0, polish));
      const silent = { polish: flow.frame.polish, material: flow.frame.material!, swell: flow.frame.swell! };
      run(flow, 0.5, voiced(1, polish));
      return { silent, loudSwell: flow.frame.swell!, loudPolish: flow.frame.polish };
    };
    const character = talk(0.4), you = talk(1);
    expect(character.silent.polish).toBeCloseTo(1, 2); // the shape: the smooth finish …
    expect(character.silent.swell).toBeCloseTo(0, 2); // … and no voice bumps in silence
    expect(character.silent.material).toBeCloseTo(0.4, 2); // the colour: the character's (mostly white)
    expect(you.silent.material).toBeCloseTo(1, 2); // yours: the rainbow
    expect(character.loudSwell).toBeCloseTo(you.loudSwell, 5); // as bumpy talking, either of you
    expect(character.loudPolish).toBeCloseTo(you.loudPolish, 5);
  });

  it("ignores a voice without a style (the head loader and the 404)", () => {
    const a = createChromeFlow(FLOW), b = createChromeFlow(FLOW);
    run(a, 2, SWING);
    run(b, 2, voiced(1));
    expect(b.frame).toEqual(a.frame);
  });
});

describe("even bumps", () => {
  const BUMPS: [number, number] = [0.4, 0.03];
  /** The fastest the bump height changes to the eye (its log) over one swing, per s, and the time near the bubble. */
  const measure = (evenBumps: number) => {
    const flow = createChromeFlow({ ...FLOW, evenBumps, bumps: BUMPS });
    const height = (p: number) => polishUniforms(p, BUMPS[0], { ...FINISH, rest: BUMPS[1], shape: undefined }).amp;
    let fastest = 0, near = 0, last = height(flow.frame.polish);
    const dt = 1 / 600;
    for (let i = 0; i < FLOW.period * 600; i++) {
      flow.step(dt, SWING);
      const h = height(flow.frame.polish);
      fastest = Math.max(fastest, Math.abs(Math.log(h / last)) / dt);
      if (h < 0.08) near += dt;
      last = h;
    }
    return { fastest, near, end: flow.frame.polish };
  };

  it("is the loader's swing exactly at 0 (and by default)", () => {
    expect(evenBumped(0.3, 0, ...BUMPS)).toBe(0.3);
    const a = createChromeFlow(FLOW), b = createChromeFlow({ ...FLOW, evenBumps: 0, bumps: BUMPS });
    run(a, 2.3, SWING);
    run(b, 2.3, SWING);
    expect(b.frame).toEqual(a.frame);
  });

  it("grows out of the smooth bubble gently and shows it longer, the period unchanged", () => {
    const today = measure(0), even = measure(1);
    expect(even.fastest).toBeLessThan(today.fastest * 0.65); // ~43 % gentler at its fastest
    expect(even.near).toBeGreaterThan(today.near * 1.3);
    expect(even.end).toBeCloseTo(0, 2); // back on the blob after one period
  });

  it("picks the swing up from a held polish without a jump", () => {
    const flow = createChromeFlow({ ...FLOW, bumps: BUMPS, voice: { swing: false, dip: 0, swell: 0, flow: 0, pulse: 0, curve: 1, attack: 0.04, release: 0.2, ease: 0.4 } });
    run(flow, 2, { ...SWING, voice: { polish: 0.7, level: 0 } });
    const before = flow.frame.polish;
    flow.step(1 / 60, { ...SWING, voice: { polish: 0, level: 0, swing: true, evenBumps: 0.75 } });
    expect(Math.abs(flow.frame.polish - before)).toBeLessThan(0.03);
  });

  it("colourFloor lifts the blob end's colour while it swings, eased in", () => {
    const flow = createChromeFlow({ ...FLOW, bumps: BUMPS, voice: { swing: false, dip: 0, swell: 0, flow: 0, pulse: 0, curve: 1, attack: 0.04, release: 0.2, ease: 0.4 } });
    const think: ChromeDrive = { ...SWING, voice: { polish: 0, level: 0, swing: true, colourFloor: 0.3 } };
    flow.step(1 / 60, think);
    expect(flow.frame.material! - flow.frame.polish).toBeLessThan(0.03); // eases in, no jump
    run(flow, 3, think);
    expect(flow.frame.material!).toBeCloseTo(0.3 + 0.7 * flow.frame.polish, 2);
  });
});

describe("colour floor (the loader)", () => {
  it("draws the colour at the floor from the first frame, lifted through the swing, and full at the finish", () => {
    const flow = createChromeFlow({ ...FLOW, colourFloor: 0.25 });
    expect(flow.frame.material).toBe(0.25); // the poster's frame, before it moves
    run(flow, 0.7, SWING);
    expect(flow.frame.material!).toBeCloseTo(0.25 + 0.75 * flow.frame.polish, 5);
    run(flow, 3, { ...SWING, settling: true }); // the reveal: on to the finish
    expect(flow.frame.polish).toBe(1);
    expect(flow.frame.material!).toBeCloseTo(1, 5); // the hand-off to the head is unchanged
  });
});

describe("startPolish (a voice orb)", () => {
  it("opens on the finish at full colour, the frame its still shows, and stays there in silence", () => {
    const style = { swing: false, holdColour: true, dip: 0, swell: 0.18, flow: 0.8, pulse: 0, curve: 0.8, attack: 0.04, release: 0.2, ease: 0.4 };
    const flow = createChromeFlow({ ...FLOW, start: 22, startPolish: 1, colourFloor: 0.25, voice: style });
    expect(flow.frame).toMatchObject({ time: 22, drift: 22 * FLOW.speed, polish: 1, material: 1 }); // VoiceSphere's voiceSphereFrame(1)
    run(flow, 2, { ...SWING, voice: { polish: 1, level: 0 } });
    expect(flow.frame.polish).toBeCloseTo(1, 5);
    expect(flow.frame.material!).toBeCloseTo(1, 5);
  });
});
