/**
 * The head loader's engine, shared by every look (./looks.tsx). One GSAP ticker callback per loader eases the
 * real load progress into `state.p`, lets the look draw a frame from `state`, writes the % text only when the number
 * changes, and updates aria-valuenow in 10 % steps. The hand-off to the head is one of the RevealStyles below, the
 * same for every look.
 *
 * Never touches React state. The only DOM writes are transforms and opacity (GSAP quickSetters), the waveform's
 * small 2D canvas, the % text and aria-valuenow.
 */
import gsap from "gsap";

import type { CSSProperties, ReactElement } from "react";

import { type ScreenCircle, beginMorph, canMorph, headMorph, prepareMorph } from "@/lib/headMorph";

/** Everything a look needs to draw one frame. The reveal tweens `flat`; the ticker owns the rest. */
export interface LoaderState {
  t: number; // seconds since the loader started (stays 0 with reduced motion)
  dt: number; // seconds since the last frame (0 with reduced motion)
  p: number; // shown progress 0..1, eased
  flat: number; // reveal: 0 → 1 while the waveform calms to a line
  revealing: boolean; // the hand-off to the head has started (the sphere settles on its finish)
  through: number | null; // the morph reveal: the sphere doesn't stop on its finish but turns round (ChromeDrive.through)
  reduced: boolean; // prefers-reduced-motion: no idle motion, the reveal is a plain fade
}

export interface Rig {
  frame(s: LoaderState): void;
  /** Resolves once the look has reached its end state after `revealing` turned on; the reveal waits for it (capped). */
  settle?(): Promise<void>;
  /** Where the look's focus is on screen (viewport px: centre and radius), for the "window" reveal. */
  focus?(): ScreenCircle | null;
  dispose?(): void;
}

/** One look: static markup (server-rendered, so it paints before any JS) plus the rig that animates it. */
export interface LoaderVariant {
  id: string;
  label: string;
  blurb: string;
  /** CSS variables on the loader root: --orb (orb size), --cy (focal point), --cap (caption offset below it). */
  vars?: CSSProperties;
  /** false: the caption is the title alone (the look shows progress itself). */
  percent?: boolean;
  Markup: () => ReactElement;
  create: (root: HTMLElement) => Rig;
}

export const TIMING = {
  minShownMs: 600, // never flash: an uncached load keeps the loader up at least this long
  settleCapMs: 1800, // longest the reveal waits for the look to settle (Rig.settle; the sphere needs up to ~1.4 s)
  quickMs: 350, // head ready this soon after the loader appeared = treat it as cached
  quickFade: 0.25, // s, the cached cross-fade
  reducedFade: 0.4, // s, the reduced-motion cross-fade
  follow: 0.9, // s, how softly the shown progress follows the real one
  partsCapMs: 6000, // longest the reveal waits for the hair and add-ons after the head's first frame
};

/** The "crossfade" hand-off. Tweak here. Sine easings: no sudden start or stop anywhere. */
const REVEAL = {
  calm: 0.6, // s, the waveform settles to a line
  out: 0.8, // s, the loader fades out…
  outScale: 0.97, // …shrinking this little
  inAt: 0.25, // s, when the head starts fading in (overlaps the fade-out: one motion, no gap)
  in: 1.1, // s, the head's fade-in…
  inScale: 0.985, // …growing from this scale
};

/**
 * How the loader hands over to the head. The app ships "swing" ("window" when there is no head to morph); the others are
 * kept for the style labs, which live outside the repository:
 * - crossfade: the loader fades out shrinking a little while the head fades in (REVEAL), overlapping.
 * - pop: the caption goes first, the sphere swells and fades quickly like a bubble popping, then the head fades in.
 * - window: the head appears through a soft-edged circle that starts as the sphere and opens to fill the card, while
 *   the sphere dissolves into it.
 * - rise: the caption goes first, the loader drifts up as it fades, then the head rises gently into place (no overlap).
 * - morph: the bubble becomes the face: the head shows as a sphere exactly where the bubble is, the loader fades over
 *   it, and every vertex flows from the sphere to its place, the face first (lib/headMorph.ts, lib/morphShader.ts).
 *   Without a morphing head on the page (or a focus), it plays "window".
 * - swing: the morph as the loader's own last swing (bubble → blob, landing on the face), one curve for size, bumps
 *   and look, starting the moment the sphere settles (lib/morphShader.ts SWING). Falls back the same way.
 * The quick fade of a cached head plays the same motion at half the length; reduced motion is always a plain fade.
 */
