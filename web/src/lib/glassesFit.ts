/**
 * Glasses on the face actually shown. The pipeline bakes how a frame follows each face-shape slider at ±1
 * (pipeline glasses_fit.bind_glasses); far slider ends and mixes of sliders go past what that bake knows, and the arms or the
 * front can end up inside the head (a narrow or long head, big ears, a low brow). Whenever the face's shape settles,
 * the frame is checked against the skin, and only where a point is deeper in the skin than on the average face:
 *   seat   the whole frame slides forward (z) until its front is out;
 *   splay  each arm opens (sideways, growing behind the hinge, like a real frame's hinge) until it is out.
 * An optician's fit, like the pipeline's place_glasses. Both are written into the frame's own positions; its face-shape
 * targets still add on top. A face the frame already fits is left exactly as it was.
 *
 * Inside or out: a frame point only ever moves one way (the front forward along z, an arm outwards along x), so a ray
 * from the point that way tells both: an odd number of skin crossings = inside, and the first crossing is how far it
 * has to move. (A ray, not the nearest triangle: next to the ears and the eye sockets the nearest skin often faces the
 * wrong way.) Mirrored by pipeline validate/addons_check.py, so the stress test measures what this draws.
 * Behind the ear root the arms' tips are left free to tuck in, as the pipeline's fit does. Tweak in GLASSES_FIT.
 */
import { BufferAttribute, Matrix3, Matrix4, type Mesh, type Object3D, Vector3 } from "three";

import { meshesOf } from "@/lib/hair";
import { onSkinShape, skinShape, skinSurface } from "@/lib/skinSurface";

export const GLASSES_FIT = {
  toleranceMm: 0.25, // a frame point may be this much further in than on the average face before the fit acts
  hingeDepthMm: 22, // the front is this deep (from its front-most point back); behind it the arms (pipeline HINGE_DEPTH_M)
  armMinXMm: 40, // arm points are further than this from the midline (pipeline ARM_MIN_X_M)
  minLeverMm: 30, // arm points closer than this behind the hinge are left out: opening barely moves them …
  earRootZMm: 19.7, // … and so are those behind the ear root (its depth on the average face; pipeline ear_top) …
  earBandMm: 6, // … by more than this: behind the ear the tips may tuck in (pipeline EAR_BAND_M), as on real glasses
  maxSeatMm: 6, // the frame slides forward at most this far (pipeline FOLLOW_SEAT_LIMITS_M) …
  maxSplay: 0.25, // … and an arm opens at most this much (metres sideways per metre behind the hinge)
  samples: 20000, // frame points tested, at most (half front and lenses, half arms): the shipped frames are tested whole
  reachMm: 15, // skin triangles whose centre is this close to a point's ray (on the average face) are its candidates
};

/** What the last fit did (debug handle, e2e): the moves, and how many tested points are still in. */
export const glassesFitState = { seatMm: 0, splayLeft: 0, splayRight: 0, stillIn: 0, ms: 0, prepareMs: 0 };

type Part = { mesh: Mesh; rest: Float32Array; toHead: Matrix4; fromHead: Matrix3; lever: Float32Array; offset: number };
type Prep = NonNullable<ReturnType<typeof prepare>>;

/** Fit `node` (a glasses style, under the head's root node `root`) to the skin now and whenever the shape settles. */
export function fitGlasses(node: Object3D, root: Object3D): () => void {
  let prepared: Prep | null = null;
  let gone = false;
  const run = () => {
    if (gone) return;
    if (!prepared) {
      const t0 = performance.now();
      prepared = prepare(node, root);
      glassesFitState.prepareMs = performance.now() - t0;
    }
    if (prepared) fit(prepared);
  };
  // in idle time (a few tens of ms): never on the frame a slider is let go
  let queued = false;
  const later = () => {
    if (queued) return;
    queued = true;
    const go = () => {
      queued = false;
      run();
    };
    if (typeof requestIdleCallback === "function") requestIdleCallback(go, { timeout: 200 });
    else setTimeout(go, 0);
  };
  later();
  const off = onSkinShape(later);
  return () => {
    gone = true;
    off();
    if (prepared) for (const p of prepared.parts) write(p, 0, 0, 0); // the file's own shape back
  };
}

