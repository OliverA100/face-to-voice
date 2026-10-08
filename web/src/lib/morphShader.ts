/**
 * The morph reveal's shader add-on, appended to every head part's material (components/scene/materials.ts): after all
 * of three's own vertex work (identity, emotion and blink morphs, the project step), each vertex is pulled onto a sphere
 * (the loader's bubble, placed in view space by Head.tsx) and released back to where it belongs as uMorph goes 0 → 1.
 *
 * - Face first: a vertex starts later the farther it is from the face point (between the eyes), by uMorphStagger
 *   (a slight lead in the shipped "swing", SWING; region by region in the lab's "pieces", MORPH).
 * - Layered, never coincident: each vertex keeps a little of its distance from the centre (LAYER), so surfaces that
 *   would land on the same spot of the sphere (ear and cheek, lips and teeth) keep their order instead of flickering;
 *   the eyes and the inside of the mouth sit a little inside the bubble (PART_SCALE) until they come out.
 * - Free at rest: uMorph = 1 on every normal frame, and the whole block is skipped.
 *
 * Every morphing material also has a look variant (define FTV_MORPH_LOOK, on only during the reveal: setMorphLookAll):
 * the loader's bumps on the vertices, and on the skin, eyes and pieces the loader's own shading (components/ui/loader/
 * chromeGl.ts) until the face has almost formed. morphFrame drives both from the reveal's progress. The variant is
 * compiled and drawn once in the background before the reveal (Head.tsx), so the head's first frame doesn't pay for it.
 *
 * Tweak here: SWING (shipped), MORPH (the lab's "D · Morph", and shared values: behind, span, layer, ao), PIECES.
 */
import { type Material, type ShaderMaterial, Vector3 } from "three";

import { CHROME, SOAP_BUBBLE } from "@/components/ui/loader/chrome";
import { CHROME_GL, NOISE, bubbleGlsl, polishUniforms, swingBack } from "@/components/ui/loader/chromeGl";
import { REVEALS } from "@/components/ui/loader/engine";
import { type MorphStyle, headMorph } from "@/lib/headMorph";

const DEG = Math.PI / 180;

/** D · Morph ("pieces" in lib/headMorph.ts), the lab's alternative reveal; also the values both styles share. */
export const MORPH = {
  behind: 0.07, // m, the sphere's centre sits this far behind the face point (inside the head): from a centre at the
  // face, almost the whole head maps onto the sphere's far side (culled), so the ball shrinks to the face oval mid-morph
  // and the eyeballs show at its sides
  stagger: 0.8, // how much later the farthest vertices start (fraction of the morph): the face forms first; spread
  // wide so regions take turns and the change is even (at 0.45 most of the head moves in the same 0.4 s)
  span: 0.3, // m, distance from the face point at which a vertex counts as farthest (head + neck)
  layer: 0.06, // how much of its distance from the centre a vertex keeps on the sphere (depth order at the start)
  look: [0.78, 0.96], // the whole surface stays bubble until the morph is this far, then turns to skin: the material
  // changes only once the face has almost formed …
  unpolish: [0.35, 0.78], // … and on the way the bubble's polish runs backwards, rainbow soap bubble → the loader's
  // matte white blob, so the reveal ends on the look the loader began with
  spikes: 0.2, // the loader's spiky noise on the skin as it is pulled into the face (× the bubble's radius, at its
  // peak halfway through each vertex's move; the loader's blob starts at 0.4; 0.28 looks crumpled)
  spikeDrift: 0.35, // how fast the spikes travel during the morph (noise units per second)
  ao: 0.6, // D and E: the skin's baked ambient occlusion under the bubble's look (0 = none, 1 = all light × AO), coming
  // in as each point lands. The bubble's look replaces the skin's whole colour, AO included: without this the forming
  // face has no shade in its eye sockets, nostrils or under the chin and reads flatter than the loader's blob, whose
  // deep bumps shade themselves. At 1 the lids' creases go black against white eyes (dark eye slits at the hand-over).
};

