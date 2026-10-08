/**
 * The face itself (shape sliders, emotion and its intensity) kept across reloads, like the hair, add-ons, skin and
 * eyes: sessionStorage, so a reload shows the same face and a new tab opens on the blank head. The pose is kept the
 * same way in lib/pose.ts.
 *
 * Saved whenever the face settles (a slider let go, a tween or an emotion blend done), restored once when the app
 * module loads, before the head binds its meshes. The panel's uncontrolled inputs read the restored values on mount.
 *
 * Identity and emotion targets live in head.extra.glb, which normally loads after the reveal (lib/headExtra.ts). A
 * restored face that uses them downloads it with the head instead and holds the loader's reveal until it is merged,
 * so the head never shows the plain face first.
 */
import { emotionDefs, manifest, MODELS_BASE, sliders } from "@/lib/data";
import { applyEmotion, emotionRig } from "@/lib/emotion";
import { prefetchPart } from "@/lib/headLoad";
import { morphs } from "@/lib/morphs/store";

const STORAGE_KEY = "ftv-face"; // sessionStorage: kept across reloads, but a new tab opens on the blank head

type Saved = { shape?: Record<string, number>; emotion?: string; intensity?: number };

const shapeTargets = () => morphs.targets().filter((t) => morphs.kinds[t] !== "emotion");

function save(): void {
  const shape: Record<string, number> = {};
  for (const t of shapeTargets()) {
    const v = morphs.base[t];
    if (Math.abs(v - morphs.defaults[t]) > 1e-4) shape[t] = Math.round(v * 1e4) / 1e4; // only what moved
  }
  const saved: Saved = { shape, emotion: emotionRig.current, intensity: emotionRig.intensity };
  try {
    window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify(saved));
  } catch {
    /* private mode: no persistence */
  }
}

let started = false;
/** Restore the saved face and start saving (once, browser only). Call after the morph store and emotions are configured. */
export function restoreFace(): void {
  if (started || typeof window === "undefined") return;
  started = true;
  try {
    const raw = window.sessionStorage.getItem(STORAGE_KEY);
    const saved = raw ? (JSON.parse(raw) as Saved) : {};
    const targets = new Set(shapeTargets());
    for (const [t, v] of Object.entries(saved.shape ?? {})) {
      if (!targets.has(t) || !Number.isFinite(v)) continue;
      const [lo, hi] = morphs.ranges[t];
      morphs.set(t, Math.min(hi, Math.max(lo, v)), "tween"); // not "ui": listeners (age skin, limiter) follow as for a tween
    }
    if (typeof saved.intensity === "number" && Number.isFinite(saved.intensity)) {
      const { min, max } = sliders.emotions.intensity; // the Intensity slider's range
      emotionRig.intensity = Math.min(max, Math.max(min, saved.intensity));
    }
    if (emotionDefs.some((e) => e.id === saved.emotion)) {
      emotionRig.current = saved.emotion!;
      emotionRig.weights[saved.emotion!] = 1;
    }
    applyEmotion();
    const extra = manifest.extra?.file;
    if (extra && manifest.targets.some((t) => t.file === "extra" && morphs.effective(t.name) !== 0)) prefetchPart("extra", MODELS_BASE + extra);
  } catch {
    /* private mode or malformed: keep the blank head */
  }
  morphs.onSettle(save);
}