export type RevealStyle = "crossfade" | "pop" | "window" | "rise" | "morph" | "swing";
const STYLE: { current: RevealStyle } = { current: "swing" };
export const revealStyle = () => STYLE.current;
export function setRevealStyle(r: RevealStyle): void {
  STYLE.current = r;
}

/** The other styles' timings; tweak here. Times in s, from the moment the sphere has settled on the bubble. */
export const REVEALS = {
  pop: { caption: 0.2, at: 0.05, out: 0.35, swell: 1.22, headAt: 0.3, head: 0.7, headFrom: 0.985 },
  // window: caption, then the bubble dissolving while the circle opens. The circle grows slowly first (ease-in): the face
  // is near the middle and fully shown at ~45 % of the final radius, so the face takes ~0.67 × `open`: 1.4 s shows it in
  // ~0.95 s (0.9 s in-out, face in ~0.75 s, reads too fast; 1.8 s ease-in, ~1.2 s, too slow).
  // A cached head plays it at `quick` × length.
  window: { caption: 0.4, at: 0.1, open: 1.4, openEase: "power2.in", feather: 64, out: 0.7, swell: 1.06, zoomFrom: 1.03, quick: 0.75 },
  rise: { caption: 0.25, at: 0.05, out: 0.45, lift: 12, headAt: 0.4, head: 0.8, headDrop: 10 },
  // morph: the loader fades over the 3D bubble (handover), then the bubble flows into the head. The tween is linear:
  // each vertex eases its own part (lib/morphShader.ts), and an eased tween on top would bunch the change into ~0.4 s.
  morph: { caption: 0.3, handover: 0.3, at: 0.15, morph: 1.8, ease: "none", quick: 0.75 },
  // swing: no wait and no stop: the sphere reaches the bubble still moving and turns straight round into the morph (a
  // stop there reads as a pause before the morph); the 3D head picks the run back up from where the loader is
  // (ScreenCircle.since). `morph` 1.3 s plays in ~1 s on the page, which skips the part the loader already ran; longer
  // runs (1.7–2.2 s) make the face's arrival feel slow. `polish`: the rainbow drains over this fraction of the morph.
  swing: { caption: 0.3, handover: 0.3, at: 0, morph: 1.3, polish: 0.55, ease: "none", quick: 0.75 },
};

export interface Loader {
  /** "full" = the REVEAL cross-fade, "fade" = a quicker plain one (cached head, reduced motion). */
  reveal(kind: "full" | "fade"): void;
  dispose(): void;
}

