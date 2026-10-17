/**
 * Triangle geometry for the limiter (lib/morphs/limits.ts), as the pipeline's checks.py does it: which triangles to
 * test against each eye and skin point, whether two triangles cross and how deeply, a ray against a triangle, and the
 * closest point on one.
 */

/** Positions of the tested vertices and the two eye pivots (head space, metres). */
export type Pose = { P: Float32Array; piv: Float32Array };

/**
 * For each tested skin vertex: the k eye triangles whose centres lie nearest its direction from the eye's pivot on the
 * average face (the pipeline's VLimits.build picks them the same way). Wide enough for the face to move.
 */
export function pickEyeTriangles(avg: Pose, ei: number, skin: Int32Array, tris: Int32Array, k: number): Int32Array {
  const P = avg.P;
  const cx = avg.piv[ei * 3], cy = avg.piv[ei * 3 + 1], cz = avg.piv[ei * 3 + 2];
  const T = tris.length / 3;
  const dir = new Float32Array(T * 3);
  for (let t = 0; t < T; t++) {
    let x = 0, y = 0, z = 0;
    for (let j = 0; j < 3; j++) {
      x += P[tris[t * 3 + j] * 3] / 3;
      y += P[tris[t * 3 + j] * 3 + 1] / 3;
      z += P[tris[t * 3 + j] * 3 + 2] / 3;
    }
    const l = Math.hypot(x - cx, y - cy, z - cz) || 1;
    dir.set([(x - cx) / l, (y - cy) / l, (z - cz) / l], t * 3);
  }
  const out = new Int32Array(skin.length * k * 3);
  const dots = new Float32Array(T);
  const order = new Int32Array(T);
  for (let s = 0; s < skin.length; s++) {
    const vx = P[skin[s] * 3] - cx, vy = P[skin[s] * 3 + 1] - cy, vz = P[skin[s] * 3 + 2] - cz;
    const l = Math.hypot(vx, vy, vz) || 1;
    for (let t = 0; t < T; t++) {
      dots[t] = (dir[t * 3] * vx + dir[t * 3 + 1] * vy + dir[t * 3 + 2] * vz) / l;
      order[t] = t;
    }
    order.sort((a, b) => dots[b] - dots[a]);
    for (let j = 0; j < k; j++) out.set(tris.subarray(order[j] * 3, order[j] * 3 + 3), (s * k + j) * 3);
  }
  return out;
}

export function sharesCorner(tri: Int32Array, t: number, u: number): boolean {
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) if (tri[t * 3 + i] === tri[u * 3 + j]) return true;
  return false;
}

/** Does an edge of either triangle pass through the other (Möller–Trumbore), as in the pipeline's checks.py? */
export function trianglesCross(P: Float32Array, tri: Int32Array, t: number, u: number, tol: number): boolean {
  return edgesThrough(P, tri, t, u, tol) || edgesThrough(P, tri, u, t, tol);
}

/** Does an edge of triangle s pass through triangle o? (No arrays per call: this runs for every candidate pair.) */
function edgesThrough(P: Float32Array, tri: Int32Array, s: number, o: number, tol: number): boolean {
  const a = tri[o * 3] * 3, b = tri[o * 3 + 1] * 3, c = tri[o * 3 + 2] * 3;
  const p0 = tri[s * 3] * 3, p1 = tri[s * 3 + 1] * 3, p2 = tri[s * 3 + 2] * 3;
  return segmentHits(P, p0, p1, a, b, c, tol) || segmentHits(P, p1, p2, a, b, c, tol) || segmentHits(P, p2, p0, a, b, c, tol);
}

/** How far a crossing pair really passes through (mm): each triangle's smaller poke through the other's plane, the
 *  smaller of the two (as checks.py crossing_depth): a graze is ~0. */
