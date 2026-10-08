/**
 * The motion scale: how long things take and how they ease, for the whole app. CSS reads the UI half from
 * app/tokens.css (--dur-1/2/3, --ease, --ease-out-soft, --ease-in-out-soft); GSAP code reads this object.
 * The UI durations here mirror tokens.css (a test keeps them equal), so a tween started from code can match a CSS
 * transition next to it.
 *
 * Two families:
 *   UI    quick 150 ms (hover, press, colour, focus) · move 300 ms (indicators, rings, fades, content entering)
 *         · height 400 ms (groups opening and closing)
 *   head  follow 0.12 s (a slider drags the face) · blend 0.45 s (an emotion button) · morph 0.9 s (a whole new face:
 *         Random character, Reset, Random face; everything that changes with it runs on this one clock)
 *         · crossfade 0.4 s (hair and add-ons swapping during a morph); every timed head change eases power2.inOut
 * Kept on their own on purpose: the loader and its reveal (components/ui/loader: one slow sine-eased clock, the
 * sphere's swing), the pose sliders' heavier follow (lib/pose.ts POSE.ease: a whole head turning), and the idle life,
 * lip sync and cursor follow (tuned for realism).
 *
 * Reduced motion: tokens.css shortens the CSS durations to ~0; the head's tweens are not shortened (no large motion: a
 * face changing is the content, started by a click), but its idle sway and breathing stop (components/scene/IdleLife.tsx).
 */
export const MOTION = {
  // UI (seconds; = tokens.css)
  quick: 0.15, // --dur-1
  move: 0.3, // --dur-2
  height: 0.4, // --dur-3

  // The head (seconds)
  follow: 0.12, // a slider dragging the face (shape, intensity, distinctiveness): GSAP quickTo
  blend: 0.45, // an emotion button cross-fading the expression
  morph: 0.9, // a whole new face: shape, age, skin, eye and hair colours, expression and pose all on this clock
  crossfade: 0.4, // the old hair and add-ons fading into the new ones (lib/pieceFade.ts)

  ease: {
    follow: "power2.out", // catches up with the thumb, no lag at the start
    morph: "power2.inOut", // shape and colour changes: gentle start and landing (the blends and the morph share it)
    crossfade: "power2.inOut", // the hair and add-ons swap on the morph's curve
  },
};
