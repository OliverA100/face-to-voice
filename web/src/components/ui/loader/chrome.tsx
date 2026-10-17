/**
 * The loader's sphere: a lumpy, matte white blob that polishes into its finish as the head loads (a port of a three.js
 * chrome noise sphere, "the reference" below; it ships as a soap bubble), drawn by ./chromeGl.ts in a worker
 * (./chromeWorker.ts).
 * Server-rendered first as a still poster of its opening frame (./orbPoster.css), which stays when WebGL is missing.
 *
 * The polish (the reference's setPolish) has its own rhythm, not the load's: the sphere swings from
 * the blob to the finish and back, and when the reveal starts it turns towards the finish and
 * settles there as the head fades in (./chromeGl.ts createChromeFlow). With prefers-reduced-motion
 * it is one still frame (the blob, as the poster) and the reveal is a plain fade.
 *
 * Tweak here: CHROME (the scene itself: ./chromeGl.ts CHROME_GL).
 */
import type { CSSProperties } from "react";
import { preloadModule } from "react-dom";

import type { ScreenCircle } from "@/lib/headMorph";

import type { LoaderState } from "./engine";
import type { ChromeFinish, ChromeFlowConfig, ChromeGl, ChromeLook, ChromeVoice, ChromeVoiceStyle, createChromeFlow } from "./chromeGl";
import type { FromChromeWorker, ToChromeWorker } from "./chromeWorker";

export const CHROME = {
  finish: null as ChromeFinish | null, // what it settles into (null = SOAP_BUBBLE; a local lab, not in the repo, sets others)
  ball: 0.85, // the polished ball's diameter, × the loader's --orb size (the bumps reach ~1.35× further at the start)
  amp: 0.4, // bump height at 0 % (sphere radii; the reference's setPolish)
  speed: 0.2, // noise drift per second at 0 % (the reference's speed; each finish sets its own at 100 %)
  turn: 0.15, // radians the sphere turns per second (the reference's rotation)
  period: 3, // s for one swing blob → finish → blob (it sits ~0.43 s at each end; 4 s with a pendulum swing sits 0.9 s)
  dwell: 0.25, // how much it slows into each end (0 = turns at constant speed, 1 = pendulum; 1 reads as long pauses)
  // the lumpy blob end keeps a little of the finish's colour (the polish its colour and gloss never drop below;
  // 0 = fully white). The poster (./orbPoster.css) and the reveal's bubble (lib/morphShader.ts) follow it
  colourFloor: 0.25,
  // once the head is ready it heads for the finish at this × the swing's pace (0.25–1.4 s; it peaks at ~1.5× the
  // swing's own speed; a fixed 0.5 s settle rushes at 3–4× and reads as skipping ahead)
  settleSpeed: 1.2,
  hold: null as number | null, // a local lab (not in the repo): pin the polish (0..1) instead of swinging
  fadeIn: 0.25, // s, first page load only: the live sphere cross-fades over the server-painted poster (the same frame)
  maxStep: 1 / 30, // s, the most the clock advances in one frame (after a stall it carries on instead of jumping)
  start: 12, // s on the clock the sphere opens at (where the bumps are; any number)
  fov: 40, // degrees, the reference's camera: at (0, 0, distance) looking at the sphere
  distance: 4,
  dprMax: 2,
};

/**
 * The finish it settles into, "Soap bubble": part metal, a full rainbow film, small rolling bumps. The other finishes
 * live in a local lab, not in the repo.
 */
export const SOAP_BUBBLE: ChromeFinish = { rest: 0.03, restSpeed: 0.3, rough: 0.06, metal: 0.7, halo: 1, irid: 1, base: [1, 1, 1], filmBody: 0 };

/**
 * How the sphere can answer a voice (a live chat's: components/ui/TalkPanel.tsx), compared side by side in a local
 * lab (not in the repo). Each number is "at full loudness" (./chromeGl.ts ChromeVoiceStyle says what each does).
 * Tweak here; VOICE_STYLE picks the one the chat uses.
 */