/**
 * E · One swing ("swing"), the shipped reveal. The morph is the loader's own last swing: from the bubble back towards
 * the blob, on the loader's curves, but landing on the face, so it reads as one motion rather than a sequence of
 * separate steps (D reads as a pause, a crumpled ball, hair pouring out on its own, then rainbow → white bust → skin).
 * One clock drives it all:
 * - the polish runs 1 → 0 at the loader's own swing pace and curve (its film, halo and gloss drain away as they do in
 *   the loader), and the bumps rise with it by the loader's own formula (polishUniforms: up to the blob's 0.4);
 * - every part (skin, eyes, mouth, hair, brows, lashes, beards, glasses) starts on the sphere and is released at the
 *   same rate (a slight face-first lead only), so the size grows from the first frame and nothing arrives late;
 * - the bumps ride on all of them at once (multiplied about the centre: one surface, layers keep their order) and
 *   flatten as each point reaches its place (× 1 − its progress), so they are gone as the face lands;
 * - the bubble's look turns to the real materials over the last stretch, overlapping the blob, never holding on it;
 * - it starts with the settled bubble's own resting wobble, noise pattern and turn (ScreenCircle), so it never stops.
 */
export const SWING = {
  // a slight face-first lead (D: 0.8), so the silhouette grows from the first frame; 0.2 holds the sides and back of
  // the head still for the morph's first ~0.25 s
  stagger: 0.05,
  polish: REVEALS.swing.polish, // the polish reaches the blob (0) at this fraction of the morph (set in engine.ts: the
  // loader runs the same curve from the bubble, ChromeDrive.through)
  // the real materials come in over this part of the morph, while it still moves ([0.68, 1] forms a white statue, then
  // paints it on a still face)
  look: [0.45, 0.85] as [number, number],
  // degrees the head starts turned away (about the neck, IdleLife) and turns back from while it forms, slowing as it
  // lands: the face turning to you reads as 3D, where a straight-on morph reads as a flat zoom. 0 = off
  turnIn: { yaw: 0, pitch: 0, from: 0.25 }, // `from`: the turn starts at this fraction of the morph (before, it would turn a blob)
};

/**
 * Hair, brows, lashes, beards and glasses come from the sphere at the same time as the face, under the bubble's look:
 * each piece forms with the patch of face under it (the same face-first timing), wears the bubble's look like the skin, and everything turns to
 * its own material together at the end (MORPH.look).
 * - Glasses and shell beards: pulled onto the sphere like the head (just inside it, PIECES.scale, so they don't sit on
 *   the bubble at the hand-over) and released with it.
 * - Strands (hair, brows, lashes, strand beards): each grows from its root as the skin under it forms (its root's own
 *   progress), and the whole strand is pulled with the skin, so it never floats off the morphing scalp. On the bubble
 *   they are shaded as part of its surface (the sphere's normal at their point).
 */
export const PIECES = {
  scale: 0.97, // glasses and shell beards start at this × the bubble's radius (just inside it)
  strandScale: 1.005, // strands ride just outside the skin they grow from
};

/**
 * The neck and shoulders, a lab option (off in the shipped reveal). Released like the rest, the bust leaves the bubble
 * first (each point moves a fixed share of its way, and the shoulders are twice as far as the face): its cut edge
 * sticks out of the bubble as a rainbow ribbon, then the bust swings up under the chin as a second object. On
 * (uMorphNeck 1): below the chin, points start inside the bubble (out of sight) and set off later, easing out, so the
 * neck grows down out from under the forming head and lands with it. By height below the face point (view space).
 */
export const NECK = {
  on: false, // the lab's toggle (morphFrame → uMorphNeck)
  top: 0.11, // m below the eyes where the neck starts to count (under the chin)…
  bottom: 0.2, // …and where it fully does (the bust below)
  scale: 0.85, // × the bubble's radius it starts at (inside, out of sight)
  delay: 0.35, // how much later (fraction of the morph) the neck and bust set off; they still land at the end
};

/** The look variant's define (on only during the reveal). */
const LOOK = "FTV_MORPH_LOOK";
/** Head parts drawn in the bubble's material during the morph (eyes and mouth too: otherwise an open mouth shows its
 * real red and teeth inside the white bubble face). The cornea (the clear shell: reflections only) keeps its own look;
 * every part moves and bumps with the rest. */
const LOOK_PARTS = ["skin", "sclera", "iris", "mouth", "gums", "teeth", "tongue"];

