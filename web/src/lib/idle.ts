/**
 * Idle-life parameters. All times in seconds, angles in radians. Numbers come from published
 * human averages (blink rate ~17/min at rest, blink ≈ 100 ms close / 220 ms open, saccades
 * mostly under 15°) scaled down for a close-up bust; tweak freely.
 */
export const IDLE = {
  blink: {
    meanInterval: 3.5, // seconds between blinks (drawn from a skewed distribution)
    minInterval: 0.8,
    maxInterval: 8,
    close: 0.1,
    hold: 0.04,
    open: 0.22,
    doubleChance: 0.15, // second blink right after the first
    doubleDelay: 0.15, // seconds between the two blinks of a double
    partialChance: 0.3, // some blinks only close ~70 %
    partialAmount: 0.7,
  },
  sway: {
    yaw: 0.04,
    pitch: 0.025,
    roll: 0.02,
    speed: 0.12, // Hz-ish; the motion is a sum of slow sines so it never repeats visibly
    speechNod: 0.012, // extra nod per unit of speech energy (lip sync), radians
  },
  breathing: {
    period: 4.2,
    bob: 0.0015, // metres
    pitch: 0.004,
  },
  saccade: {
    minInterval: 0.6,
    maxInterval: 2.5,
    amplitude: 0.1, // max eye rotation per axis
    verticalShare: 0.6, // vertical saccades are smaller than horizontal ones
    duration: 0.05,
    driftAmplitude: 0.015, // slow fixational drift between saccades
    driftSpeedYaw: 0.9,
    driftSpeedPitch: 0.7,
  },
} as const;