export const VOICE_STYLES = {
  swell: {
    label: "A · Swell",
    blurb: "Holds the soap bubble; its bumps grow and roll as the voice gets louder.",
    style: { swing: false, dip: 0, swell: 0.22, flow: 0.8, pulse: 0, curve: 0.8, attack: 0.04, release: 0.2, ease: 0.4 },
  },
  swellCalm: {
    label: "A2 · Swell, calm",
    blurb: "Swell, calmer: the bumps rise a little slower, fall back gently between words and roll at an easy pace.",
    style: { swing: false, dip: 0, swell: 0.16, flow: 0.3, pulse: 0, curve: 0.9, attack: 0.08, release: 0.4, ease: 0.6 },
  },
  breathe: {
    label: "B · Breathe",
    blurb: "The loader's own change, driven by the voice: loud turns it towards the lumpy white blob, quiet back to the bubble.",
    style: { swing: false, dip: 0.75, swell: 0, flow: 0.3, pulse: 0, curve: 1, attack: 0.05, release: 0.25, ease: 0.4 },
  },
  shimmer: {
    label: "C · Shimmer",
    blurb: "Small bumps that roll fast while it talks and calm down in the pauses.",
    style: { swing: false, dip: 0.1, swell: 0.07, flow: 3, pulse: 0, curve: 0.6, attack: 0.03, release: 0.3, ease: 0.4 },
  },
  pulse: {
    label: "D · Pulse",
    blurb: "Grows a little with each syllable, with a little swell. New movement for the sphere.",
    style: { swing: false, dip: 0, swell: 0.08, flow: 0.5, pulse: 0.08, curve: 0.8, attack: 0.03, release: 0.15, ease: 0.4 },
  },
  swing: {
    label: "E · Swing + swell",
    blurb: "Keeps the loader's blob ↔ bubble swing all the time; the voice adds bumps on top.",
    style: { swing: true, dip: 0, swell: 0.18, flow: 0.8, pulse: 0, curve: 0.8, attack: 0.04, release: 0.2, ease: 0.4 },
  },
  swingColour: {
    label: "E2 · Swing + swell, in colour",
    blurb: "E's motion exactly (the loader's whole swing, the voice's bumps on top), but the colour holds: white for the character, the rainbow for you.",
    style: { swing: true, holdColour: true, dip: 0, swell: 0.18, flow: 0.8, pulse: 0, curve: 0.8, attack: 0.04, release: 0.2, ease: 0.4 },
  },
  swellColour: {
    label: "F · Swell in colour",
    blurb: "E2 without the swing: a smooth sphere in silence, the voice's bumps when it sounds, as bumpy for the character as for you; only the colour differs.",
    style: { swing: false, holdColour: true, dip: 0, swell: 0.18, flow: 0.8, pulse: 0, curve: 0.8, attack: 0.04, release: 0.2, ease: 0.4 },
  },
} satisfies Record<string, { label: string; blurb: string; style: ChromeVoiceStyle }>;
export type VoiceStyleId = keyof typeof VOICE_STYLES;
export const VOICE_STYLE: { id: VoiceStyleId } = { id: "swellColour" }; // the chat's (a local lab, not in the repo, switches it)

/**
 * The polish a sphere's colour and gloss are drawn at for a swing polish `p`: lifted at the blob
 * end by CHROME.colourFloor.
 */
export const colourPolish = (p: number) => CHROME.colourFloor + (1 - CHROME.colourFloor) * p;

/**
 * Production: the worker as one file at a fixed URL (next.config.ts chromeWorkerSource); empty in dev, where
 * the bundler's worker (three files fetched one after another) rebuilds on every edit.
 */
const WORKER_FILE = process.env.FTV_CHROME_WORKER;

/** How much of the canvas the polished ball spans: the camera sees ±tan(fov/2)·distance at the sphere's centre. */
export const BALL_IN_FRAME = 1 / (Math.tan(((CHROME.fov / 2) * Math.PI) / 180) * CHROME.distance);

/** Without WebGL and without a poster: a still, CSS-only silvery ball. */
const FALLBACK = "radial-gradient(circle at 42% 30%, #ffffff 0, #eef0f3 22%, #a7adb6 52%, #e9ebef 72%, #6b717a 100%)";

/** An absolutely positioned box centred on the loader's focal point (--cy). No transform, so GSAP owns transforms. */
const centred = (w: string, h: string = w): CSSProperties => ({ position: "absolute", left: "50%", top: "var(--cy)", width: w, height: h, marginLeft: `calc(${w} / -2)`, marginTop: `calc(${h} / -2)` });

