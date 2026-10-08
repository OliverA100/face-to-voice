"use client";

import { type ReactNode, useEffect, useState } from "react";

import spinnerStrip from "@/lib/brand/spinner.webp";
import { whenRevealed } from "@/lib/headLoad";
import { MOTION } from "@/lib/motion";

/**
 * The busy spinner: the loader's sphere. The loader's whole swing, blob → bubble, with the rainbow film and halo at 30 %
 * (the full film at the bubble end is far more rainbow than the header logo; a short swing around the logo's moment
 * keeps the colour down but barely shows any motion), pre-rendered with the real shader in the header logo's treatment
 * (a 14 px white bubble all but vanishes on a white pill) as one strip of `frames` frames, played forwards then
 * backwards (a seamless loop; no WebGL, the browser animates it like any image). The strip is rendered with the loader's
 * shader (loader/chromeGl.ts), so it changes only when these do.
 */
export const SPINNER = { size: 18, frames: 24, half: 1.2 }; // px, frames in the strip, s from blob to bubble

// Fetched once the head is on screen (not during its download, which it would slow on a phone; no pill is busy before),
// so the first busy pill doesn't wait for it.
if (typeof window !== "undefined") {
  const fetchStrip = () => {
    const img = new Image();
    img.src = spinnerStrip.src;
    void img.decode?.().catch(() => {}); // decoded too, or the first busy pill shows an empty slot for a frame
  };
  void whenRevealed(15000).then(() =>
    typeof window.requestIdleCallback === "function" ? window.requestIdleCallback(fetchStrip, { timeout: 2000 }) : setTimeout(fetchStrip, 200), // (Safari: no idle callback)
  );
}

/**
 * The spinner inside a busy pill ("Reading the face…", "Packing…"). It inflates as it appears (from a dot) and opens on
 * the strip's last, smoothest frame (starting on the matte blob shows a grey smudge first), then swings back. `shown`
 * false: it shrinks away (BusySwap keeps it for the exit). `late`: it starts growing 120 ms in (BusySwap: once the
 * label has mostly faded).
 *
 * Compositor-only: a window onto the strip, which slides by a transform (a background-position animation repaints on
 * the main thread, and busy pills are exactly when it is busy: Random character holds it ~150 ms), and the entrance is
 * scale only. No opacity fade: Chrome keeps an animation that starts invisible (fully transparent, or fully clipped) on
 * the main thread, and the endless strip would stay there for good (seen in a performance trace).
 */
export function Spinner({ shown = true, late = false }: { shown?: boolean; late?: boolean }) {
  return (
    <span
      aria-hidden
      className={`block size-4.5 shrink-0 overflow-hidden transition-[scale] duration-(--dur-2) ease-soft starting:scale-0 ${shown ? (late ? "delay-120" : "") : "scale-0"}`}
    >
      <span
        className="block h-full"
        style={{
          width: `${SPINNER.frames * 100}%`,
          backgroundImage: `url(${spinnerStrip.src})`,
          backgroundSize: "100% 100%",
          ["--spinner-end" as string]: `${(-100 * (SPINNER.frames - 1)) / SPINNER.frames}%`, // the last frame
          // globals.css; -half: one swing already played, so it starts on the bubble on its way back
          animation: `spinner-swing ${SPINNER.half}s steps(${SPINNER.frames}, jump-none) -${SPINNER.half}s infinite alternate`,
        }}
      />
    </span>
  );
}

/** How long a busy pill keeps the spinner for its exit (--dur-2). */
const EXIT_MS = MOTION.move * 1000;

/** Whether the spinner is mounted: from `busy` until it has shrunk away. (Only once busy: the strip loads after the reveal.) */
export function useSpinnerPresent(busy: boolean): boolean {
  const [present, setPresent] = useState(busy);
  if (busy && !present) setPresent(true);
  useEffect(() => {
    if (busy) return;
    const id = setTimeout(() => setPresent(false), EXIT_MS);
    return () => clearTimeout(id);
  }, [busy]);
  return present;
}

/**
 * A busy pill whose spinner takes the label's place (every busy pill in the app): the pill keeps its natural width;
 * while `busy` the label fades out and the bubble grows in the middle (opacity + scale: the compositor). The label stays
 * in the button, so screen readers still hear it. The pill needs `grid`.
 */
export function BusySwap({ busy, children }: { busy: boolean; children: ReactNode }) {
  const present = useSpinnerPresent(busy);
  return (
    <>
      {/* one after the other, not over each other: the bubble grows once the label is mostly gone (`late`: 120 ms,
          ~90 % of the fade on --ease-out-soft), and on the way back the label returns once the bubble has mostly shrunk */}
      <span className={`col-start-1 row-start-1 transition-opacity duration-(--dur-2) ease-soft ${busy ? "opacity-0" : "delay-120"}`}>{children}</span>
      {present && (
        <span aria-hidden className="col-start-1 row-start-1 grid place-items-center">
          <Spinner shown={busy} late />
        </span>
      )}
    </>
  );
}

/** Two frames: long enough for a busy pill's entrance to start on the compositor before blocking work begins. */
export const afterEntrance = () => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
