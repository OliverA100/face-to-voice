/**
 * The loader's look: the sphere (./chrome.tsx) and one quiet line under it, "Shaping a face". The sphere is the only
 * thing moving; screen readers get the real progress from HeadLoader's progressbar. sphereCaption also shows the % (the
 * caption's `percent` flag); sphereTitle, what ships (./HeadLoader.tsx), drops it.
 *
 * Tweak here: LAYOUT_A (spacing); the sphere itself: ./chrome.tsx CHROME.
 */
import type { CSSProperties } from "react";

import { Chrome, chromeMotion } from "./chrome";
import { type LoaderVariant, type Rig } from "./engine";

/** A · the sphere and one quiet line: no waveform (the sphere is the only motion, the % the only progress). */
const LAYOUT_A = {
  "--orb": "min(200px, 36cqmin)",
  "--gap": "clamp(20px, 6cqmin, 32px)", // sphere → caption (clears the bumps at the blob end)
  "--below": "calc(var(--gap) + 24px)", // everything under the sphere (caption line 24px)
  "--cy": "calc(50% - 30px - var(--below) / 2)",
  "--cap": "calc(var(--orb) / 2 + var(--gap))",
} as CSSProperties;

function MarkupA() {
  return <Chrome size="var(--orb)" />;
}

function createA(root: HTMLElement): Rig {
  const sphere = chromeMotion(root);
  return { frame: (s) => sphere.frame(s), settle: () => sphere.settle(), focus: () => sphere.focus(), dispose: () => sphere.dispose() };
}

export const sphereCaption: LoaderVariant = {
  id: "sphere-caption",
  label: "A · Sphere + caption",
  blurb: "No waveform: the sphere is the only thing moving and the % the only progress, in one tight group.",
  vars: LAYOUT_A,
  Markup: MarkupA,
  create: createA,
};

/** A2 · as A, but the caption is the title alone: no progress shown at all, only the sphere moving. */
export const sphereTitle: LoaderVariant = {
  ...sphereCaption,
  id: "sphere-title",
  label: "A2 · Sphere + caption, no %",
  blurb: "As A without the %: just the sphere and \u201cShaping a face\u201d, no progress number.",
  percent: false,
};
