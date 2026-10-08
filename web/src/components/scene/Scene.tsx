"use client";

/**
 * The R3F canvas. Cheap by construction: capped DPR that PerformanceMonitor lowers on slow
 * devices, MSAA on, no shadow maps, environment lighting, one head. Only `dpr` is React state.
 */
import { AdaptiveDpr, OrbitControls, PerformanceMonitor } from "@react-three/drei";
import { Canvas, useThree } from "@react-three/fiber";
import { Suspense, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import { ACESFilmicToneMapping, type Object3D, type PerspectiveCamera } from "three";

import { registerView } from "@/lib/debugView";
import { revealedSnapshot, subscribeRevealed } from "@/lib/headLoad";
import { dropTier, probeTier } from "@/lib/quality";
import { setTextureRenderer } from "@/lib/textures";

import { Capture } from "./Capture";
import { PieceFadeRender } from "./PieceFadeRender";
import { Head } from "./Head";
import { IdleLife } from "./IdleLife";
import { Lighting } from "./Lighting";
import { LipSync } from "./LipSync";
import { PerfProbe } from "./PerfProbe";

const CAMERA = {
  fov: 24,
  position: [0, 0.27, 0.95] as [number, number, number],
  target: [0, 0.265, 0.05] as [number, number, number],
  /** Portrait canvases (phones) look this much higher, so tall hair keeps headroom. */
  portraitLift: 0.02,
};

const MAX_DPR = 1.5;
const maxDpr = () => Math.min(MAX_DPR, typeof window === "undefined" ? 1 : window.devicePixelRatio || 1);

// After this many real DPR changes the device is clearly borderline: stay at the low setting.
const MAX_DPR_CHANGES = 3;

/**
 * Orbit controls around the head; on a portrait canvas the whole view is lifted by CAMERA.portraitLift. No rotating
 * until the head is revealed: a drag under the loader, or during the morph from the loader's bubble, would turn the
 * view. enableRotate, not enabled: drei only updates enabled controls, and that update is what aims the camera at the
 * target (disabled controls keep R3F's default aim at the origin, and the face sits high in the frame).
 */
function Controls() {
  const { width, height } = useThree((s) => s.size);
  const camera = useThree((s) => s.camera);
  const controls = useThree((s) => s.controls);
  const revealed = useSyncExternalStore(subscribeRevealed, revealedSnapshot, () => false);
  const lift = height > width ? CAMERA.portraitLift : 0;
  useEffect(() => {
    camera.position.set(CAMERA.position[0], CAMERA.position[1] + lift, CAMERA.position[2]);
  }, [camera, lift]);
  // Debug-only: __faceToVoice.view(...) moves this camera for comparison screenshots.
  useEffect(() => registerView(camera as PerspectiveCamera, controls as Parameters<typeof registerView>[1]), [camera, controls]);
  return (
    <OrbitControls
      makeDefault
      enableRotate={revealed}
      target={[CAMERA.target[0], CAMERA.target[1] + lift, CAMERA.target[2]]}
      enablePan={false}
      enableZoom={false}
      enableDamping
      dampingFactor={0.08}
      minAzimuthAngle={-0.7}
      maxAzimuthAngle={0.7}
      minPolarAngle={Math.PI / 2 - 0.35}
      maxPolarAngle={Math.PI / 2 + 0.25}
    />
  );
}

/**
 * Compiles the scene's shaders as the canvas mounts, before its first frame: drei's <Preload all /> without its
 * "for good measure" cube camera, which renders the whole scene six more times into a throwaway 128 px target (with
 * shader variants of its own for render targets) before the head can show: ~0.15 s on a slow phone.
 */
function Precompile() {
  const gl = useThree((s) => s.gl);
  const scene = useThree((s) => s.scene);
  const camera = useThree((s) => s.camera);
  useLayoutEffect(() => {
    const hidden: Object3D[] = [];
    scene.traverse((o) => {
      if (!o.visible) {
        hidden.push(o);
        o.visible = true;
      }
    });
    gl.compile(scene, camera);
    for (const o of hidden) o.visible = false;
  }, [gl, scene, camera]);
  return null;
}

export default function Scene() {
  const [dpr, setDpr] = useState(maxDpr);
  const changes = useRef(0);

  // drei's PerformanceMonitor reports "incline" whenever fps sits at the display's refresh rate, so this counts only
  // the DPR changes actually made, not its flip counter. A decline first drops the quality
  // tier (lib/quality.ts: detail maps, hair passes, texture sizes); only at the low tier does the resolution drop.
  const adjust = (next: number) => {
    setDpr((current) => {
      if (current === next || changes.current >= MAX_DPR_CHANGES) return current;
      changes.current += 1;
      return next;
    });
  };

  const revealed = useSyncExternalStore(subscribeRevealed, revealedSnapshot, () => false);

  return (
    <Canvas
      className={revealed ? "cursor-grab active:cursor-grabbing" : undefined} // the head orbits on drag (once revealed: Controls)
      dpr={dpr}
      camera={{ fov: CAMERA.fov, position: CAMERA.position, near: 0.1, far: 5 }}
      gl={{ antialias: true, alpha: false, stencil: false, powerPreference: "high-performance", toneMapping: ACESFilmicToneMapping }} // Lighting.tsx owns tone mapping + exposure
      shadows={false}
      onCreated={({ gl }) => {
        probeTier(gl.getContext()); // the start quality tier (lib/quality.ts)
        setTextureRenderer(gl); // KTX2 transcoding picks a format this GPU supports (lib/textures.ts)
      }}
    >
      <color attach="background" args={["#f5f3f1"]} /> {/* matches --surface in app/tokens.css */}
      <PerformanceMonitor onIncline={() => adjust(maxDpr())} onDecline={() => dropTier() || adjust(1)} />
      <AdaptiveDpr />
      <Lighting />
      <Suspense fallback={null}>
        <Head />
        <IdleLife />
        <LipSync />
      </Suspense>
      <Controls />
      <PerfProbe />
      <Capture />
      <PieceFadeRender />
      <Precompile />
    </Canvas>
  );
}
