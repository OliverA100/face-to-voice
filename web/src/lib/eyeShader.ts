/**
 * The eyes' shaders. Nothing is downloaded: GNM's eye UVs are radial (centre 0.5, 0.5;
 * pupil up to r 0.05, iris up to 0.185, sclera beyond), so the iris and sclera are drawn from the UV radius and angle.
 *  - Iris + pupil: one material for both meshes. The pupil is a disc drawn by radius, so its edge is a true circle
 *    (the pupil mesh's own boundary is jagged). The iris pattern is a generated texture (iris.ktx2, `uv run eye-maps`:
 *    fibres, collarette, crypts, furrows, limbal ring) tinted by the visitor's eye colour (lib/eyes.ts).
 *  - Sclera: off-white, warmer and faintly veined towards the corners, a soft grey ring round the iris.
 *  - Lid shadow (both): the upper lid shades the top of the eyeball. It is measured in head space, not the eye's,
 *    so it stays under the lid when the eye turns.
 *  - Cornea (scene/materials.ts): GNM's clear eye shell, drawn as reflections only (additive), gives the wet highlight.
 * Tweak here: EYE_LOOK.
 */
import { Color, Matrix4, type MeshPhysicalMaterial, type Object3D, type Texture, Vector3 } from "three";

import { loadKtx2, TEXTURES_BASE } from "@/lib/textures";

export const EYE_LOOK = {
  pupil: 0.052, // UV radius of the pupil (the mesh's own pupil reaches 0.05)
  pupilSoft: 0.007, // how soft its edge is (UV radius either side)
  iris: 0.185, // UV radius of the iris edge
  warmCentre: 0.35, // warmer, lighter colour inside the collarette (the texture's G)
  limbal: 0.65, // the dark ring at the iris edge before the iris texture arrives (the texture has its own)
  veins: 0.35, // red veins on the sclera, strongest in the corners
  corners: 0.2, // sclera a little pinker towards the corners
  lidShadow: 0.4, // how dark the upper lid's shadow on the eyeball gets
  lidShadowMm: [-1.0, 3.5], // from this height above the eye centre (mm) the shadow starts … and is full (the open lid
  // sits ~3 mm above the centre)
  lowerLid: 0.2, // the lower lid's softer contact shadow
  cornerShade: 0.25, // the eyeball turning away into the corners
  caruncle: 0.6, // pink inner corner
  limbalEdge: 0.3, // the iris colour's brightness at its very edge (match iris.ktx2's limbal ring)
};

export const eyeUniforms = {
  uHeadInv: { value: new Matrix4() }, // world → head space, every frame (Head.tsx)
  uEyeL: { value: new Vector3() }, // eyeball centres in head space
  uEyeR: { value: new Vector3() },
  uPupilR: { value: EYE_LOOK.pupil },
  uPupilSoft: { value: EYE_LOOK.pupilSoft },
  uIrisR: { value: EYE_LOOK.iris },
  uWarm: { value: EYE_LOOK.warmCentre },
  uLimbal: { value: EYE_LOOK.limbal },
  uVeins: { value: EYE_LOOK.veins },
  uCorners: { value: EYE_LOOK.corners },
  uLidShadow: { value: EYE_LOOK.lidShadow },
  uLidMm: { value: EYE_LOOK.lidShadowMm.slice() },
  uLowerLid: { value: EYE_LOOK.lowerLid },
  uCornerShade: { value: EYE_LOOK.cornerShade },
  uCaruncle: { value: EYE_LOOK.caruncle },
  uIrisMap: { value: null as Texture | null },
  uIrisColour: { value: new Color() }, // the iris material's colour, by reference (installIrisShader)
  uLimbalEdge: { value: EYE_LOOK.limbalEdge },
};

const tmp = new Vector3();
/** Per frame: head-space matrix and eyeball centres (cheap: two matrix ops). */
export function updateEyeUniforms(head: Object3D, left: Object3D | null, right: Object3D | null): void {
  const inv = eyeUniforms.uHeadInv.value.copy(head.matrixWorld).invert();
  if (left) eyeUniforms.uEyeL.value.copy(left.getWorldPosition(tmp)).applyMatrix4(inv);
  if (right) eyeUniforms.uEyeR.value.copy(right.getWorldPosition(tmp)).applyMatrix4(inv);
}

const VERTEX = /* glsl */ `
uniform mat4 uHeadInv;
varying vec3 vEyeHead;
varying vec2 vEyeUv;
`;
const VERTEX_MAIN = /* glsl */ `
#include <worldpos_vertex>
vEyeHead = (uHeadInv * modelMatrix * vec4(transformed, 1.0)).xyz;
vEyeUv = uv;
`;

