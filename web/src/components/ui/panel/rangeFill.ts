import gsap from "gsap";

/**
 * The fill of a range slider (colour --fill in app/tokens.css, styles in app/globals.css). It runs from the slider's zero point to
 * the thumb: from the centre on bipolar sliders (.range-mid, e.g. −1…+1 or −20°…+30°), from the left edge on
 * the others. It is written as two CSS variables on the input itself, so dragging still never touches React.
 *
 * Positions follow the thumb's centre, which travels from 8px to (width − 8px) for the 16px thumb.
 */
const at = (t: number) => `calc(8px + ${t.toFixed(4)} * (100% - 16px))`;

/** What a screen reader says for each slider's value (aria-valuetext): registered once by speakRange, kept current by paintRange. */
const sayings = new WeakMap<HTMLInputElement, (v: number) => string>();

/**
 * Give a slider its value in words ("+0.40, toward wide skull", "10 degrees, toward right") instead of the bare number.
 * The text follows every change made through paintRange / setRange / rideRange, so it never needs React.
 */
export function speakRange(input: HTMLInputElement, say: (v: number) => string) {
  sayings.set(input, say);
  input.setAttribute("aria-valuetext", say(input.valueAsNumber));
}

/** "+0.40, toward wide skull" for a slider with end labels; "middle" (or the low end of a one-sided one) at zero. */
export function towards(value: string, v: number, low: string, high: string, oneSided = false) {
  if (low === "−" || low === "-") return value; // raw sliders: their ends have no names
  if (Math.abs(v) < 0.005) return oneSided ? `${value}, ${low}` : `${value}, middle`;
  return `${value}, toward ${v > 0 ? high : low}`;
}

/** Repaint after the value changed (user input or code). */
export function paintRange(input: HTMLInputElement) {
  const say = sayings.get(input);
  if (say) input.setAttribute("aria-valuetext", say(input.valueAsNumber));
  const min = Number(input.min);
  const max = Number(input.max);
  const span = max - min || 1;
  const t = (input.valueAsNumber - min) / span;
  if (input.classList.contains("range-mid")) {
    const z = Math.min(1, Math.max(0, (0 - min) / span));
    input.style.setProperty("--fz", at(z));
    input.style.setProperty("--fa", at(Math.min(z, t)));
    input.style.setProperty("--fb", at(Math.max(z, t)));
  } else {
    input.style.setProperty("--fa", "0px");
    input.style.setProperty("--fb", at(t));
  }
}

/** Set a slider's value from code (random face, reset, centre …) and repaint its fill. */
export function setRange(input: HTMLInputElement, value: number) {
  input.value = String(value);
  paintRange(input);
}

const rides = new WeakMap<HTMLInputElement, gsap.core.Tween>();

/**
 * Move a slider's thumb (and fill) to `value` over `seconds`, on the curve the head itself is moving on, so the thumb
 * travels with the face instead of jumping ahead of it (Random character, Reset, Centre). `onUpdate` gets each value
 * (for a readout). A newer ride or stopRide (the visitor grabbing the slider) cancels it.
 */
export function rideRange(input: HTMLInputElement, value: number, seconds: number, ease: string, onUpdate?: (v: number) => void) {
  stopRide(input);
  const from = input.valueAsNumber;
  if (!(seconds > 0) || Math.abs(from - value) < 1e-6) {
    setRange(input, value);
    onUpdate?.(value);
    return;
  }
  const at = { v: from };
  rides.set(
    input,
    gsap.to(at, {
      v: value,
      duration: seconds,
      ease,
      onUpdate: () => {
        setRange(input, at.v);
        onUpdate?.(at.v);
      },
      onComplete: () => rides.delete(input),
    }),
  );
}

/** Cancel a ride (the visitor took the slider over). */
export function stopRide(input: HTMLInputElement) {
  rides.get(input)?.kill();
  rides.delete(input);
}