export function startLoader(o: {
  root: HTMLElement;
  create: (root: HTMLElement) => Rig;
  progress: () => number;
  stage: HTMLElement | null;
  reduced: boolean;
  onRevealed?: () => void;
}): Loader {
  const s: LoaderState = { t: 0, dt: 0, p: 0, flat: 0, revealing: false, through: null, reduced: o.reduced };
  const rig = o.create(o.root);
  const pct = o.root.querySelector<HTMLElement>("[data-loader-pct]");
  const follow = gsap.quickTo(s, "p", { duration: TIMING.follow, ease: "power2.out" });
  let target = -1;
  let shownPct = -1;
  let shownAria = -1;
  let tl: gsap.core.Timeline | null = null;
  let waiting = false; // the full reveal is waiting for the look to settle
  let settled = false; // … and it has (or the wait timed out)
  let disposed = false;
  const t0 = gsap.ticker.time;
  let last = t0;

  const tick = (time: number) => {
    s.dt = s.reduced ? 0 : Math.min(time - last, 0.1); // a stalled frame must not make the wave jump
    s.t = s.reduced ? 0 : time - t0;
    last = time;
    if (!tl) {
      const next = o.progress();
      if (next !== target) follow((target = next));
    }
    rig.frame(s);
    const n = Math.round(s.p * 100);
    if (n !== shownPct && pct) pct.textContent = `${(shownPct = n)}%`;
    const aria = Math.floor(n / 10) * 10;
    if (aria !== shownAria) o.root.setAttribute("aria-valuenow", String((shownAria = aria)));
  };
  gsap.ticker.add(tick);

  const stop = () => {
    gsap.ticker.remove(tick);
    gsap.killTweensOf(s);
  };

  const loader: Loader = {
    reveal(kind) {
      if (tl || waiting) return;
      s.revealing = true;
      // Every reveal (the full one and the quick fade of a cached head) first lets the look reach its end (the sphere
      // settles on its finish), then fades: it always ends on the bubble, never fades out mid-swing.
      if (!s.reduced && rig.settle && !settled) {
        waiting = true;
        if (STYLE.current === "morph" || STYLE.current === "swing") prepareMorph(); // compile the morph's shaders while the sphere settles
        // the morph reveal: no stop on the bubble, the sphere turns straight round into the run back the head picks up
        if (STYLE.current === "swing" && o.stage && canMorph()) {
          const c = REVEALS.swing;
          s.through = c.morph * c.polish * (kind === "fade" ? c.quick : 1);
        }
        const go = () => {
          if (settled || disposed) return;
          settled = true;
          waiting = false;
          loader.reveal(kind);
        };
        void rig.settle().then(go);
        setTimeout(go, TIMING.settleCapMs);
        return;
      }
      gsap.killTweensOf(s, "p"); // the follow tween
      tl = gsap.timeline({
        onComplete: () => {
          stop();
          gsap.set(o.root, { autoAlpha: 0 });
          o.onRevealed?.();
        },
      });
      const style = STYLE.current;
      if (s.reduced || (kind === "fade" && style === "crossfade")) {
        const d = s.reduced ? TIMING.reducedFade : TIMING.quickFade;
        tl.to(o.root, { opacity: 0, duration: d, ease: "power1.out" }, 0);
        if (o.stage) tl.fromTo(o.stage, { opacity: 0 }, { opacity: 1, duration: d, ease: "power1.out" }, 0);
        return;
      }
      tl.to(s, { p: 1, duration: 0.3, ease: "sine.out" }, 0).to(s, { flat: 1, duration: REVEAL.calm, ease: "sine.inOut" }, 0);
      if (style !== "crossfade") {
        const quick = style === "window" || style === "morph" || style === "swing" ? REVEALS[style].quick : 0.5;
        buildReveal(tl, style, kind === "fade" ? quick : 1, o.root, o.stage, rig);
        return;
      }
      tl.to(o.root, { opacity: 0, scale: REVEAL.outScale, duration: REVEAL.out, ease: "sine.inOut" }, 0.1);
      if (o.stage)
        tl.fromTo(
          o.stage,
          // will-change for the fade only (the canvas is its own layer; this keeps its wrapper composited too).
          { opacity: 0, scale: REVEAL.inScale, willChange: "opacity, transform" },
          // immediateRender off: the "from" state applies at inAt, not when the timeline is built.
          { opacity: 1, scale: 1, duration: REVEAL.in, ease: "sine.out", clearProps: "transform,willChange", immediateRender: false },
          REVEAL.inAt,
        );
    },
    dispose() {
      disposed = true;
      headMorph.t = 1; // a reveal cut short never leaves the head on the sphere
      stop();
      tl?.kill();
      rig.dispose?.();
    },
  };
  return loader;
}

