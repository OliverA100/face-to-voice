/**
 * Strand hair: every hair style (HairCS, Bystedt's grooms, our own from pipeline/src/ftv_pipeline/groom.py) and the
 * strand brows, lashes and beards (lib/addons.ts). Real strands, not textured cards.
 *
 * The file (<id>.strands.bin, gzip) holds a few thousand strands, `points` each. They go into a float texture; one
 * instanced ribbon is drawn per strand, and the GPU adds `children` thinner strands around every shipped one
 * (more on fast devices, lib/quality.ts), so 6k strands become 12–30k on screen at no download cost. Each ribbon is
 * built in the vertex shader: it faces the camera, is at least ~1 px wide, and fades by how much of that pixel the
 * strand really covers, with alpha-to-coverage (MSAA) instead of sorting.
 *
 * Shading (fragment shader, lib/groomShader.ts): Kajiya-Kay hair lighting from the scene's directional lights: a soft
 * diffuse across the strand, a white primary highlight shifted towards the root and a broader secondary one tinted by
 * the hair colour, plus a sky/ground ambient. A self-shadow baked per point (how much hair lies between it and the
 * light) gives the dark, soft core real hair has. Colour runs from the root (the swatch's shadow) to the tip
 * (highlight) with a little per-strand variation.
 *
 * Following the face (lib/groomFollow.ts): every root is tied to its three nearest skin vertices; every frame the
 * skin's live morph offsets there (lib/skinSurface.ts) are written to a small texture that moves each whole strand, so
 * the hair follows the sliders, blinks, speech and expressions.
 *
 * Tweak the look in GROOM.
 */
import {
  AddEquation,
  BufferAttribute,
  type Color,
  CustomBlending,
  DataTexture,
  DoubleSide,
  FloatType,
  Group,
  InstancedBufferGeometry,
  Mesh,
  NearestFilter,
  type Object3D,
  OneFactor,
  OneMinusSrcAlphaFactor,
  type PerspectiveCamera,
  RGBAFormat,
  ShaderMaterial,
  SrcAlphaFactor,
  UniformsLib,
  UniformsUtils,
  Vector2,
  Vector3,
  type WebGLRenderer,
  ZeroFactor,
} from "three";

import { manifest } from "@/lib/data";
import { eyeUniforms } from "@/lib/eyeShader";
import { morphs } from "@/lib/morphs/store";
import type { StrandColours } from "@/lib/hair";
import { onTier, quality } from "@/lib/quality";
import { skinUniforms } from "@/lib/skinShader";
import { skinShape, skinSurface } from "@/lib/skinSurface";
import { installStrandMorph } from "@/lib/morphShader";
import { cellKey, type StyleTies, type TieWanted } from "@/lib/skinTie";
import { decodeStrandsHere, type Strands } from "@/lib/strandsDecode";
import type { FromStrandsWorker, ToStrandsWorker } from "@/lib/strandsWorker";
import { followShapePoints, followSkin } from "@/lib/groomFollow";
import { FRAGMENT, VERTEX } from "@/lib/groomShader";

export const GROOM = {
  minPx: 0.8, // a strand is drawn at least this wide (pixels); its coverage fades the rest …
  coverMin: 1.0, // … but never below this: a few thousand strands stand for ~100k real ones, each must count (MSAA smooths the edges)
  jitter: 0.32, // per-strand brightness variation (±half of this; it also breaks up an even sheen)
  ambientSky: [0.3, 0.3, 0.32] as [number, number, number], // linear, × the hair colour
  ambientGround: [0.1, 0.09, 0.08] as [number, number, number],
  diffuse: 0.6,
  // Kajiya-Kay highlights are wide (any strand at right angles to the half vector lights up): keep them weak and sharp.
  // 0.12 / 0.18 read as white plastic streaks, 0.06 / 0.09 still glossy, 0.015 / 0.03 flat and dry.
  spec1: 0.03, // primary highlight (white)
  spec2: 0.05, // secondary highlight (tinted)
  shift1: 0.12, // highlight shifts along the strand (cuticle tilt)
  shift2: -0.1,
  exp1: 140,
  exp2: 30,
  shadowFloor: 0.22, // the darkest a fully buried strand gets
  tipFade: 0.25, // how much the last 15% of a strand fades out (0.6 lets the light backdrop through: silvery ends)
  tipSpec: 0.3, // the white highlight at the tips, relative to the roots (frayed ends scatter instead of shining)
  rampAmount: 0.55, // how far towards the tip colour the ends go (1 = all the way: pale, washed-out ends)
  scalpFullLength: 0.03, // metres: hair this long or longer fully tints the scalp under it (lib/skinShader.ts)
  rampLength: 0.4, // metres from the root at which a strand reaches the tip colour (0.18 gives long hair an ombré look)
  centre: [0, 0.29, 0.01] as [number, number, number], // head centre (child strands spread around their parent)
  shapeTurnMax: 45, // degrees: the most a face's shape turns a lash away from the skin it hovers over (followSkin)
  shapeTurnMinMm: 0.5, // … and none for a lash whose tip hovers this close to its root's skin (its direction is noise)
  lashTurn: 2.0, // lashes turn this many times the angle the lid edge travels round the eyeball (closed lid → lashes down)
};

