/**
 * The shaped positions and smooth normals of a mesh: base + Σ weight·delta, then area-weighted vertex normals with the
 * UV-seam copies welded (lib/morphs/normals.ts). Plain arrays, no three.js: the page runs it, and on a slow device
 * lib/morphs/normalsWorker.ts runs the same code for the live refreshes while a face moves.
 */
export type ShapeMesh = { base: Float32Array; index: Uint16Array | Uint32Array; weld: Int32Array | null };

/** Write the shape into `p` and its normals into `n` (both 3 floats per vertex). `active`: the non-zero targets, in order. */
export function computeShape(mesh: ShapeMesh, active: { w: number; data: Float32Array }[], p: Float32Array, n: Float32Array): void {
  p.set(mesh.base);
  for (const { w, data } of active) for (let i = 0; i < p.length; i++) p[i] += w * data[i];
  n.fill(0);
  const idx = mesh.index;
  const weld = mesh.weld;
  for (let t = 0; t < idx.length; t += 3) {
    const a = (weld ? weld[idx[t]] : idx[t]) * 3, b = (weld ? weld[idx[t + 1]] : idx[t + 1]) * 3, c = (weld ? weld[idx[t + 2]] : idx[t + 2]) * 3;
    const abx = p[b] - p[a], aby = p[b + 1] - p[a + 1], abz = p[b + 2] - p[a + 2];
    const acx = p[c] - p[a], acy = p[c + 1] - p[a + 1], acz = p[c + 2] - p[a + 2];
    const nx = aby * acz - abz * acy, ny = abz * acx - abx * acz, nz = abx * acy - aby * acx;
    n[a] += nx; n[a + 1] += ny; n[a + 2] += nz;
    n[b] += nx; n[b + 1] += ny; n[b + 2] += nz;
    n[c] += nx; n[c + 1] += ny; n[c + 2] += nz;
  }
  for (let i = 0; i < n.length; i += 3) {
    const len = Math.hypot(n[i], n[i + 1], n[i + 2]) || 1;
    n[i] /= len; n[i + 1] /= len; n[i + 2] /= len;
  }
  if (weld) {
    for (let i = 0; i < weld.length; i++) {
      const k = weld[i];
      if (k !== i) {
        n[i * 3] = n[k * 3]; n[i * 3 + 1] = n[k * 3 + 1]; n[i * 3 + 2] = n[k * 3 + 2];
      }
    }
  }
}
