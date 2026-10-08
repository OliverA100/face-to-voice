/**
 * The skin's shader: three's MeshPhysicalMaterial plus our patches, composed in one onBeforeCompile.
 *  - Age (lib/age.ts): wrinkles, tone and roughness for the Age slider.
 *  - Ambient occlusion: `skin_regions` R (baked in Blender by `uv run bake-ao`). three applies an aoMap to the
 *    environment light only; real creases also hide part of the key light, so `aoDirect` darkens the direct light too.
 *  - Skin regions (`uv run skin-maps`, the same texture): G = redness (lips, nose, ears, cheeks, eyelids) tints the
 *    tone, B = oiliness sets the roughness, a faint oily sheen (clearcoat) and the pore depth, A = thickness: where it
 *    is low (ears, nose wings, eyelids) the rim lights glow red through the skin.
 *  - Subsurface look without a render pass: the direct light wraps further round the form in red than in blue, so the
 *    terminator goes warm and soft instead of grey and hard.
 *  - Pores and fine lines: `skin_detail`, a tileable height map laid on the rest position from three sides (no UVs,
 *    no stretching), bumped with screen-space derivatives. Medium and high tiers only (lib/quality.ts).
 *  - Scalp under procedural hair: a per-vertex `aHairCover` (0..1, lib/groom.ts writes it from the strand roots) takes
 *    the skin towards the hair's root colour, so gaps between strands show hair-dark scalp, not bare skin.
 *
 * Nothing here changes the swatches: redness and translucency multiply whatever tone is chosen (lib/skin.ts).
 * The maps load after the head is on screen (Head.tsx); until then the skin is plain.
 * Tweak here: SKIN_SHADE (most values are uniforms: change them live through __faceToVoice.skinShade).
 */
import { type BufferAttribute, Color, Float32BufferAttribute, type MeshPhysicalMaterial, RepeatWrapping, ShaderChunk, type Texture, Vector3 } from "three";

import { patchAgeShader } from "@/lib/age";
import { tierSettings } from "@/lib/quality";
import { skinRig } from "@/lib/skin";
import { skinSurface } from "@/lib/skinSurface";
import { loadKtx2, TEXTURES_BASE, tieredUrl } from "@/lib/textures";

export const SKIN_SHADE = {
  aoIndirect: 1.0, // how much the baked AO darkens the environment light (three's aoMapIntensity)
  aoDirect: 0.6, // … and the key/fill/rim lights (0 = not at all, 1 = as much as the environment)
  scalp: 0.85, // how far fully covered scalp goes towards the hair's root colour …
  scalpDarken: 0.7, // … darkened this much (the scalp sits in the hair's shadow)
  // regions
  redness: 0.5, // how strongly G tints the skin (multiplies the tone, so dark tones get a subtle flush)
  redTint: [1.0, 0.74, 0.74], // linear RGB multiplier at full redness
  lips: 0.55, // extra tint where G is lip-strong
  lipTint: [0.92, 0.62, 0.66],
  blotch: 0.35, // how uneven the redness is (low-frequency noise, 0 = smooth)
  roughDry: 0.8, // roughness where B = 0 (cheeks, neck) …
  roughOily: 0.52, // … and B = 1 (nose, forehead, lips)
  oilSheen: 0.15, // clearcoat strength at B = 1 (a soft second highlight on the T-zone)
  oilSheenRoughness: 0.32,
  // subsurface look
  wrap: [0.22, 0.08, 0.04], // per-channel light wrap (red reaches furthest round the form); normalised, so it softens
  // the terminator without brightening the tone
  translucency: 0.3, // back-light through thin skin (A)
  transColour: [1.0, 0.4, 0.3], // the blood colour of light that went through
  transPower: 3.0, // how tight the glow is round the light direction
  transDistort: 0.3, // how much the surface normal bends the light on its way through
  // pores
  detailDepth: 0.16, // mm: the height of the pore/line texture on the face (deepest in the oily T-zone; exaggerated:
  // at true depth they vanish below a pixel)
  detailTile: 30, // mm one tile covers (pipeline/config/skin.toml [detail] tile_mm)
  // stubble
  stubbleTile: 12, // mm one follicle tile covers (pipeline/config/stubble.toml [follicles])
  stubbleCover: 0.9, // the most a stubble patch covers the skin
  stubbleDarken: 0.4, // stubs read darker than the hair colour (short, dense, in their own shadow)
  stubbleBump: 0.08, // mm: how far the stubs raise the surface at full length
};

