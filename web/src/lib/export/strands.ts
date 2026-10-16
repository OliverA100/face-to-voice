/**
 * Strand pieces (hair, brows, lashes, strand beards) as plain ribbons for character.glb. The app draws them on the GPU
 * only (lib/groom.ts: one instanced ribbon per strand, every point placed by the vertex shader from float textures);
 * this is that placement in JS, read from the same textures and uniforms, so each strand lands where the screen shows
 * it: roots following the skin, brows following the face's shape, lashes turning with the lids.
 *
 * Two ways to export, to compare (lib/export/model.ts `strands`):
 *   "guides"    the strands in the file, one ribbon each, as wide as the portrait draws a strand
 *   "children"  plus the extra strands the GPU adds round each one (the shader's hash, clump and wobble, ported)
 *
 * A ribbon is flat (the screen's face the camera; a file can't): it lies across the strand, along the head's surface.
 * Colour per point as the strand shader's albedo (root → tip ramp, per-strand variation) × its baked self-shadow,
 * stored as vertex colours. 16-bit positions (KHR_mesh_quantization) and colours, 16-bit indices per piece of ≤ 65 535
 * vertices: ~18 bytes per vertex instead of ~40.
 */
import {
  BufferAttribute,
  BufferGeometry,
  Color,
  type DataTexture,
  DoubleSide,
  type Matrix4,
  Mesh,
  MeshPhysicalMaterial,
  type ShaderMaterial,
  Vector3,
} from "three";

import { GROOM, type GroomDef } from "@/lib/groom";

import { PORTRAIT } from "./portrait";

export type StrandMode = "guides" | "children";

/**
 * Tweak freely: the ribbons' surface. A flat ribbon reflects the room like a card (4% at full specular), which on dark
 * hair outweighs the colour and reads grey; the app's own strand highlights are faint (GROOM.spec1/spec2).
 */
export const STRANDS = { roughness: 0.7, specular: 0.15 };

const DEG = Math.PI / 180;
const MAX_VERTS = 65535;

/** A ribbon is at least as wide as the portrait draws a strand (GROOM.minPx at the portrait camera, metres). */
const minWidth = () => (GROOM.minPx * PORTRAIT.dist * 2 * Math.tan((PORTRAIT.fov / 2) * DEG)) / PORTRAIT.size;

const hash = (n: number) => {
  const x = Math.sin(n) * 43758.5453123;
  return x - Math.floor(x);
};

const data = (t: { value: DataTexture | null }) => (t.value?.image.data ?? null) as Float32Array | null;

