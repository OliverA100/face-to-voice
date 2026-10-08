/**
 * Loading head.glb with real progress, for the head loader (components/ui/loader).
 *
 * The download starts when FaceCanvas's module loads (hydration), in parallel with the three.js Scene chunk rather than
 * after it. Head.tsx parses the same bytes, so nothing is fetched twice.
 * Progress is plain module state (no React): the loader reads `loadProgress()` on its GSAP ticker.
 *
 * No three.js in here: this module ships in the first-load bundle.
 */
import { MODEL_URL } from "@/lib/data";
import { perf } from "@/lib/perf";

/** head.glb's size in bytes (next.config.ts reads it at build). Content-Length can't be used: with brotli it's the compressed size. */
const HEAD_BYTES = Number(process.env.FTV_HEAD_BYTES) || 0;

/** How much each stage adds to the loader's progress (sum 1). Parts = hair and add-ons on the head. */
const WEIGHTS = { bytes: 0.7, chunk: 0.1, firstFrame: 0.05, parts: 0.15 };

export const headLoad = {
  loaded: 0, // bytes of head.glb read so far
  total: HEAD_BYTES,
  chunk: false, // the three.js Scene chunk has arrived
  fromCache: false, // head.glb came from the HTTP cache (or was already in memory): the loader just fades
  revealed: false, // the loader has handed over to the head
  /** Style lab only: pace the download to this many kbit/s (0 = off) and bypass the HTTP cache. */
  throttleKbps: 0,
};

/** 0..1, monotonic within one load. */
export function loadProgress(): number {
  const bytes = headLoad.total ? Math.min(1, headLoad.loaded / headLoad.total) : headLoad.loaded ? 0.5 : 0;
  const parts = perf.headVisibleMs === null ? 0 : partsExpected ? partsDone / partsExpected : 1; // they attach after the head's first frame
  return WEIGHTS.bytes * bytes + (headLoad.chunk ? WEIGHTS.chunk : 0) + (perf.headVisibleMs !== null ? WEIGHTS.firstFrame : 0) + WEIGHTS.parts * parts;
}

// --- the look's other pieces (hair, brows, lashes, beard, glasses) ------------------------------------------------
// The head is revealed with them on, not bald with hair popping in seconds later. Their files download right
// after head.glb (queued behind it, so the head never shares bandwidth with them); lib/hair.ts and lib/addons.ts take
// the bytes and report each piece done once it is attached (or has failed: the head never waits on an error).

const parts = new Map<string, boolean>(); // id → attached
let partsExpected = 0;
let partsDone = 0;
const partListeners = new Set<() => void>();
const early = new Map<string, Promise<ArrayBuffer>>(); // url → bytes, taken once

/** Download a piece of the look now, and hold the reveal until partDone(id). */
export function prefetchPart(id: string, url: string): void {
  if (!parts.has(id)) {
    parts.set(id, false);
    partsExpected++;
  }
  if (early.has(url)) return;
  const bytes = headBytes()
    .catch(() => {}) // the head failed: fetch the piece anyway (a remount retries the head)
    .then(() => fetch(url, { priority: "low" }))
    .then((r) => {
      if (!r.ok) throw new Error(`${url}: ${r.status} ${r.statusText}`);
      return r.arrayBuffer();
    });
  bytes.catch(() => {}); // the loader that takes it reports the failure
  early.set(url, bytes);
}

/**
 * Download a piece now without touching the reveal (Random character: the next look's files arrive while the old one is
 * still live, lib/character.ts; "low" priority when it downloads the one after ahead of time). Resolves when the bytes are
 * in (never rejects); hair.ts / addons.ts take them as usual.
 */
export function preload(url: string, priority: RequestPriority = "auto"): Promise<void> {
  let bytes = early.get(url);
  if (!bytes) {
    bytes = fetch(url, { priority }).then((r) => {
      if (!r.ok) throw new Error(`${url}: ${r.status} ${r.statusText}`);
      return r.arrayBuffer();
    });
    bytes.catch(() => {}); // the loader that takes it reports the failure
    early.set(url, bytes);
  }
  return bytes.then(
    () => {},
    () => {},
  );
}

/** The early download of `url`, if there is one (each is handed out once). */
export function takePrefetched(url: string): Promise<ArrayBuffer> | undefined {
  const bytes = early.get(url);
  early.delete(url);
  return bytes;
}

/** A piece is on the head (or failed). Unknown ids are ignored. */
export function partDone(id: string): void {
  if (parts.get(id) !== false) return;
  parts.set(id, true);
  partsDone++;
  for (const fn of [...partListeners]) fn();
}

