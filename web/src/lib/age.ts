/**
 * Skin ageing for the Age slider (Identity section). The slider's SHAPE part is a mix slider in sliders.json
 * (lips, nose, ears, cheeks, jowls … see pipeline/config/age.toml); this file adds the SKIN part.
 *
 * GNM ships no textures and head.glb has no UVs, so wrinkles are drawn in the skin shader: every fragment knows
 * its rest (template) position, which is the vertex position before the morph targets move it, so the wrinkles
 * stay on the same bit of skin whatever the sliders do. The height of each wrinkle is a groove along a line
 * placed from a few landmarks (web/src/data/ageing.json); the shader turns the height into a bumped normal with
 * screen-space derivatives. Nothing is downloaded. Lines thinner than about a pixel fade out (no shimmer).
 *
 * Tweak here: AGE (overall strengths). Per-wrinkle onsets and depths live in pipeline/config/age.toml [skin].
 */
import { Matrix4, type Mesh, type Object3D, Vector3 } from "three";

import ageing from "@/data/ageing.json";
import { morphs } from "@/lib/morphs/store";

export const AGE = {
  target: "sem_age", // the slider (sliders.json)
  wrinkles: 0.75, // overall wrinkle depth multiplier (1.2 reads overdone)
  tone: 0.12, // how much older skin desaturates (0..1 at Age +1)
  mottle: 0.06, // uneven pigment at Age +1
  roughness: 0.08, // older skin is a little less glossy …
  youthSmooth: 0.04, // … younger skin a little more (roughness − this at Age −1)
};

type Skin = Record<string, { onset: number; depth_mm: number }>;
const SKIN = ageing.skin as Skin;
const FEATURES = ["forehead", "glabella", "crows_feet", "under_eye", "nasolabial", "marionette", "lip_lines", "neck", "texture"] as const;
const L = ageing.landmarks as Record<string, number[]>;
const mm = (n: string) => new Vector3(L[n][0], L[n][1], L[n][2]).multiplyScalar(1000);

/** Shared by the skin material's shader; values change without recompiling. */
export const ageUniforms = {
  // gltfpack stores positions as 16-bit integers and puts the dequantisation (scale + offset) on the mesh's
  // node: this is that transform, so the shader can recover template metres from the raw attribute
  uRest: { value: new Matrix4() },
  uAgeOn: { value: 0 },
  uAgeW: { value: new Array(FEATURES.length).fill(0) as number[] }, // depth (mm) per feature at the current age
  uAgeTone: { value: 0 },
  uAgeMottle: { value: 0 },
  uAgeRough: { value: 0 },
  uTR: { value: mm("trichion") }, uGL: { value: mm("glabella") }, uNA: { value: mm("nasion") },
  uEN: { value: mm("endocanthion_l") }, uEX: { value: mm("exocanthion_l") }, uLL: { value: mm("lid_lower_l") },
  uAL: { value: mm("alare_l") }, uSN: { value: mm("subnasale") }, uLS: { value: mm("labrale_superius") },
  uCH: { value: mm("cheilion_l") }, uLI: { value: mm("labrale_inferius") }, uME: { value: mm("menton") },
};

/** Push an Age slider value (−1..1) into the shader uniforms. */
export function setAge(age: number): void {
  const old = Math.max(0, age);
  FEATURES.forEach((f, i) => {
    const { onset, depth_mm } = SKIN[f];
    const k = Math.min(1, Math.max(0, (old - onset) / Math.max(1e-3, 1 - onset)));
    ageUniforms.uAgeW.value[i] = depth_mm * k * k * (3 - 2 * k) * AGE.wrinkles; // smoothstep onset
  });
  ageUniforms.uAgeTone.value = AGE.tone * old;
  ageUniforms.uAgeMottle.value = AGE.mottle * old;
  ageUniforms.uAgeRough.value = age >= 0 ? AGE.roughness * age : AGE.youthSmooth * age;
  ageUniforms.uAgeOn.value = age > 0.01 || age < -0.01 ? 1 : 0;
}

// The slider value arrives through the morph store (drags, tweens, random face, reset): no React involved.
morphs.onChange((target, value) => {
  if (target === AGE.target) setAge(value);
});

const VERTEX_DECL = /* glsl */ `
uniform mat4 uRest;
varying vec3 vRest; // template position in mm (before the morph targets)
`;
const VERTEX_MAIN = /* glsl */ `
#include <begin_vertex>
vRest = (uRest * vec4(position, 1.0)).xyz * 1000.0;
`;