const v3 = (a: number[]) => new Vector3(a[0], a[1], a[2]);

export const skinUniforms = {
  uAoDirect: { value: SKIN_SHADE.aoDirect },
  uScalpColour: { value: new Color(0, 0, 0) }, // raw sRGB; lib/groom.ts points it at the hair's root colour
  uScalp: { value: SKIN_SHADE.scalp },
  uScalpDarken: { value: SKIN_SHADE.scalpDarken },
  uRedness: { value: SKIN_SHADE.redness },
  uRedTint: { value: v3(SKIN_SHADE.redTint) },
  uLips: { value: SKIN_SHADE.lips },
  uLipTint: { value: v3(SKIN_SHADE.lipTint) },
  uBlotch: { value: SKIN_SHADE.blotch },
  uRoughDry: { value: SKIN_SHADE.roughDry },
  uRoughOily: { value: SKIN_SHADE.roughOily },
  uWrap: { value: v3(SKIN_SHADE.wrap) },
  uTrans: { value: SKIN_SHADE.translucency },
  uTransColour: { value: v3(SKIN_SHADE.transColour) },
  uTransPower: { value: SKIN_SHADE.transPower },
  uTransDistort: { value: SKIN_SHADE.transDistort },
  uDetailDepth: { value: SKIN_SHADE.detailDepth },
  uDetailTile: { value: SKIN_SHADE.detailTile },
  uSkinDetail: { value: null as Texture | null },
  // stubble (facial hair "stubble" styles, lib/addons.ts): coverage mask in the skin UVs + a tileable follicle texture
  uStubbleMap: { value: null as Texture | null },
  uStubbleDetail: { value: null as Texture | null },
  uStubbleLen: { value: 0.5 },
  uStubbleShadow: { value: 0.15 },
  uStubbleColour: { value: new Color("#1a120c") }, // raw sRGB, by reference: the facial hair's colour set (lib/hair.ts)
  uStubbleTile: { value: SKIN_SHADE.stubbleTile },
};

/** Push SKIN_SHADE into the uniforms after editing it (debug handle; the oil sheen lives on the material). */
export function applySkinShade(material?: MeshPhysicalMaterial | null): void {
  const u = skinUniforms;
  const s = SKIN_SHADE;
  u.uAoDirect.value = s.aoDirect;
  u.uScalp.value = s.scalp;
  u.uScalpDarken.value = s.scalpDarken;
  u.uRedness.value = s.redness;
  u.uRedTint.value.copy(v3(s.redTint));
  u.uLips.value = s.lips;
  u.uLipTint.value.copy(v3(s.lipTint));
  u.uBlotch.value = s.blotch;
  u.uRoughDry.value = s.roughDry;
  u.uRoughOily.value = s.roughOily;
  u.uWrap.value.copy(v3(s.wrap));
  u.uTrans.value = s.translucency;
  u.uTransColour.value.copy(v3(s.transColour));
  u.uTransPower.value = s.transPower;
  u.uTransDistort.value = s.transDistort;
  u.uDetailDepth.value = s.detailDepth;
  u.uDetailTile.value = s.detailTile;
  if (material?.aoMap) {
    material.clearcoat = s.oilSheen;
    material.clearcoatRoughness = s.oilSheenRoughness;
    material.aoMapIntensity = s.aoIndirect;
  }
}

const DECL = /* glsl */ `
uniform float uAoDirect;
uniform vec3 uScalpColour;
uniform float uScalp, uScalpDarken;
uniform float uRedness, uLips, uBlotch, uRoughDry, uRoughOily;
uniform vec3 uRedTint, uLipTint;
uniform vec3 uWrap, uTransColour;
uniform float uTrans, uTransPower, uTransDistort;
uniform float uDetailDepth, uDetailTile;
uniform sampler2D uSkinDetail;
uniform sampler2D uStubbleMap, uStubbleDetail;
uniform float uStubbleLen, uStubbleShadow, uStubbleTile;
uniform vec3 uStubbleColour;
varying float vHairCover;
varying vec3 vSkinN;
vec4 skinReg = vec4(1.0, 0.0, 0.5, 1.0); // AO, redness, oiliness, thickness (neutral until the maps arrive)
float stubbleH = 0.0; // stubble's bump height (0..-1) and how matte it makes the skin, set in the colour step
float stubbleRough = 0.0;
`;

