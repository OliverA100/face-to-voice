/**
 * One morph slider. The <input type="range"> is uncontrolled: dragging writes straight into the
 * morph store through an eased GSAP setter and the readout is updated through a ref, so React never
 * re-renders while dragging. SliderPanel keeps the input/output maps and syncs them when the store
 * changes for another reason (random face, reset). The thumb runs −1 … +1 with the average face in the middle;
 * lib/morphs/travel.ts turns it into the morph weight (each half scaled to its own end).
 *
 * Limits: when the slider is grabbed, its track adapts: the end of the track is as far as this face allows right now
 * (lib/morphs/limits.ts span, lib/morphs/travel.ts adaptiveTrack), so it always drags to its end and never resists.
 * Working that out takes 0.1–0.5 s on a slow phone, so the caps worker does it ahead for the rows likely to be grabbed
 * next (hovered, focused, or on screen on a touch screen; lib/morphs/capsClient.ts) and the grab takes its answer when
 * the face hasn't changed since.
 */
import type { SliderDef } from "@/lib/data";
import { readySpan, wantSpan } from "@/lib/morphs/capsClient";
import { limiter } from "@/lib/morphs/limiter";
import { morphs } from "@/lib/morphs/store";
import { adaptiveTrack, toUi, uiMax, uiMin } from "@/lib/morphs/travel";

import { paintRange, setRange, speakRange, towards } from "./rangeFill";

export const fmt = (v: number) => (v > 0 ? "+" : "") + v.toFixed(2);

/** Delete or Backspace on a focused slider puts it back to its default: the keyboard's double-click (aria-keyshortcuts). */
export const isResetKey = (e: { key: string; altKey: boolean; ctrlKey: boolean; metaKey: boolean }) => (e.key === "Delete" || e.key === "Backspace") && !e.altKey && !e.ctrlKey && !e.metaKey;

export type RowRefs = { inputs: Map<string, HTMLInputElement>; outputs: Map<string, HTMLOutputElement> };

/**
 * The track of the slider being moved: thumb → weight, set when it is grabbed (pointer down / a key) so its end is as far
 * as this face allows right now (lib/morphs/travel.ts adaptiveTrack). Recomputed whenever another slider moved since.
 */
const tracks = new WeakMap<HTMLInputElement, (u: number) => number>();
/** The thumb position each input last showed (the anchor of the next grab). */
const shown = new WeakMap<HTMLInputElement, number>();

function grab(input: HTMLInputElement, def: SliderDef) {
  const u0 = shown.get(input) ?? input.valueAsNumber;
  const w0 = morphs.base[def.target] ?? def.default;
  const ends: [number, number] = [def.min, def.max];
  const ready = readySpan(morphs, def.target, ends);
  if (ready) limiter.primeSpan(def.target, ready); // as if span() had just run (a key press's next grab finds it)
  const [lo, hi] = ready ?? limiter.span(morphs, def.target, ends);
  tracks.set(input, adaptiveTrack(def, u0, w0, lo, hi));
}

/** Rows likely to be grabbed next keep their span worked out ahead (the caps worker). */
const want = (def: SliderDef, on: boolean) => wantSpan(morphs, def.target, [def.min, def.max], on);
const rowDefs = new WeakMap<Element, SliderDef>();
let onScreen: IntersectionObserver | null | undefined;
/** Touch screens have no hover: the rows on screen are the ones a finger can land on. */
function watchOnScreen(el: HTMLInputElement, def: SliderDef): () => void {
  if (onScreen === undefined) {
    onScreen = typeof IntersectionObserver !== "undefined" && window.matchMedia("(pointer: coarse)").matches
      ? new IntersectionObserver((entries) => {
          for (const e of entries) {
            const d = rowDefs.get(e.target);
            if (d) want(d, e.isIntersecting);
          }
        })
      : null;
  }
  if (!onScreen) return () => {};
  rowDefs.set(el, def);
  onScreen.observe(el);
  return () => {
    onScreen?.unobserve(el);
    want(def, false);
  };
}
const unwatch = new WeakMap<HTMLInputElement, () => void>();