/** The canvas's width for a ball `size` wide: the ball plus room for the bumps. */
export const chromeBox = (size: string) => `calc(${size} * ${+(CHROME.ball / BALL_IN_FRAME).toFixed(4)})`;

/**
 * The sphere, its ball `size` wide (any CSS length), centred on the loader's focal point. `poster`: a still of its own
 * opening frame instead of the loader's (./orbPoster.css; a voice orb's, components/ui/VoiceSphere.tsx). `boot`: the
 * head loader's, with a server-rendered canvas the sphere can start on before the app hydrates (bootChrome,
 * ChromeBootScript).
 */
export function Chrome({ size, poster, boot }: { size: string; poster?: string; boot?: boolean }) {
  const box = chromeBox(size);
  // the worker file downloads with the page's head, so the early start finds it cached (a <link rel="modulepreload">)
  if (boot && WORKER_FILE) preloadModule(WORKER_FILE);
  return (
    <div data-chrome style={centred(box)}>
      <div data-chrome-still className="absolute inset-0">
        {/* Shown only without a poster (./orbPoster.css sets --chrome-fallback: none): under the poster it would peek
            through the poster's antialiased rim. */}
        <div className="absolute rounded-full" style={{ inset: `${+((1 - BALL_IN_FRAME) * 50).toFixed(3)}%`, background: FALLBACK, display: "var(--chrome-fallback, block)" }} />
        <div className="absolute inset-0" style={{ backgroundImage: poster ? `url(${poster})` : "var(--chrome-poster-image, none)", backgroundSize: "cover" }} />
      </div>
      {/* The WebGL canvas goes here (chromeMotion creates a fresh one per run: a canvas handed to a worker can't be reused).
          The boot canvas is the exception: it is in the server's HTML so a script can draw on it before React hydrates
          (one added then would break hydration). Sized inline: it may be read before the stylesheet has loaded. Once its
          worker draws, the browser writes its pixel size onto it (width, height) before React may have hydrated: expected,
          so React isn't told to warn about it. */}
      {boot && <canvas data-chrome-boot aria-hidden suppressHydrationWarning style={{ position: "absolute", inset: 0, width: "100%", height: "100%", opacity: 0 }} />}
    </div>
  );
}

/** What the renderer needs from CHROME (also the poster and logo renders, made in a local lab, not in the repo). */
export const chromeLook = (finish = CHROME.finish ?? SOAP_BUBBLE): ChromeLook => ({
  amp: CHROME.amp,
  speed: CHROME.speed,
  turn: CHROME.turn,
  finish,
  fov: CHROME.fov,
  distance: CHROME.distance,
  dprMax: CHROME.dprMax,
});
const flowConfig = (look: ChromeLook, voice?: ChromeVoiceStyle, start = CHROME.start, startPolish?: number): ChromeFlowConfig => ({ start, startPolish, speed: look.speed, restSpeed: look.finish.restSpeed, period: CHROME.period, dwell: CHROME.dwell, settleSpeed: CHROME.settleSpeed, maxStep: CHROME.maxStep, voice, bumps: [look.amp, look.finish.rest], colourFloor: CHROME.colourFloor });

/** The browser can draw the sphere in a worker (else the page draws it itself). */
const workersDraw = () => typeof Worker !== "undefined" && "transferControlToOffscreen" in HTMLCanvasElement.prototype;

/**
 * The first frame is up: the live sphere fades in over the poster while holding on the poster's frame, then the poster
 * goes and only then does the sphere start moving (returns how long that is, in ms): moving during the fade, the
 * poster's bigger spikes would show behind it and vanish in one frame when the poster is removed. Compositor
 * animations and a worker-side start time, not GSAP: the main thread is busy setting up the head right now (a 200+ ms
 * parse) and a main-thread fade would stall. Self-contained (see runWorker).
 */
function fadeIn(canvas: HTMLCanvasElement | null, still: HTMLElement | null, ms: number): number {
  canvas?.animate([{ opacity: 0 }, { opacity: 1 }], { duration: ms, easing: "ease-in-out", fill: "forwards" });
  still?.animate([{ opacity: 1 }, { opacity: 0 }], { delay: ms, duration: 1, fill: "forwards" });
  return ms + 20; // + a frame: the poster is gone
}

