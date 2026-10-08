/**
 * The page's side of the caps worker (lib/morphs/capsWorker.ts): Head.tsx hands it the limiter's geometry, animCaps.ts
 * asks it for caps, the slider rows for spans and random.ts for its limiter questions. Without workers (or after an
 * error) every call says so and the caller computes the answer on the main thread (animCaps.ts in idle slices).
 */
import type { SliderDef } from "@/lib/data";

import type { LimitStore } from "./limitBasics";
import { limiter, plainStore } from "./limiter";
import type { LimitAsk } from "./random";
import type { LimitGeometry } from "./limitGeometry";
import type { FromCapsWorker, ToCapsWorker } from "./capsWorker";

let worker: Worker | null = null;
let geom: LimitGeometry | null = null;
let failed = false;
const sent = new Set<string>(); // targets whose deltas the worker has
const skipped = new Set<string>(); // targets a question weighed before the meshes had them (head.extra.glb not merged yet)
let order = ""; // the target order the worker has (JSON)
let pivotTargets: string[] = []; // the eye pivots weigh these too (even before their mesh targets are merged)
let onResult: ((gen: number, caps: Record<string, number>) => void) | null = null;
let onFail: (() => void) | null = null;

const send = (m: ToCapsWorker, transfer: Transferable[] = []) => worker!.postMessage(m, transfer);

function fail(message: string): void {
  if (failed) return;
  console.warn("[caps] worker:", message, "(computing on the main thread)");
  failed = true;
  worker?.terminate();
  worker = null;
  onFail?.();
  for (const answer of questions.values()) answer(null); // asked again, here
  questions.clear();
}

/** Head.tsx: the head's meshes are registered (null on unmount). Cheap: the worker sets the limiter up itself. */
export function attachCapsWorker(g: LimitGeometry | null): void {
  geom = g;
  worker?.terminate();
  worker = null;
  sent.clear();
  skipped.clear();
  order = "";
  answers.clear();
  asked.clear();
  for (const answer of questions.values()) answer(null); // the old worker won't answer: asked again, here
  questions.clear();
  if (!g || failed || typeof Worker === "undefined") return;
  const layout = g.layout();
  if (!layout) return;
  try {
    worker = new Worker(new URL("./capsWorker.ts", import.meta.url), { type: "module" });
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }
  worker.onmessage = (e: MessageEvent<FromCapsWorker>) => {
    const m = e.data;
    if (m.type === "error") fail(m.message);
    else if (m.type === "span") onSpan(m.slider, m.key, m.span);
    else if (m.type === "ask") {
      questions.get(m.id)?.(m.answer);
      questions.delete(m.id);
    } else onResult?.(m.gen, m.caps);
  };
  worker.onerror = (e) => fail(e.message || "failed to start");
  order = JSON.stringify(layout.order);
  pivotTargets = layout.basis.flatMap((b) => b.map(([t]) => t));
  send({ type: "init", layout });
}

/** Bring the worker's target order up to date; the targets the geometry knows and the ones a weight function is asked
 *  for (those plus the eye pivots' basis). */
function targets(): { known: Set<string>; weighed: Set<string> } {
  const now = geom!.targetOrder(); // head.extra.glb appends targets to the meshes: the worker sums in their (new) order
  const key = JSON.stringify(now);
  const known = new Set(now.flat());
  if (key !== order) {
    order = key;
    // a span or question already queued there may weigh a target it was sent without: its deltas go first (in order)
    sendDeltas([...skipped], known);
    send({ type: "order", order: now });
  }
  return { known, weighed: new Set([...known, ...pivotTargets]) };
}

/** A store's values (the non-zero ones) for every weighed target: all the limiter reads of it. */
function valuesOf(store: LimitStore, weighed: Set<string>): Record<string, number> {
  const values: Record<string, number> = {};
  for (const t of weighed) {
    const v = store.userValue(t);
    if (v) values[t] = v;
  }
  return values;
}

/** Send the deltas of these targets the first time the worker needs them. */
function sendDeltas(needed: Iterable<string>, known: Set<string>): void {
  for (const t of needed) {
    if (sent.has(t)) continue;
    if (!known.has(t)) {
      skipped.add(t); // sent once the meshes have it (targets())
      continue;
    }
    skipped.delete(t);
    const parts = geom!.deltas(t);
    send({ type: "deltas", target: t, parts }, parts.map((p) => p.buffer));
    sent.add(t);
  }
}

/**
 * Ask for caps (animCaps.ts scheduleAnimCaps): each channel on its rest store. Results arrive one channel at a time
 * through `result`; `fallback` runs if the worker fails later. False if the worker can't take it (compute locally).
 */
export function requestCaps(
  gen: number,
  channels: [string, Record<string, number>][],
  restFor: (channel: string) => LimitStore,
  result: (gen: number, caps: Record<string, number>) => void,
  fallback: () => void,
): boolean {
  if (!worker || !geom || failed) return false;
  onResult = result;
  onFail = fallback;
  const { known, weighed } = targets();
  // spans first (sliders about to be grabbed on this face), then the caps
  refreshSpans(weighed, known);
  const rests: Record<string, Record<string, number>> = {};
  const restOf = (channel: string) => {
    const key = channel === "emotion" ? "emotion" : "plain"; // animCaps restFor: only the emotion has its own rest
    rests[key] ??= valuesOf(restFor(channel), weighed);
    return key;
  };
  const list = channels.map(([name, anim]) => [name, anim, restOf(name)] as [string, Record<string, number>, string]);
  // the deltas of every target any of them weighs, the first time it is needed
  const needed = new Set<string>();
  for (const values of Object.values(rests)) for (const t of Object.keys(values)) needed.add(t);
  for (const [, anim] of list) for (const [t, w] of Object.entries(anim)) if (w) needed.add(t);
  sendDeltas(needed, known);
  send({ type: "caps", gen, rests, channels: list });
  return true;
}

