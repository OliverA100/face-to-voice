"use client";

/**
 * Shape tab: the bones of the face. Random face + Distinctiveness and Age first (they change everything),
 * then one collapsible group per feature with the semantic sliders (pipeline/config/semantic_sliders.toml,
 * one feature each), and the raw GNM sliders last, collapsed (they move many features at once).
 */
import { useCallback, useEffect, useId, useRef, useState } from "react";

import { sectionOf, sliders, visibleSliders } from "@/lib/data";
import { askLimiter, canAsk, geometryKey } from "@/lib/morphs/capsClient";
import { canVary, onRandomChange, precomputeVariations, randomFace, randomFaceAsync, randomState, VARIATION, variationNotches, varyFace } from "@/lib/morphs/random";
import { morphs } from "@/lib/morphs/store";
import { MOTION } from "@/lib/motion";

import { AdvancedSection } from "./AdvancedSection";
import { paintRange, rideRange, setRange, speakRange, stopRide } from "./rangeFill";
import { Block, Group, Hint } from "./Group";
import { isResetKey, type RowRefs, SliderList } from "./SliderRow";

/** Distinctiveness as a screen reader says it: "1.00, as drawn", "0.40, toward average", "1.80, toward distinctive". */
const sayVariation = (v: number) =>
  `${v.toFixed(2)}, ${v < 0.005 ? "the average face" : Math.abs(v - VARIATION.default) < 0.005 ? "as drawn" : v < VARIATION.default ? "toward average" : "toward distinctive"}`;

/** The single-slider group that sits with Random face instead of among the features. */
const AGE_GROUP = "sem_age";

export function ShapeSection({ refs }: { refs: RowRefs }) {
  const defs = visibleSliders().filter((s) => sectionOf(s) === "identity");
  const groups = sliders.groups.filter((g) => sectionOf(g) === "identity" && g.id !== AGE_GROUP);
  return (
    <>
      <Hint>The face itself. Double-click any slider to reset it.</Hint>
      <Block title="Overall">
        <RandomRow />
        <SliderList defs={defs.filter((s) => s.group === AGE_GROUP)} refs={refs} className="px-5" />
      </Block>
      <Block title="Features">
        {groups.map((g, i) => {
          const items = defs.filter((s) => s.group === g.id);
          if (!items.length) return null;
          return (
            <Group key={g.id} label={g.label} count={items.length} open={i === 0}>
              <SliderList defs={items} refs={refs} />
            </Group>
          );
        })}
      </Block>
      <AdvancedSection refs={refs} />
    </>
  );
}

const RANDOM_FACE_TIP = "A new face, same style and expression"; // as the toolbar's Random character ("A new face, style and expression")
/** Distinctiveness's hint (tooltip and description): what it does, or why it is greyed out. */
const distinctivenessTip = (active: boolean) => (active ? "How striking each Random face is" : "Change the face to set this");

/**
 * Random face samples the raw GNM coefficients (realistic faces) and shows most of it on the Feature sliders
 * (lib/morphs/random.ts). Distinctiveness (randomState.variation) scales how far that same face is from the average
 * face: 0 = the average face, 1 = as drawn, above 1 = a few striking features.
 * It stays where it is set: every Random face is rolled at it, and moving it moves the current random face. With no
 * random face, a face changed by hand counts as drawn as it is; the reset face has nothing to move (greyed out).
 * Random character rolls its own (lib/character.ts) and Reset puts it back at 1; the slider shows both.
 */