// After three's colour: read the regions once, tint by redness (uneven, like real flushing) and the lips.
const REGIONS = /* glsl */ `
#include <color_fragment>
#ifdef USE_AOMAP
  skinReg = texture2D(aoMap, vAoMapUv);
  float blotch = mix(1.0, 0.55 + 0.9 * ageNoise(vRest * 0.08), uBlotch);
  diffuseColor.rgb *= mix(vec3(1.0), uRedTint, clamp(skinReg.g * blotch, 0.0, 1.0) * uRedness);
  diffuseColor.rgb *= mix(vec3(1.0), uLipTint, smoothstep(0.7, 0.95, skinReg.g) * uLips);
#ifdef USE_STUBBLE
  {
    // stubble: the mask says where (and how patchy), the follicle texture (on the rest position from three sides, like
    // the pores) gives the stubs; far away they average into an even shadow, close up they read as hairs
    float sd = texture2D(uStubbleMap, vAoMapUv).r;
    vec3 sw = pow(abs(normalize(vSkinN)), vec3(4.0));
    sw /= sw.x + sw.y + sw.z;
    vec3 sq = vRest / uStubbleTile;
    float stubs = texture2D(uStubbleDetail, sq.zy).r * sw.x + texture2D(uStubbleDetail, sq.xz).r * sw.y + texture2D(uStubbleDetail, sq.xy).r * sw.z;
    // short, dense, shadowed stubs read much darker than the hair colour itself
    vec3 hairC = sRGBTransferEOTF(vec4(uStubbleColour, 1.0)).rgb * ${SKIN_SHADE.stubbleDarken.toFixed(2)};
    // the shaved shadow: hair under the skin, seen through it as a cool, greyed version of the hair colour
    vec3 underC = mix(hairC, vec3(dot(hairC, vec3(0.3, 0.59, 0.11))) * vec3(0.82, 0.9, 1.0), 0.6);
    diffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb * mix(vec3(1.0), underC * 3.0, 0.5), clamp(sd * uStubbleShadow, 0.0, 1.0));
    // the stubs themselves
    float cover = sd * uStubbleLen * (0.35 + 1.5 * stubs);
    diffuseColor.rgb = mix(diffuseColor.rgb, hairC, clamp(cover, 0.0, ${SKIN_SHADE.stubbleCover.toFixed(2)}));
    stubbleH = -sd * uStubbleLen * stubs;
    stubbleRough = sd * uStubbleLen;
  }
#endif
#endif
`;

const ROUGHNESS = /* glsl */ `
#include <roughnessmap_fragment>
#ifdef USE_AOMAP
  roughnessFactor = mix(uRoughDry, uRoughOily, skinReg.b);
  roughnessFactor = mix(roughnessFactor, 0.92, stubbleRough); // stubble is matte
#endif
`;

const OIL = /* glsl */ `
#include <lights_physical_fragment>
#ifdef USE_CLEARCOAT
  material.clearcoat *= skinReg.b * skinReg.b;
#endif
`;

const DETAIL = /* glsl */ `
#include <normal_fragment_maps>
#ifdef SKIN_DETAIL
{
  vec3 w = pow(abs(normalize(vSkinN)), vec3(4.0));
  w /= w.x + w.y + w.z;
  vec3 q = vRest / uDetailTile;
  float hd = texture2D(uSkinDetail, q.zy).r * w.x + texture2D(uSkinDetail, q.xz).r * w.y + texture2D(uSkinDetail, q.xy).r * w.z;
  // pores on the face only (oiliness above the scalp/neck's 0.3), none on thin skin (ears, eyelids), few on the lips
  float depth = uDetailDepth * smoothstep(0.3, 0.6, skinReg.b) * skinReg.a * (1.0 - 0.7 * smoothstep(0.7, 0.95, skinReg.g));
  normal = ageBump(-vViewPosition, normal, (hd - 0.5) * depth, faceDirection);
}
#endif
#ifdef USE_STUBBLE
normal = ageBump(-vViewPosition, normal, stubbleH * ${SKIN_SHADE.stubbleBump.toFixed(3)}, faceDirection);
#endif
`;