// --- slider spans ----------------------------------------------------------------------------------------------------
// A slider's grab asks the limiter how far it may go on this face (limiter.span: ~0.03 s on a laptop, 0.1–0.5 s on a
// slow phone, all before the drag can start). The worker works it out ahead for the sliders likely to be grabbed next
// (hovered, focused, or on screen on a touch screen), and the grab takes its answer when the face is still exactly the
// one it was asked about. Same code, same numbers: otherwise the grab computes it itself.

type SpanAsk = { store: LimitStore; slider: string; ends: [number, number] };
const wanted = new Map<string, SpanAsk>(); // slider → how to ask (rows hovered, focused or on screen)
const answers = new Map<string, { key: string; span: [number, number] }>();
const asked = new Map<string, string>(); // slider → key in flight

/** What a span depends on: the face's values, the slider's own value and mix, its ends, and the geometry (a span worked
 *  out before head.extra.glb added its targets moved those sliders without them). */
function spanAsk(a: SpanAsk, weighed: Set<string>) {
  const values = valuesOf(a.store, weighed);
  const own = a.store.base[a.slider] ?? 0;
  const combo = a.store.comboOf(a.slider) ?? undefined;
  const key = JSON.stringify([geometryKey(), values, own, combo, a.ends]);
  return { values, own, combo, key };
}

function askSpan(a: SpanAsk, weighed: Set<string>, known: Set<string>): void {
  const q = spanAsk(a, weighed);
  if (answers.get(a.slider)?.key === q.key || asked.get(a.slider) === q.key) return;
  const needed = new Set([...Object.keys(q.values), a.slider, ...Object.keys(q.combo?.pos ?? {}), ...Object.keys(q.combo?.neg ?? {})]);
  sendDeltas(needed, known);
  asked.set(a.slider, q.key);
  send({ type: "span", key: q.key, slider: a.slider, ends: a.ends, values: q.values, own: q.own, combo: q.combo });
}

function refreshSpans(weighed: Set<string>, known: Set<string>): void {
  for (const a of wanted.values()) askSpan(a, weighed, known);
}

function onSpan(slider: string, key: string, span: [number, number]): void {
  if (asked.get(slider) === key) asked.delete(slider);
  answers.set(slider, { key, span });
}

/** A slider row is hovered, focused or on screen (`on`), or no longer: keep its span worked out ahead. */
export function wantSpan(store: LimitStore, slider: string, ends: [number, number], on: boolean): void {
  if (!on) return void wanted.delete(slider);
  const a = { store, slider, ends };
  wanted.set(slider, a);
  if (!worker || !geom || failed) return;
  const { known, weighed } = targets();
  askSpan(a, weighed, known);
}

/** The worker's span for this slider if it was worked out on exactly this face, else null (compute it here). */
export function readySpan(store: LimitStore, slider: string, ends: [number, number]): [number, number] | null {
  const hit = answers.get(slider);
  if (!hit || !geom || !worker) return null; // no worker (it failed): targets() would post to it
  return hit.key === spanAsk({ store, slider, ends }, targets().weighed).key ? hit.span : null;
}

// --- questions for the limiter (Distinctiveness, lib/morphs/random.ts varyFaceAsync) ------------------------------------

const questions = new Map<number, (answer: boolean | [number, number] | null) => void>();
let questionId = 0;

/**
 * The limiter's answer to one of random.ts's questions about a face (broken? how far may a feature go?), from the worker
 * when there is one, so a drag never waits on it. The same Limiter on the same vertices: the same answer as
 * limiter.broken / limiter.reach here (reach = span toward `end`, which is how reach() works).
 */
export async function askLimiter(defs: SliderDef[], a: LimitAsk): Promise<boolean | number> {
  const store = plainStore(a.face, defs);
  const here = () => (a.kind === "broken" ? limiter.broken(store) : limiter.reach(store, a.target, a.end));
  if (!worker || !geom || failed) return here();
  const { known, weighed } = targets();
  const values = valuesOf(store, weighed);
  const id = ++questionId;
  let answer: boolean | [number, number] | null;
  if (a.kind === "broken") {
    sendDeltas(Object.keys(values), known);
    answer = await new Promise((resolve) => {
      questions.set(id, resolve);
      send({ type: "ask", id, values, q: { kind: "broken" } });
    });
  } else {
    const own = store.base[a.target] ?? 0;
    const combo = store.comboOf(a.target) ?? undefined;
    const ends: [number, number] = a.end < own ? [a.end, own] : [own, a.end];
    sendDeltas([...Object.keys(values), a.target, ...Object.keys(combo?.pos ?? {}), ...Object.keys(combo?.neg ?? {})], known);
    answer = await new Promise((resolve) => {
      questions.set(id, resolve);
      send({ type: "ask", id, values, q: { kind: "span", slider: a.target, own, combo, ends } });
    });
    if (Array.isArray(answer)) return a.end < own ? answer[0] : answer[1];
  }
  return answer === null ? here() : (answer as boolean); // null: the worker failed meanwhile
}

/** The limiter's geometry as the page has it now (its targets per part): answers worked out on another geometry (before
 *  head.extra.glb added its targets) don't count. "" before the head is registered. */
export function geometryKey(): string {
  return geom ? geom.targetOrder().map((o) => o.length).join(",") : "";
}

/** The worker can answer questions now, and the page's own limiter is set up (both answer the same). */
export const canAsk = (): boolean => !!worker && !!geom && !failed && limiter.ready;