/**
 * Per kind of groom, what differs from GROOM: hair and beards have darker buried strands (shadowFloor), more
 * strand-to-strand variation (jitter, brows too) and less flat diffuse light, so the sheen and shade carry the shape;
 * a beard's extra strands spread wider round their parent (childSpread × its childRadiusMm), filling gaps between clumps.
 */
const GROOM_KIND = {
  head: { childSpread: 1.0, shade: { shadowFloor: 0.1, jitter: 0.55, diffuse: 0.45 } },
  beard: { childSpread: 1.8, shade: { shadowFloor: 0.12, jitter: 0.5, diffuse: 0.5 } },
  brows: { childSpread: 1.0, shade: { jitter: 0.45 } },
  lashes: { childSpread: 1.0, shade: {} },
} satisfies Record<string, { childSpread: number; shade: Partial<Pick<typeof GROOM, "shadowFloor" | "jitter" | "diffuse">> }>;

export type GroomDef = {
  count: number;
  points: number;
  children: [number, number, number];
  childRadiusMm: number;
  widthMm: number;
  tipWidth: number;
  coverMin?: number; // opacity floor per strand (GROOM.coverMin when absent)
  rampMm?: number; // root → tip colour over this length (GROOM.rampLength when absent; short brow hairs set their own)
  darken?: number; // how far the hair swatch is taken toward the category's dark (ADDONS.darken), for this style
  /** Lashes: per lash, the extra turn (pipeline lash_strands.LidFix) that keeps it clear of a lid folded by these
   *  morph targets ([target, sign]), from `file` (int8, 0.5° units, lash-major); the app adds Σ turn × weight. */
  lidFix?: { file: string; targets: [string, number][] };
  shine?: number; // highlight strength × (1 when absent)
  eyeFollow?: boolean; // lashes: turn with the lid round the eyeball as it closes, not only move with it
  root: string;
  tip: string;
};

const TEX_W = 1024;

let strandsWorker: Worker | null | undefined; // undefined: not tried yet, null: none (decode here)
let strandsJob = 0;
const strandsWaiting = new Map<number, (r: FromStrandsWorker) => void>();

/** The skin the strands worker was last sent (it keeps one), so its rest positions go over once per registration. */
let skinSent: { rest: Float32Array; m: string; key: number } | null = null;
let skinKeys = 0;

/**
 * Decode a .strands.bin (gzip): positions (N·P·3, metres, head space) and per-point shade (0..1). In a worker where there
 * is one (lib/strandsWorker.ts: the same code, lib/strandsDecode.ts, off a slow phone's main thread: ~60–80 ms per hair
 * style), otherwise here. The worker also ties the style to the skin (`wanted`, lib/skinTie.ts) when the head is in:
 * `ties`, for the skin `skinRest`, which groom.ts uses only while that is still the skin.
 */
