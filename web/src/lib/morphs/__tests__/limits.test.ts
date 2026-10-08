import { describe, expect, it } from "vitest";

import type { LimitGeometry } from "@/lib/morphs/limitGeometry";
import { Limiter, LIMITS, type LimitsDoc, type LimitStore } from "@/lib/morphs/limits";

/**
 * A toy head: the front of an eyeball (a flat square at z = 10 mm facing +z, pivot at the origin) and one skin vertex in
 * front of it at z = 15 mm that "eye_size" pulls toward the eye by 4 mm per unit; two crossing-test triangles that
 * "chin" pushes through each other (5 mm apart, 6 mm per unit); lip landmarks that never move.
 */
const R = 0.01;
const eyeV = [[-0.02, -0.02, R], [0.02, -0.02, R], [0.02, 0.02, R], [-0.02, 0.02, R], [0, 0, 0], [0, 0, 0]];
const eyeTris = [[0, 1, 2], [0, 2, 3]];
// vertex slots: 0..5 eye, 6 skin, 7..9 triangle A, 10..12 triangle B, 13..16 lips
const rest: number[][] = [...eyeV, [0, 0, 0.015], [-0.01, 0, 0.1], [0.01, 0, 0.1], [0, 0.01, 0.1], [-0.01, -0.005, 0.1 + 0.004], [0.01, -0.005, 0.1 + 0.004], [0, -0.005, 0.1 - 0.006], [0, 0, 0.2], [0, -0.001, 0.2], [0, 0.01, 0.2], [0, -0.01, 0.2]];
const motion: Record<string, Record<number, number[]>> = {
  eye_size: { 6: [0, 0, -0.004] },
  chin: { 7: [0, -0.006, 0], 8: [0, -0.006, 0], 9: [0, -0.006, 0] },
  blink: { 6: [0, 0, -0.003] },
};

const geom = {
  count: rest.length,
  positions(weight: (t: string) => number, out: Float32Array, isRest = true, piv?: Float32Array) {
    rest.forEach((p, i) => p.forEach((v, k) => (out[i * 3 + k] = isRest ? v : 0)));
    for (const [t, moves] of Object.entries(motion)) {
      const w = weight(t);
      for (const [i, d] of Object.entries(moves)) d.forEach((v, k) => (out[Number(i) * 3 + k] += w * v));
    }
    piv?.fill(0);
    return true;
  },
} as unknown as LimitGeometry;

const doc: LimitsDoc = {
  version: 2,
  thresholds: { eye_lids_mm: 0.3, eye_lids_hard_mm: 1, eye_lids_count: 3, eye_limiter_slack_mm: 0, lips_cross_mm: 0, limiter_crossing_mm: 0.05, limiter_edge_tol: 0.02 },
  parts: [],
  vertices: { part: [], index: [] },
  eyes: [{ skin: [6], tris: eyeTris.flat(), k: eyeTris.length, base: [0], edge: [0] }, { skin: [], tris: eyeTris.flat(), k: 2, base: [], edge: [] }],
  cross: { tris: [7, 8, 9, 10, 11, 12], inner: [0, 0], outer: [1, 1], zone: [-1, -1], contact: [0, 0] },
  lips: { up: [13], lo: [14], ls: [15], li: [16] },
};

function store(base: Record<string, number>): LimitStore {
  return { base, userValue: (t) => base[t] ?? 0, comboOf: () => undefined };
}
const limiter = () => {
  const L = new Limiter(doc);
  L.attach(geom);
  return L;
};

describe("vertex limiter", () => {
  it("lets the average face through", () => {
    expect(limiter().broken(store({}))).toBe(false);
  });

  it("finds where the skin would sink into the eye (5 mm gap + 1 mm allowed, 4 mm per unit → 1.5)", () => {
    const [, hi] = limiter().span(store({}), "eye_size", [-2, 2]);
    expect(hi).toBeGreaterThan(1.49);
    expect(hi).toBeLessThan(1.51);
  });

  it("finds where two surfaces start to cross (5 mm apart, 6 mm per unit → 0.83)", () => {
    const [, hi] = limiter().span(store({}), "chin", [-2, 2]);
    expect(hi).toBeGreaterThan(0.82);
    expect(hi).toBeLessThan(0.84);
    expect(limiter().broken(store({ chin: hi + 0.05 }))).toBe(true);
  });

  it("other sliders take room: with eye_size at 1, the blink may go less far (eyes never drawn back)", () => {
    const L = limiter();
    const saved = LIMITS.blinkRetractMm;
    LIMITS.blinkRetractMm = 0;
    try {
      const capsAlone = L.caps(store({}), { blink: { blink: 1 } });
      const capsBig = L.caps(store({ eye_size: 1 }), { blink: { blink: 1 } });
      expect(capsAlone.blink).toBe(1); // 3 mm toward a 5 mm gap: fine on the average face
      // 1 mm left + 0.5 mm allowed (an animation: LIMITS.animToleranceMm) = 1.5 mm of the 3 → ≈ 0.5
      expect(capsBig.blink).toBeGreaterThan(0.48);
      expect(capsBig.blink).toBeLessThan(0.51);
    } finally {
      LIMITS.blinkRetractMm = saved;
    }
  });

  it("a blink that would press into the eye closes in full with the eyes drawn back a little", () => {
    const L = limiter();
    expect(L.caps(store({}), { blink: { blink: 1 } }).blinkRetract).toBe(0); // the average face: nothing moves
    const caps = L.caps(store({ eye_size: 1 }), { blink: { blink: 1 } });
    expect(caps.blink).toBe(1);
    // the skin ends 2 mm inside the eye with 0.5 mm allowed: 1.5 mm back; this toy's two eyes share one eyeball,
    // which is drawn back once per eye, so half of it; at half a blink (1.5 mm of travel) 0.5 mm in, just allowed: ~0
    expect(caps.blinkRetract).toBeGreaterThan(0.74);
    expect(caps.blinkRetract).toBeLessThan(0.77);
    expect(caps.blinkRetract50).toBeLessThan(0.05); // exactly at the allowance (float rounding)
  });
});
