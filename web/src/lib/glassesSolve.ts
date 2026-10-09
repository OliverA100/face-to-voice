/**
 * The glasses fit's arithmetic (lib/glassesFit.ts) on plain arrays, without three.js: lib/glassesWorker.ts runs it off
 * the main thread (a frame's few thousand rays against the skin take a phone a few hundred ms), and glassesFit.ts runs
 * it in place where there are no workers. glassesFit.ts explains the method.
 */

/** What glassesFit.ts measures on the page and hands over once per frame style. */
export type SolveInput = {
  head: Float32Array; // every frame point in head space, as the file has it (the average face)
  side: Int8Array; // per frame point: 1 / -1 an arm point (left / right), 0 the front and lenses
  lever: Float32Array; // per frame point: how far behind the hinge, signed by side
  samples: Int32Array; // the frame points tested
  restPts: Float32Array; // the tested points in head space, as the file has them
  skinRest: Float32Array; // the skin at rest, in its own space
  skinMatrix: number[]; // skin space → head space (Matrix4 elements, column-major)
  tris: Uint16Array | Uint32Array; // the skin's own triangles
  reachMm: number;
  toleranceMm: number;
};

export type Solve = {
  side: Int8Array;
  lever: Float32Array;
  samples: Int32Array;
  start: Int32Array;
  cand: Int32Array;
  tris: Uint16Array | Uint32Array;
  skin: Float32Array; // scratch: the current skin in head space
  allow: Float32Array;
};

export type FitLimits = { maxSeatMm: number; maxSplay: number };
export type FitResult = { seat: number; splayLeft: number; splayRight: number; stillIn: number; ms: number };

/** Per tested point, the skin triangles near its ray, and how far in it may be (as far as on the average face, + tolerance). */
export function prepareSolve(input: SolveInput): Solve {
  const { head, side, lever, samples, restPts, skinRest: rest, skinMatrix: e, tris } = input;
  // the skin in head space (average face), as three.js's Vector3.applyMatrix4 computes it
  const skinRest = new Float32Array(rest.length);
  for (let n = 0; n < rest.length / 3; n++) {
    const x = rest[n * 3], y = rest[n * 3 + 1], z = rest[n * 3 + 2];
    const w = 1 / (e[3] * x + e[7] * y + e[11] * z + e[15]);
    skinRest[n * 3] = (e[0] * x + e[4] * y + e[8] * z + e[12]) * w;
    skinRest[n * 3 + 1] = (e[1] * x + e[5] * y + e[9] * z + e[13]) * w;
    skinRest[n * 3 + 2] = (e[2] * x + e[6] * y + e[10] * z + e[14]) * w;
  }
  const T = tris.length / 3;
  const cen = new Float32Array(T * 3);
  for (let t = 0; t < T; t++)
    for (let a = 0; a < 3; a++) cen[t * 3 + a] = (skinRest[tris[t * 3] * 3 + a] + skinRest[tris[t * 3 + 1] * 3 + a] + skinRest[tris[t * 3 + 2] * 3 + a]) / 3;
  const reach = input.reachMm / 1000, r2 = reach * reach;
  // triangle centres bucketed by `reach` across each ray's direction: (y, z) for the arms, (x, y) for the front
  const cell = (u: number, w: number) => `${Math.floor(u / reach)},${Math.floor(w / reach)}`;
  const grids = [new Map<string, number[]>(), new Map<string, number[]>()];
  for (let t = 0; t < T; t++) {
    for (const [grid, u, w] of [[grids[0], cen[t * 3 + 1], cen[t * 3 + 2]], [grids[1], cen[t * 3], cen[t * 3 + 1]]] as const) {
      const key = cell(u, w);
      let b = grid.get(key);
      if (!b) grid.set(key, (b = []));
      b.push(t);
    }
  }
  const start: number[] = [0], list: number[] = [];
  for (const g of samples) {
    const arm = side[g] !== 0;
    const [u, w] = arm ? [head[g * 3 + 1], head[g * 3 + 2]] : [head[g * 3], head[g * 3 + 1]];
    const cu = Math.floor(u / reach), cw = Math.floor(w / reach);
    const near: number[] = [];
    for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) near.push(...(grids[arm ? 0 : 1].get(`${cu + a},${cw + b}`) ?? []));
    for (const t of near) {
      // distance from the triangle's centre to the point's ray line (x line for an arm, z line for the front)
      const d2 = arm
        ? (cen[t * 3 + 1] - head[g * 3 + 1]) ** 2 + (cen[t * 3 + 2] - head[g * 3 + 2]) ** 2
        : (cen[t * 3] - head[g * 3]) ** 2 + (cen[t * 3 + 1] - head[g * 3 + 1]) ** 2;
      if (d2 < r2 && (!arm || cen[t * 3] * side[g] > 0)) list.push(t);
    }
    start.push(list.length);
  }
  const solve: Solve = { side, lever, samples, start: Int32Array.from(start), cand: Int32Array.from(list), tris, skin: new Float32Array(skinRest.length), allow: new Float32Array(samples.length) };
  // what each point may have on the average face: how far in it already is there (+ the tolerance)
  for (let s = 0; s < samples.length; s++) solve.allow[s] = exitOf(solve, skinRest, restPts, s, 0, 0) + input.toleranceMm / 1000;
  return solve;
}