export function crossingDepth(P: Float32Array, tri: Int32Array, t: number, u: number): number {
  const poke = (x: number, y: number) => {
    const a = tri[y * 3] * 3, b = tri[y * 3 + 1] * 3, c = tri[y * 3 + 2] * 3;
    const ux = P[b] - P[a], uy = P[b + 1] - P[a + 1], uz = P[b + 2] - P[a + 2];
    const vx = P[c] - P[a], vy = P[c + 1] - P[a + 1], vz = P[c + 2] - P[a + 2];
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const nl = Math.hypot(nx, ny, nz) || 1;
    let pos = 0, neg = 0;
    for (let k = 0; k < 3; k++) {
      const p = tri[x * 3 + k] * 3;
      const d = ((P[p] - P[a]) * nx + (P[p + 1] - P[a + 1]) * ny + (P[p + 2] - P[a + 2]) * nz) / nl;
      pos = Math.max(pos, d);
      neg = Math.max(neg, -d);
    }
    return Math.min(pos, neg);
  };
  return Math.min(poke(t, u), poke(u, t)) * 1000;
}

/** Möller–Trumbore; `tol` also counts segments passing within that share of the triangle's border. */
function segmentHits(P: Float32Array, p: number, q: number, a: number, b: number, c: number, tol: number): boolean {
  const e1x = P[b] - P[a], e1y = P[b + 1] - P[a + 1], e1z = P[b + 2] - P[a + 2];
  const e2x = P[c] - P[a], e2y = P[c + 1] - P[a + 1], e2z = P[c + 2] - P[a + 2];
  const dx = P[q] - P[p], dy = P[q + 1] - P[p + 1], dz = P[q + 2] - P[p + 2];
  const hx = dy * e2z - dz * e2y, hy = dz * e2x - dx * e2z, hz = dx * e2y - dy * e2x;
  const det = e1x * hx + e1y * hy + e1z * hz;
  if (Math.abs(det) < 1e-18) return false;
  const inv = 1 / det;
  const sx = P[p] - P[a], sy = P[p + 1] - P[a + 1], sz = P[p + 2] - P[a + 2];
  const uu = (sx * hx + sy * hy + sz * hz) * inv;
  if (uu < -tol || uu > 1 + tol) return false;
  const qx = sy * e1z - sz * e1y, qy = sz * e1x - sx * e1z, qz = sx * e1y - sy * e1x;
  const vv = (dx * qx + dy * qy + dz * qz) * inv;
  if (vv < -tol || uu + vv > 1 + tol) return false;
  const tt = (e2x * qx + e2y * qy + e2z * qz) * inv;
  return tt >= -tol && tt <= 1 + tol;
}

/**
 * For each visible eye point (slots `pts`), the k skin triangles (indices into `tris`, slot triplets) whose centres lie
 * nearest its direction from the eye's pivot on the average face (pipeline VLimits.build, eye_through).
 */
export function pickSkinTriangles(avg: Pose, ei: number, pts: Int32Array, tris: Int32Array, k: number): Int32Array {
  const P = avg.P;
  const cx = avg.piv[ei * 3], cy = avg.piv[ei * 3 + 1], cz = avg.piv[ei * 3 + 2];
  const T = tris.length / 3;
  const dir = new Float32Array(T * 3);
  for (let t = 0; t < T; t++) {
    let x = 0, y = 0, z = 0;
    for (let q = 0; q < 3; q++) {
      const v = tris[t * 3 + q] * 3;
      x += P[v] / 3;
      y += P[v + 1] / 3;
      z += P[v + 2] / 3;
    }
    x -= cx;
    y -= cy;
    z -= cz;
    const l = Math.hypot(x, y, z) || 1;
    dir.set([x / l, y / l, z / l], t * 3);
  }
  const out = new Int32Array(pts.length * k);
  const best = new Float32Array(k), bestT = new Int32Array(k);
  for (let i = 0; i < pts.length; i++) {
    const v = pts[i] * 3;
    const x = P[v] - cx, y = P[v + 1] - cy, z = P[v + 2] - cz;
    const l = Math.hypot(x, y, z) || 1;
    best.fill(-Infinity);
    for (let t = 0; t < T; t++) {
      const d = (dir[t * 3] * x + dir[t * 3 + 1] * y + dir[t * 3 + 2] * z) / l; // cosine: larger = nearer in direction
      if (d <= best[k - 1]) continue;
      let at = k - 1;
      while (at > 0 && d > best[at - 1]) {
        best[at] = best[at - 1];
        bestT[at] = bestT[at - 1];
        at--;
      }
      best[at] = d;
      bestT[at] = t;
    }
    out.set(bestT, i * k);
  }
  return out;
}

