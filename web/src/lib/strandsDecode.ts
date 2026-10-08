/**
 * The .strands.bin format (lib/groom.ts): gzip of a header, int16 second differences per axis (low bytes of the whole
 * array first, then the high bytes) and one shade byte per point. Shared by the page and lib/strandsWorker.ts, which
 * decodes hair off the main thread (~60–80 ms per style on a slow phone): the same code, so the same floats.
 */
export type Strands = { n: number; p: number; positions: Float32Array; shade: Float32Array };

/** Gunzip and decode a .strands.bin: positions (N·P·3, metres, head space) and per-point shade (0..1). */
export async function decodeStrandsHere(gz: ArrayBuffer): Promise<Strands> {
  const stream = new Blob([gz]).stream().pipeThrough(new DecompressionStream("gzip"));
  const buf = await new Response(stream).arrayBuffer();
  const dv = new DataView(buf);
  const magic = String.fromCharCode(dv.getUint8(0), dv.getUint8(1), dv.getUint8(2), dv.getUint8(3));
  if (magic !== "FTVH") throw new Error("not a strands file");
  if (dv.getUint32(4, true) !== 2) throw new Error("strands file version 2 expected (re-export with the pipeline)");
  const n = dv.getUint32(8, true), p = dv.getUint32(12, true);
  const origin = [dv.getFloat32(16, true), dv.getFloat32(20, true), dv.getFloat32(24, true)];
  const q = dv.getFloat32(28, true);
  // int16 second differences, per axis (all x, then y, then z), low bytes of the whole array first, then the high bytes
  const count = n * p * 3;
  const lo = new Uint8Array(buf, 32, count), hi = new Uint8Array(buf, 32 + count, count);
  const positions = new Float32Array(n * p * 3);
  for (let axis = 0; axis < 3; axis++) {
    const base = axis * n * p;
    for (let s = 0; s < n; s++) {
      let value = 0, step = 0;
      for (let k = 0; k < p; k++) {
        const j = base + s * p + k;
        const raw = lo[j] | (hi[j] << 8);
        const d2 = raw > 32767 ? raw - 65536 : raw;
        if (k === 0) value = d2;
        else if (k === 1) {
          step = d2;
          value += step;
        } else {
          step += d2;
          value += step;
        }
        positions[(s * p + k) * 3 + axis] = origin[axis] + value * q;
      }
    }
  }
  const shadeBytes = new Uint8Array(buf, 32 + count * 2, n * p);
  const shade = new Float32Array(n * p);
  for (let i = 0; i < shade.length; i++) shade[i] = shadeBytes[i] / 255;
  return { n, p, positions, shade };
}