const FRAGMENT_DECL = /* glsl */ `
varying vec3 vRest;
uniform float uAgeOn;
uniform float uAgeW[${FEATURES.length}];
uniform float uAgeTone, uAgeMottle, uAgeRough;
uniform vec3 uTR, uGL, uNA, uEN, uEX, uLL, uAL, uSN, uLS, uCH, uLI, uME;

float ageHash(vec3 p) { return fract(sin(dot(p, vec3(12.9898, 78.233, 37.719))) * 43758.5453); }
float ageNoise(vec3 p) { // value noise, 0..1
  vec3 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(mix(ageHash(i), ageHash(i + vec3(1, 0, 0)), f.x), mix(ageHash(i + vec3(0, 1, 0)), ageHash(i + vec3(1, 1, 0)), f.x), f.y),
             mix(mix(ageHash(i + vec3(0, 0, 1)), ageHash(i + vec3(1, 0, 1)), f.x), mix(ageHash(i + vec3(0, 1, 1)), ageHash(i + vec3(1, 1, 1)), f.x), f.y), f.z);
}
float ageGroove(float d, float w) { return exp(-(d * d) / (w * w)); }
float ageBand(float x, float lo, float hi, float soft) { return smoothstep(lo - soft, lo + soft, x) * (1.0 - smoothstep(hi - soft, hi + soft, x)); }
// distance to segment ab seen from the front (x, y only: the fold follows the cheek surface), and where along it (0..1)
float ageSegment(vec3 p, vec3 a, vec3 b, out float t) {
  vec2 ab = b.xy - a.xy;
  t = clamp(dot(p.xy - a.xy, ab) / dot(ab, ab), 0.0, 1.0);
  return length(p.xy - (a.xy + t * ab));
}
// thin periodic lines: 1 on a line, 0 between; faded when the spacing is under ~3 pixels (px = mm per pixel)
float ageLines(float phase, float sharp, float spacing, float px) {
  return pow(0.5 + 0.5 * cos(6.2831853 * phase), sharp) * smoothstep(1.5, 3.0, spacing / px);
}

// Height of the skin surface in mm (negative = groove) at the rest position P.
float ageHeight(vec3 P, float px) {
  vec3 Q = vec3(abs(P.x), P.y, P.z); // mirrored: left-side landmarks serve both sides
  float front = smoothstep(uGL.z - 45.0, uGL.z - 30.0, P.z);
  float h = 0.0;
  // forehead lines: horizontal, curving down towards the temples, irregular depth
  float fy = P.y + 0.003 * P.x * P.x;
  h -= uAgeW[0] * ageLines(fy / 7.0, 10.0, 7.0, px) * (0.65 + 0.35 * sin(P.x * 0.23 + fy * 0.9))
       * ageBand(P.y, uGL.y + 13.0, uTR.y - 6.0, 3.0) * (1.0 - smoothstep(34.0, 50.0, abs(P.x))) * front;
  // frown lines between the brows ("11s"): short, tapering, converging slightly downwards
  float gl = (P.y - uNA.y - 4.0) / 16.0; // 0 at the bottom, 1 at the top
  h -= uAgeW[1] * ageGroove(abs(abs(P.x) - (3.8 + 1.2 * gl)), 0.75) * ageBand(gl, 0.0, 1.0, 0.18) * sin(3.1416 * clamp(gl, 0.0, 1.0)) * front;
  // crow's feet: a fan of lines at the outer eye corner
  vec3 c = uEX + vec3(6.0, 0.0, -4.0);
  vec3 v = Q - c;
  float lat = v.x * 0.8 - v.z * 0.6;
  float r = length(vec2(lat, v.y));
  float th = atan(v.y, max(lat, 1e-3));
  h -= uAgeW[2] * ageLines(th * 1.45, 12.0, r * 0.7, px) * smoothstep(3.0, 7.0, r) * (1.0 - smoothstep(14.0, 22.0, r))
       * smoothstep(0.0, 3.0, lat) * (1.0 - smoothstep(0.75, 1.0, abs(th)));
  // under-eye line: a curve 5 mm under the lower lid, between the corners
  float xm = 0.5 * (uEN.x + uEX.x);
  float uy = uLL.y - 5.0 - 0.02 * (Q.x - xm) * (Q.x - xm);
  h -= uAgeW[3] * ageGroove(Q.y - uy, 1.0) * ageBand(Q.x, uEN.x + 2.0, uEX.x + 3.0, 2.5) * front;
  // nasolabial folds: a smooth curve (quadratic Bezier, 8 segments, seen from the front) from the nose wing,
  // bowing gently out, to beside the mouth corner; the cheek bulges over it on the outer side
  vec2 b0 = uAL.xy + vec2(1.5, 2.5);
  vec2 b2 = uCH.xy + vec2(4.0, -5.0);
  vec2 b1 = vec2(max(b0.x, b2.x) + 3.0, 0.5 * (b0.y + b2.y));
  float d = 1e3, along = 0.0, cx = 0.0;
  vec2 prev = b0;
  for (int i = 1; i <= 8; i++) {
    float u = float(i) / 8.0;
    vec2 cur = mix(mix(b0, b1, u), mix(b1, b2, u), u);
    vec2 ab = cur - prev;
    float tt = clamp(dot(Q.xy - prev, ab) / dot(ab, ab), 0.0, 1.0);
    vec2 cp = prev + tt * ab;
    float di = length(Q.xy - cp);
    if (di < d) { d = di; along = (float(i) - 1.0 + tt) / 8.0; cx = cp.x; }
    prev = cur;
  }
  float outer = smoothstep(-0.5, 1.5, Q.x - cx);
  float fold = smoothstep(0.0, 0.15, along) * (1.0 - smoothstep(0.9, 1.0, along)) * front;
  h -= uAgeW[4] * (ageGroove(d, 2.2) - 0.45 * outer * ageGroove(d - 3.5, 3.0)) * fold;
  // marionette lines: carry on from the end of the fold down towards the chin
  float t;
  d = ageSegment(Q, vec3(b2, 0.0), vec3(b2 + vec2(1.0, -12.0), 0.0), t);
  h -= uAgeW[5] * ageGroove(d, 1.8) * smoothstep(0.0, 0.25, t) * (1.0 - smoothstep(0.6, 1.0, t)) * front;
  // lip lines: short straight vertical lines rising from the upper lip, uneven spacing and length
  float lx = P.x / 3.2;
  float lid = floor(lx + 0.5);
  float llen = 3.5 + 3.0 * ageHash(vec3(lid, 1.0, 7.0));
  h -= uAgeW[6] * ageLines(lx, 16.0, 3.2, px) * ageBand(P.y - uLS.y, 0.8, llen, 0.8)
       * (1.0 - smoothstep(9.0, 13.0, abs(P.x))) * step(0.35, ageHash(vec3(lid, 3.0, 1.0))) * front;
  // neck rings
  float ny = P.y + 0.002 * P.x * P.x;
  h -= uAgeW[7] * ageLines(ny / 13.0 + 0.15 * sin(P.x * 0.08), 3.0, 13.0, px) * ageBand(P.y, 125.0, uME.y - 14.0, 6.0) * smoothstep(-15.0, 5.0, P.z);
  // fine grain everywhere
  h -= uAgeW[8] * (ageNoise(P * 1.4) - 0.5) * smoothstep(0.3, 0.8, 0.7 / px);
  return h;
}

// Bump mapping from a height in mm via screen-space derivatives (Mikkelsen's surface gradient; no UVs needed).
vec3 ageBump(vec3 surfPos, vec3 n, float h, float faceDir) {
  vec3 sx = dFdx(surfPos), sy = dFdy(surfPos);
  vec3 r1 = cross(sy, n), r2 = cross(n, sx);
  float det = dot(sx, r1) * faceDir;
  vec2 dh = vec2(dFdx(h), dFdy(h)) * 0.001; // mm -> m (view space is in metres)
  vec3 grad = sign(det) * (dh.x * r1 + dh.y * r2);
  return normalize(abs(det) * n - grad);
}
`;

