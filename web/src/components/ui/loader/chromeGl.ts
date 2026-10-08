/**
 * The chrome loader's renderer: a bare WebGL1 canvas, one sphere mesh, one shader pair, no libraries (the loader must
 * paint and run before three.js is anywhere near the page; three.js for this look would be ~136 KB gzip and ~0.4 s of
 * shader compiles before the first frame).
 *
 * The look reproduces a reference three.js scene (a MeshPhysicalMaterial sphere displaced by simplex noise, lit by
 * RoomEnvironment, with a rainbow fresnel halo), rebuilt on the GPU:
 * - Vertex shader: simplex noise pushes each vertex of a unit sphere along its normal; the normal comes from the same
 *   noise's gradient (no per-frame CPU work, no computeVertexNormals).
 * - Fragment shader: a small MeshPhysicalMaterial (white base, metalness, roughness, Fresnel, multiple scattering, a
 *   GGX key light, ACES tone mapping, sRGB) whose reflections come from RoomEnvironment traced analytically: the ray
 *   finds the room's walls, its six grey boxes (lit by the room's one point light) and its six glowing panels, softened by
 *   the same blur PMREM would apply at that roughness. The matte light on the early blob is the room's irradiance as 9
 *   spherical-harmonic numbers, measured once from three's own render of the room. No PMREM, no textures: startup is a
 *   shader compile.
 * - The rainbow halo is added after tone mapping, as in the reference.
 *
 * Nothing runs per frame except `draw` (a few uniforms + one draw call).
 *
 * Third-party code and data (see NOTICE):
 * - NOISE is adapted from webgl-noise (noise3Dgrad.glsl, https://github.com/stegu/webgl-noise).
 *   Copyright (C) 2011 by Ashima Arts (Simplex noise). Copyright (C) 2011-2016 by Stefan Gustavson (Classic noise and
 *   others). MIT License.
 * - ROOM, POINT, BOXES and PANELS transcribe the layout of three.js's RoomEnvironment
 *   (examples/jsm/environments/RoomEnvironment.js), and DFG is a 7×16 slice of its DFG lookup table
 *   (src/renderers/shaders/DFGLUTData.js). Copyright © 2010-2026 three.js authors. MIT License
 *   (https://github.com/mrdoob/three.js).
 */

/** One frame's inputs (see createChromeFlow). */
export interface ChromeFrame {
  time: number; // clock (s): turns the sphere, cycles the halo's colours
  drift: number; // how far the noise has moved (its speed eases with the polish, so it is integrated: createChromeFlow)
  polish: number; // 0 = lumpy matte blob … 1 = the finish
}

type Rgb = [number, number, number];

/**
 * How the sphere ends up at 100 %. Every finish opens on the same matte white blob (one poster for all); the polish
 * takes it to these values.
 */
export interface ChromeFinish {
  rest: number; // bumps left at 100 % (sphere radii; 0 = perfectly smooth)
  restSpeed: number; // noise drift per second at 100 % (at 0 %: ChromeLook.speed)
  rough: number; // roughness at 100 % (the reference: 0.1)
  metal: number; // metalness at 100 % (the reference: 1)
  halo: number; // rainbow rim at 100 % (the reference: 0.6)
  irid: number; // 0..1, a thin-film rainbow across the whole surface at 100 % (soap bubble, oil on metal)
  filmBody?: number; // how much the film also tints a non-metal body (default CHROME_GL.film.body; 0: reflections only)
  film?: Rgb[]; // the film's colours instead of a rainbow: three linear colours it cycles through (each at full brightness)
  base: Rgb; // surface colour at 100 % (white = chrome or porcelain, a colour = lacquer, near black = obsidian)
  base2?: Rgb; // with base: a gradient, base at the bottom → base2 at the top
  opacity?: number; // < 1: see-through at 100 % like glass (the rim stays solid)
  tint?: { walls: Rgb; panels: Rgb[] }; // the reflected room's colours at 100 % (six panels; white when absent)
  shape?: { kind: ShapeKind; k: number; spin?: number }; // a form it settles into (k = how much; spin = radians per
  // second it turns in the picture plane, default CHROME_GL.shapeSpin)
}

/** Per-sphere settings (from chrome.tsx CHROME). */
export interface ChromeLook {
  amp: number; // bump height at polish 0 (sphere radii; the reference's 0.4)
  speed: number; // noise drift per clock second
  turn: number; // radians the sphere turns per clock second
  finish: ChromeFinish;
  fov: number; // degrees, camera at (0, 0, distance) looking at the sphere
  distance: number;
  dprMax: number;
  sync?: boolean; // compile and size now, so the very first frame can draw
  pixels?: number; // a fixed square size in device pixels instead of tracking the canvas's CSS size (the poster render)
  size?: [number, number]; // a starting size in device pixels, then resize() (an OffscreenCanvas in the worker)
}

export interface ChromeGl {
  ready(): boolean;
  /** Draw one frame; false if not ready or the context is gone. */
  draw(f: ChromeFrame): boolean;
  /** Device-pixel width, changes on resize. */
  width(): number;
  resize(width: number, height: number): void;
  /** Wait until the GPU has run the last draw (the worker paces its clock on it). */
  finish(): void;
  dispose(): void;
}