/** A sphere a worker draws on `canvas`. It fades itself in over the poster on its first frame (fadeIn). */
interface WorkerSphere {
  worker: Worker;
  canvas: HTMLCanvasElement;
  startAt: number; // when it starts moving (performance.now() ms; Infinity until its first frame is up)
  failed: boolean; // the worker couldn't draw (the page draws it instead)
  on(m: FromChromeWorker): void; // its owner's: every message, after the sphere's own handling
  stop(): void;
}

/** Everything runWorker needs but the worker, as plain data (the inline script gets it as JSON). */
interface WorkerSetup {
  look: ChromeLook;
  flow: ChromeFlowConfig;
  dprMax: number;
  fadeMs: number;
}

/**
 * `worker` drawing the sphere on `canvas`: sized to it, and on its first frame faded in over the poster (`still`) and
 * set moving. `boot`: the server-rendered canvas (React's markup: hidden when done, never removed).
 * Self-contained, like fadeIn and earlyBoot: they use only their arguments, each other and browser globals, because the
 * page's HTML runs a copy of them (ChromeBootScript) before any of the app's JS has arrived.
 */
function runWorker(worker: Worker, canvas: HTMLCanvasElement, still: HTMLElement | null, o: WorkerSetup, boot: boolean): WorkerSphere {
  const t0 = performance.now();
  const dpr = Math.min(o.dprMax, devicePixelRatio || 1);
  const width = canvas.clientWidth * dpr; // one layout read, at start only
  const height = canvas.clientHeight * dpr;
  const ro = new ResizeObserver(([entry]) => worker.postMessage({ type: "size", width: entry.contentRect.width * dpr, height: entry.contentRect.height * dpr } satisfies ToChromeWorker));
  const s: WorkerSphere = {
    worker,
    canvas,
    startAt: Infinity,
    failed: false,
    on: () => {},
    stop() {
      s.on = () => {};
      ro.disconnect();
      worker.terminate();
      if (boot) canvas.style.visibility = "hidden";
      else canvas.remove();
    },
  };
  worker.onmessage = (e: MessageEvent<FromChromeWorker>) => {
    const m = e.data;
    if (m.type === "shown") {
      performance.measure("chrome-first-frame", { start: t0, end: performance.now() }); // worker start + compile + first draw
      const wait = fadeIn(canvas, still, o.fadeMs);
      worker.postMessage({ type: "go", afterMs: wait } satisfies ToChromeWorker);
      s.startAt = performance.now() + wait; // (the worker keeps its own; this one also estimates its clock: focus())
    } else if (m.type === "failed") s.failed = true;
    s.on(m);
  };
  worker.onerror = () => {
    s.failed = true;
    s.on({ type: "failed" });
  };
  const offscreen = canvas.transferControlToOffscreen();
  const init: ToChromeWorker = { type: "init", canvas: offscreen, look: o.look, flow: o.flow, width, height };
  worker.postMessage(init, [offscreen]);
  ro.observe(canvas);
  return s;
}

/**
 * The head loader's sphere on its server-rendered canvas (Chrome `boot`), if this page has one and it can
 * move: not with reduced motion (the poster is all there is), nor without OffscreenCanvas (the page draws
 * it after hydration). Self-contained (see runWorker); `newWorker` defaults to the production worker file.
 */
function earlyBoot(o: WorkerSetup & { file: string }, newWorker = () => new Worker(o.file, { type: "module" })): WorkerSphere | undefined {
  const canvas = document.querySelector<HTMLCanvasElement>("canvas[data-chrome-boot]");
  if (!canvas || typeof Worker === "undefined" || !("transferControlToOffscreen" in canvas)) return;
  if (matchMedia("(prefers-reduced-motion: reduce)").matches || canvas.closest("[data-chrome-still-only]")) return;
  const t0 = performance.now();
  const sphere = runWorker(newWorker(), canvas, canvas.parentElement!.querySelector<HTMLElement>("[data-chrome-still]"), o, true);
  performance.measure("chrome-boot", { start: t0, end: performance.now() });
  return sphere;
}

