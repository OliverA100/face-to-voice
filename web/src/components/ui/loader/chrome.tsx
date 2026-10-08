/**
 * The loader's sphere: a lumpy, matte white blob that polishes into its finish as the head loads (a port of a three.js
 * chrome noise sphere, "the reference" below; it ships as a soap bubble), drawn by ./chromeGl.ts in a worker
 * (./chromeWorker.ts).
 * Server-rendered first as a still poster of its opening frame (./orbPoster.css), which stays when WebGL is missing.
 *
 * The polish (the reference's setPolish) has its own rhythm, not the load's (the waveform and the % show progress):
 * the sphere swings from the blob to the finish and back, and when the reveal starts it turns towards the finish and
 * settles there as the head fades in (./chromeGl.ts createChromeFlow). With prefers-reduced-motion it is one still
 * frame (the blob, as the poster) and the reveal is a plain fade.
 *
 * Tweak here: CHROME (the scene itself: ./chromeGl.ts CHROME_GL).
 */
import gsap from "gsap";

import { type ScreenCircle } from "@/lib/headMorph";

import { type LoaderState } from "./engine";
import type { ChromeFinish, ChromeFlowConfig, ChromeGl, ChromeLook, createChromeFlow } from "./chromeGl";
import type { FromChromeWorker, ToChromeWorker } from "./chromeWorker";
import { centred } from "./wave";

export const CHROME = {
  finish: null as ChromeFinish | null, // what it settles into (null = SOAP_BUBBLE; the style lab sets others)
  ball: 0.85, // the polished ball's diameter, × the loader's --orb size (the bumps reach ~1.35× further at the start)
  amp: 0.4, // bump height at 0 % (sphere radii; the reference's setPolish)
  speed: 0.2, // noise drift per second at 0 % (the reference's speed; each finish sets its own at 100 %)
  turn: 0.15, // radians the sphere turns per second (the reference's rotation)
  period: 3, // s for one swing blob → finish → blob (it sits ~0.43 s at each end; 4 s with a pendulum swing sits 0.9 s)
  dwell: 0.25, // how much it slows into each end (0 = turns at constant speed, 1 = pendulum; 1 reads as long pauses)
  settleSpeed: 1.2, // once the head is ready it heads for the finish at this × the swing's pace (0.25–1.4 s; it peaks at
  // ~1.5× the swing's own speed; a fixed 0.5 s settle rushes at 3–4× and reads as skipping ahead)
  hold: null as number | null, // the style lab: pin the polish (0..1) instead of swinging
  fadeIn: 0.25, // s, first page load only: the live sphere cross-fades over the server-painted poster (the same frame)
  maxStep: 1 / 30, // s, the most the clock advances in one frame (after a stall it carries on instead of jumping)
  start: 12, // s on the clock the sphere opens at (where the bumps are; any number)
  fov: 40, // degrees, the reference's camera: at (0, 0, distance) looking at the sphere
  distance: 4,
  dprMax: 2,
};

/**
 * The finish it settles into, "Soap bubble": part metal, a full rainbow film, small rolling bumps. The other finishes
 * (compared in the style labs) are not in the repository.
 */
export const SOAP_BUBBLE: ChromeFinish = { rest: 0.03, restSpeed: 0.3, rough: 0.06, metal: 0.7, halo: 1, irid: 1, base: [1, 1, 1], filmBody: 0 };

/** How much of the canvas the polished ball spans: the camera sees ±tan(fov/2)·distance at the sphere's centre. */
export const BALL_IN_FRAME = 1 / (Math.tan(((CHROME.fov / 2) * Math.PI) / 180) * CHROME.distance);

/** Without WebGL and without a poster: a still, CSS-only silvery ball. */
const FALLBACK = "radial-gradient(circle at 42% 30%, #ffffff 0, #eef0f3 22%, #a7adb6 52%, #e9ebef 72%, #6b717a 100%)";

/** The canvas's width for a ball `size` wide: the ball plus room for the bumps. */
export const chromeBox = (size: string) => `calc(${size} * ${+(CHROME.ball / BALL_IN_FRAME).toFixed(4)})`;

/** The sphere, its ball `size` wide (any CSS length), centred on the loader's focal point. */
export function Chrome({ size }: { size: string }) {
  const box = chromeBox(size);
  return (
    <div data-chrome style={centred(box)}>
      <div data-chrome-still className="absolute inset-0">
        {/* Shown only without a poster (./orbPoster.css sets --chrome-fallback: none): under the poster it would peek
            through the poster's antialiased rim. */}
        <div className="absolute rounded-full" style={{ inset: `${+((1 - BALL_IN_FRAME) * 50).toFixed(3)}%`, background: FALLBACK, display: "var(--chrome-fallback, block)" }} />
        <div className="absolute inset-0" style={{ backgroundImage: "var(--chrome-poster-image, none)", backgroundSize: "cover" }} />
      </div>
      {/* The WebGL canvas goes here (chromeMotion creates a fresh one per run: a canvas handed to a worker can't be reused). */}
    </div>
  );
}

