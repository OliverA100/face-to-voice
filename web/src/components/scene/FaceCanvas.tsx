"use client";

/**
 * Lazy entry point for the 3D scene: three.js only loads in the browser and only when this
 * component mounts. head.glb starts downloading as soon as this module loads (lib/headLoad.ts),
 * in parallel with the three.js chunk. Until the head is ready, the loader (components/ui/loader)
 * covers the bust, then cross-fades to it.
 */
import dynamic from "next/dynamic";
import { useEffect, useRef, useState } from "react";

import { HeadLoader } from "@/components/ui/loader/HeadLoader";
import { prefetchAddons } from "@/lib/addons";
import { describeFace } from "@/lib/describeFace";
import { prefetchHair } from "@/lib/hair";
import { headBytes, headLoad, markRevealed } from "@/lib/headLoad";

import { SceneErrorBoundary } from "./SceneErrorBoundary";

// Browser only: start the downloads now instead of after the Scene chunk. head.glb first; the saved hair and
// add-ons at low priority, so the head is revealed wearing them (the parses in Head.tsx / hair.ts / addons.ts reuse the bytes).
if (typeof window !== "undefined") {
  headBytes().catch(() => {}); // a failure resurfaces (and retries) in Head.tsx
  prefetchHair();
  prefetchAddons();
}

const Scene = dynamic(
  () =>
    import("./Scene").then((m) => {
      headLoad.chunk = true;
      return m;
    }),
  { ssr: false, loading: () => null },
);

/** `reducedMotion` forces the loader's reduced-motion mode on or off (previews of the loader); default: the visitor's setting. */
export function FaceCanvas({ reducedMotion }: { reducedMotion?: boolean }) {
  const [revealed, setRevealed] = useState(() => headLoad.revealed);
  const stage = useRef<HTMLDivElement>(null);

  // The head's text alternative (WCAG 1.1.1): the face is the content, so the canvas is an image named by the look in
  // words (lib/describeFace.ts). Rechecked every second (the pose and the sliders have no single change event) and
  // written only when it changed; no React render.
  useEffect(() => {
    const el = stage.current;
    if (!el) return;
    const update = () => {
      const text = describeFace();
      if (el.getAttribute("aria-label") !== text) el.setAttribute("aria-label", text);
    };
    update();
    const id = window.setInterval(update, 1000);
    return () => clearInterval(id);
  }, []);

  // From xl the canvas stops short of the right edge so the bust sits left of the floating voice
  // card; the strip it leaves is the same --surface colour as the scene, so nothing shows.
  return (
    <div className="absolute inset-0 xl:right-52">
      <SceneErrorBoundary>
        {/* The head's wrapper: hidden until the loader's reveal fades it in (opacity/transform only). */}
        <div ref={stage} role="img" aria-label="3D head" className="absolute inset-0" style={revealed ? undefined : { opacity: 0 }}>
          <Scene />
        </div>
        {!revealed && (
          <HeadLoader
            stageRef={stage}
            reducedMotion={reducedMotion}
            onRevealed={() => {
              markRevealed();
              setRevealed(true);
            }}
          />
        )}
      </SceneErrorBoundary>
    </div>
  );
}