declare global {
  interface Window {
    __chromeBoot?: WorkerSphere; // the sphere ChromeBootScript started, for bootChrome to take on
  }
}

const workerSetup = (look = chromeLook()): WorkerSetup => ({ look, flow: flowConfig(look), dprMax: CHROME.dprMax, fadeMs: CHROME.fadeIn * 1000 });
/** The sphere's worker: production's one file, or the bundler's (dev). */
const newWorker = () => (WORKER_FILE ? new Worker(WORKER_FILE, { type: "module" }) : new Worker(new URL("./chromeWorker.ts", import.meta.url), { type: "module" }));

/**
 * The script that starts the head loader's sphere straight from the page's HTML, before any of the app's JS: on a slow
 * first visit the app's first scripts arrive about a second after the poster, the rest seconds later. Rendered by the
 * root layout (a server component: its text is the server's, so hydration matches), after the page's markup. It waits
 * for the stylesheets (the loader has no size before them, and the poster isn't painted yet), runs
 * earlyBoot, and leaves the sphere on window.__chromeBoot for bootChrome. Production only (the
 * worker file, preloaded with the page's head by Chrome `boot`); any error leaves it to bootChrome.
 */
export function ChromeBootScript() {
  return WORKER_FILE ? <script dangerouslySetInnerHTML={{ __html: chromeBootJs(WORKER_FILE) }} /> : null;
}
/** ChromeBootScript's text: the self-contained functions, then a start once every stylesheet has loaded. */
export const chromeBootJs = (file: string) => `(function(){${fadeIn}${runWorker}${earlyBoot}
var go=function(){try{window.__chromeBoot=${earlyBoot.name}(${JSON.stringify({ ...workerSetup(), file })})}catch(e){}};
var css=[].filter.call(document.querySelectorAll('link[rel="stylesheet"]'),function(l){return !l.sheet});
var n=css.length;if(!n)go();else css.forEach(function(l){var done=function(){if(--n===0)go()};l.addEventListener("load",done);l.addEventListener("error",done)});
})()`;

/**
 * The sphere bootChrome started (or took on), until its loader adopts it (`closed`: too late to
 * start one, the app is up).
 */
const boot = { sphere: null as WorkerSphere | null, box: null as HTMLElement | null, still: null as HTMLElement | null, look: "", release: 0, closed: false };

/**
 * Starts the head loader's sphere as soon as the app's first scripts run (src/instrumentation-client.ts), long before
 * the app hydrates, unless the page's inline script (ChromeBootScript) has already started it: then it takes that one
 * on. Either way the worker draws on the loader's server-rendered canvas, fades in over the poster and swings as usual;
 * the loader's chromeMotion then adopts it as it is (no second worker, no restart).
 */
export function bootChrome(): void {
  const start = () => {
    const canvas = document.querySelector<HTMLCanvasElement>("canvas[data-chrome-boot]");
    const box = canvas?.parentElement;
    if (!canvas || !box || boot.closed) return;
    boot.closed = true;
    const setup = workerSetup();
    let sphere = window.__chromeBoot;
    try {
      sphere ??= earlyBoot({ ...setup, file: "" }, newWorker);
    } catch {} // (the canvas already handed over by a failed inline start: chromeMotion starts its own)
    Object.assign(boot, { box, still: box.querySelector<HTMLElement>("[data-chrome-still]"), look: JSON.stringify(setup.look), sphere: sphere ?? null });
  };
  // the scripts can run before the parser reaches the loader
  if (!document.querySelector("canvas[data-chrome-boot]") && document.readyState === "loading") document.addEventListener("DOMContentLoaded", start, { once: true });
  else start();
}

/**
 * The booted sphere, if it is in `box` and drawn as `look` (else it stops: the caller starts its own, from the poster).
 */
function adoptBooted(box: HTMLElement, look: ChromeLook, other: boolean): WorkerSphere | null {
  const s = boot.sphere;
  if (!s || boot.box !== box) return null;
  boot.sphere = null;
  clearTimeout(boot.release);
  if (!other && boot.look === JSON.stringify(look)) return s;
  s.stop();
  boot.still?.getAnimations().forEach((a) => a.cancel()); // the poster back
  return null;
}

/**
 * Its loader is done with the booted sphere: it stops after this task, unless React's dev-only remount (StrictMode runs
 * every effect twice) adopts it again first, which would otherwise restart it.
 */
