"use client";

/**
 * Expression tab: one button per emotion (plus Neutral) with its intensity, then the fine-tune sliders.
 * The buttons cross-fade the face with GSAP (lib/emotion.ts); React only mirrors which button is chosen.
 * The emotion also reaches the voice: it is in the look sent with the face and in every line the voice speaks.
 */
import { useEffect, useRef, useSyncExternalStore } from "react";

import { RadioGroup } from "@/components/ui/RadioGroup";
import { emotionDefs, sectionOf, sliders, visibleSliders } from "@/lib/data";
import { emotionRig, NEUTRAL, onEmotionChange, onIntensityChange, setEmotion, setIntensity } from "@/lib/emotion";
import { MOTION } from "@/lib/motion";

import { Block, Group, Hint } from "./Group";
import { paintRange, rideRange, setRange, speakRange, stopRide } from "./rangeFill";
import { isResetKey, type RowRefs, SliderList } from "./SliderRow";

const current = () => emotionRig.current;

export function EmotionSection({ refs }: { refs: RowRefs }) {
  const chosen = useSyncExternalStore(onEmotionChange, current, () => NEUTRAL);
  const range = sliders.emotions.intensity;
  const buttons = [{ id: NEUTRAL, label: "Neutral" }, ...emotionDefs];
  // The slider is uncontrolled; a random character moves it through this listener.
  const intensity = useRef<HTMLInputElement>(null);
  useEffect(
    () =>
      onIntensityChange((v, seconds) => {
        if (intensity.current) rideRange(intensity.current, v, seconds, MOTION.ease.morph); // with the face (Random character, Reset)
      }),
    [],
  );
  useEffect(() => {
    if (!intensity.current) return;
    speakRange(intensity.current, (v) => `${Math.round(v * 100)} percent`);
    setRange(intensity.current, emotionRig.intensity); // restored after a reload (lib/faceSession.ts)
  }, []);
  const resetIntensity = (input: HTMLInputElement) => {
    stopRide(input);
    setRange(input, range.default);
    setIntensity(range.default);
  };
  return (
    <>
      <Hint>How the face feels. The eyes keep the feeling while the voice speaks.</Hint>
      <Block title="Emotion">
        <div className="px-5 pt-2">
          <RadioGroup label="Emotion" className="flex flex-wrap gap-2">
            {buttons.map((e) => (
              <button
                key={e.id}
                type="button"
                role="radio"
                aria-checked={chosen === e.id}
                onClick={() => setEmotion(e.id)}
                className="pill-secondary pill-choice h-8 px-3 text-label"
              >
                {e.label}
              </button>
            ))}
          </RadioGroup>
          <label className="mt-4 block py-2">
            <span className="block text-body text-ink">Intensity</span>
            <input
              ref={intensity}
              type="range"
              min={range.min}
              max={range.max}
              step={0.01}
              defaultValue={range.default}
              aria-label="Emotion intensity"
              aria-keyshortcuts="Delete"
              onKeyDown={(e) => {
                if (!isResetKey(e)) return;
                e.preventDefault();
                resetIntensity(e.currentTarget);
              }}
              onPointerDown={(e) => stopRide(e.currentTarget)}
              onInput={(e) => {
                stopRide(e.currentTarget);
                paintRange(e.currentTarget);
                setIntensity(e.currentTarget.valueAsNumber);
              }}
              onDoubleClick={(e) => resetIntensity(e.currentTarget)}
              className="range block"
            />
            <span className="flex justify-between text-meta text-ink-4">
              <span>a hint</span>
              <span>full</span>
            </span>
          </label>
        </div>
      </Block>
      {/* Fine-tune: jaw, smile, brows … (mixes of the shipped expression targets); they add to the emotion. */}
      <Block title="Fine-tune" note="adds to the emotion">
        {sliders.groups
          .filter((g) => sectionOf(g) === "emotion")
          .map((g) => {
            const items = visibleSliders().filter((s) => sectionOf(s) === "emotion" && s.group === g.id);
            if (!items.length) return null;
            return (
              <Group key={g.id} label={g.label} count={items.length}>
                <SliderList defs={items} refs={refs} />
              </Group>
            );
          })}
      </Block>
    </>
  );
}