/** Another slider or a tween changed the face: tracks are re-made on the next grab; `u` is what the thumb shows now. */
export function syncRow(input: HTMLInputElement, u: number) {
  shown.set(input, u);
  tracks.delete(input);
}

export function SliderRow({ def, refs }: { def: SliderDef; refs: RowRefs }) {
  const { inputs, outputs } = refs;
  const show = (v: number) => {
    const out = outputs.get(def.target);
    if (out) out.textContent = fmt(v);
  };
  const reset = (input: HTMLInputElement) => {
    const u = toUi(def, def.default);
    setRange(input, u);
    shown.set(input, u);
    tracks.delete(input);
    morphs.quickTo(def.target)(def.default);
    show(u);
  };
  return (
    <label className="group/row block py-2" onPointerEnter={() => want(def, true)} onPointerLeave={() => want(def, false)}>
      <span className="flex items-baseline justify-between gap-3">
        <span className="truncate text-body text-ink">{def.name}</span>
        {/* The readout repeats the slider's own value (aria-valuetext), so it is hidden from screen readers: an <output> is a
            live region, and every slider moving at once (Random face) would be read out. */}
        <output
          aria-hidden
          ref={(el) => {
            if (el) outputs.set(def.target, el);
            else outputs.delete(def.target);
          }}
          className="shrink-0 text-meta tabular-nums text-ink-3 transition-colors group-hover/row:text-ink group-focus-within/row:text-ink"
        >
          {fmt(toUi(def, def.default))}
        </output>
      </span>
      <input
        type="range"
        min={uiMin(def)}
        max={uiMax(def)}
        step={0.01}
        defaultValue={toUi(def, def.default)}
        aria-label={def.name}
        aria-keyshortcuts="Delete"
        ref={(el) => {
          if (el) {
            inputs.set(def.target, el);
            speakRange(el, (u) => towards(fmt(u), u, def.lowLabel, def.highLabel, uiMin(def) >= 0));
            paintRange(el);
            unwatch.set(el, watchOnScreen(el, def));
          } else {
            const old = inputs.get(def.target);
            if (old) unwatch.get(old)?.();
            inputs.delete(def.target);
          }
        }}
        onFocus={() => want(def, true)}
        onBlur={() => want(def, false)}
        onPointerDown={(e) => grab(e.currentTarget, def)}
        onKeyDown={(e) => {
          if (isResetKey(e)) {
            e.preventDefault();
            reset(e.currentTarget);
            return;
          }
          grab(e.currentTarget, def);
        }}
        onInput={(e) => {
          const input = e.currentTarget;
          if (!tracks.has(input)) grab(input, def);
          const u = input.valueAsNumber;
          const w = tracks.get(input)!(u);
          morphs.quickTo(def.target)(w);
          shown.set(input, u);
          paintRange(input);
          show(u);
        }}
        onDoubleClick={(e) => reset(e.currentTarget)}
        className="range range-mid block"
      />
      {/* The end labels wrap rather than cut off when the panel is very narrow (320px, 400% zoom). */}
      <span className="flex justify-between gap-3 text-meta text-ink-4">
        <span className="min-w-0 break-words">{def.lowLabel}</span>
        <span className="min-w-0 break-words text-right">{def.highLabel}</span>
      </span>
    </label>
  );
}

/** Rows of one group, padded like the rest of the panel. */
export function SliderList({ defs, refs, className = "px-5 pb-2" }: { defs: SliderDef[]; refs: RowRefs; className?: string }) {
  return (
    <div className={className}>
      {defs.map((s) => (
        <SliderRow key={s.id} def={s} refs={refs} />
      ))}
    </div>
  );
}