const FRAGMENT_NORMAL = /* glsl */ `
#include <normal_fragment_maps>
if (uAgeOn > 0.5) {
  float agePx = max(length(fwidth(vRest)), 1e-4); // mm per pixel here
  normal = ageBump(-vViewPosition, normal, ageHeight(vRest, agePx), faceDirection);
}
`;
const FRAGMENT_COLOR = /* glsl */ `
#include <color_fragment>
if (uAgeOn > 0.5) {
  float luma = dot(diffuseColor.rgb, vec3(0.299, 0.587, 0.114));
  diffuseColor.rgb = mix(diffuseColor.rgb, vec3(luma) * vec3(1.02, 0.99, 0.94), uAgeTone);
  diffuseColor.rgb *= 1.0 - uAgeMottle * smoothstep(0.55, 0.9, ageNoise(vRest * 0.12));
}
`;
const FRAGMENT_ROUGHNESS = /* glsl */ `
#include <roughnessmap_fragment>
roughnessFactor = clamp(roughnessFactor + uAgeRough, 0.05, 1.0);
`;

/** Local transforms from `mesh` up to (not including) the .glb's "head" node: raw (quantised) attribute → template metres. */
export function headSpaceMatrix(mesh: Mesh, out = new Matrix4()): Matrix4 {
  out.identity();
  for (let o: Object3D | null = mesh; o && o.name !== "head"; o = o.parent) {
    o.updateMatrix();
    out.premultiply(o.matrix);
  }
  return out;
}

/** The skin mesh from head.glb: its node transform dequantises the positions (Head.tsx calls this once). */
export function bindAgeMesh(mesh: Mesh): void {
  headSpaceMatrix(mesh, ageUniforms.uRest.value);
}

/** Add the ageing to a skin shader (lib/skinShader.ts composes it with the rest of the skin's look). */
export function patchAgeShader(shader: { uniforms: Record<string, unknown>; vertexShader: string; fragmentShader: string }): void {
  Object.assign(shader.uniforms, ageUniforms);
  shader.vertexShader = VERTEX_DECL + shader.vertexShader.replace("#include <begin_vertex>", VERTEX_MAIN);
  shader.fragmentShader = FRAGMENT_DECL + shader.fragmentShader
    .replace("#include <normal_fragment_maps>", FRAGMENT_NORMAL)
    .replace("#include <color_fragment>", FRAGMENT_COLOR)
    .replace("#include <roughnessmap_fragment>", FRAGMENT_ROUGHNESS);
}
