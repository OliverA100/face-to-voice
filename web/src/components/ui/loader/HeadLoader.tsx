"use client";

/**
 * The loader shown over the bust until the head is on screen. The markup is server-rendered (it paints with the
 * page's first paint, before any JS), then ./engine animates it from real load progress (lib/headLoad.ts) and hands
 * over to the head: the full reveal after at least TIMING.minShownMs, or a quick fade when the head was cached.
 */
import { type CSSProperties, type RefObject, useEffect, useRef } from "react";

import { headLoad, loadProgress, whenPartsReady } from "@/lib/headLoad";
import { onHeadVisible, perf } from "@/lib/perf";

import { type Loader, type LoaderVariant, TIMING, startLoader } from "./engine";
import { sphereTitle } from "./looks";

/**
 * The look a HeadLoader uses when none is passed: "A2 · Sphere + caption, no %". setDefaultLook swaps it, so the
 * style labs (outside the repository) can try other looks on the real head.
 */
const LOOK: { current: LoaderVariant } = { current: sphereTitle };
export const defaultLook = () => LOOK.current;
export function setDefaultLook(v: LoaderVariant): void {
  LOOK.current = v;
}

export interface LoaderControl {
  reveal(kind: "full" | "fade"): void;
}

const page = { firstMount: true }; // the first loader of the page load is the server-rendered one: it has been up since FCP

export function HeadLoader({
  variant = LOOK.current,
  stageRef,
  progress = loadProgress,
  auto = true,
  reducedMotion,
  controlRef,
  onRevealed,
}: {
  variant?: LoaderVariant;
  /** The head's wrapper, faded in by the reveal. */
  stageRef?: RefObject<HTMLElement | null>;
  /** 0..1; defaults to the real head load. */
  progress?: () => number;
  /** Reveal by itself once the head's first frame is drawn (false: only through `controlRef`). */
  auto?: boolean;
  /** Force reduced motion on or off (the style lab); default: the visitor's prefers-reduced-motion. */
  reducedMotion?: boolean;
  controlRef?: RefObject<LoaderControl | null>;
  onRevealed?: () => void;
}) {
  const root = useRef<HTMLDivElement>(null);
  // Latest callbacks without restarting the loader when a parent re-renders.
  const cb = useRef({ progress, onRevealed });
  useEffect(() => {
    cb.current = { progress, onRevealed };
  });

  useEffect(() => {
    const el = root.current;
    if (!el) return;
    const fcp = performance.getEntriesByName("first-contentful-paint")[0]?.startTime;
    const shownAt = page.firstMount && fcp !== undefined ? fcp : performance.now();
    if (page.firstMount && fcp !== undefined) perf.loaderPaintMs = Math.round(fcp);
    perf.loaderLiveMs = Math.round(performance.now());
    page.firstMount = false;

    const reduced = reducedMotion ?? matchMedia("(prefers-reduced-motion: reduce)").matches;
    let loader: Loader;
    try {
      loader = startLoader({
        root: el,
        create: variant.create,
        progress: () => cb.current.progress(),
        stage: stageRef?.current ?? null,
        reduced,
        onRevealed: () => cb.current.onRevealed?.(),
      });
    } catch (e) {
      // Never let a loader bug hide the head: show it and step aside.
      console.error("[loader]", e);
      if (stageRef?.current) stageRef.current.style.opacity = "1";
      el.style.visibility = "hidden";
      cb.current.onRevealed?.();
      return;
    }
    if (controlRef) controlRef.current = loader;

    let timer = 0;
    let raf = 0;
    let live = true;
    const offVisible = auto
      ? onHeadVisible(async () => {
          // Reveal the whole look at once: wait for the hair and add-ons to be on the head (capped).
          await whenPartsReady(TIMING.partsCapMs);
          if (!live) return;
          // Two frames: the first frame with a new mesh compiles its shaders (the long main-thread tasks of the
          // load), and a tween started inside one would lose its first steps.
          const afterTwoFrames = (fn: () => void) => (raf = requestAnimationFrame(() => (raf = requestAnimationFrame(fn))));
          const now = performance.now();
          if (headLoad.fromCache || now - shownAt < TIMING.quickMs) return afterTwoFrames(() => loader.reveal("fade"));
          timer = window.setTimeout(() => afterTwoFrames(() => loader.reveal("full")), Math.max(0, shownAt + TIMING.minShownMs - now));
        })
      : () => {};

    return () => {
      live = false;
      offVisible();
      clearTimeout(timer);
      cancelAnimationFrame(raf);
      loader.dispose();
      if (controlRef) controlRef.current = null;
    };
  }, [variant, stageRef, auto, reducedMotion, controlRef]);

  return (
    <div
      ref={root}
      role="progressbar"
      aria-label="Loading the 3D head"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={0}
      className="pointer-events-none absolute inset-0 overflow-hidden"
      // will-change: the fade-out and shrink only composite; without it every frame would repaint the orb's grain.
      // Sizes scale with the card (cq units) so the orb and caption stay clear of the Reset pill on phones.
      style={{ containerType: "size", willChange: "opacity, transform", "--orb": "min(256px, 44cqmin)", "--cy": "calc(50% - 32px)", "--cap": "calc(var(--orb) * 0.5 + clamp(28px, 8cqmin, 44px))", ...variant.vars } as CSSProperties}
    >
      <variant.Markup />
      {/* Type as under a voice card (docs/design.md): the title 16px medium in black, the secondary value muted.
          The whole line is centred as one unit. The % sits in a slot as wide as "00%" (an invisible copy sizes it, so
          it holds in any font), right-aligned with tabular figures: from 10 to 99 % the line never moves; "100%"
          widens it by half a digit, but only during the fade-out.
          Screen readers get aria-valuenow instead. */}
      <p data-loader-caption className="absolute inset-x-0 flex justify-center gap-2 px-4 text-input font-medium text-ink" style={{ top: "calc(var(--cy) + var(--cap))" }}>
        Shaping a face
        {variant.percent !== false && (
          <span aria-hidden className="inline-grid font-normal tabular-nums text-ink-3">
            <span className="invisible col-start-1 row-start-1">00%</span>
            <span data-loader-pct className="col-start-1 row-start-1 text-right">
              0%
            </span>
          </span>
        )}
      </p>
    </div>
  );
}