/** The fixed parts of the look (the reference's scene); tweak here. */
export const CHROME_GL = {
  segments: 128, // sphere segments around and top to bottom (the reference's SphereGeometry(1, 128, 128))
  frequency: 1.5, // noise scale on the unit sphere
  light: 1.2, // key light intensity, from (3, 3, 3)
  halo: { power: 3, bands: 1.5, cycle: 0.05 }, // fresnel exponent, rainbow repeats across the rim, hue turns per second
  film: { bands: 1.7, flow: 0.35, cycle: 0.03, gain: 1.8, gainColours: 1.25, body: 0.45 }, // iridescent finishes:
  // rainbow repeats from centre to rim, how much the surface's tilt shifts it, hue turns per second, brightness of the
  // coloured reflection (rainbow; a finish's own colours), how much the film also tints a non-metal body
  shapeSpin: 0.1, // radians per second a finish's form spins in the picture plane
  blur: 0.04, // radians, the PMREM blur of the whole room (fromScene's sigma)
};

/**
 * The reference's setPolish, towards a finish: bumps, roughness and shape ease (cosine) from the blob's values to the
 * finish's; metalness, halo, iridescence and the colours rise linearly. The plain chrome finish is the reference exactly.
 */
export function polishUniforms(p: number, amp: number, fin: ChromeFinish) {
  const ease = (1 + Math.cos(p * Math.PI)) / 2, u = 1 - ease;
  return { amp: ease * amp + u * fin.rest, shape: u * (fin.shape?.k ?? 0), rough: ease * 0.2 + u * fin.rough, metal: p * fin.metal, halo: p * fin.halo, irid: p * fin.irid, fin: p };
}

const f = (n: number) => (Number.isInteger(n) ? n.toFixed(1) : String(+n.toFixed(5)));
const v3 = (a: number[]) => `vec3(${a.map(f).join(",")})`;

// RoomEnvironment (three/examples/jsm/environments/RoomEnvironment.js), in its own coordinates: the PMREM camera sits at
// the scene origin, which is (0, 3.5, 0) here (the room is moved down 3.5).
const ROOM = { c: [-0.757, 13.219, 0.717], s: [31.713, 28.305, 28.591] };
const POINT = { at: [0.418, 16.199, 0.3], intensity: 900, cutoff: 28 };
const BOXES = [
  { c: [-10.906, 2.009, 1.846], a: -0.195, s: [2.328, 7.905, 4.651] },
  { c: [-5.607, -0.754, -0.758], a: 0.994, s: [1.97, 1.534, 3.955] },
  { c: [6.167, 0.857, 7.803], a: 0.561, s: [3.927, 6.285, 3.687] },
  { c: [-2.017, 0.018, 6.124], a: 0.333, s: [2.002, 4.566, 2.064] },
  { c: [2.291, -0.756, -2.621], a: -0.286, s: [1.546, 1.552, 1.496] },
  { c: [-2.193, -0.369, -5.547], a: 0.516, s: [3.875, 3.487, 2.986] },
];
const PANELS = [
  { c: [-16.116, 14.37, 8.208], s: [0.1, 2.428, 2.739], i: 50 },
  { c: [-16.109, 18.021, -8.207], s: [0.1, 2.425, 2.751], i: 50 },
  { c: [14.904, 12.198, -1.832], s: [0.15, 4.265, 6.331], i: 17 },
  { c: [-0.462, 8.89, 14.52], s: [4.38, 5.441, 0.088], i: 43 },
  { c: [3.235, 11.486, -12.541], s: [2.5, 2.0, 0.1], i: 20 },
  { c: [0, 20, 0], s: [1.0, 0.1, 1.0], i: 100 },
];
// The room's irradiance / π (grey: everything in it is white), as SH terms 1, y, z, x, xy, yz, z², xz, x²−y² (three's
// LightProbeGenerator on a 128 px cube render of the room, folded with shGetIrradianceAt's constants).
const SH = [1.056 - 0.0965, 0.5717, 0.5335, 0.0896, 0.0587, 0.2975, 0.2894, -0.0952, -0.0833];

/** The room's blur taps sit this many sigmas out (5 taps at ±1.1σ come close to the reference's Gaussian on the box edges). */
const ROOM_TAP = 1.1;

/**
 * three's DFG table (renderers/shaders/DFGLUTData.js: scale, bias by roughness across × dotNV down), the 7 columns
 * the finishes use (roughness up to 0.41), as bytes. The usual analytic fit (Karis) loses 5–11 % of a smooth metal's
 * reflection at these roughnesses and fills it with flat irradiance, which would lift the room's dark corners.
 */
const DFG = "JtkqyT6jX4R/appTrkFjnGSZaYt0codam0atNpJtkmyUZ5danUmnObIstUq1SrVItUK1OLgtuyPOMc4xzjDMLcooyCLGG+Af4B/fH94e2xzWGNAU7BPsE+sT6hPmEuEQ2Q70C/QL8wvyC+8L6QrhCfkG+Qb5BvcG9QbvBucG/AP8A/wD+wP4A/MD6wP+Af4B/QH9AfoC9gLvAv8A/wD+AP4B/AH4AfEB/wD/AP8A/gD8APkA8wD/AP8A/wD+AP0A+gD0AP8A/wD/AP4A/QD6APUA/wD/AP8A/gD9APsA9gA=";
const DFG_COLS = 7;