const SCALP = /* glsl */ `
#include <alphamap_fragment>
vec3 scalpC = sRGBTransferEOTF(vec4(uScalpColour, 1.0)).rgb * uScalpDarken;
diffuseColor.rgb = mix(diffuseColor.rgb, scalpC, clamp(vHairCover, 0.0, 1.0) * uScalp);
`;

const AO_DIRECT = /* glsl */ `
#include <aomap_fragment>
#ifdef USE_AOMAP
  float aoDirect = mix(1.0, ambientOcclusion, uAoDirect);
  reflectedLight.directDiffuse *= aoDirect;
  reflectedLight.directSpecular *= aoDirect;
#endif
`;

// Direct diffuse: wrapped per channel (the subsurface look) plus light through thin skin from behind.
const LAMBERT = "reflectedLight.directDiffuse += irradiance * BRDF_Lambert( material.diffuseContribution ) * ( 1.0 - F );";
const SKIN_DIFFUSE = /* glsl */ `
  float skinNL = dot( geometryNormal, directLight.direction );
  // energy-conserving wrap (the same total light as Lambert, spread further round the form)
  vec3 skinIrr = clamp( ( vec3( skinNL ) + uWrap ) / ( ( 1.0 + uWrap ) * ( 1.0 + uWrap ) ), 0.0, 1.0 ) * directLight.color;
  reflectedLight.directDiffuse += skinIrr * BRDF_Lambert( material.diffuseContribution ) * ( 1.0 - F );
  vec3 skinTH = normalize( directLight.direction + geometryNormal * uTransDistort );
  float skinThrough = pow( clamp( dot( geometryViewDir, -skinTH ), 0.0, 1.0 ), uTransPower );
  reflectedLight.directDiffuse += skinThrough * (1.0 - skinReg.a) * uTrans * uTransColour * material.diffuseContribution * directLight.color;
`;
const PHYSICAL_PARS = ShaderChunk.lights_physical_pars_fragment.includes(LAMBERT)
  ? ShaderChunk.lights_physical_pars_fragment.replace(LAMBERT, SKIN_DIFFUSE)
  : (console.warn("skinShader: three's direct diffuse line changed; the subsurface look is off"), ShaderChunk.lights_physical_pars_fragment);

export function installSkinShader(material: MeshPhysicalMaterial): void {
  material.onBeforeCompile = (shader) => {
    patchAgeShader(shader); // first: the patches below build on its vRest, ageNoise and ageBump
    Object.assign(shader.uniforms, skinUniforms);
    shader.vertexShader = "attribute float aHairCover;\nvarying float vHairCover;\nvarying vec3 vSkinN;\n" +
      shader.vertexShader.replace("#include <uv_vertex>", "#include <uv_vertex>\nvHairCover = aHairCover;\nvSkinN = normal;");
    shader.fragmentShader = DECL + shader.fragmentShader
      .replace("#include <color_fragment>", REGIONS)
      .replace("#include <roughnessmap_fragment>", ROUGHNESS)
      .replace("#include <lights_physical_fragment>", OIL)
      .replace("#include <normal_fragment_maps>", DETAIL)
      .replace("#include <lights_physical_pars_fragment>", PHYSICAL_PARS)
      .replace("#include <aomap_fragment>", AO_DIRECT)
      .replace("#include <alphamap_fragment>", SCALP);
  };
  material.customProgramCacheKey = () => "skin-v10";
}

/** Pores on or off for the current tier (Head.tsx calls this again when the tier drops). */
export function applySkinTier(material: MeshPhysicalMaterial): void {
  const on = tierSettings().detailNormals && skinUniforms.uSkinDetail.value !== null;
  if (on === !!material.defines?.SKIN_DETAIL) return;
  material.defines ??= {};
  if (on) material.defines.SKIN_DETAIL = "";
  else delete material.defines.SKIN_DETAIL;
  material.needsUpdate = true;
}

