/**
 * Where a context's sound goes: its own destination, or (desktop Safari) a live MediaStream played by an <audio>
 * element.
 *
 * Safari on a Mac, 2026-10-15: a tab's Web Audio output (one per sample rate, shared by every AudioContext in the tab)
 * could fall behind and stay behind: lines and chats ~0.8 s after the mouth, or silent, while Safari reported them on
 * time (outputLatency, getOutputTimestamp), so the page could not tell. A new context or a reload at that rate kept it,
 * and the backlog itself survived: the end of a line cut by a pause played at the next start, even from another
 * context (a chat). Found after a context left running with nothing to play in a tab nobody looked at, and after chats
 * with clicks into other apps. A MediaStream is live, so nothing waits in a queue behind anything: played by an element,
 * the same beeps stayed on time with the context's own output stuck (qa/lipsync stale.mjs), ROUTE_EXTRA later.
 *
 * `?audioRoute=direct` keeps the context's own destination (this page view); `?audioRoute=element` takes the element
 * route in any browser (for testing).
 */
import { isAppleTouch } from "./staleTab";

/** s the element route adds to the context's reported output delay (Safari on a Mac, built-in speakers: the app's
 *  beeps −29…−48 ms against −16…+1 direct with 45 ms allowed, qa/lipsync appstale.mjs 2026-10-15). */
export const ROUTE_EXTRA = 0.075;

/** Safari (WebKit) on a Mac: not Chrome, Edge, Firefox or Opera there, and not an iPhone or iPad. */
export function isDesktopSafari(): boolean {
  if (typeof navigator === "undefined") return false;
  const ua = navigator.userAgent;
  return /Safari\//.test(ua) && !/Chrome|Chromium|CriOS|FxiOS|Edg|OPR|Android/.test(ua) && !isAppleTouch();
}

let choice: boolean | null = null;
/** Whether sound takes the element route on this page. */
export function elementRoute(): boolean {
  if (choice === null) {
    const q = typeof window === "undefined" ? null : new URLSearchParams(window.location.search).get("audioRoute");
    choice = q === "element" ? true : q === "direct" ? false : isDesktopSafari();
  }
  return choice;
}

const routes = new WeakMap<BaseAudioContext, { node: MediaStreamAudioDestinationNode; el: HTMLAudioElement }>();

/** The node a context's sound connects to. */
export function outputOf(ctx: AudioContext): AudioNode {
  if (!elementRoute() || typeof ctx.createMediaStreamDestination !== "function" || typeof document === "undefined") return ctx.destination;
  let r = routes.get(ctx);
  if (!r) {
    const node = ctx.createMediaStreamDestination();
    const el = document.createElement("audio");
    el.style.display = "none";
    el.srcObject = node.stream;
    document.body.append(el);
    void el.play().catch(() => {});
    r = { node, el };
    routes.set(ctx, r);
  }
  return r.node;
}

/** Call in a tap, with the context's resume: the element plays again if it was paused (Safari pauses media on its own). */
export function wakeOutput(ctx: AudioContext): void {
  const r = routes.get(ctx);
  if (r?.el.paused) void r.el.play().catch(() => {});
}

/**
 * Suspend the context, its element paused first. A suspended context's stream gets no new sound, and Safari's element
 * then played the last few milliseconds it had over and over: after End chat (mid-word) a fast stutter until the next
 * chat (user, 2026-10-15). wakeOutput plays it again.
 */
export function restOutput(ctx: AudioContext): Promise<void> {
  routes.get(ctx)?.el.pause();
  return ctx.suspend();
}

/** s the route adds to the context's reported output delay (the heard clock adds it). */
export function routeDelay(ctx: AudioContext): number {
  return routes.has(ctx) ? ROUTE_EXTRA : 0;
}