function releaseBooted(s: WorkerSphere): void {
  s.on = () => {};
  boot.sphere = s;
  boot.release = window.setTimeout(() => {
    if (boot.sphere !== s) return;
    boot.sphere = null;
    s.stop();
  });
}

/**
 * The sphere's motion. Drawn in a worker on an OffscreenCanvas where possible, else by the page; without WebGL the
 * poster stays. Either way it opens on the poster's frame, holds there until it is on screen, then cross-fades in
 * over the poster. An ancestor with [data-chrome-still-only] forces the still poster; `finish` overrides CHROME.finish
 * (both for a local lab, not in the repo). With `voice`, voice() lets a voice's loudness drive it
 * (./LoaderSphere.tsx `voice`); `start`: another clock to open at than CHROME.start (other bumps and rainbow:
 * one per voice preview), `startPolish` another polish than the blob's. The loader's poster is CHROME.start's
 * blob: a sphere opening elsewhere brings its own (Chrome `poster`), or cross-fades from a different shape.
 */
export function chromeMotion(
  root: HTMLElement,
  finish?: ChromeFinish,
  { voice: voiceStyle, start, startPolish }: { voice?: ChromeVoiceStyle; start?: number; startPolish?: number } = {},
): {
  frame(s: LoaderState): void;
  /** Each frame while a voice drives it (null: the loader's own swing). */
  voice(v: ChromeVoice | null): void;
  /** Answer the voice this way from now on (a local lab, not in the repo). */
  tune(style: ChromeVoiceStyle): void;
  settle(): Promise<void>;
  focus(): ScreenCircle | null;
  dispose(): void;
} {
  const box = root.querySelector<HTMLElement>("[data-chrome]");
  const still = root.querySelector<HTMLElement>("[data-chrome-still]");
  let canvas: HTMLCanvasElement | null = null; // the page's own (main-thread renderer)
  let sphere: WorkerSphere | null = null; // or the worker's
  let adopted = false; // the sphere is the one bootChrome started before the app hydrated
  let gl: ChromeGl | null = null; // main-thread renderer
  let flow: ReturnType<typeof createChromeFlow> | null = null;
  let shown = false;
  let failed = !box || !!root.closest("[data-chrome-still-only]");
  const look = chromeLook(finish);
  const config = flowConfig(look, voiceStyle ? { ...voiceStyle } : undefined, start, startPolish); // the main-thread flow's (tune() changes it)
  let voiceNow: ChromeVoice | null = null;
  let sentVoice = "off"; // the voice last posted to the worker
  let sent = ""; // the drive last posted to the worker
  let drawn = ""; // reduced motion, main thread: the polish and width last drawn
  let last = 0;
  let disposed = false;
  let reduced = false;
  let startAt = Infinity; // when the sphere may start moving (after the fade-in, see fadeIn)
  let isSettled = false;
  let rest: { time: number; drift: number; at: number } | null = null; // the clock and noise when it settled
  // resolves settle(); it may wait for the first live frame too (the poster is the blob: a reveal before the live
  // sphere is up would otherwise fade out on the blob)
  let onSettled: (() => void) | null = null;
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
  /** The live sphere is up (`at`: when it starts moving; the worker's sphere has faded itself in). */
  const onShown = (at: number) => {
    shown = true;
    startAt = at;
  };
  const toStill = () => {
    failed = true;
    sphere?.stop();
    sphere = null;
    gl?.dispose();
    gl = null;
    canvas?.remove();
    canvas = null;
    still?.getAnimations().forEach((a) => a.cancel());
    if (still) still.style.visibility = "visible";
    settledNow(); // nothing left to wait for
  };
  /**
   * The page draws it itself (no OffscreenCanvas, or the worker couldn't do WebGL). The renderer
   * loads only then: the worker has its own copy.
   */
  let fellBack = false;
  const onMainThread = async () => {
    if (fellBack) return; // the worker can report "failed" and fail (onerror) too: one canvas, one GL context
    fellBack = true;
    sphere?.stop();
    sphere = null;
    shown = false;
    startAt = Infinity; // hold on the poster's frame again until the page's sphere has faded in
    still?.getAnimations().forEach((a) => a.cancel()); // the poster back (it may have faded after the worker's "shown")
    const { createChromeGl, createChromeFlow } = await import("./chromeGl");
    if (disposed) return;
    const c = newCanvas();
    c.addEventListener("webglcontextlost", toStill);
    gl = createChromeGl(c, { ...look, sync: true });
    flow = createChromeFlow(config);
    if (!gl) toStill();
  };
  const onWorker = (m: FromChromeWorker) => {
    if (m.type === "shown") onShown(sphere!.startAt);
    else if (m.type === "settled") {
      rest = { time: m.time, drift: m.drift, at: m.at };
      settledNow();
    } else void onMainThread();
  };

  const t0 = performance.now();
  boot.closed = true; // the app is up: too late for bootChrome to start one
  if (!failed) {
    // the head loader's sphere may already be up, started before the app hydrated: carry on with it as it is
    sphere = adoptBooted(box!, look, !!voiceStyle || start !== undefined || startPolish !== undefined);
    adopted = !!sphere;
    if (sphere) {
      sphere.on = onWorker;
      if (sphere.failed) void onMainThread();
      else if (sphere.startAt < Infinity) onShown(sphere.startAt);
    } else if (workersDraw()) {
      sphere = runWorker(newWorker(), newCanvas(), still, { look, flow: config, dprMax: CHROME.dprMax, fadeMs: CHROME.fadeIn * 1000 }, false);
      sphere.on = onWorker;
    } else void onMainThread();
  }
  performance.measure("chrome-gl-init", { start: t0, end: performance.now() });

  return {
    frame(s) {
      reduced = s.reduced;
      const drive = { settling: s.revealing, through: s.through, hold: CHROME.hold };
      if (sphere) {
        const now = `${s.reduced} ${drive.settling} ${drive.through} ${drive.hold}`;
        if (now !== sent) {
          sent = now;
          sphere.worker.postMessage({ type: "drive", reduced: s.reduced, ...drive } satisfies ToChromeWorker);
        }
        return;
      }
      if (!gl || !flow) return;
      const t = performance.now(); // its own clock: the engine's dt is 0 with reduced motion (a lab's hold still applies)
      const dt = last ? (t - last) / 1000 : 0;
      last = t;
      flow.step(dt, { ...drive, voice: voiceNow, moving: t >= startAt && !s.reduced }); // hold on the poster's frame until it has replaced it
      const key = `${flow.frame.polish.toFixed(3)} ${gl.width()}`;
      if (s.reduced && key === drawn) return;
      if (gl.draw(flow.frame)) {
        drawn = key;
        if (!shown) {
          performance.measure("chrome-first-frame", { start: t0, end: performance.now() }); // renderer load + compile + first draw
          onShown(performance.now() + fadeIn(canvas, still, CHROME.fadeIn * 1000));
        }
        if (flow.settled() && !isSettled) {
          rest = { time: flow.frame.time, drift: flow.frame.drift, at: performance.timeOrigin + t };
          settledNow();
        }
      }
    },
    voice(v) {
      voiceNow = v;
      if (!sphere) return;
      const key = v ? `${v.polish.toFixed(3)} ${v.level.toFixed(3)} ${v.swing ?? ""} ${v.pace ?? ""} ${v.rainbow ?? ""} ${v.evenBumps ?? ""} ${v.colourFloor ?? ""}` : "off";
      if (key === sentVoice) return;
      sentVoice = key;
      sphere.worker.postMessage({ type: "voice", voice: v && { polish: v.polish, level: v.level, swing: v.swing, pace: v.pace, rainbow: v.rainbow, evenBumps: v.evenBumps, colourFloor: v.colourFloor } } satisfies ToChromeWorker);
    },
    tune(style) {
      config.voice = { ...style };
      sphere?.worker.postMessage({ type: "tune", style: config.voice } satisfies ToChromeWorker);
    },
    /**
     * The ball on screen (viewport px): its centre and radius (the canvas box also holds room for the bumps), and where
     * its clock, noise and turn are now (from the settled frame on: at rest the noise drifts at the
     * finish's restSpeed).
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
      if (sphere && adopted) releaseBooted(sphere);
      else sphere?.stop();
      gl?.dispose();
      canvas?.remove();
    },
  };
}
