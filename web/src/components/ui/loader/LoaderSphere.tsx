"use client";

/**
 * The loader's sphere on its own, for places without a head loader (the 404, a live chat): the same markup, poster and
 * worker as the head loader (./chrome.tsx), swinging between the blob and the soap bubble the same way (no engine, no
 * reveal, no three.js). With `voice` it answers a voice instead while `voice.read()` returns one (./chrome.tsx
 * VOICE_STYLES), and swings again when it returns null.
 * The poster paints with the server HTML; with prefers-reduced-motion (or without JS or WebGL) it is all there is.
 * Decorative: hidden from screen readers.
 */
import { type CSSProperties, useEffect, useLayoutEffect, useRef } from "react";

import { Chrome, chromeBox, chromeMotion } from "./chrome";
import type { ChromeFinish, ChromeVoice, ChromeVoiceStyle } from "./chromeGl";
import type { LoaderState } from "./engine";

/** What the sphere is told each frame: never revealing, so it keeps swinging (the worker runs its own clock). */
const SWINGING: LoaderState = { t: 0, dt: 0, p: 0, flat: 0, revealing: false, through: null, reduced: false };

export interface SphereVoice {
  style: ChromeVoiceStyle;
  /** Read every frame: the polish to hold and the loudness now (0..1), or null for the loader's swing. */
  read: () => ChromeVoice | null;
}

/** `size`: the polished ball's diameter (any CSS length); the box is wider, with room for the bumps. `finish`: another
 * finish than the loader's; `start`: another clock to open at (other bumps and rainbow); `startPolish`: another polish
 * (all read once, at start); `poster`: a still of that opening frame (else the loader's, the blob). */
export function LoaderSphere({ size, voice, finish, start, startPolish, poster }: { size: string; voice?: SphereVoice; finish?: ChromeFinish; start?: number; startPolish?: number; poster?: string }) {
  const root = useRef<HTMLDivElement>(null);
  const sphere = useRef<ReturnType<typeof chromeMotion> | null>(null);
  const voiceRef = useRef(voice); // read by the frame loop (which outlives renders)
  const opening = useRef({ finish, start, startPolish });
  useLayoutEffect(() => {
    voiceRef.current = voice;
  });

  useEffect(() => {
    const el = root.current;
    if (!el) return;
    const reduced = matchMedia("(prefers-reduced-motion: reduce)");
    let raf = 0;
    const start = () => {
      const s = (sphere.current = chromeMotion(el, opening.current.finish, { voice: voiceRef.current?.style, start: opening.current.start, startPolish: opening.current.startPolish }));
      // The worker only needs SWINGING once; the page's own renderer (no OffscreenCanvas) draws on each call.
      const tick = () => {
        s.voice(voiceRef.current?.read() ?? null);
        s.frame(SWINGING);
        raf = requestAnimationFrame(tick);
      };
      tick();
    };
    const stop = () => {
      cancelAnimationFrame(raf);
      sphere.current?.dispose();
      sphere.current = null;
      el.querySelector("[data-chrome-still]")?.getAnimations().forEach((a) => a.cancel()); // the poster back
    };
    const sync = () => (reduced.matches ? stop() : !sphere.current && start());
    sync();
    reduced.addEventListener("change", sync);
    return () => {
      reduced.removeEventListener("change", sync);
      stop();
    };
  }, []);

  // a new style (from a local lab, not in the repo) is tuned in place: no new worker, no recompile
  const style = voice?.style;
  useEffect(() => {
    if (style) sphere.current?.tune(style);
  }, [style]);

  const box = chromeBox(size);
  return (
    <div ref={root} aria-hidden className="relative shrink-0" style={{ width: box, height: box, "--cy": "50%" } as CSSProperties}>
      <Chrome size={size} poster={poster} />
    </div>
  );
}