/** What the renderer needs from CHROME (also the poster and logo renders in the style lab). */
export const chromeLook = (finish = CHROME.finish ?? SOAP_BUBBLE): ChromeLook => ({
  amp: CHROME.amp,
  speed: CHROME.speed,
  turn: CHROME.turn,
  finish,
  fov: CHROME.fov,
  distance: CHROME.distance,
  dprMax: CHROME.dprMax,
});
const flowConfig = (look: ChromeLook): ChromeFlowConfig => ({ start: CHROME.start, speed: look.speed, restSpeed: look.finish.restSpeed, period: CHROME.period, dwell: CHROME.dwell, settleSpeed: CHROME.settleSpeed, maxStep: CHROME.maxStep });

/**
 * The sphere's motion. Drawn in a worker on an OffscreenCanvas where possible, else by the page; without WebGL the
 * poster stays. Either way it opens on the poster's frame, holds there until it is on screen, then cross-fades in
 * over the poster. An ancestor with [data-chrome-still-only] forces the still poster; `finish` overrides CHROME.finish
 * (both the style lab).
 */
export function chromeMotion(
  root: HTMLElement,
  finish?: ChromeFinish,
): { frame(s: LoaderState): void; settle(): Promise<void>; focus(): ScreenCircle | null; dispose(): void } {
  const box = root.querySelector<HTMLElement>("[data-chrome]");
  const still = root.querySelector<HTMLElement>("[data-chrome-still]");
  let canvas: HTMLCanvasElement | null = null;
  let worker: Worker | null = null;
  let gl: ChromeGl | null = null; // main-thread renderer
  let flow: ReturnType<typeof createChromeFlow> | null = null;
  let ro: ResizeObserver | null = null;
  let shown = false;
  let failed = !box || !!root.closest("[data-chrome-still-only]");
  const look = chromeLook(finish);
  let sent = ""; // the drive last posted to the worker
  let drawn = ""; // reduced motion, main thread: the polish and width last drawn
  let last = 0;
  let disposed = false;
  let reduced = false;
  let startAt = Infinity; // main-thread renderer: when the sphere may start moving (after the fade-in, see onShown)
  let isSettled = false;
  let rest: { time: number; drift: number; at: number } | null = null; // the clock and noise when it settled
  let onSettled: (() => void) | null = null; // resolves settle(); it may wait for the first live frame too (the poster
  // is the blob: a reveal before the live sphere is up would otherwise fade out on the blob)
  const settledNow = () => {
    isSettled = true;
    onSettled?.();
    onSettled = null;
  };

  const newCanvas = () => {
    canvas?.remove();
    canvas = document.createElement("canvas");
    canvas.className = "absolute inset-0 h-full w-full";
    canvas.style.opacity = "0";
    canvas.setAttribute("aria-hidden", "true");
    box!.append(canvas);
    return canvas;
  };
  const onShown = () => {
    shown = true;
    performance.measure("chrome-first-frame", { start: t0, end: performance.now() }); // worker start + compile + first draw
    // The live sphere fades in over the poster while holding on the poster's frame, then the poster goes and only then
    // does the sphere start moving: moving during the fade, the poster's bigger spikes would show behind it and vanish
    // in one frame when the poster is removed. Compositor animations and a worker-side start time, not GSAP: the main
    // thread is busy setting up the head right now (a 200+ ms parse) and a main-thread fade would stall.
    const ms = CHROME.fadeIn * 1000;
    canvas?.animate([{ opacity: 0 }, { opacity: 1 }], { duration: ms, easing: "ease-in-out", fill: "forwards" });
    still?.animate([{ opacity: 1 }, { opacity: 0 }], { delay: ms, duration: 1, fill: "forwards" });
    if (worker) worker.postMessage({ type: "go", afterMs: ms + 20 } satisfies ToChromeWorker); // + a frame: the poster is gone
    startAt = performance.now() + ms + 20; // (the worker keeps its own; this one also estimates its clock: focus())
  };
  const toStill = () => {
    failed = true;
    worker?.terminate();
    worker = null;
    gl?.dispose();
    gl = null;
    canvas?.remove();
    canvas = null;
    still?.getAnimations().forEach((a) => a.cancel());
    gsap.set(still, { visibility: "visible" });
    settledNow(); // nothing left to wait for
  };
  /** The page draws it itself (no OffscreenCanvas, or the worker couldn't do WebGL). The renderer loads only then: the worker has its own copy. */
  let fellBack = false;
  const onMainThread = async () => {
    if (fellBack) return; // the worker can report "failed" and fail (onerror) too: one canvas, one GL context
    fellBack = true;
    worker?.terminate();
    worker = null;
    shown = false;
    startAt = Infinity; // hold on the poster's frame again until the page's sphere has faded in
    still?.getAnimations().forEach((a) => a.cancel()); // the poster back (it may have faded after the worker's "shown")
    const { createChromeGl, createChromeFlow } = await import("./chromeGl");
    if (disposed) return;
    const c = newCanvas();
    c.addEventListener("webglcontextlost", toStill);
    gl = createChromeGl(c, { ...look, sync: true });
    flow = createChromeFlow(flowConfig(look));
    if (!gl) toStill();
  };

  const t0 = performance.now();
  if (!failed) {
    if (typeof Worker !== "undefined" && "transferControlToOffscreen" in HTMLCanvasElement.prototype) {
      const c = newCanvas();
      const dpr = Math.min(CHROME.dprMax, devicePixelRatio || 1);
      const width = c.clientWidth * dpr; // one layout read, at start only
      const height = c.clientHeight * dpr;
      worker = new Worker(new URL("./chromeWorker.ts", import.meta.url), { type: "module" });
      worker.onmessage = (e: MessageEvent<FromChromeWorker>) => {
        const m = e.data;
        if (m.type === "shown") onShown();
        else if (m.type === "settled") {
          rest = { time: m.time, drift: m.drift, at: m.at };
          settledNow();
        } else void onMainThread();
      };
      worker.onerror = () => void onMainThread();
      const offscreen = c.transferControlToOffscreen();
      const init: ToChromeWorker = { type: "init", canvas: offscreen, look, flow: flowConfig(look), width, height };
      worker.postMessage(init, [offscreen]);
      ro = new ResizeObserver(([entry]) => worker?.postMessage({ type: "size", width: entry.contentRect.width * dpr, height: entry.contentRect.height * dpr } satisfies ToChromeWorker));
      ro.observe(c);
    } else void onMainThread();
  }
  performance.measure("chrome-gl-init", { start: t0, end: performance.now() });

  return {
    frame(s) {
      reduced = s.reduced;
      const drive = { settling: s.revealing, through: s.through, hold: CHROME.hold };
      if (worker) {
        const now = `${s.reduced} ${drive.settling} ${drive.through} ${drive.hold}`;
        if (now !== sent) {
          sent = now;
          worker.postMessage({ type: "drive", reduced: s.reduced, ...drive } satisfies ToChromeWorker);
        }
        return;
      }
      if (!gl || !flow) return;
      const t = performance.now(); // its own clock: the engine's dt is 0 with reduced motion (a lab hold still applies)
      const dt = last ? (t - last) / 1000 : 0;
      last = t;
      flow.step(dt, { ...drive, moving: t >= startAt && !s.reduced }); // hold on the poster's frame until it has replaced it
      const key = `${flow.frame.polish.toFixed(3)} ${gl.width()}`;
      if (s.reduced && key === drawn) return;
      if (gl.draw(flow.frame)) {
        drawn = key;
        if (!shown) onShown();
        if (flow.settled() && !isSettled) {
          rest = { time: flow.frame.time, drift: flow.frame.drift, at: performance.timeOrigin + t };
          settledNow();
        }
      }
    },
    /**
     * The ball on screen (viewport px): its centre and radius (the canvas box also holds room for the bumps), and where
     * its clock, noise and turn are now (from the settled frame on: at rest the noise drifts at the finish's restSpeed).
     */
    focus() {
      const r = box?.getBoundingClientRect();
      if (!r) return null;
      const since = rest ? (performance.timeOrigin + performance.now() - rest.at) / 1000 : 0;
      const clock = rest ? rest.time + since : CHROME.start + Math.max(0, performance.now() - startAt) / 1000; // (an estimate before it settles: it pauses briefly on stalls)
      const drift = rest ? rest.drift + since * look.finish.restSpeed : undefined;
      return { x: r.left + r.width / 2, y: r.top + r.height / 2, r: (r.width * BALL_IN_FRAME) / 2, clock, drift, turn: clock * look.turn, since: rest ? since : undefined };
    },
    /** After the reveal starts: resolves once the sphere is drawn on its finish (at once when it can't move). */
    settle() {
      if (failed || reduced || isSettled) return Promise.resolve();
      return new Promise<void>((resolve) => (onSettled = resolve));
    },
    dispose() {
      disposed = true;
      settledNow();
      ro?.disconnect();
      worker?.terminate();
      gl?.dispose();
      canvas?.remove();
    },
  };
}