function prepare(node: Object3D, root: Object3D) {
  const shape = skinShape();
  const index = skinSurface.mesh?.geometry.index;
  if (!shape || !index) return null;
  root.updateWorldMatrix(true, true);
  const inv = new Matrix4().copy(root.matrixWorld).invert();
  // the frame in head space, as the file has it (the average face)
  const parts: Part[] = [];
  let count = 0;
  for (const mesh of meshesOf(node)) {
    const pos = mesh.geometry.attributes.position as BufferAttribute;
    const toHead = new Matrix4().multiplyMatrices(inv, mesh.matrixWorld);
    const rest = new Float32Array(pos.count * 3);
    for (let i = 0; i < pos.count; i++) rest.set([pos.getX(i), pos.getY(i), pos.getZ(i)], i * 3);
    // The file's positions are whole numbers 0…65535 (KHR_mesh_quantization): an arm opened past that range would wrap
    // round to the far side of the head (long pale slivers at the tips). Floats, same values, hold any fit.
    if (!(pos.array instanceof Float32Array)) mesh.geometry.setAttribute("position", new BufferAttribute(rest.slice(), 3));
    parts.push({ mesh, rest, toHead, fromHead: new Matrix3().setFromMatrix4(toHead).invert(), lever: new Float32Array(pos.count), offset: count });
    count += pos.count;
  }
  const head = new Float32Array(count * 3);
  const owner = new Int32Array(count); // part of each frame point
  const v = new Vector3();
  let front = -Infinity;
  parts.forEach((p, k) => {
    for (let i = 0; i < p.rest.length / 3; i++) {
      v.fromArray(p.rest, i * 3).applyMatrix4(p.toHead).toArray(head, (p.offset + i) * 3);
      owner[p.offset + i] = k;
      front = Math.max(front, head[(p.offset + i) * 3 + 2]);
    }
  });
  // arms: far enough from the midline and behind the hinge; lever = how far behind the hinge, signed by side
  const hinge = front - GLASSES_FIT.hingeDepthMm / 1000;
  const side = new Int8Array(count); // 1 / -1: an arm point (left / right), 0: the front and lenses
  const lever = new Float32Array(count);
  for (const p of parts) {
    for (let i = 0; i < p.rest.length / 3; i++) {
      const g = p.offset + i, x = head[g * 3], z = head[g * 3 + 2];
      if (Math.abs(x) <= GLASSES_FIT.armMinXMm / 1000 || z >= hinge) continue;
      p.lever[i] = lever[g] = Math.sign(x) * (hinge - z);
      side[g] = x > 0 ? 1 : -1;
    }
  }
  // the points tested: spread evenly, half on the arms (leaving out the arms right behind the hinge)
  const fronts: number[] = [], arms: number[] = [];
  for (let g = 0; g < count; g++) {
    if (!side[g]) fronts.push(g);
    else if (Math.abs(lever[g]) >= GLASSES_FIT.minLeverMm / 1000 && head[g * 3 + 2] > (GLASSES_FIT.earRootZMm - GLASSES_FIT.earBandMm) / 1000) arms.push(g);
  }
  const every = (list: number[], n: number) => list.filter((_, k) => k % Math.max(1, Math.ceil(list.length / n)) === 0);
  const samples = Int32Array.from([...every(fronts, GLASSES_FIT.samples / 2), ...every(arms, GLASSES_FIT.samples / 2)]);
  // the skin in head space (average face) and, per point, the triangles near its ray
  const m = skinSurface.toHead;
  const skinRest = new Float32Array(shape.rest.length);
  for (let i = 0; i < shape.rest.length / 3; i++) v.fromArray(shape.rest, i * 3).applyMatrix4(m).toArray(skinRest, i * 3);
  // the skin's own triangles: a shell beard appends copies of the beard's (lib/beardShells.ts), which would count twice
  const tris = (index.array as Uint16Array | Uint32Array).subarray(0, (skinSurface.mesh!.geometry.userData.baseIndexCount as number | undefined) ?? index.count);
  const T = tris.length / 3;
  const cen = new Float32Array(T * 3);
  for (let t = 0; t < T; t++)
    for (let a = 0; a < 3; a++) cen[t * 3 + a] = (skinRest[tris[t * 3] * 3 + a] + skinRest[tris[t * 3 + 1] * 3 + a] + skinRest[tris[t * 3 + 2] * 3 + a]) / 3;
  const reach = GLASSES_FIT.reachMm / 1000, r2 = reach * reach;
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
  const prep = { parts, owner, side, lever, samples, start: Int32Array.from(start), cand: Int32Array.from(list), tris, skin: new Float32Array(skinRest.length), allow: new Float32Array(samples.length) };
  // what each point may have on the average face: how far in it already is there (+ the tolerance)
  const pts = sampled(prep, false);
  for (let s = 0; s < samples.length; s++) prep.allow[s] = exitOf(prep, skinRest, pts, s, 0, 0) + GLASSES_FIT.toleranceMm / 1000;
  return prep;
}