const half = (s: number[]) => s.map((x) => x / 2);
const thin = (s: number[]) => s.indexOf(Math.min(...s)); // a panel's flat axis
const AXES = ["vec3(1.,0.,0.)", "vec3(0.,1.,0.)", "vec3(0.,0.,1.)"];

// Simplex noise with its gradient: webgl-noise by Ian McEwan (Ashima Arts) and Stefan Gustavson, noise3Dgrad.glsl.
// Copyright (C) 2011 Ashima Arts, Copyright (C) 2011-2016 Stefan Gustavson; MIT License
// (https://github.com/stegu/webgl-noise/blob/master/LICENSE). Adapted: minified, with the 0.6 kernel and 42 scale of the
// original (closest to three's SimplexNoise).
export const NOISE = `
vec3 m289(vec3 x){return x-floor(x*(1./289.))*289.;}
vec4 m289(vec4 x){return x-floor(x*(1./289.))*289.;}
vec4 perm(vec4 x){return m289(((x*34.)+10.)*x);}
float snoise(vec3 v,out vec3 grad){
const vec2 C=vec2(1./6.,1./3.);const vec4 D=vec4(0.,.5,1.,2.);
vec3 i=floor(v+dot(v,C.yyy)),x0=v-i+dot(i,C.xxx),g=step(x0.yzx,x0.xyz),l=1.-g,i1=min(g.xyz,l.zxy),i2=max(g.xyz,l.zxy);
vec3 x1=x0-i1+C.xxx,x2=x0-i2+C.yyy,x3=x0-D.yyy;
i=m289(i);
vec4 p=perm(perm(perm(i.z+vec4(0.,i1.z,i2.z,1.))+i.y+vec4(0.,i1.y,i2.y,1.))+i.x+vec4(0.,i1.x,i2.x,1.));
vec3 ns=.142857142857*D.wyz-D.xzx;
vec4 j=p-49.*floor(p*ns.z*ns.z),x_=floor(j*ns.z),y_=floor(j-7.*x_),x=x_*ns.x+ns.yyyy,y=y_*ns.x+ns.yyyy,h=1.-abs(x)-abs(y);
vec4 b0=vec4(x.xy,y.xy),b1=vec4(x.zw,y.zw),s0=floor(b0)*2.+1.,s1=floor(b1)*2.+1.,sh=-step(h,vec4(0.));
vec4 a0=b0.xzyw+s0.xzyw*sh.xxyy,a1=b1.xzyw+s1.xzyw*sh.zzww;
vec3 p0=vec3(a0.xy,h.x),p1=vec3(a0.zw,h.y),p2=vec3(a1.xy,h.z),p3=vec3(a1.zw,h.w);
vec4 nm=1.79284291400159-.85373472095314*vec4(dot(p0,p0),dot(p1,p1),dot(p2,p2),dot(p3,p3));
p0*=nm.x;p1*=nm.y;p2*=nm.z;p3*=nm.w;
vec4 m=max(.6-vec4(dot(x0,x0),dot(x1,x1),dot(x2,x2),dot(x3,x3)),0.),m2=m*m,m4=m2*m2;
vec4 pdx=vec4(dot(p0,x0),dot(p1,x1),dot(p2,x2),dot(p3,x3)),t=m2*m*pdx;
grad=42.*(-8.*(t.x*x0+t.y*x1+t.z*x2+t.w*x3)+m4.x*p0+m4.y*p1+m4.z*p2+m4.w*p3);
return 42.*dot(m4,pdx);}`;

// A finish's form as a radial offset s(q) on the unit sphere and its gradient (q in view space: the form faces the
// camera and spins slowly in the picture plane while the surface turns under it).
export type ShapeKind = "pebble" | "trefoil" | "clover" | "star" | "cube" | "tetra" | "octa" | "drop";
const SHAPES: Record<ShapeKind | "none", string> = {
  none: "g=vec3(0.);return 0.;",
  star: "float x=q.x,y=q.y,x2=x*x,y2=y*y;g=vec3(5.*x2*x2-30.*x2*y2+5.*y2*y2,20.*x*y*(y2-x2),0.);return x*(x2*x2-10.*x2*y2+5.*y2*y2);", // five soft points
  tetra: "g=5.*q.yxx*q.zzy;return 5.*q.x*q.y*q.z;", // a rounded tetrahedron
  octa: "g=-4.*q*q*q;return .6-dot(q*q,q*q);", // a rounded octahedron (a soft diamond face-on)
  drop: "float y=max(q.y,0.),y2=y*y;g=vec3(0.,14.4*y2*y2*y,0.);return 2.4*y2*y2*y2-.3;", // a droplet, point up
  pebble: "g=vec3(2.*q.x,-4.*q.y,2.*q.z);return q.x*q.x+q.z*q.z-2.*q.y*q.y;", // squashed: a smooth river stone
  trefoil: "g=vec3(3.*q.x*q.x-3.*q.y*q.y,-6.*q.x*q.y,0.);return q.x*q.x*q.x-3.*q.x*q.y*q.y;", // three soft lobes
  clover: "g=vec3(4.*q.x*q.x*q.x-12.*q.x*q.y*q.y,4.*q.y*q.y*q.y-12.*q.x*q.x*q.y,0.);return q.x*q.x*q.x*q.x-6.*q.x*q.x*q.y*q.y+q.y*q.y*q.y*q.y;", // four
  cube: "g=4.*q*q*q;return dot(q*q,q*q)-.6;", // a rounded cube
};