const FRAGMENT = /* glsl */ `
uniform vec3 uEyeL, uEyeR;
uniform float uPupilR, uPupilSoft, uIrisR, uWarm, uLimbal, uVeins, uCorners, uLidShadow, uLowerLid, uCornerShade, uCaruncle;
uniform float uLidMm[2];
uniform sampler2D uIrisMap;
uniform vec3 uIrisColour;
uniform float uLimbalEdge;
varying vec3 vEyeHead;
varying vec2 vEyeUv;
float eyeHash(vec3 p) { return fract(sin(dot(p, vec3(12.9898, 78.233, 37.719))) * 43758.5453); }
float eyeNoise(vec3 p) {
  vec3 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(mix(eyeHash(i), eyeHash(i + vec3(1, 0, 0)), f.x), mix(eyeHash(i + vec3(0, 1, 0)), eyeHash(i + vec3(1, 1, 0)), f.x), f.y),
             mix(mix(eyeHash(i + vec3(0, 0, 1)), eyeHash(i + vec3(1, 0, 1)), f.x), mix(eyeHash(i + vec3(0, 1, 1)), eyeHash(i + vec3(1, 1, 1)), f.x), f.y), f.z);
}
// mm from this eye's centre (the nearer of the two) in head space: x towards the nose, y up
vec2 eyeLocal() {
  bool left = abs(vEyeHead.x - uEyeL.x) < abs(vEyeHead.x - uEyeR.x);
  vec3 c = left ? uEyeL : uEyeR;
  vec2 d = (vEyeHead.xy - c.xy) * 1000.0;
  d.x *= c.x > 0.0 ? -1.0 : 1.0;
  return d;
}
// shade where the lids meet the eyeball: the upper lid's shadow (strongest), the lower lid and the corners
float eyeLid() {
  vec2 d = eyeLocal();
  float shade = uLidShadow * smoothstep(uLidMm[0], uLidMm[1], d.y)
    + uLowerLid * smoothstep(-2.0, -5.0, d.y)
    + uCornerShade * smoothstep(7.0, 11.5, abs(d.x));
  return 1.0 - clamp(shade, 0.0, 0.85);
}
`;

// The iris pattern comes from iris.ktx2 (`uv run eye-maps`: R = brightness ×2, G = the warm pupillary zone), tinted
// by the eye colour. Until it has loaded (and on the low tier's first frames) the iris is the plain colour with its
// dark rim.
const IRIS = /* glsl */ `
#include <color_fragment>
{
  vec2 d = vEyeUv - 0.5;
  float r = length(d);
  float t = clamp((r - uPupilR) / (uIrisR - uPupilR), 0.0, 1.0); // 0 at the pupil, 1 at the iris edge
  vec3 base = diffuseColor.rgb;
  vec3 col = base;
#ifdef IRIS_MAP
  vec4 tex = texture2D(uIrisMap, d / (2.0 * uIrisR) + 0.5);
  col = base * tex.r * 2.0;
  col = mix(col, col * vec3(1.6, 1.3, 0.8) + base * 0.12, uWarm * tex.g); // warmer pupillary zone
#else
  col *= 1.0 - uLimbal * smoothstep(0.72, 1.0, t);
#endif
  // light gathers on the far side of the iris from the lights above (a soft caustic low in the iris)
  vec2 e = eyeLocal();
  col *= 1.0 + 0.3 * smoothstep(-0.2, 1.0, -e.y / 6.0) * smoothstep(0.1, 0.5, t);
  float soft = max(uPupilSoft, fwidth(r) * 1.2); // a little soft, as the cornea and the ruff blur it
  col = mix(vec3(0.008), col, smoothstep(uPupilR - soft, uPupilR + soft, r)); // the pupil: a true circle
  diffuseColor.rgb = col * eyeLid();
}
`;

const SCLERA = /* glsl */ `
#include <color_fragment>
{
  float r = length(vEyeUv - 0.5);
  float corner = smoothstep(0.22, 0.36, r);
  vec3 col = diffuseColor.rgb * mix(vec3(1.0), vec3(0.97, 0.86, 0.86), corner * uCorners);
  // veins: thin wandering lines that run in from the corners (noise stretched round the eye, so its ridges run radially)
  float a = atan(vEyeUv.y - 0.5, vEyeUv.x - 0.5);
  vec3 q = vec3(cos(a) * 16.0, sin(a) * 16.0, r * 7.0);
  float vein = pow(1.0 - abs(eyeNoise(q) * 2.0 - 1.0), 22.0) + 0.7 * pow(1.0 - abs(eyeNoise(q * 1.9 + 5.0) * 2.0 - 1.0), 28.0);
  col = mix(col, vec3(0.6, 0.2, 0.18), clamp(vein, 0.0, 1.0) * uVeins * smoothstep(0.2, 0.3, r));
  // the inner corner is pink (caruncle and the moist fold next to it)
  col = mix(col, col * vec3(0.95, 0.6, 0.6), uCaruncle * smoothstep(5.0, 9.0, eyeLocal().x));
  // the limbus: the white starts in the iris's own dark rim colour and fades to white, so nothing changes colour
  // across the meshes' jagged boundary and the visible edge is this smooth circle
  col = mix(uIrisColour * uLimbalEdge, col, smoothstep(uIrisR + 0.004, uIrisR + 0.026, r));
  diffuseColor.rgb = col * eyeLid();
}
`;

function install(material: MeshPhysicalMaterial, body: string, key: string): void {
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, eyeUniforms);
    shader.vertexShader = VERTEX + shader.vertexShader.replace("#include <worldpos_vertex>", VERTEX_MAIN);
    shader.fragmentShader = FRAGMENT + shader.fragmentShader.replace("#include <color_fragment>", body);
  };
  material.customProgramCacheKey = () => key;
  // three only declares `uv` (and the vUv chain) when a map uses it; the shader reads it itself
  material.defines = { ...material.defines, USE_UV: "" };
}

/** Iris and pupil share this material (scene/materials.ts). */
export function installIrisShader(m: MeshPhysicalMaterial): void {
  install(m, IRIS, "eye-iris-v1");
  eyeUniforms.uIrisColour.value = m.color; // by reference: the sclera's limbus follows eye colour changes and blends
}
export const installScleraShader = (m: MeshPhysicalMaterial) => install(m, SCLERA, "eye-sclera-v1");

/** Fetch the iris texture after the head is on screen (Head.tsx) and switch the iris shader to it (one recompile). */
export async function loadEyeMaps(iris: MeshPhysicalMaterial): Promise<void> {
  eyeUniforms.uIrisMap.value = await loadKtx2(TEXTURES_BASE + "iris.ktx2");
  iris.defines = { ...iris.defines, IRIS_MAP: "" };
  iris.needsUpdate = true;
}
