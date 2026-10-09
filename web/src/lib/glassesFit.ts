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
 *
 * The rays run off the main thread (lib/glassesSolve.ts in lib/glassesWorker.ts; in place where there are no workers):
 * a phone took up to half a second per fit, once when the frame went on and again every few frames while a face morphed.
 * A new frame is shown once its first fit is on (`fitted`, which the add-on swap waits for).
 */
import { BufferAttribute, Matrix3, Matrix4, type Mesh, type Object3D, Vector3 } from "three";

import { meshesOf } from "@/lib/hair";
import { type FitResult, prepareSolve, type Solve, solveFit, type SolveInput } from "@/lib/glassesSolve";
import type { FromGlassesWorker, ToGlassesWorker } from "@/lib/glassesWorker";
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

// --- where the arithmetic runs (lib/glassesSolve.ts): a worker, or here where there is none --------------------------

let worker: Worker | null | undefined; // undefined: not tried yet; null: none (or it failed): solve here
const waiting = new Map<number, (r: FromGlassesWorker) => void>();
let requests = 0;
let frames = 0;
const solvedHere = new Map<number, Solve>();

function solver(): Worker | null {
  if (worker !== undefined) return worker;
  worker = null;
  try {
    if (typeof Worker !== "undefined") {
      const w = new Worker(new URL("./glassesWorker.ts", import.meta.url), { type: "module" });
      w.onmessage = (e: MessageEvent<FromGlassesWorker>) => {
        waiting.get(e.data.req)?.(e.data);
        waiting.delete(e.data.req);
      };
      w.onerror = () => {
        worker = null; // solve here from now on (the waiting fits too)
        for (const [req, done] of waiting) done({ req, error: "worker failed" });
        waiting.clear();
      };
      worker = w;
    }
  } catch {
    worker = null;
  }
  return worker;
}

/** Fit a prepared frame to the skin shown now (`current`, skin space; `pts`, the tested points as shown): in the worker,
 *  or here. Null when it couldn't be done. */
async function solveNow(prep: Prep, read: () => { current: Float32Array; pts: Float32Array }): Promise<FitResult | null> {
  const limits = { maxSeatMm: GLASSES_FIT.maxSeatMm, maxSplay: GLASSES_FIT.maxSplay };
  const skinMatrix = skinSurface.toHead.elements.slice();
  const w = solver();
  if (w && prep.inWorker) {
    const req = ++requests;
    const { current, pts } = read();
    const reply = await new Promise<FromGlassesWorker>((done) => {
      waiting.set(req, done);
      w.postMessage({ type: "fit", id: prep.id, req, current, skinMatrix, pts, limits } satisfies ToGlassesWorker, [current.buffer, pts.buffer]);
    });
    if (!("error" in reply)) return reply;
    if (worker) return null; // still running: a real error
    prep.inWorker = false; // the worker failed: solve here from now on
  }
  const { current, pts } = read();
  let solve = solvedHere.get(prep.id);
  if (!solve) solvedHere.set(prep.id, (solve = prepareSolve(prep.input)));
  return solveFit(solve, current, skinMatrix, pts, limits);
}

/**
 * Fit `node` (a glasses style, under the head's root node `root`) to the skin now and whenever the shape settles.
 * `fitted` resolves once the first fit is on (or couldn't be done; at most FIRST_FIT_WAIT_MS), so a swap can wait for it
 * and the frame never shows unfitted; `unfit` takes it off.
 */
export function fitGlasses(node: Object3D, root: Object3D): { fitted: Promise<void>; unfit: () => void } {
  let prepared: Prep | null = null;
  let gone = false;
  let latest = 0; // the newest fit asked for: an older answer arriving late is dropped
  const run = async (): Promise<void> => {
    if (gone) return;
    if (!prepared) {
      const t0 = performance.now();
      prepared = prepare(node, root);
      glassesFitState.prepareMs = performance.now() - t0;
    }
    if (!prepared || !skinShape()) return;
    const prep = prepared;
    const ask = ++latest;
    const r = await solveNow(prep, () => ({ current: skinShape()!.current.slice(), pts: sampled(prep, true) }));
    if (gone || !r || ask !== latest) return;
    for (const p of prep.parts) write(p, r.seat, r.splayLeft, r.splayRight);
    Object.assign(glassesFitState, { seatMm: r.seat * 1000, splayLeft: r.splayLeft, splayRight: r.splayRight, stillIn: r.stillIn, ms: r.ms });
  };
  // in idle time (a few ms here; the rays run in the worker): never on the frame a slider is let go
  let queued = false;
  const later = () => {
    if (queued) return;
    queued = true;
    const go = () => {
      queued = false;
      void run();
    };
    if (typeof requestIdleCallback === "function") requestIdleCallback(go, { timeout: 200 });
    else setTimeout(go, 0);
  };
  // the first fit at once (the frame is not shown yet when it goes on in a cross-fade)
  const first = new Promise<void>((resolve) => setTimeout(resolve, 0)).then(run).catch((err: unknown) => console.warn("glasses: fit failed", err));
  const fitted = Promise.race([first, new Promise<void>((resolve) => setTimeout(resolve, FIRST_FIT_WAIT_MS))]);
  const off = onSkinShape(later);
  const unfit = () => {
    gone = true;
    off();
    if (prepared) {
      for (const p of prepared.parts) write(p, 0, 0, 0); // the file's own shape back
      if (prepared.inWorker) worker?.postMessage({ type: "drop", id: prepared.id } satisfies ToGlassesWorker);
      solvedHere.delete(prepared.id);
    }
  };
  return { fitted, unfit };
}

/** The longest a swap waits for the glasses' first fit before showing them anyway. */
const FIRST_FIT_WAIT_MS = 1000;

/**
 * The frame measured on the page (its meshes, in head space as the file has them; the arms, the tested points), handed
 * to the solver once: it finds each tested point's nearby skin triangles and how far in it may be.
 */
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
  // the skin's own triangles: a shell beard appends copies of the beard's (lib/beardShells.ts), which would count twice
  const tris = (index.array as Uint16Array | Uint32Array).subarray(0, (skinSurface.mesh!.geometry.userData.baseIndexCount as number | undefined) ?? index.count);
  const input: SolveInput = {
    head,
    side,
    lever,
    samples,
    restPts: sampled({ parts, owner, samples }, false),
    skinRest: shape.rest.slice(),
    skinMatrix: skinSurface.toHead.elements.slice(),
    tris: tris.slice(),
    reachMm: GLASSES_FIT.reachMm,
    toleranceMm: GLASSES_FIT.toleranceMm,
  };
  const id = ++frames;
  const w = solver();
  w?.postMessage({ type: "prepare", id, input } satisfies ToGlassesWorker); // copied: the input stays for solving here
  return { id, parts, owner, samples, input, inWorker: !!w };
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