/** One groom mesh (lib/groom.ts) → ribbon meshes in `m`'s space, named `name_0`, `name_1`, …. */
export function strandMeshes(groom: Mesh, m: Matrix4, mode: StrandMode, name: string): Mesh[] {
  const u = (groom.material as ShaderMaterial).uniforms;
  const def = groom.userData.groomDef as GroomDef;
  const pos = data(u.uPos)!;
  const root = data(u.uRoot)!;
  const shapePts = u.uShapeFollow.value > 0.5 ? data(u.uShapePts) : null;
  const lid = data(u.uLid);
  const lidW = u.uLidW.value as number[];
  const eyeFollow = u.uEyeFollow.value as number;
  const [eyeL, eyeR, eyeL0, eyeR0] = [u.uEyeL.value, u.uEyeR.value, u.uEyeL0.value, u.uEyeR0.value] as Vector3[];
  const centre = u.uCentre.value as Vector3;
  const n = u.uStrands.value as number;
  const p = u.uPoints.value as number;
  const childR = u.uChildR.value as number;
  const rampLen = u.uRampLen.value as number;

  // as the tiers do (groom.ts tierCount): fewer strands, each wider, so the hair covers the same
  const most = Math.max(...def.children);
  const children = mode === "children" ? most : 0;
  const width = (def.widthMm / 1000) * Math.sqrt((1 + most) / (1 + children));
  const minW = minWidth();

  // colours: raw sRGB uniforms → linear (glTF vertex colours are linear)
  const rootC = new Color().copy(u.uHairShadow.value).convertSRGBToLinear();
  const tipC = new Color().copy(u.uHairHighlight.value).convertSRGBToLinear();
  const jitter = u.uJitter.value as number, shadowFloor = u.uShadowFloor.value as number, rampAmount = u.uRampAmount.value as number;

  const out: Mesh[] = [];
  const material = new MeshPhysicalMaterial({ name, vertexColors: true, roughness: STRANDS.roughness, specularIntensity: STRANDS.specular, metalness: 0, side: DoubleSide });
  let chunk = newChunk(MAX_VERTS);

  // per strand, its points as the shader places them
  const P = new Float32Array(p * 3); // head space, after the root offset and the brow / lash follow
  const raw0 = new Vector3();
  const v = new Vector3(), a = new Vector3(), b = new Vector3(), T = new Vector3(), ref = new Vector3(), n1 = new Vector3(), n2 = new Vector3(), side = new Vector3();
  const up = new Vector3(0, 1, 0);
  const point = (s: number, k: number, out: Vector3) => {
    const i = s * p + k;
    out.set(pos[i * 4], pos[i * 4 + 1], pos[i * 4 + 2]);
    if (shapePts) out.set(out.x + shapePts[i * 4], out.y + shapePts[i * 4 + 1], out.z + shapePts[i * 4 + 2]);
    return out;
  };

  for (let s = 0; s < n; s++) {
    const off = new Vector3(root[s * 4], root[s * 4 + 1], root[s * 4 + 2]);
    raw0.set(pos[s * p * 4], pos[s * p * 4 + 1], pos[s * p * 4 + 2]);
    // lashes: turn round the eye's horizontal axis as the lid closes (groom.ts VERTEX, uEyeFollow)
    let cs = 1, sn = 0;
    if (eyeFollow > 0.5) {
      const c = raw0.x > 0 ? eyeL : eyeR;
      const c0 = raw0.x > 0 ? eyeL0 : eyeR0;
      let da = eyeFollow * (Math.atan2(raw0.y + off.y - c.y, raw0.z + off.z - c.z) - Math.atan2(raw0.y - c0.y, raw0.z - c0.z));
      da += root[s * 4 + 3];
      if (lid) for (let t = 0; t < 16; t++) da += lid[s * 16 + t] * lidW[t];
      cs = Math.cos(da);
      sn = Math.sin(da);
    }
    for (let k = 0; k < p; k++) {
      point(s, k, v);
      if (eyeFollow > 0.5) {
        const x = v.x - raw0.x, y = v.y - raw0.y, z = v.z - raw0.z;
        v.set(raw0.x + x, raw0.y + z * sn + y * cs, raw0.z + z * cs - y * sn);
      }
      P[k * 3] = v.x;
      P[k * 3 + 1] = v.y;
      P[k * 3 + 2] = v.z;
    }

    for (let c = 0; c <= children; c++) {
      if (chunk.count + p * 2 > MAX_VERTS) {
        out.push(finish(chunk, material, `${name}_${out.length}`));
        chunk = newChunk(MAX_VERTS);
      }
      const id = s * 7.13 + c * 131.71;
      const shadeJitter = 1 + (hash(id + 11) - 0.5) * jitter;
      const base = chunk.count;
      for (let k = 0; k < p; k++) {
        a.fromArray(P, Math.max(k - 1, 0) * 3);
        b.fromArray(P, Math.min(k + 1, p - 1) * 3);
        T.subVectors(b, a).addScalar(1e-7).normalize();
        const t = k / (p - 1);
        v.fromArray(P, k * 3).add(off);
        ref.fromArray(P, k * 3).sub(centre).normalize();
        if (c > 0) {
          // a child strand: round its parent, closer towards the tip (clumping), with its own slow wobble
          n1.crossVectors(T, ref).normalize();
          n2.crossVectors(n1, T);
          const th = hash(id) * Math.PI * 2;
          const r = childR * Math.sqrt(hash(id + 3.1)) * (1 - 0.7 * t);
          v.addScaledVector(n1, Math.cos(th) * r).addScaledVector(n2, Math.abs(Math.sin(th)) * r * 0.5);
          const far = Math.min(1, Math.max(0, Math.hypot(P[k * 3] - raw0.x, P[k * 3 + 1] - raw0.y, P[k * 3 + 2] - raw0.z) / 0.12));
          v.addScaledVector(n1, Math.sin(t * (5 + 6 * hash(id + 5.3)) + hash(id + 7.7) * Math.PI * 2) * childR * 0.3 * far * far);
        }
        // the ribbon lies across the strand, along the head (a strand pointing out from the head: across it, level)
        side.crossVectors(T, ref);
        if (side.lengthSq() < 0.09) side.crossVectors(T, up);
        side.normalize().multiplyScalar(0.5 * Math.max(width * (1 + (def.tipWidth - 1) * t), minW));
        // colour: the strand shader's albedo × its baked self-shadow (groom.ts FRAGMENT)
        const i = s * p + k;
        const ramp = Math.min(1, Math.hypot(pos[i * 4] - raw0.x, pos[i * 4 + 1] - raw0.y, pos[i * 4 + 2] - raw0.z) / rampLen);
        const mix = Math.pow(ramp, 0.8) * rampAmount;
        const shade = (shadowFloor + (1 - shadowFloor) * pos[i * 4 + 3]) * shadeJitter;
        const rgb = [rootC.r + (tipC.r - rootC.r) * mix, rootC.g + (tipC.g - rootC.g) * mix, rootC.b + (tipC.b - rootC.b) * mix].map((x) => x * shade);
        for (const sign of [-1, 1]) {
          const at = chunk.count++;
          chunk.pos[at * 3] = v.x + side.x * sign;
          chunk.pos[at * 3 + 1] = v.y + side.y * sign;
          chunk.pos[at * 3 + 2] = v.z + side.z * sign;
          for (let j = 0; j < 3; j++) chunk.col[at * 3 + j] = rgb[j];
        }
        if (k < p - 1) {
          const q = base + k * 2;
          chunk.index.push(q, q + 1, q + 2, q + 1, q + 3, q + 2);
        }
      }
    }
  }
  if (chunk.count) out.push(finish(chunk, material, `${name}_${out.length}`));
  for (const mesh of out) mesh.applyMatrix4(m);
  return out;
}

