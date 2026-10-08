/**
 * Tiny performance store shared between the scene (writes) and the ?perf=1 overlay (reads).
 * Plain object on purpose: updating it never re-renders React.
 */
export const perf = {
  fps: 0,
  dpr: 1,
  drawCalls: 0,
  triangles: 0,
  geometries: 0,
  textures: 0,
  headVisibleMs: null as number | null,
  /** The head loader: first paint (FCP, it is in the server HTML), animation running, reveal finished. */
  loaderPaintMs: null as number | null,
  loaderLiveMs: null as number | null,
  revealDoneMs: null as number | null,
  maxVertexUniforms: 0,
  maxArrayTextureLayers: 0,
  renderer: "",
  speakFirstAudibleMs: null as number | null,
};

const headVisibleListeners = new Set<() => void>();

/** Runs once, on the first frame that draws the head (read it in the ?perf=1 overlay or as the "head-visible" mark). */
export function markHeadVisible(): void {
  if (perf.headVisibleMs !== null) return;
  performance.mark("head-visible");
  perf.headVisibleMs = Math.round(performance.now());
  for (const fn of headVisibleListeners) fn();
  headVisibleListeners.clear();
}

export function onHeadVisible(fn: () => void): () => void {
  if (perf.headVisibleMs !== null) fn();
  else headVisibleListeners.add(fn);
  return () => headVisibleListeners.delete(fn);
}

/** Style-lab replays: forget the first frame so the next mount marks it again. */
export function resetHeadVisible(): void {
  perf.headVisibleMs = perf.revealDoneMs = null;
}

export function perfEnabled(): boolean {
  if (typeof window === "undefined") return false;
  return new URLSearchParams(window.location.search).get("perf") === "1";
}
