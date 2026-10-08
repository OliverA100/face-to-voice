"use client";

/**
 * Pose tab: head turn, bend and tilt, and where the eyes look, plus "look at cursor". The sliders write degrees into
 * lib/pose.ts through GSAP (no React state); IdleLife draws the pose with the idle sway and saccades on top.
 */
import { useEffect, useId, useState, useSyncExternalStore } from "react";

import { sectionOf, sliders, type SliderDef, visibleSliders } from "@/lib/data";
import { MOTION } from "@/lib/motion";
import { centrePose, followSnapshot, onPoseCentre, POSE_TARGETS, poseRig, setLookAtCursor, setPose, subscribeFollow } from "@/lib/pose";

import { blockTitle, Hint } from "./Group";
import { paintRange, rideRange, setRange, speakRange, stopRide, towards } from "./rangeFill";
import { isResetKey } from "./SliderRow";

const fmt = (v: number) => `${v > 0 ? "+" : ""}${Math.round(v)}°`;
const GAZE_OFF_TIP = "Turn off Look at cursor first";
/** The value as a screen reader says it: "10 degrees, toward right". */
const say = (v: number, def: SliderDef) => towards(`${Math.round(v)} degrees`, Math.round(v), def.lowLabel, def.highLabel);

export function PoseSection() {
  const defs = visibleSliders().filter((s) => sectionOf(s) === "pose");
  const groups = sliders.groups.filter((g) => sectionOf(g) === "pose");
  // Stable maps of DOM nodes (created once; never trigger a render).
  const [inputs] = useState(() => new Map<string, HTMLInputElement>());
  const [outputs] = useState(() => new Map<string, HTMLOutputElement>());
  // On by default with a mouse, off on touch, or the visitor's saved choice (lib/pose.ts); false on the server.
  const follow = useSyncExternalStore(subscribeFollow, followSnapshot, () => false);

  // "Look at cursor" and the gaze sliders are exclusive: following disables the eye rows and shows them at 0.
  const gazeRows = defs.filter((d) => d.group === "pose_eyes");
  const toggleFollow = (on: boolean) => {
    setLookAtCursor(on);
    if (on) {
      for (const d of gazeRows) {
        const input = inputs.get(d.target);
        if (input) {
          stopRide(input);
          setRange(input, 0);
        }
        const out = outputs.get(d.target);
        if (out) out.textContent = fmt(0);
      }
    }
  };

  // The rows render at 0; a pose restored after a reload (lib/pose.ts) is already in the rig. Gaze rows stay at 0 while following.
  useEffect(() => {
    for (const [target, input] of inputs) {
      const v = poseRig.follow.on && target.startsWith("pose_gaze") ? 0 : poseRig.base[POSE_TARGETS[target]];
      if (!v) continue;
      setRange(input, v);
      const out = outputs.get(target);
      if (out) out.textContent = fmt(v);
    }
  }, [inputs, outputs]);

  // Centre (here or from Reset over the head) brings every row back to 0, the thumbs travelling with the head.
  useEffect(
    () =>
      onPoseCentre((seconds) => {
        for (const [target, input] of inputs) {
          const out = outputs.get(target);
          rideRange(input, 0, seconds, MOTION.ease.morph, (v) => {
            if (out) out.textContent = fmt(v);
          });
        }
      }),
    [inputs, outputs],
  );

  return (
    <>
      <Hint>Where the head points and the eyes look. The idle motion plays on top.</Hint>
      <div className="flex items-center justify-between gap-3 px-5 pt-4">
        <label className="flex cursor-pointer items-center gap-2.5 text-body text-ink">
          <input type="checkbox" role="switch" checked={follow} onChange={(e) => toggleFollow(e.currentTarget.checked)} className="switch" />
          Look at cursor
        </label>
        <button type="button" className="pill-secondary h-8 px-3 text-label" onClick={() => centrePose()}>
          Centre
        </button>
      </div>
      <div className="px-5">
        {groups.map((g) => {
          const off = follow && g.id === "pose_eyes";
          return (
            <div key={g.id}>
              <h3 className={`pt-5 ${blockTitle}`}>
                {g.label}
                {off && <span className="font-normal text-ink-4"> · following the cursor</span>}
              </h3>
              {defs.filter((d) => d.group === g.id).map((d) => (
                <PoseRow key={d.id} def={d} inputs={inputs} outputs={outputs} disabled={off} />
              ))}
            </div>
          );
        })}
      </div>
    </>
  );
}

function PoseRow({ def, inputs, outputs, disabled = false }: { def: SliderDef; inputs: Map<string, HTMLInputElement>; outputs: Map<string, HTMLOutputElement>; disabled?: boolean }) {
  const key = POSE_TARGETS[def.target];
  const hintId = useId();
  const show = (v: number) => {
    const out = outputs.get(def.target);
    if (out) out.textContent = fmt(v);
  };
  const reset = (input: HTMLInputElement) => {
    stopRide(input);
    setRange(input, 0);
    setPose(key, 0);
    show(0);
  };
  return (
    // a hint only while greyed out: why (TooltipLayer)
    <label className={`group/row block py-2 transition-opacity ${disabled ? "opacity-40" : ""}`} data-tip={disabled ? GAZE_OFF_TIP : undefined}>
      {/* the same hint for screen readers (the tooltip is visual only) */}
      {disabled && (
        <span id={hintId} className="sr-only">
          {GAZE_OFF_TIP}
        </span>
      )}
      <span className="flex items-baseline justify-between gap-3">
        <span className="truncate text-body text-ink">{def.name}</span>
        <output
          aria-hidden // the slider says its own value (aria-valuetext); an <output> would be a live region
          ref={(el) => {
            if (el) outputs.set(def.target, el);
          }}
          className="shrink-0 text-meta tabular-nums text-ink-3 transition-colors group-hover/row:text-ink group-focus-within/row:text-ink"
        >
          {fmt(def.default)}
        </output>
      </span>
      <input
        type="range"
        min={def.min}
        max={def.max}
        step={1}
        disabled={disabled}
        aria-describedby={disabled ? hintId : undefined}
        defaultValue={def.default}
        aria-label={`${def.group === "pose_eyes" ? "Eyes" : "Head"}: ${def.name}`}
        aria-keyshortcuts="Delete"
        ref={(el) => {
          if (el) {
            inputs.set(def.target, el);
            speakRange(el, (v) => say(v, def));
            paintRange(el);
          }
        }}
        onKeyDown={(e) => {
          if (!isResetKey(e)) return;
          e.preventDefault();
          reset(e.currentTarget);
        }}
        onPointerDown={(e) => stopRide(e.currentTarget)}
        onInput={(e) => {
          stopRide(e.currentTarget);
          const v = e.currentTarget.valueAsNumber;
          setPose(key, v);
          paintRange(e.currentTarget);
          show(v);
        }}
        onDoubleClick={(e) => reset(e.currentTarget)}
        className="range range-mid block"
      />
      <span data-tip-under className="flex justify-between gap-3 text-meta text-ink-4">
        <span>{def.lowLabel}</span>
        <span>{def.highLabel}</span>
      </span>
    </label>
  );
}
