/**
 * Tying strand points to the skin (lib/groom.ts): each point to its three nearest rest skin vertices, 1/d⁴ (the nearest
 * dominates: a lash root on the lid edge must move with the edge, not the fold above it). Plain arrays, no three.js:
 * lib/strandsWorker.ts ties a style's roots while it decodes the file (a few hundred ms of searching on a slow phone,
 * which would otherwise land in the piece's first frame), and groom.ts ties here when the worker couldn't.
 */

/** The rest skin in head space, bucketed in a 1 cm grid. */
export type SkinGrid = { head: Float32Array; grid: Map<number, number[]>; cell: number };
export type Tie = { idx: Int32Array; wts: Float32Array };

export const cellKey = (x: number, y: number, z: number) => ((x + 1024) * 2048 + (y + 1024)) * 2048 + (z + 1024);

/** `rest` (skin space) in head space by `m` (Matrix4 elements, column-major; as three.js's Vector3.applyMatrix4), bucketed. */
export function skinGrid(rest: Float32Array, m: ArrayLike<number>): SkinGrid {
  const count = rest.length / 3;
  const head = new Float32Array(rest.length);
  for (let i = 0; i < count; i++) {
    const x = rest[i * 3], y = rest[i * 3 + 1], z = rest[i * 3 + 2];
    const w = 1 / (m[3] * x + m[7] * y + m[11] * z + m[15]);
    head[i * 3] = (m[0] * x + m[4] * y + m[8] * z + m[12]) * w;
    head[i * 3 + 1] = (m[1] * x + m[5] * y + m[9] * z + m[13]) * w;
    head[i * 3 + 2] = (m[2] * x + m[6] * y + m[10] * z + m[14]) * w;
  }
  const cell = 0.01;
  const grid = new Map<number, number[]>();
  for (let i = 0; i < count; i++) {
    const k = cellKey(Math.floor(head[i * 3] / cell), Math.floor(head[i * 3 + 1] / cell), Math.floor(head[i * 3 + 2] / cell));
    let b = grid.get(k);
    if (!b) grid.set(k, (b = []));
    b.push(i);
  }
  return { head, grid, cell };
}

/** Tie points (head space) to their three nearest rest skin vertices. */
export function tiePoints(pts: Float32Array, { head, grid, cell }: SkinGrid): Tie {
  const n = pts.length / 3;
  const idx = new Int32Array(n * 3);
  const wts = new Float32Array(n * 3);
  for (let s = 0; s < n; s++) {
    const x = pts[s * 3], y = pts[s * 3 + 1], z = pts[s * 3 + 2];
    const best = [-1, -1, -1], bestD = [Infinity, Infinity, Infinity];
    for (let r = 1; r <= 3 && best[2] < 0; r++) {
      const cx = Math.floor(x / cell), cy = Math.floor(y / cell), cz = Math.floor(z / cell);
      for (let i = cx - r; i <= cx + r; i++)
        for (let j = cy - r; j <= cy + r; j++)
          for (let k = cz - r; k <= cz + r; k++) {
            const b = grid.get(cellKey(i, j, k));
            if (!b) continue;
            for (const vi of b) {
              const dx = head[vi * 3] - x, dy = head[vi * 3 + 1] - y, dz = head[vi * 3 + 2] - z;
              const d = dx * dx + dy * dy + dz * dz;
              if (d < bestD[2] && !best.includes(vi)) {
                // insert sorted
                let at = 2;
                while (at > 0 && d < bestD[at - 1]) {
                  bestD[at] = bestD[at - 1];
                  best[at] = best[at - 1];
                  at--;
                }
                bestD[at] = d;
                best[at] = vi;
              }
            }
          }
    }
    let sum = 0;
    for (let q = 0; q < 3; q++) {
      const w = best[q] < 0 ? 0 : 1 / (bestD[q] * bestD[q] + 1e-16);
      idx[s * 3 + q] = Math.max(0, best[q]);
      wts[s * 3 + q] = w;
      sum += w;
    }
    for (let q = 0; q < 3; q++) wts[s * 3 + q] /= sum || 1;
  }
  return { idx, wts };
}

/** What groom.ts ties for a strand style: the roots, the lash tips (eyeFollow), every point (brows' shapeFollow). */
export type TieWanted = { tips: boolean; points: boolean };
export type StyleTies = { roots: Tie; tips?: Tie; points?: Tie };

/** The ties of a decoded style (positions N·P·3, head space). */
export function tieStyle(positions: Float32Array, n: number, p: number, skin: SkinGrid, wanted: TieWanted): StyleTies {
  const roots = new Float32Array(n * 3);
  for (let s = 0; s < n; s++) roots.set(positions.subarray(s * p * 3, s * p * 3 + 3), s * 3);
  const out: StyleTies = { roots: tiePoints(roots, skin) };
  if (wanted.tips) {
    const tips = new Float32Array(n * 3);
    for (let s = 0; s < n; s++) tips.set(positions.subarray((s * p + p - 1) * 3, (s * p + p) * 3), s * 3);
    out.tips = tiePoints(tips, skin);
  }
  if (wanted.points) out.points = tiePoints(positions, skin);
  return out;
}
