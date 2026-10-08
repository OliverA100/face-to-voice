"use client";

/**
 * Studio lighting with zero downloads. The environment is a small procedural photo studio built from glowing
 * panels and rendered once through PMREM: a big warm softbox front-left (the key), a dimmer card on the right (the
 * fill), two tall strips behind the head (the rims that outline the hair and jaw), a soft top light, and a warm floor
 * bounce, all in a dim room. Skin, eyes and hair pick up soft reflections of these shapes. Three directional lights
 * add crisp shape on top: key, fill and rim, matching the panels. No shadow maps (a render pass for one bust);
 * contact darkness comes from the baked AO (lib/skinShader.ts).
 *
 * Tweak the numbers in LIGHTING. `__faceToVoice.lighting.rig.toneMapping("agx" | "aces" | "neutral", exposure)` switches
 * tone mapping live for comparisons.
 */
import { useThree } from "@react-three/fiber";
import { useEffect, useRef } from "react";
import {
  ACESFilmicToneMapping,
  AgXToneMapping,
  BoxGeometry,
  Color,
  DirectionalLight,
  DoubleSide,
  Mesh,
  MeshBasicMaterial,
  NeutralToneMapping,
  PlaneGeometry,
  PMREMGenerator,
  Scene,
  type Texture,
  type ToneMapping,
  type WebGLRenderer,
} from "three";

type V3 = [number, number, number];
type Panel = { position: V3; size: [number, number]; color: string; intensity: number };

export const LIGHTING = {
  // ACES looks the most natural at matched face brightness (Neutral turns the skin orange-peach, AgX grey). The
  // exposure is high because the studio is dim and the key is the main light, not the environment.
  toneMapping: "aces" as ToneMappingName,
  exposure: 1.4,
  environmentIntensity: 0.5,
  /** The procedural studio seen by reflections and image-based light (metres, around the head). */
  studio: {
    room: "#1f1d1b", // the studio's walls: dim, so the panels do the lighting
    roomIntensity: 1,
    panels: {
      key: { position: [-2.4, 1.9, 2.4], size: [2.4, 2.4], color: "#fff1e2", intensity: 5.5 },
      fill: { position: [2.8, 0.5, 2.0], size: [2.4, 2.0], color: "#eef0f4", intensity: 1.4 },
      rimLeft: { position: [-2.2, 1.2, -2.4], size: [0.7, 3.2], color: "#edf2ff", intensity: 6 },
      rimRight: { position: [2.2, 1.2, -2.4], size: [0.7, 3.2], color: "#edf2ff", intensity: 6 },
      top: { position: [0, 3.2, 0.4], size: [2.0, 2.0], color: "#ffffff", intensity: 1.5 },
      floor: { position: [0, -2.4, 0.8], size: [5.0, 5.0], color: "#d9c3ad", intensity: 0.35 },
    } satisfies Record<string, Panel>,
  },
  /** Directional lights for crisp shape (they also make the speculars that the panels only blur). */
  key: { position: [-1.3, 1.3, 2.0] as V3, intensity: 1.8, color: "#fff4ea" },
  fill: { position: [1.8, 0.3, 0.9] as V3, intensity: 0.3, color: "#e8ecf2" },
  rim: { position: [1.2, 1.3, -1.6] as V3, intensity: 1.1, color: "#eef3ff" },
  /** What the lights aim at (the middle of the face), so their direction does not depend on the origin. */
  target: [0, 0.27, 0.05] as V3,
};

export type ToneMappingName = "agx" | "aces" | "neutral";
const TONE: Record<ToneMappingName, ToneMapping> = { agx: AgXToneMapping, aces: ACESFilmicToneMapping, neutral: NeutralToneMapping };

/**
 * Live tuning (debug handle): edit LIGHTING, then `apply()` (lights, exposure, environment strength) or `rebuild()`
 * (the studio panels). `toneMapping(name, exposure)` switches tone mapping; materials recompile on the next frame.
 */