/** The tested points in head space, with the frame's morphs as shown now (`live`) or as the file has them. */
function sampled(prep: Pick<Prep, "parts" | "owner" | "samples">, live: boolean): Float32Array {
  const out = new Float32Array(prep.samples.length * 3);
  const v = new Vector3();
  prep.samples.forEach((g, s) => {
    const p = prep.parts[prep.owner[g]];
    const i = g - p.offset;
    v.fromArray(p.rest, i * 3);
    const infl = live ? (p.mesh.morphTargetInfluences ?? []) : [];
    const deltas = p.mesh.geometry.morphAttributes.position ?? [];
    for (let k = 0; k < infl.length; k++) {
      if (!infl[k]) continue;
      const d = deltas[k] as BufferAttribute;
      v.x += infl[k] * d.getX(i);
      v.y += infl[k] * d.getY(i);
      v.z += infl[k] * d.getZ(i);
    }
    v.applyMatrix4(p.toHead).toArray(out, s * 3);
  });
  return out;
}

/**
 * How far point s (moved by dx, dz) has to go along its ray to be out of the skin P (0 when it is out): the front's
 * ray runs forward (+z), an arm's outwards (±x). Odd number of crossings ahead = inside; the nearest one is the way out.
 */
function exitOf(prep: Prep, P: Float32Array, pts: Float32Array, s: number, dx: number, dz: number): number {
  const g = prep.samples[s], sd = prep.side[g];
  const p = [pts[s * 3] + dx, pts[s * 3 + 1], pts[s * 3 + 2] + dz];
  // the ray's axis (k) and the two across it (i, j)
  const [k, i, j] = sd ? [0, 1, 2] : [2, 0, 1];
  const dir = sd || 1;
  let hits = 0, near = Infinity;
  for (let c = prep.start[s]; c < prep.start[s + 1]; c++) {
    const t = prep.cand[c];
    const a = prep.tris[t * 3] * 3, b = prep.tris[t * 3 + 1] * 3, e = prep.tris[t * 3 + 2] * 3;
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

function fit(prep: Prep): void {
  const t0 = performance.now();
  const shape = skinShape();
  if (!shape) return;
  const m = skinSurface.toHead.elements;
  const P = prep.skin, cur = shape.current;
  for (let n = 0; n < cur.length / 3; n++) {
    const x = cur[n * 3], y = cur[n * 3 + 1], z = cur[n * 3 + 2];
    P[n * 3] = m[0] * x + m[4] * y + m[8] * z + m[12];
    P[n * 3 + 1] = m[1] * x + m[5] * y + m[9] * z + m[13];
    P[n * 3 + 2] = m[2] * x + m[6] * y + m[10] * z + m[14];
  }
  const pts = sampled(prep, true);
  const { samples, side, lever, allow } = prep;
  // the front first (sliding moves the arms too), then each arm with the slide in place
  let seat = 0;
  samples.forEach((g, s) => {
    if (!side[g]) seat = Math.max(seat, exitOf(prep, P, pts, s, 0, 0) - allow[s]);
  });
  seat = Math.min(seat, GLASSES_FIT.maxSeatMm / 1000);
  const splay = [0, 0]; // left, right
  samples.forEach((g, s) => {
    if (!side[g]) return;
    const need = (exitOf(prep, P, pts, s, 0, seat) - allow[s]) / Math.abs(lever[g]);
    const k = side[g] > 0 ? 0 : 1;
    splay[k] = Math.min(GLASSES_FIT.maxSplay, Math.max(splay[k], need));
  });
  let stillIn = 0;
  samples.forEach((g, s) => {
    const dx = side[g] ? lever[g] * splay[side[g] > 0 ? 0 : 1] : 0;
    if (exitOf(prep, P, pts, s, dx, seat) > allow[s] + 1e-5) stillIn++;
  });
  for (const p of prep.parts) write(p, seat, splay[0], splay[1]);
  Object.assign(glassesFitState, { seatMm: seat * 1000, splayLeft: splay[0], splayRight: splay[1], stillIn, ms: performance.now() - t0 });
}

/** The frame's positions = the file's + the fit (a head-space move, turned back into the mesh's own space). */
function write(p: Part, seat: number, splayLeft: number, splayRight: number): void {
  const pos = p.mesh.geometry.attributes.position as BufferAttribute;
  const e = p.fromHead.elements;
  for (let i = 0; i < pos.count; i++) {
    const l = p.lever[i];
    const dx = l * (l > 0 ? splayLeft : splayRight), dz = seat;
    pos.setXYZ(i, p.rest[i * 3] + e[0] * dx + e[6] * dz, p.rest[i * 3 + 1] + e[1] * dx + e[7] * dz, p.rest[i * 3 + 2] + e[2] * dx + e[8] * dz);
  }
  pos.needsUpdate = true;
}