/** The inside of the mouth under the bubble's look, × its colour: shaded like a sculpted mouth (all white, an open mouth
 * reads as filled in). The teeth stay bright. */
const MOUTH_SHADE: Record<string, number> = { mouth: 0.45, tongue: 0.6, gums: 0.75 };

/** Radius of each part on the bubble, × the bubble: inner parts start inside it, out of sight. */
const PART_SCALE: Record<string, number> = { sclera: 0.95, iris: 0.95, cornea: 0.955, mouth: 0.92, gums: 0.92, teeth: 0.92, tongue: 0.92 };

/** Shared by every morphing material; Head.tsx writes them. View space: the bubble stays where the loader drew it. */
export const morphUniforms = {
  uMorph: { value: 1 },
  uMorphStagger: { value: SWING.stagger },
  uMorphPolish: { value: 1 }, // the bubble's polish (1 = the finish … 0 = the loader's blob): morphFrame
  uMorphSkin: { value: 1 }, // 0 = the bubble's look … 1 = the part's own (1 at rest: Head.tsx's warm-up draw)
  uMorphBumps: { value: 0 }, // the bumps on every part (× its distance from the centre, × 1 − its progress): E
  uMorphMid: { value: 0 }, // the skin's bumps peaking halfway through its move (× the bubble's radius): D
  uMorphGrow: { value: 0 }, // 1 = strands grow from their roots (D), 0 = they ride the sphere like the skin (E)
  uMorphTurn: { value: 0 }, // the loader sphere's turn at the hand-over (the bumps' pattern lines up)
  uMorphHue: { value: 0 }, // the loader sphere's clock at the hand-over (its film's colours)
  uMorphCentre: { value: new Vector3() },
  uMorphFace: { value: new Vector3() },
  uMorphRadius: { value: 0.1 },
  uMorphDrift: { value: 0 }, // the bumps' noise offset (morphFrame moves it during the morph)
  uMorphNeck: { value: 0 }, // 1 = the neck and bust start inside the bubble and set off later (NECK)
};

const smooth = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/** Each frame of a morph (Head.tsx): the uniforms at progress `t`, the noise moved on by `dt` seconds. */
export function morphFrame(style: MorphStyle, t: number, dt: number): void {
  const u = morphUniforms;
  u.uMorph.value = t;
  const away = 1 - smooth(SWING.turnIn.from, 1, t); // held while it is still a blob, then turning as the face forms, landing softly
  headMorph.yaw = style === "swing" ? SWING.turnIn.yaw * DEG * away : 0;
  headMorph.pitch = style === "swing" ? SWING.turnIn.pitch * DEG * away : 0;
  if (style === "pieces") {
    u.uMorphNeck.value = 0;
    u.uMorphStagger.value = MORPH.stagger;
    u.uMorphPolish.value = 1 - smooth(MORPH.unpolish[0], MORPH.unpolish[1], t);
    u.uMorphSkin.value = smooth(MORPH.look[0], MORPH.look[1], t);
    u.uMorphBumps.value = 0;
    u.uMorphMid.value = MORPH.spikes;
    u.uMorphGrow.value = 1;
    u.uMorphDrift.value += dt * MORPH.spikeDrift;
    return;
  }
  // The loader's swing from the finish towards the blob (createChromeFlow: mostly steady, easing into the turns by
  // `dwell`), its bumps (polishUniforms) and its noise speed (fast as a blob, slow at rest).
  const fin = CHROME.finish ?? SOAP_BUBBLE;
  const p = swingBack(Math.min(1, t / SWING.polish), CHROME.dwell);
  const ease = (1 + Math.cos(p * Math.PI)) / 2;
  u.uMorphStagger.value = SWING.stagger;
  u.uMorphNeck.value = NECK.on ? 1 : 0;
  u.uMorphPolish.value = p;
  u.uMorphSkin.value = smooth(SWING.look[0], SWING.look[1], t);
  u.uMorphBumps.value = polishUniforms(p, CHROME.amp, fin).amp;
  u.uMorphMid.value = 0;
  u.uMorphGrow.value = 0;
  u.uMorphDrift.value += dt * (CHROME.speed * ease + fin.restSpeed * (1 - ease));
}

