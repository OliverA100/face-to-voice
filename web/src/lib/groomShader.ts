/**
 * The strand shaders (lib/groom.ts buildGroom). Vertex: one camera-facing ribbon per strand, at least ~1 px wide and
 * faded by how much of that pixel the strand really covers, child strands placed round their parent, the roots moved
 * with the skin and lashes turned with the lid. Fragment: Kajiya-Kay hair lighting from the scene's directional lights,
 * the baked self-shadow and the root → tip colour ramp.
 */

export const VERTEX = /* glsl */ `
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
uniform float uShapeFollow; // … on (1) or off (0) (lib/groomFollow.ts followShapePoints)
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

export const FRAGMENT = /* glsl */ `
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