const vert = (o: ChromeLook, proj = 1 / Math.tan(((o.fov / 2) * Math.PI) / 180)) => `
attribute vec3 aP;
uniform float uT,uDrift,uAmp,uShape,uTurn,uAspect;
varying vec3 vN,vP;
${NOISE}
float shape(vec3 q,out vec3 g){${SHAPES[o.finish.shape?.kind ?? "none"]}}
void main(){
float a=uT*uTurn,c=cos(a),s=sin(a),b=uT*${f(o.finish.shape?.spin ?? CHROME_GL.shapeSpin)},cb=cos(b),sb=sin(b);
mat3 R=mat3(c,0.,-s,0.,1.,0.,s,0.,c),Z=mat3(cb,sb,0.,-sb,cb,0.,0.,0.,1.);
vec3 g,gs;
float n=snoise(aP*${f(CHROME_GL.frequency)}+vec3(uDrift,0.,0.),g),sh=shape(Z*(R*aP),gs),r=1.+uAmp*n+uShape*sh;
vec3 G=uAmp*${f(CHROME_GL.frequency)}*g+uShape*((gs*Z)*R);
vec3 N=normalize(aP-(G-dot(G,aP)*aP)/r);
vN=R*N;vP=R*(aP*r);
vec3 e=vP-vec3(0.,0.,${f(o.distance)});
gl_Position=vec4(e.x*${f(proj)}/uAspect,e.y*${f(proj)},e.z*${f(-100.1 / 99.9)}-${f((2 * 100 * 0.1) / 99.9)},-e.z);
}`;

const box = (b: (typeof BOXES)[number]) => {
  const c = Math.cos(b.a), s = Math.sin(b.a);
  return `chBox(O,D,${v3(b.c)},${v3(half(b.s))},mat3(${f(c)},0.,${f(s)},0.,1.,0.,${f(-s)},0.,${f(c)}),t,n);`;
};
const WHITE: Rgb = [1, 1, 1];
const panel = (p: (typeof PANELS)[number], i: number, fin: ChromeFinish) =>
  `L+=${f(p.i)}*chPanel(O,D,${v3(p.c)},${v3(half(p.s))},${AXES[thin(p.s)]},t,sg,cv)*mix(vec3(1.),${v3(fin.tint?.panels[i] ?? WHITE)},fin);`;

/** The film's colour at phase fh: a rainbow, or the finish's three colours in turn. */
const film = (fin: ChromeFinish) => {
  if (!fin.film) return `vec3 film=(.5+.5*cos(6.28318*(fh+vec3(0.,.33,.67))))*${f(CHROME_GL.film.gain)};`;
  const [a, b, c] = fin.film.map(v3);
  return `float fq=fract(fh)*3.;vec3 film=(fq<1.?mix(${a},${b},fq):fq<2.?mix(${b},${c},fq-1.):mix(${c},${a},fq-2.))*${f(CHROME_GL.film.gainColours)};`;
};

/**
 * The look as GLSL functions (prefixed ch*, no uniforms, no precision line): the loader's own fragment shader calls
 * chShade, and the 3D head's skin calls it too during the morph reveal (bubbleGlsl), so the bubble it starts as is the
 * loader's bubble. `fab` is the DFG table's (scale, bias) for the roughness and N·V (each caller has its own table).
 */
