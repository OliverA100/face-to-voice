"use client";

/**
 * A voice preview's orb: the header logo's look, the loader's sphere mid-swing
 * with its rainbow, each voice another moment of the loader (other bumps, other rainbow). Pre-rendered with the loader's
 * shader (loader/chromeGl.ts): a still per voice, and while `playing` a strip of 24 frames
 * swinging close to the logo's moment (polish 0.4 → 0.65: wider, it reaches the rainbow-heavy bubble; out to the matte
 * blob it washes out), played forwards then backwards behind a one-orb window by a transform (a Web Animation on the
 * compositor, as the spinner).
 *
 * No jump at either hand-over: the still IS the strip's frame `stillFrame` (rendered as a pair), so playing starts on
 * that frame, and on pause the strip runs back to it the shorter way, at its own pace (≤ ~0.7 s, as the loader settles
 * rather than cutting), before the still takes over. The strip is an <img> decoded before it goes on the page (as a CSS
 * background, Chrome paints the first play's first ~200 ms blank while it decodes the 2.6k-px strip; decode() on the
 * very element shown is what guarantees it draws at once); until then the still stays. Reduced motion: the still stays.
 *
 * Darkened by the row: on hover → 40 %, while playing → VOICE_BLOB.playingBrightness (the swing and colour stay visible
 * under the pause icon); a filter on the blob itself, so it follows the bumps (a dark circle over it would show around
 * them).
 */
import { useEffect, useLayoutEffect, useRef, useState } from "react";

import still0 from "@/lib/brand/voice-orb-0.webp";
import strip0 from "@/lib/brand/voice-orb-0-strip.webp";
import still1 from "@/lib/brand/voice-orb-1.webp";
import strip1 from "@/lib/brand/voice-orb-1-strip.webp";
import still2 from "@/lib/brand/voice-orb-2.webp";
import strip2 from "@/lib/brand/voice-orb-2-strip.webp";
import { reducedMotion } from "@/lib/reducedMotion";

const STILLS = [still0, still1, still2];
const STRIPS = [strip0, strip1, strip2];

export const VOICE_BLOB = {
  frames: 24, // in each strip
  half: 1.2, // s per pass through the strip (the spinner's pace)
  stillFrame: 9, // the strip's frame that is the still (polish 0.494 ≈ the logo's 0.5)
  playingBrightness: 0.85, // while playing (the class brightness-[0.85]): colour and motion stay clear (hover: 0.4)
};

const FRAME_MS = (VOICE_BLOB.half * 1000) / VOICE_BLOB.frames; // how long each frame shows while playing
/** The strip's offset that shows frame `f` (a share of the strip's own width). */
const at = (f: number) => `translateX(${(-100 * f) / VOICE_BLOB.frames}%)`;

// Each strip, fetched and decoded once ahead (prefetch): the first play's own <img> then decodes at once.
const decoded: (Promise<void> | undefined)[] = [];
const decode = (i: number) =>
  (decoded[i] ??= (() => {
    const img = new Image();
    img.src = STRIPS[i].src;
    return img.decode().catch(() => {});
  })());

/** The strip as shown: an <img> 24 orbs wide behind the one-orb window, starting on the still's frame. */
function stripImage(i: number): HTMLImageElement {
  const img = new Image();
  img.src = STRIPS[i].src;
  img.alt = "";
  img.draggable = false;
  img.style.cssText = `display:block;height:100%;width:${VOICE_BLOB.frames * 100}%;max-width:none;transform:${at(VOICE_BLOB.stillFrame)}`;
  return img;
}

/** Fetch the playing strips ahead (the voice list calls it once the previews show), so the first play doesn't wait. */
export function usePrefetchVoiceBlobs(): void {
  useEffect(() => {
    const fetchAll = () => STRIPS.forEach((_, i) => void decode(i));
    const id = typeof window.requestIdleCallback === "function" ? window.requestIdleCallback(fetchAll, { timeout: 2000 }) : window.setTimeout(fetchAll, 200);
    return () => (typeof window.cancelIdleCallback === "function" ? window.cancelIdleCallback(id) : window.clearTimeout(id));
  }, []);
}

/** The frame a strip animation shows now (its stepped progress: 0, 1/n, … 1 across the frames it covers). */
function frameOf(r: { anim: Animation; from: number; to: number }): number {
  const p = r.anim.effect?.getComputedTiming().progress ?? 1; // null once a finished run no longer fills: its end
  return Math.round(r.from + (r.to - r.from) * p);
}

