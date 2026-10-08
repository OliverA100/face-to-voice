import { gzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";

import { decodeStrandsHere } from "../strandsDecode";

/** Encode strands the way the pipeline does: int16 second differences per axis, low bytes, then high bytes, then shade. */
function encode(strands: number[][][], origin: [number, number, number], q: number, shade: number[], version = 2): ArrayBuffer {
  const n = strands.length, p = strands[0].length, count = n * p * 3;
  const buf = new ArrayBuffer(32 + count * 2 + n * p);
  const dv = new DataView(buf);
  "FTVH".split("").forEach((c, i) => dv.setUint8(i, c.charCodeAt(0)));
  dv.setUint32(4, version, true);
  dv.setUint32(8, n, true);
  dv.setUint32(12, p, true);
  origin.forEach((o, i) => dv.setFloat32(16 + i * 4, o, true));
  dv.setFloat32(28, q, true);
  const lo = new Uint8Array(buf, 32, count), hi = new Uint8Array(buf, 32 + count, count);
  for (let axis = 0; axis < 3; axis++) {
    for (let s = 0; s < n; s++) {
      const v = strands[s].map((pt) => Math.round((pt[axis] - origin[axis]) / q));
      for (let k = 0; k < p; k++) {
        const d2 = k === 0 ? v[0] : k === 1 ? v[1] - v[0] : v[k] - 2 * v[k - 1] + v[k - 2];
        const raw = d2 & 0xffff;
        const j = axis * n * p + s * p + k;
        lo[j] = raw & 255;
        hi[j] = raw >> 8;
      }
    }
  }
  new Uint8Array(buf, 32 + count * 2).set(shade);
  const gz = gzipSync(new Uint8Array(buf));
  return gz.buffer.slice(gz.byteOffset, gz.byteOffset + gz.byteLength) as ArrayBuffer;
}

describe("strandsDecode", () => {
  const q = 0.001;
  const origin: [number, number, number] = [0, 0.25, 0];
  // two strands of four points, curving both ways so the differences go negative
  const strands = [
    [[0.01, 0.3, 0.05], [0.012, 0.29, 0.052], [0.016, 0.276, 0.051], [0.019, 0.26, 0.047]],
    [[-0.02, 0.31, -0.01], [-0.025, 0.3, -0.012], [-0.027, 0.288, -0.011], [-0.026, 0.275, -0.006]],
  ];
  const shade = [0, 51, 102, 153, 204, 255, 128, 64];

  it("restores positions (head space, metres) and per-point shade", async () => {
    const s = await decodeStrandsHere(encode(strands, origin, q, shade));
    expect(s.n).toBe(2);
    expect(s.p).toBe(4);
    strands.flat().forEach((pt, i) => {
      for (let a = 0; a < 3; a++) expect(s.positions[i * 3 + a]).toBeCloseTo(pt[a], 6);
    });
    expect(Array.from(s.shade)).toEqual(shade.map((b) => Math.fround(b / 255)));
  });

  it("rejects other files and other versions", async () => {
    const bad = gzipSync(new Uint8Array(64));
    await expect(decodeStrandsHere(bad.buffer.slice(bad.byteOffset, bad.byteOffset + bad.byteLength) as ArrayBuffer)).rejects.toThrow("not a strands file");
    await expect(decodeStrandsHere(encode(strands, origin, q, shade, 1))).rejects.toThrow("version 2");
  });
});
