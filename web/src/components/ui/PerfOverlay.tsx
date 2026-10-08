"use client";

/** Add ?perf=1 to the URL: fps, dpr, draw calls, head-visible time and GPU limits. */
import { useEffect, useRef } from "react";

import { perf, perfEnabled } from "@/lib/perf";

const ms = (v: number | null) => (v === null ? "…" : `${v} ms`);

export function PerfOverlay() {
  const pre = useRef<HTMLPreElement>(null);

  useEffect(() => {
    if (!perfEnabled() || !pre.current) return;
    pre.current.hidden = false;
    const id = setInterval(() => {
      if (!pre.current) return;
      pre.current.textContent =
        `fps ${perf.fps}  dpr ${perf.dpr.toFixed(2)} (device ${window.devicePixelRatio})  ${perf.renderer}\n` +
        `draw calls ${perf.drawCalls}  triangles ${perf.triangles}\n` +
        `loader ${ms(perf.loaderPaintMs)} painted, ${ms(perf.loaderLiveMs)} live · head ${ms(perf.headVisibleMs)} · revealed ${ms(perf.revealDoneMs)}\n` +
        `gpu limits ${perf.maxVertexUniforms} uniform vec4 / ${perf.maxArrayTextureLayers} layers\n` +
        `memory ${perf.geometries} geometries, ${perf.textures} textures\n` +
        `speak tap→audible ${ms(perf.speakFirstAudibleMs)}`;
    }, 500);
    return () => clearInterval(id);
  }, []);

  // A small white card over the scene, like the app's floating controls.
  return (
    <pre
      ref={pre}
      hidden
      className="pointer-events-none absolute right-5 top-5 rounded-tray bg-card/95 px-4 py-3 font-mono text-[11px] leading-relaxed text-ink-2 shadow-float backdrop-blur"
    />
  );
}