export function VoiceBlob({ index, playing, size = 36 }: { index: number; playing: boolean; size?: number }) {
  const i = ((index % 3) + 3) % 3;
  const host = useRef<HTMLSpanElement>(null); // the window the strip <img> goes into
  const img = useRef<{ i: number; el: HTMLImageElement } | null>(null); // this orb's strip, kept between plays
  // the strip is up while playing and while it runs back to the still's frame afterwards
  const [moving, setMoving] = useState(false);
  const [ready, setReady] = useState(false); // decoded: the strip may replace the still
  if (playing && !moving && !reducedMotion.on) setMoving(true);
  else if (!playing && moving && !ready) setMoving(false); // paused before the strip could show: the still never left
  const run = useRef<{ anim: Animation; from: number; to: number } | null>(null);
  const rest = () => {
    run.current?.anim.cancel(); // its end (fill) is the still's frame; the still takes over in the same paint
    run.current = null;
    setMoving(false);
    setReady(false);
  };

  useEffect(() => {
    if (!moving || ready) return;
    let live = true;
    if (img.current?.i !== i) img.current = { i, el: stripImage(i) };
    const el = img.current.el;
    void decode(i)
      .then(() => el.decode())
      .catch(() => {})
      .then(() => live && setReady(true));
    return () => {
      live = false;
    };
  }, [moving, ready, playing, i]);

  // the decoded <img> into its window before the first paint (React renders the window empty)
  useLayoutEffect(() => {
    const el = img.current?.el;
    // (its inline transform, the still's frame, is never changed: the animations only override it while they run)
    if (moving && ready && el && host.current && el.parentNode !== host.current) host.current.append(el);
  }, [moving, ready]);

  useEffect(() => {
    const el = img.current?.el;
    if (!moving || !ready || !el) return;
    const now = run.current ? frameOf(run.current) : VOICE_BLOB.stillFrame;
    run.current?.anim.cancel();
    const last = VOICE_BLOB.frames - 1;
    if (playing) {
      // swing on from where it is (the still's frame at first), forwards first; +½ frame: never a frame early
      const anim = el.animate([{ transform: at(0) }, { transform: at(last) }], {
        duration: VOICE_BLOB.half * 1000,
        easing: `steps(${VOICE_BLOB.frames}, jump-none)`,
        iterations: Infinity,
        direction: "alternate",
        iterationStart: (now + 0.5) / VOICE_BLOB.frames,
      });
      run.current = { anim, from: 0, to: last };
      return;
    }
    // paused: back to the still's frame the shorter way, one frame at a time at the swing's pace, then the still
    const to = VOICE_BLOB.stillFrame;
    const n = Math.abs(to - now); // 0: already there, the still takes over on the next frame
    const anim = el.animate([{ transform: at(now) }, { transform: at(to) }], { duration: n * FRAME_MS, easing: `steps(${Math.max(1, n)}, jump-end)`, fill: "forwards" });
    run.current = { anim, from: now, to };
    anim.onfinish = rest;
  }, [moving, ready, playing]);

  useEffect(() => () => run.current?.anim.cancel(), []);

  return (
    <span
      aria-hidden
      // classes, not an inline filter: hover (a variant, later in the CSS) must win while playing too
      className={`block shrink-0 overflow-hidden transition-[filter] duration-(--dur-1) group-hover/row:brightness-[0.4] ${playing ? "brightness-[0.85]" : ""}`}
      style={{ width: size, height: size }}
    >
      {moving && ready ? (
        // keys: the still is a new element (the strip's animation must not carry over); the window's <img> is added above
        <span key="strip" ref={host} className="block h-full" />
      ) : (
        <span key="still" className="block h-full w-full" style={{ backgroundImage: `url(${STILLS[i].src})`, backgroundSize: "cover" }} />
      )}
    </span>
  );
}

/**
 * A preview row's placeholder while the voices are designed: its orb's own silhouette (the still as a mask) in the grey
 * of the other skeleton bars, pulsing, so the result appears in the shape it promised (round placeholders turned into
 * bumpy orbs). It also fetches the stills ahead of the result.
 */
export function VoiceBlobPlaceholder({ index, size = 36 }: { index: number; size?: number }) {
  const mask = `url(${STILLS[((index % 3) + 3) % 3].src})`;
  return (
    <span
      aria-hidden
      className="block shrink-0 animate-pulse bg-surface"
      style={{ width: size, height: size, maskImage: mask, WebkitMaskImage: mask, maskSize: "cover", WebkitMaskSize: "cover" }}
    />
  );
}
