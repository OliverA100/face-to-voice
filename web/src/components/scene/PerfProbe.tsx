"use client";

/** Inside the Canvas: writes fps, draw calls and GPU limits into the perf store every 500 ms. */
import { useFrame, useThree } from "@react-three/fiber";
import { useEffect, useRef } from "react";

import { perf } from "@/lib/perf";

export function PerfProbe() {
  const gl = useThree((s) => s.gl);
  const frames = useRef(0);
  const last = useRef(0);

  useEffect(() => {
    const ctx = gl.getContext();
    perf.renderer = gl.capabilities.isWebGL2 ? "WebGL2" : "WebGL1";
    perf.maxVertexUniforms = gl.capabilities.maxVertexUniforms;
    perf.maxArrayTextureLayers = ctx.getParameter((ctx as WebGL2RenderingContext).MAX_ARRAY_TEXTURE_LAYERS) as number;
  }, [gl]);

  useFrame(() => {
    frames.current++;
    const now = performance.now();
    if (now - last.current < 500) return;
    perf.fps = Math.round((frames.current * 1000) / (now - last.current));
    frames.current = 0;
    last.current = now;
    perf.dpr = gl.getPixelRatio();
    perf.drawCalls = gl.info.render.calls;
    perf.triangles = gl.info.render.triangles;
    perf.geometries = gl.info.memory.geometries;
    perf.textures = gl.info.memory.textures;
  });
  return null;
}