/** Distance along unit ray d (from the origin) to triangle abc, Infinity when it misses (Möller–Trumbore, both faces). */
export function rayTriangle(dx: number, dy: number, dz: number, ax: number, ay: number, az: number, bx: number, by: number, bz: number, cx: number, cy: number, cz: number): number {
  const e1x = bx - ax, e1y = by - ay, e1z = bz - az, e2x = cx - ax, e2y = cy - ay, e2z = cz - az;
  const hx = dy * e2z - dz * e2y, hy = dz * e2x - dx * e2z, hz = dx * e2y - dy * e2x;
  const a = e1x * hx + e1y * hy + e1z * hz;
  if (Math.abs(a) < 1e-14) return Infinity;
  const f = 1 / a;
  const sx = -ax, sy = -ay, sz = -az;
  const u = f * (sx * hx + sy * hy + sz * hz);
  if (u < 0 || u > 1) return Infinity;
  const qx = sy * e1z - sz * e1y, qy = sz * e1x - sx * e1z, qz = sx * e1y - sy * e1x;
  const v = f * (dx * qx + dy * qy + dz * qz);
  if (v < 0 || u + v > 1) return Infinity;
  const t = f * (e2x * qx + e2y * qy + e2z * qz);
  return t > 0 ? t : Infinity;
}

/** Closest point on triangle abc to p (Ericson, Real-Time Collision Detection 5.1.5). */
export function closestOnTriangle(px: number, py: number, pz: number, ax: number, ay: number, az: number, bx: number, by: number, bz: number, cx: number, cy: number, cz: number): [number, number, number] {
  const abx = bx - ax, aby = by - ay, abz = bz - az, acx = cx - ax, acy = cy - ay, acz = cz - az;
  const apx = px - ax, apy = py - ay, apz = pz - az;
  const d1 = abx * apx + aby * apy + abz * apz, d2 = acx * apx + acy * apy + acz * apz;
  if (d1 <= 0 && d2 <= 0) return [ax, ay, az];
  const bpx = px - bx, bpy = py - by, bpz = pz - bz;
  const d3 = abx * bpx + aby * bpy + abz * bpz, d4 = acx * bpx + acy * bpy + acz * bpz;
  if (d3 >= 0 && d4 <= d3) return [bx, by, bz];
  const vc = d1 * d4 - d3 * d2;
  if (vc <= 0 && d1 >= 0 && d3 <= 0) {
    const v = d1 / (d1 - d3);
    return [ax + v * abx, ay + v * aby, az + v * abz];
  }
  const cpx = px - cx, cpy = py - cy, cpz = pz - cz;
  const d5 = abx * cpx + aby * cpy + abz * cpz, d6 = acx * cpx + acy * cpy + acz * cpz;
  if (d6 >= 0 && d5 <= d6) return [cx, cy, cz];
  const vb = d5 * d2 - d1 * d6;
  if (vb <= 0 && d2 >= 0 && d6 <= 0) {
    const w = d2 / (d2 - d6);
    return [ax + w * acx, ay + w * acy, az + w * acz];
  }
  const va = d3 * d6 - d5 * d4;
  if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) {
    const w = (d4 - d3) / (d4 - d3 + (d5 - d6));
    return [bx + w * (cx - bx), by + w * (cy - by), bz + w * (cz - bz)];
  }
  const den = 1 / (va + vb + vc);
  const v = vb * den, w = vc * den;
  return [ax + abx * v + acx * w, ay + aby * v + acy * w, az + abz * v + acz * w];
}
