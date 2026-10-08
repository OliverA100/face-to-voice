/**
 * The limiter as the page uses it, loaded on demand: lib/morphs/limits.ts with data/limits.json (80 KB gzip) stays out
 * of the page's first JavaScript, since nothing needs it before the head's first frame. Head.tsx calls loadLimiter() as
 * the head mounts; until the module arrives (and until a head is attached) every call answers as the limiter does with
 * no head: no limits, nothing broken, the same answers it gives while head.glb downloads.
 */
import type { Weights } from "@/lib/data";

import type { LimitGeometry } from "./limitGeometry";
import type { Limiter, LimitStore } from "./limits";

export { BLINK_STAGES, plainStore, REST_LAYERS, type LimitStore } from "./limitBasics";

let real: Limiter | null = null;
let loaded: typeof import("./limits") | null = null;
let pending: Promise<typeof import("./limits")> | null = null;

/** Load the limiter (once). Resolves with the module (the debug handle reads LIMITS from it). */
export function loadLimiter(): Promise<typeof import("./limits")> {
  pending ??= import("./limits").then((m) => {
    real = m.limiter;
    loaded = m;
    return m;
  });
  return pending;
}

/** The loaded module (Limiter, LIMITS …), or null: the debug handle and the stress test reach into it. */
export const loadedLimits = (): typeof import("./limits") | null => loaded;

/** Same calls as Limiter; before it has loaded, the answers of a limiter with no head attached. */
export const limiter = {
  get ready(): boolean {
    return !!real?.ready;
  },
  attach(geom: LimitGeometry | null): void {
    real?.attach(geom);
  },
  span(store: LimitStore, slider: string, ends: [number, number]): [number, number] {
    return real ? real.span(store, slider, ends) : ends;
  },
  broken(store: LimitStore): boolean {
    return real ? real.broken(store) : false;
  },
  reach(face: LimitStore, slider: string, end: number): number {
    return real ? real.reach(face, slider, end) : end;
  },
  caps(store: LimitStore, channels: Record<string, Weights>): Record<string, number> {
    return real ? real.caps(store, channels) : {};
  },
  invalidate(): void {
    real?.invalidate();
  },
  changed(target: string): void {
    real?.changed(target);
  },
  primeSpan(slider: string, span: [number, number]): void {
    real?.primeSpan(slider, span);
  },
};