async function decodeStrands(gz: ArrayBuffer, wanted?: TieWanted): Promise<Strands & { ties?: StyleTies; skinRest?: Float32Array }> {
  if (strandsWorker === undefined) {
    strandsWorker = null;
    try {
      if (typeof Worker !== "undefined") {
        const w = new Worker(new URL("./strandsWorker.ts", import.meta.url), { type: "module" });
        w.onmessage = (e: MessageEvent<FromStrandsWorker>) => {
          strandsWaiting.get(e.data.id)?.(e.data);
          strandsWaiting.delete(e.data.id);
        };
        w.onerror = () => {
          strandsWorker = null; // decode here from now on (the waiting ones too)
          for (const [id, done] of strandsWaiting) done({ id, error: "worker failed" });
          strandsWaiting.clear();
        };
        strandsWorker = w;
      }
    } catch {
      strandsWorker = null;
    }
  }
  const worker = strandsWorker;
  if (!worker) return decodeStrandsHere(gz);
  const id = ++strandsJob;
  let tie: ToStrandsWorker["tie"];
  const shape = skinShape();
  if (wanted && shape) {
    const m = skinSurface.toHead.elements, mKey = m.join();
    const fresh = skinSent?.rest !== shape.rest || skinSent.m !== mKey;
    if (fresh) skinSent = { rest: shape.rest, m: mKey, key: ++skinKeys };
    tie = { skin: { key: skinSent!.key, rest: fresh ? shape.rest.slice() : undefined, m: [...m] }, wanted };
  }
  const sent = skinSent;
  const r = await new Promise<FromStrandsWorker>((resolve) => {
    strandsWaiting.set(id, resolve);
    worker.postMessage({ id, gz, tie } satisfies ToStrandsWorker); // copied, not transferred: the caller keeps its bytes
  });
  if ("error" in r) return decodeStrandsHere(gz);
  return { ...r, skinRest: r.ties && sent && sent.key === r.skinKey ? sent.rest : undefined };
}

function floatTexture(texels: number): { tex: DataTexture; data: Float32Array } {
  const h = Math.max(1, Math.ceil(texels / TEX_W));
  const data = new Float32Array(TEX_W * h * 4);
  const tex = new DataTexture(data, TEX_W, h, RGBAFormat, FloatType);
  tex.minFilter = tex.magFilter = NearestFilter;
  tex.needsUpdate = true;
  return { tex, data };
}


/** Index of the tier in [low, medium, high]. */
const tierIndex = () => (quality.tier === "low" ? 0 : quality.tier === "medium" ? 1 : 2);

/** Children per strand on the current tier and the width that keeps the hair's coverage the same. */
function tierCount(def: GroomDef): { children: number; widthScale: number } {
  const children = def.children[tierIndex()] ?? def.children[1];
  const most = Math.max(...def.children);
  return { children, widthScale: Math.sqrt((1 + most) / (1 + children)) };
}

/**
 * Build the strand mesh for a style, inside a Group named "hair". The roots follow the skin every frame. `scalp`: tint
 * the skin under the roots (hair only); `fine` (brows, lashes) and `soft` (lashes): how sub-pixel hairs blend (below);
 * `lidFix`: the lashes' baked lid turns (GroomDef.lidFix); `shapeFollow` (brows): every point follows the face's shape.
 */