/** Resolves when every expected piece is attached, or after `capMs` at the latest (a slow piece may then pop in). */
export function whenPartsReady(capMs: number): Promise<void> {
  if (partsDone >= partsExpected) return Promise.resolve();
  return new Promise((resolve) => {
    const check = () => {
      if (partsDone < partsExpected) return;
      done();
    };
    const done = () => {
      clearTimeout(timer);
      partListeners.delete(check);
      resolve();
    };
    const timer = setTimeout(done, capMs);
    partListeners.add(check);
  });
}

let bytes: Promise<ArrayBuffer> | null = null;
let generation = 0; // a download superseded by resetHeadLoad stops writing progress

/** head.glb couldn't be downloaded (offline, a server error): not a WebGL problem, so the scene offers a retry
 *  (components/scene/SceneErrorBoundary.tsx). */
export class HeadDownloadError extends Error {
  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause));
    this.name = "HeadDownloadError";
  }
}

/** head.glb's bytes; the first call starts the download. A failed download is not remembered (a remount retries). */
export function headBytes(): Promise<ArrayBuffer> {
  bytes ??= download().catch((e) => {
    bytes = null;
    throw new HeadDownloadError(e);
  });
  return bytes;
}

async function download(): Promise<ArrayBuffer> {
  const gen = ++generation;
  const kbps = headLoad.throttleKbps;
  const res = await fetch(MODEL_URL, kbps ? { cache: "reload" } : undefined);
  if (!res.ok) throw new Error(`${MODEL_URL}: ${res.status} ${res.statusText}`); // never hand an error page to the parser
  if (!headLoad.total && !res.headers.get("content-encoding")) headLoad.total = Number(res.headers.get("content-length")) || 0;
  if (!res.body) {
    const buf = await res.arrayBuffer();
    headLoad.loaded = buf.byteLength;
    return buf;
  }
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  const t0 = performance.now();
  let loaded = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    loaded += value.byteLength;
    if (gen === generation) headLoad.loaded = loaded;
    if (kbps) {
      const due = t0 + (loaded * 8) / kbps; // ms at which this many bytes would have arrived
      const wait = due - performance.now();
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    }
  }
  const out = new Uint8Array(loaded);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.byteLength;
  }
  // Served from the HTTP cache (0 bytes) or revalidated (304: headers only)?
  const entry = performance.getEntriesByName(new URL(MODEL_URL, location.href).href).at(-1) as PerformanceResourceTiming | undefined;
  if (gen === generation) headLoad.fromCache = !kbps && !!entry && entry.transferSize < 0.01 * loaded;
  return out.buffer;
}

const revealListeners = new Set<() => void>();
const revealSubscribers = new Set<() => void>(); // React: useSyncExternalStore(subscribeRevealed, revealedSnapshot)

/** React: called whenever the head becomes revealed (or a style-lab replay starts over). */
export function subscribeRevealed(fn: () => void): () => void {
  revealSubscribers.add(fn);
  return () => void revealSubscribers.delete(fn);
}
export const revealedSnapshot = (): boolean => headLoad.revealed;

/** The loader calls this when the head is fully shown (or right away when there is no loader). */
export function markRevealed(): void {
  if (headLoad.revealed) return;
  headLoad.revealed = true;
  perf.revealDoneMs = Math.round(performance.now());
  performance.mark("head-revealed");
  for (const fn of revealListeners) fn();
  revealListeners.clear();
  for (const fn of revealSubscribers) fn();
}

/** Resolves once the reveal is over, or after `capMs` at the latest (work that would make the reveal stutter waits for it). */
export function whenRevealed(capMs: number): Promise<void> {
  if (headLoad.revealed) return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      revealListeners.delete(done);
      resolve();
    };
    const timer = setTimeout(done, capMs);
    revealListeners.add(done);
  });
}

/** Style lab: start over. `cold` drops the downloaded bytes (the next mount fetches again, paced by `throttleKbps`). */
export function resetHeadLoad({ cold, throttleKbps = 0 }: { cold: boolean; throttleKbps?: number }): void {
  headLoad.revealed = false;
  for (const fn of revealSubscribers) fn();
  parts.clear(); // the remount's pieces register again (prefetchHair, prefetchAddons)
  partsExpected = partsDone = 0;
  early.clear();
  headLoad.throttleKbps = throttleKbps;
  if (cold) {
    bytes = null;
    generation++;
    headLoad.loaded = 0;
    headLoad.fromCache = false;
  } else {
    headLoad.fromCache = true; // the bytes (and the parsed head) are already in memory
  }
}