function RandomRow() {
  const tipId = useId();
  const input = useRef<HTMLInputElement>(null);
  // Off on the server's render (always the reset face); checked after mount, as a restored face may already be changed.
  const [active, setActive] = useState(false);
  // Every notch worked out ahead in the caps worker (lib/morphs/random.ts precomputeVariations), while the row is on screen
  // or hovered: a drag then never waits on the limiter. Again whenever the face settles.
  const ahead = useRef({ seen: false, timer: 0 });
  const workAhead = useCallback(function work() {
    const a = ahead.current;
    window.clearTimeout(a.timer);
    a.timer = window.setTimeout(() => {
      if (!a.seen || !canVary(visibleSliders(), morphs.base)) return;
      if (!canAsk()) return void (a.timer = window.setTimeout(work, 1000)); // the limiter is still loading
      void precomputeVariations(visibleSliders(), morphs.base, variationNotches(randomState.variation), geometryKey(), askLimiter);
    }, 300); // after a burst of changes
  }, []);
  useEffect(() => {
    const check = () => {
      setActive(canVary(visibleSliders(), morphs.base));
      workAhead();
    };
    check();
    return morphs.onSettle(check); // the face changed by hand, or a tween landed
  }, [workAhead]);
  useEffect(() => {
    const el = input.current;
    if (!el || typeof IntersectionObserver === "undefined") return;
    const io = new IntersectionObserver(([e]) => {
      ahead.current.seen = e.isIntersecting;
      if (e.isIntersecting) workAhead();
    });
    io.observe(el);
    return () => io.disconnect();
  }, [workAhead]);
  useEffect(
    () =>
      onRandomChange(() => {
        setActive(canVary(visibleSliders(), morphs.base));
        workAhead();
        // a character's roll or Reset moves it, with the face (both change on the morph's clock)
        if (input.current) rideRange(input.current, randomState.variation, MOTION.morph, MOTION.ease.morph);
      }),
    [workAhead],
  );
  useEffect(() => {
    if (!input.current) return;
    speakRange(input.current, sayVariation);
    paintRange(input.current);
  }, []);
  // the face fitted in the caps worker (a distinctive one is seconds of checks on a phone); a newer click overtakes it
  const newRandomFace = async () => {
    const defs = visibleSliders();
    const w = await randomFaceAsync(defs, askLimiter, randomState.variation).catch(() => randomFace(defs, randomState.variation));
    if (w) morphs.tweenTo(w, MOTION.morph);
  };
  const reset = (el: HTMLInputElement) => {
    stopRide(el);
    setRange(el, VARIATION.default);
    randomState.variation = VARIATION.default;
    const w = varyFace(visibleSliders(), VARIATION.default, morphs.base, geometryKey());
    if (w) morphs.tweenTo(w, MOTION.follow, MOTION.ease.follow);
  };
  return (
    <div className="flex items-center gap-4 px-5 py-2">
      <button
        type="button"
        className="pill-secondary h-9 shrink-0"
        data-tip={RANDOM_FACE_TIP}
        aria-describedby={tipId}
        onClick={() => void newRandomFace()}
      >
        Random face
      </button>
      <span id={tipId} className="sr-only">
        {RANDOM_FACE_TIP}
      </span>
      <span id={`${tipId}-dist`} className="sr-only">
        {distinctivenessTip(active)}
      </span>
      {/* The one slider with a tooltip (the others' names and end labels say enough): its name alone doesn't. */}
      <label
        className={`flex min-w-0 flex-1 flex-col transition-opacity ${active ? "" : "opacity-40"}`}
        data-tip={distinctivenessTip(active)}
      >
        <span className="text-label text-ink-3">Distinctiveness</span>
        <input
          ref={input}
          type="range"
          min={VARIATION.min}
          max={VARIATION.max}
          step={VARIATION.notch}
          defaultValue={VARIATION.default}
          aria-label="Distinctiveness"
          aria-describedby={`${tipId}-dist`} // the hint (the tooltip is visual only): what it does, or why it is greyed out
          disabled={!active}
          aria-keyshortcuts="Delete"
          onKeyDown={(e) => {
            if (!isResetKey(e)) return;
            e.preventDefault();
            reset(e.currentTarget);
          }}
          onPointerDown={(e) => stopRide(e.currentTarget)}
          onInput={(e) => {
            stopRide(e.currentTarget);
            paintRange(e.currentTarget);
            randomState.variation = Math.round(e.currentTarget.valueAsNumber * 100) / 100; // a notch (as variationNotches)
            const w = varyFace(visibleSliders(), randomState.variation, morphs.base, geometryKey());
            if (w) morphs.tweenTo(w, MOTION.follow, MOTION.ease.follow);
          }}
          onDoubleClick={(e) => reset(e.currentTarget)}
          className="range block"
        />
        <span data-tip-under className="flex justify-between text-meta text-ink-4">
          <span>average</span>
          <span>distinctive</span>
        </span>
      </label>
    </div>
  );
}