export async function buildGroom(
  def: GroomDef,
  gz: ArrayBuffer,
  colours: StrandColours,
  opts: { scalp?: boolean; fine?: boolean; soft?: boolean; lidFix?: Int8Array; shapeFollow?: boolean } = {},
): Promise<Group> {
  const { scalp: tintScalp = true, fine = false, soft = false, lidFix, shapeFollow = false } = opts;
  const kind = GROOM_KIND[tintScalp ? "head" : soft ? "lashes" : shapeFollow || fine ? "brows" : "beard"];
  const G = { ...GROOM, ...kind.shade };
  const { n, p, positions, shade, ties, skinRest } = await decodeStrands(gz, { tips: !!def.eyeFollow, points: shapeFollow });
  // tied by the worker for the skin shown now: used (the same ties groom.ts would make here); otherwise tied here, later
  const made = ties && skinRest && skinRest === skinShape()?.rest ? ties : undefined;
  const pos = floatTexture(n * p);
  for (let i = 0; i < n * p; i++) {
    pos.data[i * 4] = positions[i * 3];
    pos.data[i * 4 + 1] = positions[i * 3 + 1];
    pos.data[i * 4 + 2] = positions[i * 3 + 2];
    pos.data[i * 4 + 3] = shade[i];
  }
  const root = floatTexture(n);

  // One ribbon: 2 vertices per point, (P - 1) quads; instances = strands × (1 + children).
  const geometry = new InstancedBufferGeometry();
  const vert = new Float32Array(p * 2 * 2);
  for (let k = 0; k < p; k++) {
    vert.set([k, -1, k, 1], k * 4);
  }
  const index: number[] = [];
  for (let k = 0; k < p - 1; k++) {
    const a = k * 2;
    index.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
  }
  geometry.setAttribute("aVert", new BufferAttribute(vert, 2));
  geometry.setIndex(index);
  // three needs a position attribute to count vertices; the shader ignores it
  geometry.setAttribute("position", new BufferAttribute(new Float32Array(p * 2 * 3), 3));

  const material = new ShaderMaterial({
    vertexShader: VERTEX,
    fragmentShader: FRAGMENT,
    lights: true,
    side: DoubleSide,
    // `soft` (lashes): real blending instead of alpha-to-coverage, whose on/off samples show as a screen-door dither
    // on hairs this faint and packed; lashes are thin and dark, so drawing them unsorted over each other is fine.
    alphaToCoverage: !soft,
    ...(soft ? { transparent: true, depthWrite: false } : {}),
    // `fine` (brows, lashes): hairs finer than a pixel draw on some of its samples (coverMin < 1) and must not write their
    // coverage into the frame's alpha, or the faded hairs read pale (the frame composites over the light backdrop).
    // Colour replaces, alpha keeps the skin's.
    ...(soft
      ? { blending: CustomBlending, blendEquation: AddEquation, blendSrc: SrcAlphaFactor, blendDst: OneMinusSrcAlphaFactor, blendSrcAlpha: ZeroFactor, blendDstAlpha: OneFactor }
      : fine
        ? { blending: CustomBlending, blendEquation: AddEquation, blendSrc: OneFactor, blendDst: ZeroFactor, blendSrcAlpha: ZeroFactor, blendDstAlpha: OneFactor }
        : {}),
    uniforms: UniformsUtils.merge([
      UniformsLib.lights,
      {
        uPos: { value: null },
        uRoot: { value: null },
        uTexW: { value: TEX_W },
        uStrands: { value: n },
        uPoints: { value: p },
        uChildR: { value: (def.childRadiusMm / 1000) * kind.childSpread },
        uWidth: { value: def.widthMm / 1000 },
        uTipW: { value: def.tipWidth },
        uMinPx: { value: GROOM.minPx },
        uPxScale: { value: 0.001 },
        uCoverMin: { value: def.coverMin ?? GROOM.coverMin },
        uRampLen: { value: def.rampMm ? def.rampMm / 1000 : GROOM.rampLength },
        uCentre: { value: new Vector3(...GROOM.centre) },
        uEyeFollow: { value: def.eyeFollow ? GROOM.lashTurn : 0 },
        uLid: { value: null },
        uShapePts: { value: null },
        uShapeFollow: { value: 0 },
        uLidW: { value: new Array(16).fill(0) },
        uEyeL: { value: null },
        uEyeR: { value: null },
        uEyeL0: { value: new Vector3().fromArray(manifest.nodes.left_eye.pivot) },
        uEyeR0: { value: new Vector3().fromArray(manifest.nodes.right_eye.pivot) },
        uSky: { value: new Vector3(...GROOM.ambientSky) },
        uGround: { value: new Vector3(...GROOM.ambientGround) },
        uUpView: { value: new Vector3(0, 1, 0) },
        uDiffuse: { value: G.diffuse },
        uSpec1: { value: GROOM.spec1 * (def.shine ?? 1) },
        uSpec2: { value: GROOM.spec2 * (def.shine ?? 1) },
        uShift1: { value: GROOM.shift1 },
        uShift2: { value: GROOM.shift2 },
        uExp1: { value: GROOM.exp1 },
        uExp2: { value: GROOM.exp2 },
        uJitter: { value: G.jitter },
        uShadowFloor: { value: G.shadowFloor },
        uTipFade: { value: GROOM.tipFade },
        uTipSpec: { value: GROOM.tipSpec },
        uRampAmount: { value: GROOM.rampAmount },
      },
    ]),
  });
  // Textures and the shared colour uniforms go in after the merge (it would clone them).
  material.uniforms.uPos.value = pos.tex;
  material.uniforms.uRoot.value = root.tex;
  // lid fix: four texels per lash (16 turns: left/right lid components in pairs + emotions), zero when the style has none
  const LID_MAX = 16;
  const lid = floatTexture(Math.max(1, n * 4));
  const lidTargets = def.lidFix && lidFix ? def.lidFix.targets.slice(0, LID_MAX) : [];
  if (lidFix) {
    const k = def.lidFix?.targets.length ?? 0;
    for (let s = 0; s < n; s++) for (let t = 0; t < Math.min(k, LID_MAX); t++) lid.data[s * LID_MAX + t] = (lidFix[s * k + t] * 0.5 * Math.PI) / 180;
  }
  material.uniforms.uLid.value = lid.tex;
  // brows: every point follows the face's shape (followShapePoints)
  const shapePts = shapeFollow ? floatTexture(n * p) : floatTexture(1);
  const shapeFollowUpdate = shapeFollow ? followShapePoints(positions, p, shapePts, made?.points) : null;
  material.uniforms.uShapePts.value = shapePts.tex;
  material.uniforms.uShapeFollow.value = shapeFollow ? 1 : 0;
  material.uniforms.uEyeL = eyeUniforms.uEyeL; // shared: Head.tsx moves them every frame
  material.uniforms.uEyeR = eyeUniforms.uEyeR;
  material.uniforms.uHairShadow = colours.uniforms.uHairShadow;
  material.uniforms.uHairHighlight = colours.uniforms.uHairHighlight;
  material.name = "groom";
  installStrandMorph(material, "vec4 mv = modelViewMatrix * vec4(pos, 1.0);"); // grows out of the loader's bubble (lib/morphShader.ts)

  const mesh = new Mesh(geometry, material);
  mesh.name = "groom";
  mesh.frustumCulled = false; // the shader places every vertex
  mesh.userData.groom = true;
  mesh.userData.groomDef = def; // the 3D model export rebuilds the strands from it (lib/export/strands.ts)

  const applyTier = () => {
    const { children, widthScale } = tierCount(def);
    geometry.instanceCount = n * (1 + children);
    material.uniforms.uWidth.value = (def.widthMm / 1000) * widthScale;
  };
  applyTier();

  // Per frame: pixel size at unit distance (for the ≥ 1 px rule) and "up" in view space (ambient).
  const size = new Vector2();
  const up = new Vector3();
  mesh.onBeforeRender = (renderer: WebGLRenderer, _scene, camera) => {
    follow();
    shapeFollowUpdate?.();
    // the lid-folding targets' weights now (a target driven the other way does not count)
    const w = material.uniforms.uLidW.value as number[];
    for (let t = 0; t < lidTargets.length; t++) w[t] = Math.max(0, lidTargets[t][1] * morphs.effective(lidTargets[t][0]));
    renderer.getDrawingBufferSize(size);
    const cam = camera as PerspectiveCamera;
    material.uniforms.uPxScale.value = (2 * Math.tan(((cam.fov ?? 24) * Math.PI) / 360)) / Math.max(1, size.y);
    material.uniforms.uUpView.value.copy(up.set(0, 1, 0).transformDirection(cam.matrixWorldInverse));
  };

  // Roots follow the skin.
  const roots = new Float32Array(n * 3);
  const reach = new Float32Array(n); // root → tip distance (m): very short hair barely hides the scalp
  for (let s = 0; s < n; s++) {
    roots.set(positions.subarray(s * p * 3, s * p * 3 + 3), s * 3);
    const t = (s * p + p - 1) * 3;
    reach[s] = Math.hypot(positions[t] - roots[s * 3], positions[t + 1] - roots[s * 3 + 1], positions[t + 2] - roots[s * 3 + 2]);
  }
  let tips: Float32Array | undefined;
  if (def.eyeFollow) {
    tips = new Float32Array(n * 3);
    for (let s = 0; s < n; s++) tips.set(positions.subarray((s * p + p - 1) * 3, (s * p + p) * 3), s * 3);
  }
  const follow = followSkin(roots, root, GROOM, tips, made);
  const offTier = onTier(() => applyTier());

  const group = new Group();
  group.name = "hair";
  group.add(mesh);
  // While this groom is on the head, the scalp under it takes the hair's root colour (lib/skinShader.ts).
  if (tintScalp) scalpTint(group, roots, reach, colours.uniforms.uHairShadow.value);
  group.userData.dispose = () => {
    lid.tex.dispose();
    shapePts.tex.dispose();
    offTier();
    pos.tex.dispose();
    root.tex.dispose();
  };
  group.userData.colours = colours;
  return group;
}