/**
 * How far point s (moved by dx, dz) has to go along its ray to be out of the skin P (0 when it is out): the front's
 * ray runs forward (+z), an arm's outwards (±x). Odd number of crossings ahead = inside; the nearest one is the way out.
 */
function exitOf(solve: Solve, P: Float32Array, pts: Float32Array, s: number, dx: number, dz: number): number {
  const g = solve.samples[s], sd = solve.side[g];
  const p = [pts[s * 3] + dx, pts[s * 3 + 1], pts[s * 3 + 2] + dz];
  // the ray's axis (k) and the two across it (i, j)
  const [k, i, j] = sd ? [0, 1, 2] : [2, 0, 1];
  const dir = sd || 1;
  let hits = 0, near = Infinity;
  for (let c = solve.start[s]; c < solve.start[s + 1]; c++) {
    const t = solve.cand[c];
    const a = solve.tris[t * 3] * 3, b = solve.tris[t * 3 + 1] * 3, e = solve.tris[t * 3 + 2] * 3;
    // where the ray's line meets the triangle's plane, by barycentric coordinates in the (i, j) projection
    const ai = P[a + i] - p[i], aj = P[a + j] - p[j], bi = P[b + i] - p[i], bj = P[b + j] - p[j], ei = P[e + i] - p[i], ej = P[e + j] - p[j];
    const w0 = bi * ej - bj * ei, w1 = ei * aj - ej * ai, w2 = ai * bj - aj * bi; // twice the signed areas
    if ((w0 < 0 || w1 < 0 || w2 < 0) && (w0 > 0 || w1 > 0 || w2 > 0)) continue; // the line misses this triangle
    const sum = w0 + w1 + w2;
    if (!sum) continue;
    const at = (w0 * P[a + k] + w1 * P[b + k] + w2 * P[e + k]) / sum;
    const ahead = (at - p[k]) * dir;
    if (ahead <= 0) continue;
    hits++;
    near = Math.min(near, ahead);
  }
  return hits % 2 ? near : 0;
}

/** The fit on the skin as shown (`current`, skin space) for the tested points as shown (`pts`, head space). */
export function solveFit(solve: Solve, current: Float32Array, m: number[], pts: Float32Array, limits: FitLimits): FitResult {
  const t0 = performance.now();
  const P = solve.skin;
  for (let n = 0; n < current.length / 3; n++) {
    const x = current[n * 3], y = current[n * 3 + 1], z = current[n * 3 + 2];
    P[n * 3] = m[0] * x + m[4] * y + m[8] * z + m[12];
    P[n * 3 + 1] = m[1] * x + m[5] * y + m[9] * z + m[13];
    P[n * 3 + 2] = m[2] * x + m[6] * y + m[10] * z + m[14];
  }
  const { samples, side, lever, allow } = solve;
  // the front first (sliding moves the arms too), then each arm with the slide in place
  let seat = 0;
  samples.forEach((g, s) => {
    if (!side[g]) seat = Math.max(seat, exitOf(solve, P, pts, s, 0, 0) - allow[s]);
  });
  seat = Math.min(seat, limits.maxSeatMm / 1000);
  const splay = [0, 0]; // left, right
  samples.forEach((g, s) => {
    if (!side[g]) return;
    const need = (exitOf(solve, P, pts, s, 0, seat) - allow[s]) / Math.abs(lever[g]);
    const k = side[g] > 0 ? 0 : 1;
    splay[k] = Math.min(limits.maxSplay, Math.max(splay[k], need));
  });
  let stillIn = 0;
  samples.forEach((g, s) => {
    const dx = side[g] ? lever[g] * splay[side[g] > 0 ? 0 : 1] : 0;
    if (exitOf(solve, P, pts, s, dx, seat) > allow[s] + 1e-5) stillIn++;
  });
  return { seat, splayLeft: splay[0], splayRight: splay[1], stillIn, ms: performance.now() - t0 };
}
