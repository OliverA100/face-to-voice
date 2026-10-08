/**
 * Small helpers for the loader: a DPR-aware 2D canvas that tracks its CSS size without forcing layout
 * (ResizeObserver, never getBoundingClientRect per frame), the "listening" level, and layout/colour helpers.
 */
import type { CSSProperties } from "react";

export interface Canvas2D {
  ctx: CanvasRenderingContext2D;
  /** CSS pixel size; 0 until the first ResizeObserver callback. */
  w: number;
  h: number;
  dispose(): void;
}

export function canvas2d(el: HTMLCanvasElement | null): Canvas2D | null {
  const ctx = el?.getContext("2d");
  if (!el || !ctx) return null;
  const dpr = Math.min(2, window.devicePixelRatio || 1); // 2x is sharp enough for a 1px line; 3x phones would triple the fill cost
  const c: Canvas2D = { ctx, w: 0, h: 0, dispose: () => ro.disconnect() };
  const ro = new ResizeObserver(([entry]) => {
    c.w = entry.contentRect.width;
    c.h = entry.contentRect.height;
    el.width = Math.round(c.w * dpr);
    el.height = Math.round(c.h * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  });
  ro.observe(el);
  return c;
}

/**
 * The quiet "listening" level, 0.55..1: two slow, unrelated sines multiplied, so the swell never repeats
 * exactly (the idea behind a voice UI's idle state: something is there, nothing is said yet).
 */
export const listen = (t: number) => 0.55 + 0.45 * (0.5 + 0.5 * Math.sin(t * 1.3)) * (0.5 + 0.5 * Math.sin(t * 0.47 + 1));

/** Absolutely positioned box centred on the loader's focal point (--cy), sized from --orb. No transform, so GSAP owns transforms. */
export function centred(w: string, h: string = w): CSSProperties {
  return { position: "absolute", left: "50%", top: "var(--cy)", width: w, height: h, marginLeft: `calc(${w} / -2)`, marginTop: `calc(${h} / -2)` };
}

/** Stroke colours as "r,g,b" (for rgba()): the app's ink (--ink in app/tokens.css). */
export const TINT = {
  ink: "0,0,0",
};
export const rgba = (rgb: string, a: number) => `rgba(${rgb},${a})`;
