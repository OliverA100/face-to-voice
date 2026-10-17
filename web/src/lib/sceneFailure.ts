/**
 * Whether the 3D head has failed for good: WebGL missing, head.glb not downloaded (SceneErrorBoundary) or a lost WebGL
 * context that never came back (Scene.tsx). Anything that waits on the head (the voice's picture of it) races that wait
 * against this, so a failed scene ends in a message instead of a wait that never ends.
 */
export type SceneFailure = "webgl" | "download";

let failure: SceneFailure | null = null;
const listeners = new Set<(f: SceneFailure | null) => void>();

export const sceneFailure = (): SceneFailure | null => failure;

export function setSceneFailure(f: SceneFailure | null): void {
  if (f === failure) return;
  failure = f;
  for (const fn of listeners) fn(f);
}

export function onSceneFailure(fn: (f: SceneFailure | null) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export class SceneFailedError extends Error {
  constructor() {
    super("The 3D head isn't showing, so there's no face to read. Reload the page to try again.");
  }
}

/** `wait`, unless the scene fails first (or already has): then a SceneFailedError. */
export function unlessSceneFails<T>(wait: Promise<T>): Promise<T> {
  if (failure) return Promise.reject(new SceneFailedError());
  let off = () => {};
  const failed = new Promise<never>((_, reject) => {
    off = onSceneFailure((f) => f && reject(new SceneFailedError()));
  });
  return Promise.race([wait, failed]).finally(off);
}
