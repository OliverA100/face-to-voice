/**
 * The two steps of the limiter's vertex positions that the page (LimitGeometry.positions, lib/morphs/limitGeometry.ts)
 * and the caps worker's copy (lib/morphs/capsWorker.ts) share, so their numbers stay identical. No three.js in here:
 * the worker imports it.
 */

/** The two eye pivots for these weights (`rest` false: only their change). */
export function eyePivots(pivot: number[][], basis: [string, number[]][][], weight: (target: string) => number, rest: boolean): number[][] {
  return [0, 1].map((e) => {
    const p = rest ? [...pivot[e]] : [0, 0, 0];
    for (const [t, d] of basis[e]) {
      const w = weight(t);
      if (w) {
        p[0] += w * d[0];
        p[1] += w * d[1];
        p[2] += w * d[2];
      }
    }
    return p;
  });
}

/** One part's vertices `s` (its mesh space, 3 floats each) → head space into `out` at its slots, plus `off` (its eye's pivot). */
export function placePart(slots: Int32Array, m: Float32Array, off: number[], s: Float32Array, out: Float32Array, rest: boolean): void {
  const tx = rest ? m[12] : 0, ty = rest ? m[13] : 0, tz = rest ? m[14] : 0;
  for (let i = 0; i < slots.length; i++) {
    const x = s[i * 3], y = s[i * 3 + 1], z = s[i * 3 + 2];
    const o = slots[i] * 3;
    out[o] = m[0] * x + m[4] * y + m[8] * z + tx + off[0];
    out[o + 1] = m[1] * x + m[5] * y + m[9] * z + ty + off[1];
    out[o + 2] = m[2] * x + m[6] * y + m[10] * z + tz + off[2];
  }
}
