/**
 * Draws the chrome loader off the main thread (OffscreenCanvas), so it keeps moving while the page is busy setting up
 * the head (parsing it and compiling its shaders freezes the main thread for 50–200 ms at a time). The page sends
 * what drives it (reduced motion, the reveal, a lab hold) and its size; the worker runs the clock and polish
 * (./chromeGl.ts createChromeFlow) on its own animation frames, holds on the opening frame until it is on screen, and
 * reports "shown" (or "failed": then the page draws it itself).
 */
import { type ChromeDrive, type ChromeFlowConfig, type ChromeGl, type ChromeLook, createChromeFlow, createChromeGl } from "./chromeGl";

export type ToChromeWorker =
  | { type: "init"; canvas: OffscreenCanvas; look: ChromeLook; flow: ChromeFlowConfig; width: number; height: number }
  | { type: "drive"; reduced: boolean; settling: boolean; through: number | null; hold: number | null }
  | { type: "size"; width: number; height: number }
  | { type: "go"; afterMs: number }; // the page is fading the canvas in over the poster: start moving after that
/** "settled" carries where the sphere's clock and noise were then (`at`: ms, performance.timeOrigin + now, the same
 * on both threads), so the morph reveal's 3D bubble can carry on from exactly that frame. */
export type FromChromeWorker = { type: "shown" } | { type: "settled"; time: number; drift: number; at: number } | { type: "failed" };

const post = (m: FromChromeWorker) => (self as unknown as Worker).postMessage(m);
// Workers have requestAnimationFrame in Chrome, Firefox and recent Safari; a timer stands in elsewhere.
const nextFrame = (fn: (now: number) => void) =>
  typeof requestAnimationFrame === "function" ? requestAnimationFrame(fn) : setTimeout(() => fn(performance.now()), 16);

let gl: ChromeGl | null = null;
let flow: ReturnType<typeof createChromeFlow> | null = null;
let reduced = false;
let drive: Omit<ChromeDrive, "moving"> = { settling: false, through: null, hold: null };
let shown = false;
let last = 0;
let drawn = ""; // reduced motion: the polish and width last drawn (redraw only when either changes)
let settled = false;
let startAt = Infinity; // when it may start moving (the page's "go": after the fade-in over the poster)

const tick = (now: number) => {
  if (!gl || !flow) return;
  nextFrame(tick);
  const dt = last ? (now - last) / 1000 : 0;
  last = now;
  flow.step(dt, { ...drive, moving: now >= startAt && !reduced }); // until then it holds on the opening frame (the poster's)
  const key = `${flow.frame.polish.toFixed(3)} ${gl.width()}`;
  if (reduced && key === drawn) return;
  if (gl.draw(flow.frame)) {
    // Wait for the GPU before the next frame: while the page sets up the head the GPU is busy for 100+ ms at a time,
    // and a clock that kept running would draw frames nobody sees, then jump ahead when they show. Waiting makes the
    // next frame's dt include the stall, and the flow's maxStep turns it into a brief pause instead.
    gl.finish();
    drawn = key;
    if (!shown) {
      shown = true;
      post({ type: "shown" });
    }
    if (!settled && flow.settled()) {
      settled = true;
      // drawn on its finish: the page's reveal can fade it out
      post({ type: "settled", time: flow.frame.time, drift: flow.frame.drift, at: performance.timeOrigin + now });
    }
  }
};

self.onmessage = (e: MessageEvent<ToChromeWorker>) => {
  const m = e.data;
  if (m.type === "init") {
    m.canvas.addEventListener("webglcontextlost", () => post({ type: "failed" }));
    gl = createChromeGl(m.canvas, { ...m.look, sync: true, size: [m.width, m.height] });
    if (!gl) return post({ type: "failed" });
    flow = createChromeFlow(m.flow);
    nextFrame(tick);
  } else if (m.type === "drive") {
    reduced = m.reduced;
    drive = { settling: m.settling, through: m.through, hold: m.hold };
  } else if (m.type === "size") gl?.resize(m.width, m.height);
  else if (m.type === "go") startAt = performance.now() + m.afterMs;
};