/** The pop, window and rise reveals (see RevealStyle) on `tl`, every time scaled by `k` (0.5 for a cached head). */
function buildReveal(tl: gsap.core.Timeline, style: Exclude<RevealStyle, "crossfade">, k: number, root: HTMLElement, stage: HTMLElement | null, rig: Rig) {
  const caption = root.querySelector("[data-loader-caption]");
  const sphere = root.querySelector("[data-chrome]");
  const t = (x: number) => x * k;
  if (style === "morph" || style === "swing") {
    const focus = rig.focus?.();
    if (!stage || !focus || !canMorph()) return buildReveal(tl, "window", k, root, stage, rig);
    const c = REVEALS[style];
    // "swing": the loader turned round on the bubble `since` s ago and is already on its way back; the head starts
    // there too (its share of the morph so far), so the two move as one under the fade
    const t0 = style === "swing" ? Math.min(0.3, (focus.since ?? 0) / t(c.morph)) : 0;
    tl.call(
      () => {
        beginMorph(rig.focus?.() ?? focus, style === "swing" ? "swing" : "pieces"); // (its clock as of now)
        headMorph.t = t0;
        gsap.set(stage, { opacity: 1 }); // the head, as the sphere, under the loader's bubble
      },
      [],
      0,
    )
      .to(caption, { opacity: 0, duration: t(c.caption), ease: "sine.inOut" }, 0)
      .to(root, { opacity: 0, duration: t(c.handover), ease: "sine.inOut" }, 0)
      .to(headMorph, { t: 1, duration: t(c.morph) * (1 - t0), ease: c.ease }, t(c.at));
    return;
  }
  if (style === "pop") {
    const c = REVEALS.pop;
    tl.to(caption, { opacity: 0, duration: t(c.caption), ease: "sine.in" }, 0)
      .to(sphere, { scale: c.swell, duration: t(c.out), ease: "power2.out" }, t(c.at))
      .to(root, { opacity: 0, duration: t(c.out), ease: "power2.in" }, t(c.at));
    if (stage)
      tl.fromTo(stage, { opacity: 0, scale: c.headFrom, willChange: "opacity, transform" }, { opacity: 1, scale: 1, duration: t(c.head), ease: "sine.out", clearProps: "transform,willChange", immediateRender: false }, t(c.headAt));
  } else if (style === "rise") {
    const c = REVEALS.rise;
    tl.to(caption, { opacity: 0, y: -4, duration: t(c.caption), ease: "sine.in" }, 0).to(root, { opacity: 0, y: -c.lift, duration: t(c.out), ease: "sine.inOut" }, t(c.at));
    if (stage)
      tl.fromTo(stage, { opacity: 0, y: c.headDrop, willChange: "opacity, transform" }, { opacity: 1, y: 0, duration: t(c.head), ease: "sine.out", clearProps: "transform,willChange", immediateRender: false }, t(c.headAt));
  } else {
    const c = REVEALS.window;
    tl.to(caption, { opacity: 0, duration: t(c.caption), ease: "sine.inOut" }, 0)
      .to(sphere, { scale: c.swell, duration: t(c.out), ease: "sine.inOut" }, t(c.at))
      .to(root, { opacity: 0, duration: t(c.out), ease: "sine.inOut" }, t(c.at));
    if (stage) {
      // The head shows through a soft circle on the sphere (a radial mask, viewport px → the stage's own box), which
      // opens until it covers the farthest corner. One layout read here, at the start.
      const box = stage.getBoundingClientRect();
      const f = rig.focus?.() ?? { x: box.left + box.width / 2, y: box.top + box.height / 2, r: 60 };
      const cx = f.x - box.left, cy = f.y - box.top;
      const far = Math.hypot(Math.max(cx, box.width - cx), Math.max(cy, box.height - cy)) + c.feather;
      const m = { r: f.r };
      const mask = (v: string) => {
        stage.style.maskImage = v;
        stage.style.setProperty("-webkit-mask-image", v);
      };
      const draw = () => mask(`radial-gradient(circle at ${cx}px ${cy}px, #000 ${Math.max(0, m.r - c.feather)}px, transparent ${m.r}px)`);
      tl.call(() => {
        draw();
        gsap.set(stage, { opacity: 1, scale: c.zoomFrom, transformOrigin: `${cx}px ${cy}px`, willChange: "transform" });
      }, [], 0)
        .to(m, { r: far, duration: t(c.open), ease: c.openEase, onUpdate: draw, onComplete: () => mask("") }, t(c.at))
        .to(stage, { scale: 1, duration: t(c.open + 0.3), ease: "sine.inOut", clearProps: "transform,transformOrigin,willChange" }, t(c.at));
    }
  }
}
