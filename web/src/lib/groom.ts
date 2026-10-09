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
 * Shading (fragment shader): Kajiya-Kay hair lighting from the scene's directional lights: a soft diffuse across
 * the strand, a white primary highlight shifted towards the root and a broader secondary one tinted by the hair
 * colour, plus a sky/ground ambient. A self-shadow baked per point (how much hair lies between it and the light)
 * gives the dark, soft core real hair has. Colour runs from the root (the swatch's shadow) to the tip (highlight)
 * with a little per-strand variation.
 *
 * Following the face: every root is tied to its three nearest skin vertices; every frame the skin's live morph
 * offsets there (lib/skinSurface.ts) are written to a small texture that moves each whole strand, so the hair follows
 * the sliders, blinks, speech and expressions.
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
  Matrix3,
  type Matrix4,
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

import { manifest, sliders } from "@/lib/data";
import { eyeUniforms } from "@/lib/eyeShader";
import { morphs } from "@/lib/morphs/store";
import type { StrandColours } from "@/lib/hair";
import { onTier, quality } from "@/lib/quality";
import { skinUniforms } from "@/lib/skinShader";
import { skinOffsets, skinShape, skinSurface } from "@/lib/skinSurface";
import { installStrandMorph } from "@/lib/morphShader";
import { cellKey, skinGrid, type SkinGrid, type StyleTies, type Tie, tiePoints, type TieWanted } from "@/lib/skinTie";
import { decodeStrandsHere, type Strands } from "@/lib/strandsDecode";
import type { FromStrandsWorker, ToStrandsWorker } from "@/lib/strandsWorker";

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
export async function decodeStrands(gz: ArrayBuffer, wanted?: TieWanted): Promise<Strands & { ties?: StyleTies; skinRest?: Float32Array }> {
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

const VERTEX = /* glsl */ `
uniform highp sampler2D uPos;
uniform highp sampler2D uRoot;
uniform int uTexW;
uniform int uStrands;
uniform int uPoints;
uniform float uChildR;
uniform float uWidth;
uniform float uTipW;
uniform float uMinPx;
uniform float uPxScale;
uniform float uCoverMin;
uniform vec3 uCentre;
uniform float uEyeFollow;
uniform vec3 uEyeL; // the eye centres now (they move with the face's shape) …
uniform vec3 uEyeR;
uniform vec3 uEyeL0; // … and on the average face
uniform vec3 uEyeR0;
uniform highp sampler2D uShapePts; // brows: per point, the face shape's offset there minus at the hair's root …
uniform float uShapeFollow; // … on (1) or off (0) (lib/groom.ts followShapePoints)
uniform highp sampler2D uLid; // per lash: the extra turn (radians at full weight) for each of 16 lid-folding targets …
uniform float uLidW[16]; // … and those targets' current weights (lib/groom.ts lidFix)
attribute vec2 aVert; // x: point index along the strand, y: ribbon side (-1 / 1)
varying float vT;
varying float vRamp;
varying float vLong;
varying float vShade;
varying float vCover;
varying float vRand;
varying vec3 vTan;
varying vec3 vViewPos;
uniform float uRampLen;

vec4 fetchP(int s, int k) {
  int i = s * uPoints + k;
  return texelFetch(uPos, ivec2(i % uTexW, i / uTexW), 0);
}
float hash(float n) { return fract(sin(n) * 43758.5453123); }

void main() {
  int s = gl_InstanceID % uStrands;
  int c = gl_InstanceID / uStrands;
  int k = int(aVert.x);
  vec4 P = fetchP(s, k);
  vec3 a = fetchP(s, max(k - 1, 0)).xyz;
  vec3 b = fetchP(s, min(k + 1, uPoints - 1)).xyz;
  vec4 rootT = texelFetch(uRoot, ivec2(s % uTexW, s / uTexW), 0); // xyz: the root's offset; w: lashes' shape turn
  vec3 off = rootT.xyz;
  if (uShapeFollow > 0.5) {
    // a brow hair keeps its distance from its own skin when the face's shape bends the skin under it
    int i0 = s * uPoints + k, ia = s * uPoints + max(k - 1, 0), ib = s * uPoints + min(k + 1, uPoints - 1);
    P.xyz += texelFetch(uShapePts, ivec2(i0 % uTexW, i0 / uTexW), 0).xyz;
    a += texelFetch(uShapePts, ivec2(ia % uTexW, ia / uTexW), 0).xyz;
    b += texelFetch(uShapePts, ivec2(ib % uTexW, ib / uTexW), 0).xyz;
  }
  if (uEyeFollow > 0.5) {
    // A closing lid slides round the eyeball: turn the lash about the eye's horizontal axis by the angle its root
    // travelled round the eye centre, so a closed lid's lashes point down, not up across the lid.
    vec3 r0 = fetchP(s, 0).xyz;
    // (round the eye centre where it is now: deep-set or big eyes move it, and the lid moves with it)
    vec3 c = r0.x > 0.0 ? uEyeL : uEyeR;
    vec3 c0 = r0.x > 0.0 ? uEyeL0 : uEyeR0;
    float da = uEyeFollow * (atan(r0.y + off.y - c.y, r0.z + off.z - c.z) - atan(r0.y - c0.y, r0.z - c0.z));
    // and away from skin the face's shape brought towards the lash (a deep-set eye's overhang: followSkin)
    da += rootT.w;
    // and clear of a lid folded down over the lash line (angry, a squint): the baked turn × each target's weight
    vec4 l0 = texelFetch(uLid, ivec2((s * 4) % uTexW, (s * 4) / uTexW), 0);
    vec4 l1 = texelFetch(uLid, ivec2((s * 4 + 1) % uTexW, (s * 4 + 1) / uTexW), 0);
    vec4 l2 = texelFetch(uLid, ivec2((s * 4 + 2) % uTexW, (s * 4 + 2) / uTexW), 0);
    vec4 l3 = texelFetch(uLid, ivec2((s * 4 + 3) % uTexW, (s * 4 + 3) / uTexW), 0);
    da += dot(l0, vec4(uLidW[0], uLidW[1], uLidW[2], uLidW[3])) + dot(l1, vec4(uLidW[4], uLidW[5], uLidW[6], uLidW[7]))
      + dot(l2, vec4(uLidW[8], uLidW[9], uLidW[10], uLidW[11])) + dot(l3, vec4(uLidW[12], uLidW[13], uLidW[14], uLidW[15]));
    float cs = cos(da), sn = sin(da);
    vec3 v;
    v = P.xyz - r0; P.xyz = r0 + vec3(v.x, v.z * sn + v.y * cs, v.z * cs - v.y * sn);
    v = a - r0; a = r0 + vec3(v.x, v.z * sn + v.y * cs, v.z * cs - v.y * sn);
    v = b - r0; b = r0 + vec3(v.x, v.z * sn + v.y * cs, v.z * cs - v.y * sn);
  }
  vec3 T = normalize(b - a + vec3(1e-7));
  float t = float(k) / float(uPoints - 1);
  vec3 pos = P.xyz + off;
  float id = float(s) * 7.13 + float(c) * 131.71;
  if (c > 0) {
    // a child strand: around its parent, closer towards the tip (clumping), with its own slow wobble
    vec3 ref = normalize(P.xyz - uCentre);
    vec3 n1 = normalize(cross(T, ref));
    vec3 n2 = cross(n1, T);
    float th = hash(id) * 6.2831853;
    float r = uChildR * sqrt(hash(id + 3.1)) * (1.0 - 0.7 * t);
    pos += n1 * cos(th) * r + n2 * abs(sin(th)) * r * 0.5;
    float far = clamp(distance(P.xyz, fetchP(s, 0).xyz) / 0.12, 0.0, 1.0); // wobble by real length, not by t
    pos += n1 * sin(t * (5.0 + 6.0 * hash(id + 5.3)) + hash(id + 7.7) * 6.2831853) * uChildR * 0.3 * far * far;
  }
  vec4 mv = modelViewMatrix * vec4(pos, 1.0);
  vec3 tv = normalize((modelViewMatrix * vec4(T, 0.0)).xyz);
  vec3 side = normalize(cross(tv, normalize(-mv.xyz)));
  float want = uWidth * mix(1.0, uTipW, t);
  float w = max(want, uMinPx * (-mv.z) * uPxScale);
  vCover = max(want / w, uCoverMin);
  mv.xyz += side * (0.5 * w * aVert.y);
  gl_Position = projectionMatrix * mv;
  vT = t;
  vRamp = clamp(distance(P.xyz, fetchP(s, 0).xyz) / uRampLen, 0.0, 1.0); // root → tip colour over real length
  vLong = clamp(distance(fetchP(s, uPoints - 1).xyz, fetchP(s, 0).xyz) / 0.15, 0.0, 1.0); // 1 = a long strand
  vShade = P.w;
  vRand = hash(id + 11.0);
  vTan = tv;
  vViewPos = mv.xyz;
}
`;

const FRAGMENT = /* glsl */ `
#include <common>
#include <lights_pars_begin>
uniform vec3 uHairShadow; // root colour, raw sRGB (lib/hair.ts strandColours)
uniform vec3 uHairHighlight; // tip colour, raw sRGB
uniform vec3 uSky;
uniform vec3 uGround;
uniform vec3 uUpView;
uniform float uDiffuse, uSpec1, uSpec2, uShift1, uShift2, uExp1, uExp2, uJitter, uShadowFloor, uTipFade, uTipSpec, uRampAmount;
varying float vT;
varying float vRamp;
varying float vLong;
varying float vShade;
varying float vCover;
varying float vRand;
varying vec3 vTan;
varying vec3 vViewPos;

float kk(vec3 T, vec3 H, float e) {
  float th = dot(T, H);
  return pow(sqrt(max(0.0, 1.0 - th * th)), e);
}

void main() {
  vec3 rootC = sRGBTransferEOTF(vec4(uHairShadow, 1.0)).rgb;
  vec3 tipC = sRGBTransferEOTF(vec4(uHairHighlight, 1.0)).rgb;
  vec3 albedo = mix(rootC, tipC, pow(vRamp, 0.8) * uRampAmount) * (1.0 + (vRand - 0.5) * uJitter);
  vec3 T = normalize(vTan);
  vec3 V = normalize(-vViewPos);
  vec3 N = normalize(V - T * dot(V, T));
  float shade = mix(uShadowFloor, 1.0, vShade);
  vec3 colour = albedo * mix(uGround, uSky, 0.5 + 0.5 * dot(N, uUpView)) * shade;
  #if NUM_DIR_LIGHTS > 0
  for (int i = 0; i < NUM_DIR_LIGHTS; i++) {
    vec3 L = directionalLights[i].direction;
    vec3 Lc = directionalLights[i].color;
    float tl = dot(T, L);
    float diff = sqrt(max(0.0, 1.0 - tl * tl)) * (0.35 + 0.65 * clamp(dot(N, L) * 0.5 + 0.5, 0.0, 1.0));
    vec3 H = normalize(L + V);
    float s1 = kk(normalize(T + N * (uShift1 + (vRand - 0.5) * 0.08)), H, uExp1);
    float s2 = kk(normalize(T + N * uShift2), H, uExp2);
    float facing = smoothstep(-0.3, 0.4, dot(N, L));
    colour += Lc * shade * (albedo * diff * uDiffuse + facing * (uSpec1 * mix(1.0, uTipSpec, vRamp) * s1 + uSpec2 * s2 * albedo));
  }
  #endif
  // Long hair thins out at the tips; short hair ends bluntly (faded short tips dither into speckle).
  float alpha = vCover * (1.0 - uTipFade * vLong * smoothstep(0.85, 1.0, vT));
  gl_FragColor = vec4(colour, alpha);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

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
        uChildR: { value: def.childRadiusMm / 1000 },
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
        uDiffuse: { value: GROOM.diffuse },
        uSpec1: { value: GROOM.spec1 * (def.shine ?? 1) },
        uSpec2: { value: GROOM.spec2 * (def.shine ?? 1) },
        uShift1: { value: GROOM.shift1 },
        uShift2: { value: GROOM.shift2 },
        uExp1: { value: GROOM.exp1 },
        uExp2: { value: GROOM.exp2 },
        uJitter: { value: GROOM.jitter },
        uShadowFloor: { value: GROOM.shadowFloor },
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
  const follow = followSkin(roots, root, tips, made);
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

/** A Map that notes whether set() was called since `changed` was last cleared (which morph weights moved this frame). */
class SetWatch<K, V> extends Map<K, V> {
  changed = false;
  set(key: K, value: V): this {
    this.changed = true;
    return super.set(key, value);
  }
}

/** A grid cell's key: a number, not an "x,y,z" string (a hair attach looked up ~1M cells: the strings were most of it). */

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

// --- roots follow the skin ------------------------------------------------------------------------

/** Shape targets (identity and Shape sliders): what a lash's shape turn follows, never blinks or expressions. */
const SHAPE = new Set(sliders.sliders.filter((d) => d.kind === "identity" || d.kind === "semantic").map((d) => d.target));
const shapeWeight = (t: string) => (SHAPE.has(t) ? morphs.effective(t) : 0);
const yz = (y: number, z: number) => Math.atan2(y, z); // a direction's angle about the head's x axis (the lash turn)

/** The rest skin in head space, bucketed in a 1 cm grid (lib/skinTie.ts): the same for every piece tied to it (hair,
 *  brows, lashes and beard attach together on a Random character), so built once per skin registration. Read only. */
let skinGridCache: { rest: Float32Array; m: string; grid: SkinGrid } | null = null;
function restSkinGrid(rest: Float32Array, m: Matrix4): SkinGrid {
  const key = m.elements.join();
  if (skinGridCache?.rest !== rest || skinGridCache.m !== key) skinGridCache = { rest, m: key, grid: skinGrid(rest, m.elements) };
  return skinGridCache.grid;
}

type SkinTie = Tie & { head: Float32Array; lin: Matrix3 };

/**
 * Tie points (head space) to their three nearest rest skin vertices (lib/skinTie.ts), or take the tie the strands worker
 * made while decoding (`made`, for the same skin). Also the rest skin in head space and the skin → head direction
 * matrix. Null before the head loads.
 */
function tieToSkin(pts: Float32Array, made?: Tie): SkinTie | null {
  const shape = skinShape();
  if (!shape) return null;
  const m = skinSurface.toHead;
  const grid = restSkinGrid(shape.rest, m);
  return { ...(made ?? tiePoints(pts, grid)), head: grid.head, lin: new Matrix3().setFromMatrix4(m) };
}

/** The distinct skin vertices of `idx` (`uniq`) and each entry's place among them (`slot`): neighbouring points share
 *  their skin, so its offsets are summed once per vertex instead of once per point that uses it (same values). */
function uniqueSkin(idx: Int32Array): { uniq: Int32Array; slot: Int32Array } {
  const at = new Map<number, number>();
  const slot = new Int32Array(idx.length);
  for (let i = 0; i < idx.length; i++) {
    let u = at.get(idx[i]);
    if (u === undefined) at.set(idx[i], (u = at.size));
    slot[i] = u;
  }
  return { uniq: Int32Array.from(at.keys()), slot };
}

/**
 * Brows (`shapeFollow`): hairs lie on the skin, and a face's shape bends the skin under a hair, not only where its root
 * is (a low brow folds the upper lid over the brow's lower hairs, a deep-set eye rolls the brow ridge). Every point is
 * tied to the skin under it, and gets the SHAPE's offset there minus the shape's offset at its root (`out`, per point;
 * the root's own offset, with blinks and expressions, still moves the whole hair). So a hair keeps its distance from
 * its own skin; blinks and expressions move it as before. Live: follows a slider drag.
 */
function followShapePoints(points: Float32Array, p: number, out: { tex: DataTexture; data: Float32Array }, made?: Tie) {
  const count = points.length / 3;
  let tie: ReturnType<typeof tieToSkin> = null;
  let shared: ReturnType<typeof uniqueSkin> | null = null; // every point's three skin vertices, once each
  let offs: Float32Array | null = null;
  const last = new Map<string, number>();
  const seen = new Map<string, number>(); // shape weights at the last write
  const d = new Float32Array(count * 3);
  let rest: Float32Array | null = null; // the skin registration the sums belong to
  const update = () => {
    tie ??= tieToSkin(points, made);
    if (!tie) return;
    shared ??= uniqueSkin(tie.idx);
    offs ??= new Float32Array(shared.uniq.length * 3);
    // head.extra.glb re-registers the skin with its targets (a new rest array). The semantic sliders' weights didn't
    // change, so nothing below would notice: start the sums again, or brows that attached first never follow them.
    const skin = skinShape();
    if (skin && skin.rest !== rest) {
      rest = skin.rest;
      seen.clear();
      last.clear();
      offs.fill(0);
    }
    let changed = false;
    for (const t of SHAPE) {
      const w = morphs.effective(t);
      if ((seen.get(t) ?? 0) !== w) {
        seen.set(t, w);
        changed = true;
      }
    }
    if (!changed || !skinOffsets(shared.uniq, last, offs, shapeWeight)) return;
    const e = tie.lin.elements;
    for (let q = 0; q < count; q++) {
      let x = 0, y = 0, z = 0;
      for (let c = 0; c < 3; c++) {
        const j = shared.slot[q * 3 + c] * 3, w = tie.wts[q * 3 + c];
        x += w * offs[j];
        y += w * offs[j + 1];
        z += w * offs[j + 2];
      }
      d[q * 3] = e[0] * x + e[3] * y + e[6] * z;
      d[q * 3 + 1] = e[1] * x + e[4] * y + e[7] * z;
      d[q * 3 + 2] = e[2] * x + e[5] * y + e[8] * z;
    }
    for (let q = 0; q < count; q++) {
      const r = q - (q % p); // the hair's root
      for (let a = 0; a < 3; a++) out.data[q * 4 + a] = d[q * 3 + a] - d[r * 3 + a];
    }
    out.tex.needsUpdate = true;
  };
  return update;
}

/**
 * Tie every root (head space) to its three nearest rest skin vertices; the returned update (every frame) moves it with
 * them. Lashes (`tips`): each tip's nearest skin is tied the same way, and when the face's SHAPE brings that skin
 * towards the lash (a deep-set eye's overhang, a low brow) the lash turns with it, away from the skin, never towards
 * it (out.data w). Blinks and expressions keep their own turns (the eye-follow turn and the baked lid fix).
 */
function followSkin(roots: Float32Array, out: { tex: DataTexture; data: Float32Array }, tips?: Float32Array, made?: { roots: Tie; tips?: Tie }): () => void {
  const n = roots.length / 3;
  const idx = new Int32Array(n * 3);
  const wts = new Float32Array(n * 3);
  const tipIdx = tips ? new Int32Array(n * 3) : null;
  const tipWts = tips ? new Float32Array(n * 3) : null;
  const under = tips ? new Float32Array(n * 3) : null; // the rest skin point under each tip (head space)
  const above = tips ? new Int8Array(n) : null; // 1: that skin is above the lash (upper lid), 0: below (lower lid)
  let bound = false;
  const lin = new Matrix3();

  const bind = (): boolean => {
    const r = tieToSkin(roots, made?.roots);
    if (!r) return false;
    idx.set(r.idx);
    wts.set(r.wts);
    lin.copy(r.lin);
    if (tips && tipIdx && tipWts && under && above) {
      const t = tieToSkin(tips, made?.tips)!;
      tipIdx.set(t.idx);
      tipWts.set(t.wts);
      for (let s = 0; s < n; s++) {
        for (let a = 0; a < 3; a++) {
          let u = 0;
          for (let q = 0; q < 3; q++) u += tipWts[s * 3 + q] * t.head[tipIdx[s * 3 + q] * 3 + a];
          under[s * 3 + a] = u;
        }
        const ry = roots[s * 3 + 1], rz = roots[s * 3 + 2];
        above[s] = yz(under[s * 3 + 1] - ry, under[s * 3 + 2] - rz) > yz(tips[s * 3 + 1] - ry, tips[s * 3 + 2] - rz) ? 1 : 0;
      }
    }
    bound = true;
    return true;
  };

  /** Every frame: the bound skin vertices' current morph offsets, straight from the morph store, once per skin vertex
   *  (uniqueSkin). */
  let offs: Float32Array | null = null;
  let uniq: Int32Array | null = null;
  let slot: Int32Array | null = null;
  const lastWeights = new SetWatch<string, number>();
  // lashes: the shape-only offsets of the roots' and tips' skin
  let shapeRoot: Float32Array | null = null;
  let shapeTip: Float32Array | null = null;
  const lastShapeRoot = new SetWatch<string, number>();
  const lastShapeTip = new SetWatch<string, number>();
  let written = false; // the texture holds this groom's offsets (written once, then only when a weight moved)
  const shapeTurn = () => {
    if (!tipIdx || !tipWts || !under || !above) return;
    shapeRoot ??= new Float32Array(idx.length * 3);
    shapeTip ??= new Float32Array(idx.length * 3);
    if (!skinOffsets(idx, lastShapeRoot, shapeRoot, shapeWeight) || !skinOffsets(tipIdx, lastShapeTip, shapeTip, shapeWeight)) return;
    if (written && !lastShapeRoot.changed && !lastShapeTip.changed) return; // the shape didn't move: same turns
    const e = lin.elements;
    for (let s = 0; s < n; s++) {
      // y and z (head space) of how far the shape moved the root and the skin under the tip
      let ry = 0, rz = 0, uy = 0, uz = 0;
      for (let q = 0; q < 3; q++) {
        const j = (s * 3 + q) * 3, w = wts[s * 3 + q], wt = tipWts[s * 3 + q];
        ry += w * (e[1] * shapeRoot[j] + e[4] * shapeRoot[j + 1] + e[7] * shapeRoot[j + 2]);
        rz += w * (e[2] * shapeRoot[j] + e[5] * shapeRoot[j + 1] + e[8] * shapeRoot[j + 2]);
        uy += wt * (e[1] * shapeTip[j] + e[4] * shapeTip[j + 1] + e[7] * shapeTip[j + 2]);
        uz += wt * (e[2] * shapeTip[j] + e[5] * shapeTip[j + 1] + e[8] * shapeTip[j + 2]);
      }
      const dy = under[s * 3 + 1] - roots[s * 3 + 1], dz = under[s * 3 + 2] - roots[s * 3 + 2];
      if (Math.hypot(dy, dz) < GROOM.shapeTurnMinMm / 1000) continue; // stays 0
      // how the root → skin-under-the-tip direction turned (wrapped to ±π), at most shapeTurnMax, only away from that skin
      let turn = yz(dy + uy - ry, dz + uz - rz) - yz(dy, dz);
      turn = Math.atan2(Math.sin(turn), Math.cos(turn));
      const max = (GROOM.shapeTurnMax * Math.PI) / 180;
      out.data[s * 4 + 3] = above[s] ? Math.max(-max, Math.min(0, turn)) : Math.min(max, Math.max(0, turn));
    }
  };
  return () => {
    if (!bound && !bind()) return;
    if (!uniq || !slot) ({ uniq, slot } = uniqueSkin(idx));
    offs ??= new Float32Array(uniq.length * 3);
    lastWeights.changed = lastShapeRoot.changed = lastShapeTip.changed = false;
    if (!skinOffsets(uniq, lastWeights, offs)) return;
    shapeTurn();
    // no weight moved since the last frame (most idle frames, or a second render in the same frame): same texture
    if (written && !lastWeights.changed && !lastShapeRoot.changed && !lastShapeTip.changed) return;
    written = true;
    const e = lin.elements; // column-major 3×3: skin space → head space directions
    for (let s = 0; s < n; s++) {
      let dx = 0, dy = 0, dz = 0;
      for (let q = 0; q < 3; q++) {
        const j = slot[s * 3 + q] * 3, w = wts[s * 3 + q];
        dx += w * offs[j];
        dy += w * offs[j + 1];
        dz += w * offs[j + 2];
      }
      out.data[s * 4] = e[0] * dx + e[3] * dy + e[6] * dz;
      out.data[s * 4 + 1] = e[1] * dx + e[4] * dy + e[7] * dz;
      out.data[s * 4 + 2] = e[2] * dx + e[5] * dy + e[8] * dz;
    }
    out.tex.needsUpdate = true;
  };
}

