"use client";

/**
 * The loader's sphere on its own, for pages without a head (the 404): the same markup, poster and worker as the head
 * loader (./chrome.tsx), swinging between the blob and the soap bubble the same way, and nothing else (no engine, no
 * reveal, no three.js).
 * The poster paints with the server HTML; with prefers-reduced-motion (or without JS or WebGL) it is all there is.
 * Decorative: hidden from screen readers.
 */
import { type CSSProperties, useEffect, useRef } from "react";

import { Chrome, chromeBox, chromeMotion } from "./chrome";
import type { LoaderState } from "./engine";

/** What the sphere is told each frame: never revealing, so it keeps swinging (the worker runs its own clock). */
const SWINGING: LoaderState = { t: 0, dt: 0, p: 0, flat: 0, revealing: false, through: null, reduced: false };

/** `size`: the polished ball's diameter (any CSS length); the box is wider, with room for the bumps. */
export function LoaderSphere({ size }: { size: string }) {
  const root = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = root.current;
    if (!el) return;
    const reduced = matchMedia("(prefers-reduced-motion: reduce)");
    let sphere: ReturnType<typeof chromeMotion> | null = null;
    let raf = 0;
    const start = () => {
      sphere = chromeMotion(el);
      // The worker only needs this once; the page's own renderer (no OffscreenCanvas) draws on each call.
      const tick = () => {
        sphere?.frame(SWINGING);
        raf = requestAnimationFrame(tick);
      };
      tick();
    };
    const stop = () => {
      cancelAnimationFrame(raf);
      sphere?.dispose();
      sphere = null;
      el.querySelector("[data-chrome-still]")?.getAnimations().forEach((a) => a.cancel()); // the poster back
    };
    const sync = () => (reduced.matches ? stop() : !sphere && start());
    sync();
    reduced.addEventListener("change", sync);
    return () => {
      reduced.removeEventListener("change", sync);
      stop();
    };
  }, []);

  const box = chromeBox(size);
  return (
    <div ref={root} aria-hidden className="relative shrink-0" style={{ width: box, height: box, "--cy": "50%" } as CSSProperties}>
      <Chrome size={size} />
    </div>
  );
}