const f = (n: number) => n.toFixed(4);
/** The loader's bumps at a direction `d` from the centre: its noise in its own (turned) frame; `g` = the gradient, in view space. */
const BUMP = `#ifdef ${LOOK}
uniform float uMorphDrift, uMorphTurn, uMorphBumps, uMorphMid;
${NOISE}
float morphBump(vec3 d, out vec3 g) {
  float c = cos(uMorphTurn), s = sin(uMorphTurn);
  vec3 q = vec3(c * d.x - s * d.z, d.y, s * d.x + c * d.z), gq;
  float n = snoise(q * ${f(CHROME_GL.frequency)} + vec3(uMorphDrift, 0.0, 0.0), gq);
  g = vec3(c * gq.x + s * gq.z, gq.y, -s * gq.x + c * gq.z) * ${f(CHROME_GL.frequency)};
  return n;
}
#endif`;
/** GLSL shared by the head parts and the strands: how much a view-space point counts as neck or bust (NECK). */
const NECK_GLSL = `uniform float uMorphNeck;
float morphNeck(vec3 p) { return uMorphNeck * smoothstep(${f(NECK.top)}, ${f(NECK.bottom)}, uMorphFace.y - p.y); }`;
const DECLARE = `uniform float uMorph, uMorphRadius, uMorphPart, uMorphStagger;
uniform vec3 uMorphCentre, uMorphFace;
varying float vMorphK;
${NECK_GLSL}
${BUMP}`;

/** A point's own progress (0 on the sphere … 1 in place) from its view-space position `p`: the face first. */
const progress = (p: string) =>
  `clamp((clamp(uMorph * (1.0 + uMorphStagger) - uMorphStagger * clamp(length(${p} - uMorphFace) / ${f(MORPH.span)}, 0.0, 1.0), 0.0, 1.0) - ${f(NECK.delay)} * morphNeck(${p})) / (1.0 - ${f(NECK.delay)} * morphNeck(${p})), 0.0, 1.0)`; // (the neck: later, NECK)
/** Pull the view-space `mv` (vec4) onto the sphere by 1 − `k` (keeps its depth order: LAYER). */
const pull = (mv: string, k: string) => `{
  vec3 dC = ${mv}.xyz - uMorphCentre;
  float dist = max(length(dC), 1e-5);
  float r = uMorphRadius * uMorphPart * (1.0 + ${f(MORPH.layer)} * min(dist / ${f(MORPH.span)}, 1.0)) * (1.0 - ${f(1 - NECK.scale)} * morphNeck(${mv}.xyz));
  ${mv}.xyz = mix(uMorphCentre + dC / dist * r, ${mv}.xyz, ${k});
}`;

/**
 * The loader's bumps (look variant: during the reveal only) on a pulled point `mv` (vec4, view space) at progress `k`:
 * E's uMorphBumps on every part, flattening as the point lands, plus D's halfway bumps on the head (FTV_MORPH_SPIKES).
 * Scaled by the distance from the centre: one surface, every layer moved alike, so they keep their order.
 */