const shadeLib = (fin: ChromeFinish, taps: 1 | 5 = 5) => `
// A Y-rotated box (Ri = world→box rotation): nearest hit before t, its normal into n.
void chBox(vec3 O,vec3 D,vec3 c,vec3 h,mat3 Ri,inout float t,inout vec3 n){
vec3 o=Ri*(O-c),d=Ri*D,iv=1./d,t1=(-h-o)*iv,t2=(h-o)*iv,tn=min(t1,t2),tf=max(t1,t2);
float a=max(max(tn.x,tn.y),tn.z),b=min(min(tf.x,tf.y),tf.z);
if(a<b&&a>0.&&a<t){t=a;vec3 m=step(tn.yzx,tn)*step(tn.zxy,tn);n=(-sign(d)*m)*Ri;}}
// A glowing panel seen through a Gaussian blur of sg radians: its coverage (0..1), unless something is in front (t).
vec3 chLg(vec3 x){return 1./(1.+exp(-1.702*x));}
float chPanel(vec3 O,vec3 D,vec3 c,vec3 h,vec3 ax,float t,float sg,inout float cv){
float th=dot(c-O,ax)/dot(D,ax);
if(th<=0.||th>t)return 0.;
vec3 q=abs(O+th*D-c)/h,s=max(sg*th/h,1e-3),k=chLg((1.-q)/s)-chLg((-1.-q)/s);
float k2=mix(k.x,1.,ax.x)*mix(k.y,1.,ax.y)*mix(k.z,1.,ax.z);
cv=max(cv,k2);return k2;}
// The lit room along D: the walls and boxes, shaded by the room's point light. t = the distance to what it hits.
float chRoom(vec3 O,vec3 D,out float t){
vec3 rc=${v3(ROOM.c)},rh=${v3(half(ROOM.s))};
D+=step(abs(D),vec3(1e-5))*1e-5;
vec3 tw=(rc+sign(D)*rh-O)/D;
t=min(min(tw.x,tw.y),tw.z);
vec3 n=-sign(D)*step(tw,tw.yzx)*step(tw,tw.zxy);
${BOXES.map(box).join("\n")}
vec3 P=O+t*D,Lv=${v3(POINT.at)}-P;
float d=length(Lv),w=clamp(1.-pow(d/${f(POINT.cutoff)},4.),0.,1.);
vec3 l=Lv/d,h=normalize(l-D);
float nl=max(dot(n,l),0.),nv=max(dot(n,-D),1e-4),F=exp2((-5.55473*dot(-D,h)-6.98316)*dot(-D,h));
// MeshStandardMaterial at roughness 1: Lambert minus what the Fresnel reflects, plus its broad GGX lobe.
return ${f(POINT.intensity)}*nl/max(d*d,.01)*w*w*${f(1 / Math.PI)}*((1.-(.04+.96*F))+(.04+.96*F)*.5/(nl+nv));}
// The room seen along D through a Gaussian blur of sg radians (PMREM's): the walls and boxes as 5 taps, the bright
// panels (where the blur shows most) analytically. fin: how far the finish's room tint is in.
vec3 chEnv(vec3 D,float sg,float fin){
vec3 O=vec3(0.,3.5,0.),T=normalize(cross(D,abs(D.y)<.9?vec3(0.,1.,0.):vec3(1.,0.,0.))),B=cross(D,T);
float t,t2,o=sg*${f(ROOM_TAP)};
float wall=${taps === 5 ? "(chRoom(O,D,t)+chRoom(O,normalize(D+o*T),t2)+chRoom(O,normalize(D-o*T),t2)+chRoom(O,normalize(D+o*B),t2)+chRoom(O,normalize(D-o*B),t2))*.2" : "chRoom(O,D,t)"};
float cv=0.;vec3 L=vec3(0.);
${PANELS.map((p, i) => panel(p, i, fin)).join("\n")}
return wall*(1.-cv)*mix(vec3(1.),${v3(fin.tint?.walls ?? WHITE)},fin)+L;}
float chIrr(vec3 n){
return ${f(SH[0])}+${f(SH[1])}*n.y+${f(SH[2])}*n.z+${f(SH[3])}*n.x+${f(SH[4])}*n.x*n.y+${f(SH[5])}*n.y*n.z+${f(SH[6])}*n.z*n.z+${f(SH[7])}*n.x*n.z+${f(SH[8])}*(n.x*n.x-n.y*n.y);}
vec3 chAces(vec3 c){
c=mat3(.59719,.076,.0284,.35458,.90834,.13383,.04823,.01566,.83777)*(c/.6);
c=(c*(c+.0245786)-.000090537)/(c*(.983729*c+.432951)+.238081);
return clamp(mat3(1.60475,-.10208,-.00327,-.53108,1.10813,-.07276,-.07367,-.00605,1.07602)*c,0.,1.);}
vec3 chSrgb(vec3 c){return mix(pow(c,vec3(1./2.4))*1.055-.055,c*12.92,step(c,vec3(.0031308)));}
// The sphere's colour (display sRGB, tone-mapped) and alpha, for normal N, view direction V and position P (the
// gradient finishes), from the polish uniforms' values (polishUniforms).
vec4 chShade(vec3 N,vec3 V,vec3 P,vec2 fab,float hue,float rough,float m,float halo,float irid,float fin){
float r=max(rough,.0525),nv=clamp(dot(N,V),0.,1.);
vec3 bc=mix(vec3(1.),${fin.base2 ? `mix(${v3(fin.base)},${v3(fin.base2)},smoothstep(-1.,1.,P.y))` : v3(fin.base)},fin);
float Ess=fab.x+fab.y,Ems=1.-Ess;
float ssD=.04*fab.x+fab.y,fa=.04+.96/21.,msD=ssD*fa/(1.-Ems*fa)*Ems;
vec3 ssM=bc*fab.x+fab.y,faM=bc+(1.-bc)/21.,msM=ssM*faM/(1.-Ems*faM)*Ems;
vec3 ss=mix(vec3(ssD),ssM,m),ms=mix(vec3(msD),msM,m);
// Thin film: the reflection takes a rainbow tint that shifts with the viewing angle and the surface's tilt.
float fh=nv*${f(CHROME_GL.film.bands)}+${f(CHROME_GL.film.flow)}*dot(N,vec3(.5,.7,.3))+hue*${f(CHROME_GL.film.cycle)};
${film(fin)}
vec3 fm=mix(vec3(1.),film,irid);
vec3 R=normalize(mix(reflect(-V,N),N,r*r*r*r));
float sg=sqrt(${f(CHROME_GL.blur ** 2)}+pow(1.16*r,4.));
vec3 ci=chIrr(N)*mix(vec3(1.),${v3(fin.tint?.walls ?? WHITE)},fin);
vec3 col=chEnv(R,sg,fin)*ss*fm+(ms+(1.-m)*(1.-ssD-msD)*bc*mix(vec3(1.),fm,${f(fin.filmBody ?? CHROME_GL.film.body)}))*ci;
vec3 Ld=normalize(vec3(1.)),H=normalize(Ld+V);
float nl=clamp(dot(N,Ld),0.,1.),nh=clamp(dot(N,H),0.,1.),vh=clamp(dot(V,H),0.,1.);
float fr=exp2((-5.55473*vh-6.98316)*vh);
vec3 f0=mix(vec3(.04),bc,m);
float a2=r*r*r*r,gv=nl*sqrt(a2+(1.-a2)*nv*nv),gl=nv*sqrt(a2+(1.-a2)*nl*nl),dd=nh*nh*(a2-1.)+1.;
vec3 spec=(f0+(1.-f0)*fr)*.5/max(gv+gl,1e-6)*a2/(3.14159265*dd*dd)*(1.+f0*(1./Ess-1.))*fm;
col+=nl*${f(CHROME_GL.light)}*(spec+(1.-m)*bc*(1.-(.04+.96*fr))/3.14159265);
col=chSrgb(chAces(col));
float fz=pow(1.-abs(dot(N,V)),${f(CHROME_GL.halo.power)}),hu=fract(fz*${f(CHROME_GL.halo.bands)}+hue*${f(CHROME_GL.halo.cycle)});
col+=clamp(vec3(abs(hu*6.-3.)-1.,2.-abs(hu*6.-2.),2.-abs(hu*6.-4.)),0.,1.)*fz*halo;
${fin.opacity === undefined ? "return vec4(col,1.);" : `return vec4(col,mix(1.,mix(${f(fin.opacity)},1.,pow(1.-nv,2.)),fin)); // the card shows through the body, the rim stays solid`}
}`;

const frag = (o: ChromeLook) => `
#ifdef GL_FRAGMENT_PRECISION_HIGH
precision highp float;
#else
precision mediump float;
#endif
// The halo has its own clock uniform: a uniform shared with the vertex shader would need the same precision there.
uniform float uHue,uRough,uMetal,uHalo,uIrid,uFin;
uniform sampler2D uDfg;
varying vec3 vN,vP;
${shadeLib(o.finish)}
vec2 dfg(float r,float nv){return texture2D(uDfg,vec2(r*${f(16 / DFG_COLS)},nv)).xw;}
void main(){
vec3 N=normalize(vN),V=normalize(vec3(0.,0.,${f(o.distance)})-vP);
vec4 c=chShade(N,V,vP,dfg(max(uRough,.0525),clamp(dot(N,V),0.,1.)),uHue,uRough,uMetal,uHalo,uIrid,uFin);
gl_FragColor=vec4(min(c.rgb,1.)*c.a,c.a); // premultiplied (a = 1 unless the finish is see-through)
}`;

/**
 * The sphere's look at any polish as GLSL for another shader (the 3D head during the morph reveal, lib/morphShader.ts):
 * `float chRough(float p)` (the roughness to look the DFG table up with) and `vec3 chBubble(vec3 N, vec3 V, vec2 fab,
 * float hue, float p)` in display sRGB, p = polish (0 = the loader's matte blob, 1 = the finish), on polishUniforms'
 * curves. N and V in a space whose axes match the loader's (view space).
 */
export function bubbleGlsl(finish: ChromeFinish): string {
  // polishUniforms in GLSL: bumps and roughness ease (cosine), metalness, halo and film rise linearly.
  return `${shadeLib(finish, 1)}