export const lightingRig = {
  gl: null as WebGLRenderer | null,
  scene: null as Scene | null,
  lights: {} as Partial<Record<"key" | "fill" | "rim", DirectionalLight>>,
  rebuildStudio: null as null | (() => void),
  toneMapping(name: ToneMappingName = LIGHTING.toneMapping, exposure = LIGHTING.exposure): void {
    LIGHTING.toneMapping = name;
    LIGHTING.exposure = exposure;
    const gl = lightingRig.gl;
    if (!gl) return;
    gl.toneMapping = TONE[name];
    gl.toneMappingExposure = exposure;
  },
  apply(): void {
    lightingRig.toneMapping();
    if (lightingRig.scene) lightingRig.scene.environmentIntensity = LIGHTING.environmentIntensity;
    for (const k of ["key", "fill", "rim"] as const) {
      const light = lightingRig.lights[k];
      if (!light) continue;
      light.position.set(...LIGHTING[k].position);
      light.intensity = LIGHTING[k].intensity;
      light.color.set(LIGHTING[k].color);
    }
  },
  rebuild(): void {
    lightingRig.rebuildStudio?.();
  },
};

/** The studio as a tiny three scene: a dim box room with emissive panels facing the head. */
function studioScene(): Scene {
  const s = LIGHTING.studio;
  const scene = new Scene();
  const room = new Mesh(new BoxGeometry(10, 8, 10), new MeshBasicMaterial({ color: new Color(s.room).multiplyScalar(s.roomIntensity), side: DoubleSide }));
  room.position.y = 1;
  scene.add(room);
  for (const p of Object.values(s.panels)) {
    const panel = new Mesh(new PlaneGeometry(...p.size), new MeshBasicMaterial({ color: new Color(p.color).multiplyScalar(p.intensity), side: DoubleSide }));
    panel.position.set(...p.position);
    panel.lookAt(0, 0.27, 0);
    scene.add(panel);
  }
  return scene;
}

/** Tone mapping + the studio environment on the renderer and scene; returns the cleanup. */
function installStudio(gl: WebGLRenderer, scene: Scene): () => void {
  lightingRig.gl = gl;
  lightingRig.scene = scene;
  lightingRig.toneMapping();
  let env: Texture | null = null;
  const build = () => {
    const pmrem = new PMREMGenerator(gl);
    const studio = studioScene();
    env?.dispose();
    env = pmrem.fromScene(studio, 0.03).texture;
    scene.environment = env;
    scene.environmentIntensity = LIGHTING.environmentIntensity;
    pmrem.dispose();
    studio.traverse((o) => {
      if ((o as Mesh).isMesh) {
        (o as Mesh).geometry.dispose();
        ((o as Mesh).material as MeshBasicMaterial).dispose();
      }
    });
  };
  build();
  lightingRig.rebuildStudio = build;
  // The environment exists only on the GPU (a render target): a lost context (sleep, a GPU reset) takes it with it and
  // three restores it empty, which leaves the head darker and flat. Rendered again once three has restored its state.
  const canvas = gl.domElement;
  canvas.addEventListener("webglcontextrestored", build);
  return () => {
    canvas.removeEventListener("webglcontextrestored", build);
    scene.environment = null;
    env?.dispose();
    lightingRig.gl = lightingRig.scene = lightingRig.rebuildStudio = null;
  };
}

export function Lighting() {
  const gl = useThree((s) => s.gl);
  const scene = useThree((s) => s.scene);

  useEffect(() => installStudio(gl, scene), [gl, scene]);

  // Every directional light aims at the head, not the origin.
  const key = useRef<DirectionalLight>(null);
  const fill = useRef<DirectionalLight>(null);
  const rim = useRef<DirectionalLight>(null);
  useEffect(() => {
    lightingRig.lights = { key: key.current ?? undefined, fill: fill.current ?? undefined, rim: rim.current ?? undefined };
    const lights = [key.current, fill.current, rim.current].filter((l): l is DirectionalLight => !!l);
    for (const light of lights) {
      light.target.position.set(...LIGHTING.target);
      scene.add(light.target);
    }
    return () => {
      for (const light of lights) scene.remove(light.target);
      lightingRig.lights = {};
    };
  }, [scene]);

  return (
    <>
      <directionalLight ref={key} position={LIGHTING.key.position} intensity={LIGHTING.key.intensity} color={LIGHTING.key.color} />
      <directionalLight ref={fill} position={LIGHTING.fill.position} intensity={LIGHTING.fill.intensity} color={LIGHTING.fill.color} />
      <directionalLight ref={rim} position={LIGHTING.rim.position} intensity={LIGHTING.rim.intensity} color={LIGHTING.rim.color} />
    </>
  );
}