const bumps = (mv: string, k: string, normal: boolean) => `{
  vec3 bC = ${mv}.xyz - uMorphCentre;
  float bD = max(length(bC), 1e-5);
  vec3 bDir = bC / bD, bG;
  float bRel = uMorphBumps * (1.0 - ${k}), bMid = 0.0;
  #ifdef FTV_MORPH_SPIKES
  bMid = uMorphMid * 4.0 * ${k} * (1.0 - ${k});
  #endif
  if (bRel + bMid > 0.0) {
    float bN = morphBump(bDir, bG);
    ${mv}.xyz += bDir * (bD * bRel + uMorphRadius * bMid) * bN;${
      normal
        ? `
    #ifndef FLAT_SHADED
    vNormal = normalize(vNormal - (bRel + bMid) * (bG - dot(bG, bDir) * bDir)); // the loader's own normal tilt
    #endif`
        : ""
    }
  }
}`;

/**
 * The morph for a three material (head parts, glasses, shell beards) after <project_vertex>: pull, bend the normal, the
 * bumps, then gl_Position again.
 */
const MESH_VERTEX = `
vMorphK = 1.0;
if (uMorph < 1.0) {
  float k = ${progress("mvPosition.xyz")};
  k = k * k * (3.0 - 2.0 * k);
  vMorphK = k;
  vec3 dC = mvPosition.xyz - uMorphCentre;
  float dist = max(length(dC), 1e-5);
  ${pull("mvPosition", "k")}
  #ifndef FLAT_SHADED
  vNormal = normalize(mix(dC / dist, vNormal, k));
  #endif
  #ifdef ${LOOK}
  ${bumps("mvPosition", "k", true)}
  #endif
  gl_Position = projectionMatrix * mvPosition;
}`;

/** The strands' vertex shader (lib/groom.ts; s, off and pos are its own: strand index, root offset, this point). */
const STRAND_DECLARE = `uniform float uMorph, uMorphRadius, uMorphPart, uMorphStagger, uMorphGrow;
uniform vec3 uMorphCentre, uMorphFace;
varying float vMorphGrow;
${NECK_GLSL}
${BUMP}`;
/** Before the point goes to view space: the strand grows from its root by its root's progress (D: uMorphGrow 1). */
const STRAND_GROW = `
vMorphGrow = 1.0;
float sk = 1.0;
if (uMorph < 1.0) {
  vec3 gRoot = fetchP(s, 0).xyz + off;
  sk = ${progress("(modelViewMatrix * vec4(gRoot, 1.0)).xyz")};
  sk = sk * sk * (3.0 - 2.0 * sk);
  vMorphGrow = mix(1.0, sk, uMorphGrow);
  pos = gRoot + (pos - gRoot) * vMorphGrow;
}`;
/** After: the whole strand is pulled with the skin it grows from (the root's progress, so the strand keeps its shape), and bumps with it. */
const STRAND_PULL = `
if (uMorph < 1.0) {
  ${pull("mv", "sk")}
  #ifdef ${LOOK}
  ${bumps("mv", "sk", false)}
  #endif
}`;

/**
 * The bubble's look (variant only): the finished sphere's own shading (components/ui/loader/chromeGl.ts, the same
 * functions the loader draws with), in view space, until the morph reaches MORPH.look, then the part's own colour.
 * `normal`/`view`: GLSL for the surface normal and the direction to the eye; `fab`: "lut" reads (scale, bias) from
 * three's DFG table, "schlick" a stand-in for shaders without it (the strands).
 */
function lookGlsl(o: { normal: string; view: string; fab: "lut" | "schlick"; extra?: string; ao?: string; shade?: number }) {
  const b = bubbleGlsl(CHROME.finish ?? SOAP_BUBBLE);
  return {
    declare: `#ifdef ${LOOK}\nuniform float uMorphHue, uMorphSkin, uMorphPolish;\n${o.extra ?? ""}\n${b}\n#endif`,
    apply: `
#ifdef ${LOOK}
float bSkin = uMorphSkin;
if (bSkin < 1.0) {
  vec3 bN = ${o.normal}, bV = ${o.view};
  float bNv = clamp(dot(bN, bV), 0.0, 1.0);
  float bP = uMorphPolish; // the polish, running back to the blob's (morphFrame)
  vec2 bFab = ${o.fab === "lut" ? "texture2D(dfgLUT, vec2(chRough(bP), bNv)).rg" : "vec2(1.0 - pow(1.0 - bNv, 5.0), pow(1.0 - bNv, 5.0))"};
  vec3 bCol = chBubble(bN, bV, bFab, uMorphHue, bP);${
    o.ao ? `
  bCol *= pow(mix(1.0, clamp(${o.ao}, 0.0, 1.0), ${f(MORPH.ao)} * vMorphK), ${f(1 / 2.2)}); // AO on the light, in display sRGB` : ""
  }${o.shade !== undefined ? `
  bCol *= ${f(o.shade)}; // MOUTH_SHADE` : ""}
  gl_FragColor.rgb = mix(bCol, gl_FragColor.rgb, bSkin);
}
#endif`,
  };
}

/** Materials with a look variant (head parts, pieces), so a reveal switches them all (setMorphLookAll). */
const lookMaterials = new Set<Material>();
const registerLook = (material: Material) => {
  lookMaterials.add(material);
  material.addEventListener("dispose", () => lookMaterials.delete(material));
};

