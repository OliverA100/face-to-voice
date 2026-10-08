/**
 * The animation caps (lib/morphs/animCaps.ts), slider spans and Random face's limiter questions off the main thread. On
 * a phone limiter.caps() takes ~0.2 s per animation (2–3 s per settle, 6–7 s for a Random character): even in idle
 * slices that freezes the head for several frames at a time. Here the very same Limiter (lib/morphs/limits.ts) runs on
 * a copy of the vertices it tests: the page sends their layout and rest positions once (LimitGeometry.layout) and each
 * target's deltas the first time a question needs it, then asks with the slider values; answers come back one
 * animation at a time, exactly what the page would compute.
 */
import type { CapsLayout, LimitGeometry } from "./limitGeometry";
import { eyePivots, placePart } from "./limitPositions";
import { limiter, type LimitStore } from "./limits";

export type ToCapsWorker =
  | { type: "init"; layout: CapsLayout }
  | { type: "order"; order: string[][] }
  | { type: "deltas"; target: string; parts: Float32Array[] }
  /** rests: slider values (non-zero ones) per rest name; channels: [animation, its weights, which rest]. */
  | { type: "caps"; gen: number; rests: Record<string, Record<string, number>>; channels: [string, Record<string, number>, string][] }
  /** A slider's span() on a face (its values, the slider's own value and mix): answered before any caps. */
  | { type: "span"; key: string; slider: string; ends: [number, number]; values: Record<string, number>; own: number; combo: SpanCombo }
  /** Answered first of all (someone is dragging and waiting). */
  | { type: "ask"; id: number; values: Record<string, number>; q: LimitQuestion };

/** A question for the limiter on a face (Distinctiveness, lib/morphs/random.ts varyFaceAsync): broken, or a span. */
export type LimitQuestion = { kind: "broken" } | { kind: "span"; slider: string; own: number; combo: SpanCombo; ends: [number, number] };

export type SpanCombo = { pos: Record<string, number>; neg: Record<string, number> | null } | undefined;

export type FromCapsWorker =
  | { type: "caps"; gen: number; name: string; caps: Record<string, number> }
  | { type: "span"; key: string; slider: string; span: [number, number] }
  | { type: "ask"; id: number; answer: boolean | [number, number] }
  | { type: "error"; message: string };

const post = (m: FromCapsWorker) => (self as unknown as Worker).postMessage(m);

/** LimitGeometry's positions() over the copied vertices: same values, same order of sums, same float rounding. */
class CopiedGeometry {
  readonly count: number;
  private readonly groups: (CapsLayout["groups"][number] & { order: string[]; scratch: Float32Array })[];
  readonly deltas = new Map<string, Float32Array[]>();

  constructor(private readonly layout: CapsLayout) {
    this.count = layout.count;
    this.groups = layout.groups.map((g, i) => ({ ...g, order: layout.order[i], scratch: new Float32Array(g.rest.length) }));
  }

  setOrder(order: string[][]): void {
    this.groups.forEach((g, i) => (g.order = order[i]));
  }

  positions(weight: (target: string) => number, out: Float32Array, rest = true, pivots?: Float32Array): boolean {
    const piv = eyePivots(this.layout.pivot, this.layout.basis, weight, rest);
    if (pivots) pivots.set([...piv[0], ...piv[1]]);
    this.groups.forEach((g, gi) => {
      // NormalRefresher.sample: rest (or zero), then + weight · delta per target in the mesh's order
      const s = g.scratch;
      if (rest) s.set(g.rest);
      else s.fill(0);
      for (const t of g.order) {
        const w = weight(t);
        if (!w) continue;
        const data = this.deltas.get(t)?.[gi];
        if (!data) throw new Error(`caps worker: no deltas for ${t}`);
        for (let i = 0; i < data.length; i += 3) {
          s[i] += w * data[i];
          s[i + 1] += w * data[i + 1];
          s[i + 2] += w * data[i + 2];
        }
      }
      placePart(g.slots, g.m, g.eye >= 0 ? piv[g.eye] : [0, 0, 0], s, out, rest); // shared with LimitGeometry
    });
    return true;
  }
}

let geom: CopiedGeometry | null = null;
let job: { gen: number; rests: Record<string, LimitStore>; channels: [string, Record<string, number>, string][] } | null = null;
let busy = false;
const spans = new Map<string, Extract<ToCapsWorker, { type: "span" }>>(); // per slider, the latest ask
const asks: Extract<ToCapsWorker, { type: "ask" }>[] = [];

const storeOf = (values: Record<string, number>): LimitStore => ({ base: values, userValue: (t) => values[t] ?? 0, comboOf: () => undefined });

/** One span or animation per task, so a newer request (the face changed again) replaces the rest of an older one at
 *  once. Spans first: a slider about to be grabbed must not wait behind caps nobody sees yet. */
function step(): void {
  busy = false;
  if (!geom) return;
  const question = asks.shift();
  if (question) {
    const { values, q } = question;
    const store: LimitStore = {
      base: q.kind === "span" ? { [q.slider]: q.own } : values,
      userValue: (t) => values[t] ?? 0,
      comboOf: (x) => (q.kind === "span" && x === q.slider ? q.combo : undefined),
    };
    try {
      limiter.invalidate(); // its cache knows the slider, not the face
      post({ type: "ask", id: question.id, answer: q.kind === "broken" ? limiter.broken(store) : limiter.span(store, q.slider, q.ends) });
    } catch (err) {
      return post({ type: "error", message: err instanceof Error ? err.message : String(err) });
    }
    return schedule();
  }
  const ask = spans.values().next().value;
  if (ask) {
    spans.delete(ask.slider);
    const store: LimitStore = { base: { [ask.slider]: ask.own }, userValue: (t) => ask.values[t] ?? 0, comboOf: (x) => (x === ask.slider ? ask.combo : undefined) };
    try {
      limiter.invalidate(); // its cache knows the slider, not the face
      post({ type: "span", key: ask.key, slider: ask.slider, span: limiter.span(store, ask.slider, ask.ends) });
    } catch (err) {
      return post({ type: "error", message: err instanceof Error ? err.message : String(err) });
    }
    return schedule();
  }
  if (!job) return;
  const next = job.channels.shift();
  if (!next) return void (job = null);
  const [name, anim, rest] = next;
  try {
    post({ type: "caps", gen: job.gen, name, caps: limiter.caps(job.rests[rest], { [name]: anim }) });
  } catch (err) {
    job = null;
    return post({ type: "error", message: err instanceof Error ? err.message : String(err) });
  }
  schedule();
}

function schedule(): void {
  if (busy || (!job && !spans.size && !asks.length)) return;
  busy = true;
  setTimeout(step, 0);
}

self.onmessage = (e: MessageEvent<ToCapsWorker>) => {
  const m = e.data;
  try {
    if (m.type === "init") {
      geom = new CopiedGeometry(m.layout);
      limiter.attach(geom as unknown as LimitGeometry); // the average face and its candidate triangles, here
    } else if (m.type === "order") geom?.setOrder(m.order);
    else if (m.type === "deltas") geom?.deltas.set(m.target, m.parts);
    else if (m.type === "caps") {
      job = { gen: m.gen, rests: Object.fromEntries(Object.entries(m.rests).map(([k, v]) => [k, storeOf(v)])), channels: m.channels };
      schedule();
    } else if (m.type === "ask") {
      asks.push(m);
      schedule();
    } else if (m.type === "span") {
      spans.delete(m.slider);
      spans.set(m.slider, m);
      schedule();
    }
  } catch (err) {
    post({ type: "error", message: err instanceof Error ? err.message : String(err) });
  }
};