// --- the scalp under the hair -------------------------------------------------------------------

/**
 * Per skin vertex 0..1: how densely hair roots grow within `radius` (head space), soft-edged; hair shorter than
 * GROOM.scalpFullLength counts less (`reach`: root → tip distance per root, optional). Null before the head loads.
 */
function coverFromRoots(roots: Float32Array, reach: Float32Array | null, radius = 0.007, full = 14): Float32Array | null {
  const shape = skinShape();
  if (!shape) return null;
  const rest = shape.rest;
  const pos = new Float32Array(rest.length);
  const v = new Vector3();
  for (let i = 0; i < rest.length / 3; i++) v.fromArray(rest, i * 3).applyMatrix4(skinSurface.toHead).toArray(pos, i * 3);
  const n = roots.length / 3;
  const cell = radius;
  const grid = new Map<number, number[]>();
  const key = (x: number, y: number, z: number) => cellKey(Math.floor(x / cell), Math.floor(y / cell), Math.floor(z / cell));
  for (let s = 0; s < n; s++) {
    const k = key(roots[s * 3], roots[s * 3 + 1], roots[s * 3 + 2]);
    let b = grid.get(k);
    if (!b) grid.set(k, (b = []));
    b.push(s);
  }
  const out = new Float32Array(pos.length / 3);
  const r2 = radius * radius;
  for (let i = 0; i < out.length; i++) {
    const x = pos[i * 3], y = pos[i * 3 + 1], z = pos[i * 3 + 2];
    const cx = Math.floor(x / cell), cy = Math.floor(y / cell), cz = Math.floor(z / cell);
    let c = 0;
    for (let a = cx - 1; a <= cx + 1; a++)
      for (let b2 = cy - 1; b2 <= cy + 1; b2++)
        for (let d = cz - 1; d <= cz + 1; d++) {
          const b = grid.get(cellKey(a, b2, d));
          if (!b) continue;
          for (const s of b) {
            const dx = roots[s * 3] - x, dy = roots[s * 3 + 1] - y, dz = roots[s * 3 + 2] - z;
            const d2 = dx * dx + dy * dy + dz * dz;
            // soft edge (closer roots count more), and hair under GROOM.scalpFullLength counts less (stubble hides little)
            if (d2 < r2) c += (1 - d2 / r2) * (reach ? Math.min(1, reach[s] / GROOM.scalpFullLength) : 1);
          }
        }
    const t = Math.min(1, c / full);
    out[i] = t * t * (3 - 2 * t);
  }
  return out;
}

/** While `group` is on the head, tint the scalp under `roots` towards the hair's root colour (lib/skinShader.ts). */
function scalpTint(group: Object3D, roots: Float32Array, reach: Float32Array | null, rootColour: Color): void {
  let cover: Float32Array | null = null;
  const set = (on: boolean) => {
    const attr = skinSurface.mesh?.geometry.getAttribute("aHairCover") as BufferAttribute | undefined;
    if (!attr) return;
    if (on) {
      cover ??= coverFromRoots(roots, reach);
      if (!cover) return;
      (attr.array as Float32Array).set(cover);
      skinUniforms.uScalpColour.value = rootColour; // by reference: recolours follow
    } else if (skinUniforms.uScalpColour.value === rootColour) {
      (attr.array as Float32Array).fill(0);
    } else return;
    attr.needsUpdate = true;
  };
  group.addEventListener("added", () => set(true));
  group.addEventListener("removed", () => set(false));
  group.userData.skinOff = () => set(false); // a cross-fade takes the tint off the "after" image at once (lib/pieceFade.ts)
}
