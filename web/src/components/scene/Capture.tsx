"use client";

/** Registers the renderer, scene and camera in lib/sceneRig.ts, for the voice's screenshot and shader warm-ups. */
import { useThree } from "@react-three/fiber";
import { useEffect } from "react";

import { sceneRig } from "@/lib/sceneRig";

export function Capture() {
  const gl = useThree((s) => s.gl);
  const scene = useThree((s) => s.scene);
  const camera = useThree((s) => s.camera);
  useEffect(() => {
    sceneRig.gl = gl;
    sceneRig.scene = scene;
    sceneRig.camera = camera;
    return () => {
      sceneRig.gl = sceneRig.scene = sceneRig.camera = null;
    };
  }, [gl, scene, camera]);
  return null;
}