/** Fetch the skin's maps for the current quality tier and put them on the material (one recompile). */
export async function loadSkinMaps(material: MeshPhysicalMaterial): Promise<void> {
  const [regions, detail] = await Promise.all([
    loadKtx2(tieredUrl("skin_regions")),
    tierSettings().detailNormals ? loadKtx2(TEXTURES_BASE + "skin_detail.ktx2") : Promise.resolve(null),
  ]);
  material.aoMap = regions;
  if (detail) {
    detail.wrapS = detail.wrapT = RepeatWrapping; // the tile repeats over the face
    detail.needsUpdate = true;
    skinUniforms.uSkinDetail.value = detail;
  }
  applySkinShade(material); // the oil sheen (clearcoat) switches on with the maps
  applySkinTier(material);
  material.needsUpdate = true;
}

/** Stubble on (a facial hair "stubble" style, lib/addons.ts): its mask, the follicle texture and its look; the colour
 *  is the facial hair's colour set, by reference, so colour changes and blends follow. One recompile. */
export function enableStubble(material: MeshPhysicalMaterial, mask: Texture, detail: Texture, look: { length: number; shadow: number }, colour: Color): void {
  detail.wrapS = detail.wrapT = RepeatWrapping;
  detail.needsUpdate = true;
  skinUniforms.uStubbleMap.value = mask;
  skinUniforms.uStubbleDetail.value = detail;
  skinUniforms.uStubbleLen.value = look.length;
  skinUniforms.uStubbleShadow.value = look.shadow;
  skinUniforms.uStubbleColour.value = colour;
  if (material.defines?.USE_STUBBLE === undefined) {
    material.defines = { ...material.defines, USE_STUBBLE: "" };
    material.needsUpdate = true;
  }
}

/** Stubble off (the style was removed or replaced by one that is not stubble). */
export function disableStubble(material: MeshPhysicalMaterial | null): void {
  if (!material?.defines || material.defines.USE_STUBBLE === undefined) return;
  delete material.defines.USE_STUBBLE;
  material.needsUpdate = true;
}

// --- what the hair and beard pieces paint on the skin, per image of a cross-fade ------------------------------------

/** The scalp tint and the stubble, as the pieces on the head have set them. */
export type SkinPieces = {
  cover: BufferAttribute;
  scalpColour: Color;
  stubble: boolean;
  stubbleMap: Texture | null;
  stubbleDetail: Texture | null;
  stubbleLen: number;
  stubbleShadow: number;
  stubbleColour: Color;
};

function currentSkinPieces(cover: BufferAttribute): SkinPieces {
  const u = skinUniforms;
  return {
    cover,
    scalpColour: u.uScalpColour.value,
    stubble: skinRig.material?.defines?.USE_STUBBLE !== undefined,
    stubbleMap: u.uStubbleMap.value,
    stubbleDetail: u.uStubbleDetail.value,
    stubbleLen: u.uStubbleLen.value,
    stubbleShadow: u.uStubbleShadow.value,
    stubbleColour: u.uStubbleColour.value,
  };
}

/** A copy of the skin's piece state now (lib/pieceFade.ts: the "before" image keeps it while the pieces swap). Null
 *  before the head loads. The cover is a separate attribute, uploaded once and then swapped in by reference. */
export function snapshotSkinPieces(): SkinPieces | null {
  const live = skinSurface.mesh?.geometry.getAttribute("aHairCover") as BufferAttribute | undefined;
  if (!live) return null;
  return currentSkinPieces(new Float32BufferAttribute((live.array as Float32Array).slice(), 1));
}

/** Put `s` on the skin; returns what it replaced (to put back), or null before the head loads. */
export function applySkinPieces(s: SkinPieces): SkinPieces | null {
  const geometry = skinSurface.mesh?.geometry;
  const live = geometry?.getAttribute("aHairCover") as BufferAttribute | undefined;
  if (!geometry || !live) return null;
  const was = currentSkinPieces(live);
  const u = skinUniforms;
  geometry.setAttribute("aHairCover", s.cover);
  u.uScalpColour.value = s.scalpColour;
  u.uStubbleMap.value = s.stubbleMap;
  u.uStubbleDetail.value = s.stubbleDetail;
  u.uStubbleLen.value = s.stubbleLen;
  u.uStubbleShadow.value = s.stubbleShadow;
  u.uStubbleColour.value = s.stubbleColour;
  const material = skinRig.material;
  if (material && s.stubble !== was.stubble) {
    if (s.stubble) material.defines = { ...material.defines, USE_STUBBLE: "" };
    else delete material.defines!.USE_STUBBLE;
    material.needsUpdate = true;
  }
  return was;
}