type Chunk = { pos: Float32Array; col: Float32Array; index: number[]; count: number };
const newChunk = (max: number): Chunk => ({ pos: new Float32Array(max * 3), col: new Float32Array(max * 3), index: [], count: 0 });

/** Quantise a chunk: positions to 16 bits round its own centre (the mesh's position and scale undo it), colours too. */
function finish(c: Chunk, material: MeshPhysicalMaterial, name: string): Mesh {
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < c.count * 3; i++) {
    lo[i % 3] = Math.min(lo[i % 3], c.pos[i]);
    hi[i % 3] = Math.max(hi[i % 3], c.pos[i]);
  }
  const mid = lo.map((l, j) => (l + hi[j]) / 2);
  const half = Math.max(1e-6, ...hi.map((h, j) => (h - lo[j]) / 2));
  const qpos = new Int16Array(c.count * 3);
  for (let i = 0; i < c.count * 3; i++) qpos[i] = Math.round(((c.pos[i] - mid[i % 3]) / half) * 32767);
  const qcol = new Uint16Array(c.count * 3);
  for (let i = 0; i < c.count * 3; i++) qcol[i] = Math.round(Math.min(1, Math.max(0, c.col[i])) * 65535);
  const geometry = new BufferGeometry();
  geometry.setAttribute("position", new BufferAttribute(qpos, 3, true));
  geometry.setAttribute("color", new BufferAttribute(qcol, 3, true));
  geometry.setIndex(new BufferAttribute(new Uint16Array(c.index), 1));
  const mesh = new Mesh(geometry, material);
  mesh.name = name;
  mesh.position.set(mid[0], mid[1], mid[2]);
  mesh.scale.setScalar(half);
  mesh.updateMatrix();
  return mesh;
}