/**
 * Switch a material's look variant on (for a morph reveal) or off (after it). Both programs stay cached on the material
 * (three keeps one per define set), so after the background compile (Head.tsx) switching costs nothing.
 */
function setMorphLook(material: Material, on: boolean): void {
  const defines = (material.defines ??= {});
  if (on === LOOK in defines) return;
  if (on) defines[LOOK] = "";
  else delete defines[LOOK];
  material.needsUpdate = true;
}

/** Every material with a look variant (head, eyes, hair, brows, lashes, beards, glasses). */
export function setMorphLookAll(on: boolean): void {
  for (const m of lookMaterials) setMorphLook(m, on);
}

/**
 * Append the morph to `material`'s own shader hook (it keeps whatever the part's installer set up). `part` "piece":
 * a glasses or beard-shell material (lib/addons.ts, lib/beardShells.ts).
 */
export function installMorph(material: Material, part: string): void {
  if (material.userData.morph) return; // once per material
  material.userData.morph = true;
  const prev = material.onBeforeCompile;
  const prevKey = material.customProgramCacheKey;
  const piece = part === "piece";
  const scale = piece ? PIECES.scale : (PART_SCALE[part] ?? 1);
  const look = piece || LOOK_PARTS.includes(part);
  registerLook(material); // every part bumps during the reveal (the mouth and cornea too: they stay under the skin)
  material.onBeforeCompile = (shader, renderer) => {
    prev.call(material, shader, renderer);
    Object.assign(shader.uniforms, morphUniforms, { uMorphPart: { value: scale } });
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", `#include <common>\n${DECLARE}`)
      .replace("#include <project_vertex>", `#include <project_vertex>\n${MESH_VERTEX}`);
    // D's halfway bumps on every head part, not just the skin: where only the skin dips, the mouth shows through it
    if (!piece) shader.vertexShader = `#define FTV_MORPH_SPIKES\n${shader.vertexShader}`;
    if (look) {
      const ao = part === "skin" ? "skinReg.r" : undefined; // lib/skinShader.ts: the regions map's AO (1 until it loads)
      const l = lookGlsl({ normal: "normalize(vNormal)", view: "normalize(vViewPosition)", fab: "lut", extra: "uniform float uMorph;\nvarying float vMorphK;", ao, shade: MOUTH_SHADE[part] });
      shader.fragmentShader = shader.fragmentShader
        .replace("#include <common>", `#include <common>\n${l.declare}`)
        .replace("#include <dithering_fragment>", `#include <dithering_fragment>\n${l.apply}`);
    }
  };
  material.customProgramCacheKey = () => `${prevKey.call(material)}|morph12`;
}

/**
 * The strands (hair, brows, lashes, strand beards: a ShaderMaterial, lib/groom.ts): they grow and are pulled with the
 * skin (STRAND_GROW before `anchor`, the line that takes the point to view space as `mv`; STRAND_PULL after it), and
 * wear the bubble's look as part of its surface. A strand not yet started isn't drawn (at zero length the ≥ 1 px rule
 * would still draw a one-pixel dot at its root).
 */
export function installStrandMorph(material: ShaderMaterial, anchor: string): void {
  Object.assign(material.uniforms, morphUniforms, { uMorphPart: { value: PIECES.strandScale } });
  if (!material.vertexShader.includes(anchor) || !material.fragmentShader.includes("#include <colorspace_fragment>"))
    return console.warn("morphShader: the strand shader changed; no morph");
  registerLook(material);
  material.vertexShader = `${STRAND_DECLARE}\n${material.vertexShader.replace(anchor, `${STRAND_GROW}\n${anchor}\n${STRAND_PULL}`)}`;
  const l = lookGlsl({ normal: "normalize(vViewPos - uMorphCentre)", view: "normalize(-vViewPos)", fab: "schlick", extra: "uniform vec3 uMorphCentre;" });
  material.fragmentShader = `uniform float uMorph;\nvarying float vMorphGrow;\n${l.declare}\n${material.fragmentShader
    .replace(/void main\(\)\s*\{/, (m) => `${m}\n  if (vMorphGrow < 0.02) discard;`)
    .replace("#include <colorspace_fragment>", `#include <colorspace_fragment>\n${l.apply}`)}`;
}