float chRough(float p){float e=.5+.5*cos(p*3.14159265);return max(e*.2+(1.-e)*${f(finish.rough)},.0525);}
vec3 chBubble(vec3 N,vec3 V,vec2 fab,float hue,float p){return min(chShade(N,V,vec3(0.),fab,hue,chRough(p),p*${f(finish.metal)},p*${f(finish.halo)},p*${f(finish.irid)},p).rgb,1.);}`;
  // (one ray per pixel, not the loader's 5-tap blur: here it shades a whole head, and at the bubble's gloss the taps
  // barely show)
}

/** The sphere: three's SphereGeometry(1, n, n) vertex and triangle order (counter-clockwise from outside). */
function sphere(n: number): { pos: Float32Array; idx: Uint16Array } {
  const pos = new Float32Array((n + 1) * (n + 1) * 3);
  let k = 0;
  for (let iy = 0; iy <= n; iy++) {
    const th = (iy / n) * Math.PI;
    for (let ix = 0; ix <= n; ix++) {
      const ph = (ix / n) * Math.PI * 2;
      pos[k++] = -Math.cos(ph) * Math.sin(th);
      pos[k++] = Math.cos(th);
      pos[k++] = Math.sin(ph) * Math.sin(th);
    }
  }
  const idx: number[] = [];
  for (let iy = 0; iy < n; iy++)
    for (let ix = 0; ix < n; ix++) {
      const a = iy * (n + 1) + ix + 1, b = iy * (n + 1) + ix, c = (iy + 1) * (n + 1) + ix, d = (iy + 1) * (n + 1) + ix + 1;
      if (iy !== 0) idx.push(a, b, d);
      if (iy !== n - 1) idx.push(b, c, d);
    }
  return { pos, idx: new Uint16Array(idx) };
}

/** The renderer on `canvas`, or null when WebGL isn't there (or only in software): the caller keeps the poster. */
export function createChromeGl(canvas: HTMLCanvasElement | OffscreenCanvas, o: ChromeLook): ChromeGl | null {
  const el = "clientWidth" in canvas ? canvas : null; // a page canvas (null: an OffscreenCanvas in the worker)
  const gl = canvas.getContext("webgl", {
    alpha: true,
    premultipliedAlpha: true,
    antialias: true, // the silhouette is the one hard edge
    depth: true, // the bumps hide each other
    stencil: false,
    powerPreference: "low-power",
    failIfMajorPerformanceCaveat: true,
  }) as WebGLRenderingContext | null;
  if (!gl || gl.isContextLost()) return null;

  let lost = false;
  const onLost = (e: Event) => {
    e.preventDefault();
    lost = true;
  };
  canvas.addEventListener("webglcontextlost", onLost as EventListener);

  const parallel = o.sync ? null : gl.getExtension("KHR_parallel_shader_compile");
  const prog = gl.createProgram()!;
  const shaders = ([[gl.VERTEX_SHADER, vert(o)], [gl.FRAGMENT_SHADER, frag(o)]] as const).map(([type, src]) => {
    const sh = gl.createShader(type)!;
    gl.shaderSource(sh, src);
    gl.compileShader(sh);
    gl.attachShader(prog, sh);
    return sh;
  });
  gl.bindAttribLocation(prog, 0, "aP");
  gl.linkProgram(prog);

  const mesh = sphere(CHROME_GL.segments);
  const vbo = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
  gl.bufferData(gl.ARRAY_BUFFER, mesh.pos, gl.STATIC_DRAW);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 0, 0);
  const ibo = gl.createBuffer();
  gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ibo);
  gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, mesh.idx, gl.STATIC_DRAW);
  const dfgTex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, dfgTex);
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.LUMINANCE_ALPHA, DFG_COLS, 16, 0, gl.LUMINANCE_ALPHA, gl.UNSIGNED_BYTE, Uint8Array.from(atob(DFG), (c) => c.charCodeAt(0)));
  for (const [k, v] of [[gl.TEXTURE_MIN_FILTER, gl.LINEAR], [gl.TEXTURE_MAG_FILTER, gl.LINEAR], [gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE], [gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE]]) gl.texParameteri(gl.TEXTURE_2D, k, v);
  gl.enable(gl.DEPTH_TEST);
  gl.enable(gl.CULL_FACE);
  gl.clearColor(0, 0, 0, 0);

  let state: "compiling" | "ready" | "dead" = "compiling";
  let loc: Record<string, WebGLUniformLocation | null> = {};

  const ready = () => {
    if (state !== "compiling") return state === "ready";
    if (lost) return false;
    if (parallel && !gl.getProgramParameter(prog, parallel.COMPLETION_STATUS_KHR)) return false;
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
      console.warn("[loader] chrome shader:", gl.getProgramInfoLog(prog), ...shaders.map((s) => gl.getShaderInfoLog(s)));
      state = "dead";
      return false;
    }
    gl.useProgram(prog);
    for (const k of ["uT", "uDrift", "uHue", "uAmp", "uShape", "uAspect", "uRough", "uMetal", "uHalo", "uIrid", "uFin"]) loc[k] = gl.getUniformLocation(prog, k);
    gl.uniform1f(gl.getUniformLocation(prog, "uTurn"), o.turn);
    state = "ready";
    return true;
  };

  const dpr = Math.min(o.dprMax, globalThis.devicePixelRatio || 1);
  let w = 0;
  const resize = (nw: number, nh: number) => {
    nw = Math.max(1, Math.round(nw));
    nh = Math.max(1, Math.round(nh));
    if (nw === canvas.width && nh === canvas.height && w) return; // re-setting a canvas size clears it
    canvas.width = w = nw;
    canvas.height = nh;
  };
  if (o.pixels) resize(o.pixels, o.pixels);
  else if (o.size) resize(...o.size);
  else if (el && o.sync && el.clientWidth) resize(el.clientWidth * dpr, el.clientHeight * dpr); // one layout read, at start only
  const ro = el && !o.pixels && !o.size ? new ResizeObserver(([entry]) => resize(entry.contentRect.width * dpr, entry.contentRect.height * dpr)) : null;
  if (el) ro?.observe(el);

  return {
    ready,
    width: () => w,
    resize,
    finish: () => gl.finish(),
    draw(fr) {
      if (lost || !w || !ready()) return false;
      const u = polishUniforms(fr.polish, o.amp, o.finish);
      gl.viewport(0, 0, canvas.width, canvas.height);
      gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
      gl.uniform1f(loc.uT, fr.time);
      gl.uniform1f(loc.uHue, fr.time);
      gl.uniform1f(loc.uDrift, fr.drift);
      gl.uniform1f(loc.uAmp, u.amp);
      gl.uniform1f(loc.uShape, u.shape);
      gl.uniform1f(loc.uIrid, u.irid);
      gl.uniform1f(loc.uFin, u.fin);
      gl.uniform1f(loc.uRough, u.rough);
      gl.uniform1f(loc.uMetal, u.metal);
      gl.uniform1f(loc.uHalo, u.halo);
      gl.uniform1f(loc.uAspect, canvas.width / canvas.height);
      gl.drawElements(gl.TRIANGLES, mesh.idx.length, gl.UNSIGNED_SHORT, 0);
      return true;
    },
    dispose() {
      ro?.disconnect();
      canvas.removeEventListener("webglcontextlost", onLost as EventListener);
      if (!lost) {
        gl.deleteBuffer(vbo);
        gl.deleteBuffer(ibo);
        gl.deleteTexture(dfgTex);
        shaders.forEach((s) => gl.deleteShader(s));
        gl.deleteProgram(prog);
        setTimeout(() => !el?.isConnected && gl.getExtension("WEBGL_lose_context")?.loseContext());
      }
      loc = {};
    },
  };
}

/** The numbers come from CHROME in ./chrome.tsx (tweak them there). */
export interface ChromeFlowConfig {
  start: number; // clock the sphere opens at
  speed: number; // noise drift per second at 0 % …
  restSpeed: number; // … and at 100 %
  period: number; // s for one blob → finish → blob swing
  dwell: number; // 0..1, how much it slows into each end: 0 = turns at constant speed, 1 = a pendulum (cosine)
  settleSpeed: number; // the final approach's average speed, × the swing's (a faster one read as skipping ahead)
  maxStep: number; // s, the most the clock advances in one frame (after a stall it carries on instead of jumping)
}

/** What drives the flow each frame. */
export interface ChromeDrive {
  moving: boolean; // false: hold still (reduced motion, or not on screen yet)
  settling: boolean; // the reveal has started: head for the finish and stay there…
  through: number | null; // …or, for the morph reveal, s the polish then takes to run back to the blob: it reaches the
  // finish at that run's starting speed and turns straight round onto it (swingBack), like the swing's own turns
  hold: number | null; // the style lab: pin the polish here
}

/**
 * The swing's way back from the finish (1) to the blob (0) at x = 0..1 of the way: mostly steady, easing into the
 * start and end by `dwell` (createChromeFlow's swing). Also the morph reveal's polish (lib/morphShader.ts morphFrame).
 */
export const swingBack = (x: number, dwell: number) => 1 - (x + (0.5 - 0.5 * Math.cos(Math.PI * x) - x) * dwell);

/**
 * The clock and polish, shared by the worker (./chromeWorker.ts) and the main-thread fallback (./chrome.tsx). The
 * polish has its own rhythm, not the load's: it swings from the blob to the finish and back, at a steady pace that only
 * eases briefly into each turn (`dwell`: the look already eases near both ends, so a full cosine swing read as long
 * pauses), and once the reveal starts it turns towards the finish from wherever it is, keeping its speed (a
 * Hermite curve: a sphere on its way back to the blob turns around instead of jumping) and at about the swing's own
 * pace (a quick settle rushed at 3–4× the swing and read as skipping ahead), and stays there.
 */
export function createChromeFlow(c: ChromeFlowConfig): { frame: ChromeFrame; step(dt: number, d: ChromeDrive): void; settled(): boolean } {
  const frame: ChromeFrame = { time: c.start, drift: c.start * c.speed, polish: 0 };
  let wave = 0; // s into the swing
  let velocity = 0; // polish per second
  let from: { p: number; v: number; u: number; T: number } | null = null; // the settle, once started
  let past = 0; // s since it reached the finish (a morph reveal's run back: ChromeDrive.through)
  return {
    frame,
    settled: () => from?.u === 1,
    step(dt, d) {
      if (d.hold !== null) frame.polish = d.hold;
      if (!d.moving) return;
      const step = Math.min(dt, c.maxStep);
      if (d.hold === null && d.settling) {
        if (!from) {
          const vs = (c.settleSpeed * 2) / c.period; // the swing covers blob → finish in half a period
          const turn = velocity < 0 ? (-velocity / vs) * 0.6 : 0; // heading back to the blob: time to turn around
          from = { p: frame.polish, v: velocity, u: 0, T: Math.max(0.25, (1 - frame.polish) / vs + turn) };
        }
        if (from.u === 1 && d.through) frame.polish = swingBack(Math.min(1, (past += step) / d.through), c.dwell);
        else {
          const u = (from.u = Math.min(1, from.u + step / from.T)), T = from.T;
          const arrive = d.through ? (1 - c.dwell) / d.through : 0; // the run back's starting speed (swingBack's slope at 0)
          const h00 = 2 * u ** 3 - 3 * u ** 2 + 1, h10 = u ** 3 - 2 * u ** 2 + u, h01 = 3 * u ** 2 - 2 * u ** 3, h11 = u ** 3 - u ** 2;
          frame.polish = Math.min(1, Math.max(0, h00 * from.p + h10 * T * from.v + h01 + h11 * T * arrive));
        }
      } else if (d.hold === null) {
        wave += step;
        const ph = (wave / c.period) % 1, w = 2 * Math.PI * ph;
        const tri = ph < 0.5 ? 2 * ph : 2 - 2 * ph, triV = (ph < 0.5 ? 2 : -2) / c.period;
        const cs = 0.5 - 0.5 * Math.cos(w), csV = (Math.PI / c.period) * Math.sin(w);
        frame.polish = tri + (cs - tri) * c.dwell;
        velocity = triV + (csV - triV) * c.dwell;
      }
      const ease = (1 + Math.cos(frame.polish * Math.PI)) / 2;
      frame.time += step;
      frame.drift += step * (c.speed * ease + c.restSpeed * (1 - ease));
    },
  };
}
