/**
 * The one place morph weights live. Nothing here is React state: sliders, GSAP tweens and the
 * idle animation all write into plain objects and the store pushes values straight into every
 * mesh's morphTargetInfluences. React only re-renders for things like the perf overlay.
 *
 * Layers: `base` holds the slider values (what the visitor set). Named layers (blink, viseme, …)
 * are added on top per target and clamped to the slider's range, so a blink never fights the
 * "eye open" slider and speech never fights the mouth sliders.
 *
 * Mix sliders: a slider with a `combo` (sliders.json) has no morph target of its own. Its value lives in
 * `base` like any other slider and is spread over existing targets through the "combo" layer:
 * combo[t] = Σ value(slider) × weight(slider, t). Head size and the fine-tune controls work this way.
 * A two-sided mix (`comboNeg`) uses its own weights below zero: combo[t] += |value| × comboNeg[t].
 *
 * Limits (lib/morphs/limits.ts): sliders.json min/max are each slider's ends (the panel's track). What reaches the
 * mesh is clamped more loosely (never tighter than −1 … +1), so a blink or a viseme on a raw target still
 * plays in full; breaking the face is prevented by the limiter instead (each dragged slider's span; per-face caps on the
 * animation layers, set by lib/morphs/animCaps.ts when the shape settles).
 */
import gsap from "gsap";
import type { Mesh } from "three";

import type { SliderDef, Weights } from "@/lib/data";
import { type LimitStore, limiter, REST_LAYERS } from "@/lib/morphs/limiter";
import { MOTION } from "@/lib/motion";

type Binding = { mesh: Mesh; index: number };
const COMBO_LAYER = "combo";
/**
 * Layers that pass (a blink, the lids following the eyes, speech), as opposed to the shape the face holds (sliders,
 * mixes, emotion). The skin's normals follow only the held shape (Head.tsx): they aren't refreshed while a blink or a
 * word passes, so a refresh that included one would keep its shading after it ended.
 */
export const PASSING_LAYERS: ReadonlySet<string> = new Set(["blink", "gaze", "viseme"]);
export type ChangeSource = "ui" | "tween" | "layer";
type ChangeListener = (target: string, value: number, source: ChangeSource) => void;

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

export class MorphStore implements LimitStore {
  /** Slider layer. GSAP tweens this object directly (see quickTo / tweenTo). */
  readonly base: Weights = {};
  readonly defaults: Weights = {};
  readonly ranges: Record<string, [number, number]> = {};
  /** What the mesh may show per target: the slider's ends, never tighter than −1 … +1 (two-sided targets). */
  private readonly showRange: Record<string, [number, number]> = {};
  /** Animation layer → how much of it this face allows (0..1, limits.ts caps); missing = 1. */
  private readonly layerScale = new Map<string, number>();
  readonly kinds: Record<string, SliderDef["kind"]> = {};
  private readonly layers = new Map<string, Weights>();
  private readonly bindings = new Map<string, Binding[]>();
  private readonly changeListeners = new Set<ChangeListener>();
  private readonly settleListeners = new Set<() => void>();
  private readonly quickSetters = new Map<string, (value: number) => void>();
  private settleTimer: ReturnType<typeof setTimeout> | null = null;
  private settleQueued = false;
  /**
   * Bumped whenever the face's shape may have changed (a slider, a tween, an emotion blend). Head.tsx refreshes the
   * normals and eye pivots live while it moves, so nothing jumps when the change settles. The lip-sync and blink layers
   * don't bump it: per-frame normals while speaking would cost CPU for no visible gain.
   */
  shapeVersion = 0;
  /** Mix sliders: slider → the weights it spreads over real targets; and real target → the mixes using it. */
  private readonly combos = new Map<string, { pos: Weights; neg: Weights | null }>();
  private readonly comboUsers = new Map<string, string[]>();
  /** Fine-tune controls: the share of each side's spread this face allows now ([negative, positive], fxReach.ts). */
  private readonly comboReach = new Map<string, [number, number]>();

  /** Call once with the slider definitions (targets, ranges, defaults). */
  configure(defs: SliderDef[]): void {
    for (const d of defs) {
      if (d.kind === "pose") continue; // pose sliders rotate nodes (lib/pose.ts), they are not morph targets
      this.base[d.target] = d.default;
      this.defaults[d.target] = d.default;
      this.ranges[d.target] = [d.min, d.max];
      this.showRange[d.target] = d.min < 0 && d.max > 0 ? [Math.min(d.min, -1), Math.max(d.max, 1)] : [d.min, d.max];
      this.kinds[d.target] = d.kind;
      if (d.combo) {
        this.combos.set(d.target, { pos: d.combo, neg: d.comboNeg ?? null });
        for (const t of new Set([...Object.keys(d.combo), ...Object.keys(d.comboNeg ?? {})])) {
          this.comboUsers.set(t, [...(this.comboUsers.get(t) ?? []), d.target]);
        }
      }
    }
    for (const s of this.combos.keys()) this.apply(s);
  }

  /** Register a mesh from the .glb; its morphTargetDictionary maps target names to indices. */
  bind(mesh: Mesh): void {
    const dict = mesh.morphTargetDictionary;
    if (!dict || !mesh.morphTargetInfluences) return;
    for (const [name, index] of Object.entries(dict)) {
      const list = this.bindings.get(name) ?? [];
      list.push({ mesh, index });
      this.bindings.set(name, list);
    }
    this.applyAll();
  }

  /** Forget one mesh (a hair cap being swapped out); the other meshes keep their bindings. */
  unbind(mesh: Mesh): void {
    for (const [name, list] of this.bindings) {
      const kept = list.filter((b) => b.mesh !== mesh);
      if (kept.length) this.bindings.set(name, kept);
      else this.bindings.delete(name);
    }
  }

  unbindAll(): void {
    this.bindings.clear();
    for (const setter of this.quickSetters.values()) gsap.killTweensOf(setter);
    this.quickSetters.clear();
  }

  /** Configured targets only. (GSAP adds a hidden `_gsap` cache to `base`, so never enumerate it.) */
  targets(): string[] {
    return Object.keys(this.ranges);
  }

  /** Debug helper: the influence currently on the GPU for a target (first bound mesh). */
  influence(target: string): number | undefined {
    const b = this.bindings.get(target)?.[0];
    return b?.mesh.morphTargetInfluences?.[b.index];
  }

  /**
   * Slider value plus every layer (animation layers eased by the limiter), clamped to what the mesh may show.
   * `skip`: layers to leave out, e.g. PASSING_LAYERS for the shape the face holds.
   */
  effective(target: string, skip?: ReadonlySet<string>): number {
    let v = this.base[target] ?? 0;
    for (const [name, layer] of this.layers) {
      if (skip?.has(name)) continue;
      const x = layer[target];
      if (x) v += REST_LAYERS.has(name) ? x : x * (this.layerScale.get(name) ?? 1);
    }
    const [lo, hi] = this.showRange[target] ?? [-1, 1];
    return clamp(v, lo, hi);
  }

  /** The mix behind a mix slider as it is spread now (limits.ts): a fine-tune control's reach applied. */
  comboOf(slider: string) {
    const c = this.combos.get(slider);
    const r = this.comboReach.get(slider);
    if (!c || !r) return c;
    const scaled = (w: Weights, k: number) => Object.fromEntries(Object.entries(w).map(([t, v]) => [t, v * k]));
    // one-sided mixes (no neg) reverse pos below zero: as a neg mix that is −pos, scaled by the negative side's reach
    return { pos: scaled(c.pos, r[1]), neg: scaled(c.neg ?? c.pos, c.neg ? r[0] : -r[0]) };
  }

  /** fxReach.ts: how much of a mix slider's spread each side may use now; re-spreads it when that changed. */
  setComboReach(slider: string, reach: [number, number]): void {
    const r = this.comboReach.get(slider);
    if (r && Math.abs(r[0] - reach[0]) < 1e-4 && Math.abs(r[1] - reach[1]) < 1e-4) return;
    this.comboReach.set(slider, reach);
    limiter.changed(slider);
    this.apply(slider);
    this.shapeVersion++;
  }

  /** What the sliders ask for, before the animation layers: the slider itself plus every mix slider using it. */
  userValue(target: string): number {
    return (this.base[target] ?? 0) + (this.layers.get(COMBO_LAYER)?.[target] ?? 0);
  }

  /** Per-face caps on the animation layers (lib/morphs/animCaps.ts): re-applies the layers whose scale changed. */
  setLayerScales(scales: Record<string, number>): void {
    for (const [name, s] of Object.entries(scales)) {
      if ((this.layerScale.get(name) ?? 1) === s) continue;
      this.layerScale.set(name, s);
      for (const t of Object.keys(this.layers.get(name) ?? {})) this.apply(t);
    }
  }

  /** A layer's raw value for a target (before its cap). */
  layerValue(layer: string, target: string): number {
    return this.layers.get(layer)?.[target] ?? 0;
  }

  /** emotion.ts sets this: the share of the emotion's mouth part kept while speaking (animCaps reads it back). */
  emotionGain = 1;

  layerScales(): Record<string, number> {
    return Object.fromEntries(this.layerScale);
  }

  apply(target: string): void {
    const combo = this.combos.get(target);
    if (combo) {
      // a mix slider: recompute the combo layer of every target it touches
      for (const t of new Set([...Object.keys(combo.pos), ...Object.keys(combo.neg ?? {})])) {
        let v = 0;
        for (const s of this.comboUsers.get(t)!) {
          const { pos, neg } = this.combos.get(s)!;
          const x = this.base[s] ?? 0;
          const r = this.comboReach.get(s);
          const k = r ? r[x < 0 ? 0 : 1] : 1;
          v += k * (x < 0 && neg ? -x * (neg[t] ?? 0) : x * (pos[t] ?? 0));
        }
        this.setLayerValue(COMBO_LAYER, t, v);
      }
      return;
    }
    const v = this.effective(target);
    const list = this.bindings.get(target);
    if (!list) return;
    for (const b of list) b.mesh.morphTargetInfluences![b.index] = v;
  }

  applyAll(): void {
    for (const t of this.bindings.keys()) this.apply(t);
  }

  // --- slider layer ------------------------------------------------------------------------

  /** Immediate set (no easing). */
  set(target: string, value: number, source: ChangeSource = "ui"): void {
    this.base[target] = value;
    this.apply(target);
    this.notify(target, value, source);
    this.scheduleSettle();
  }

  /**
   * Eased setter for slider drags: gsap.quickTo retargets one tween per slider, so dragging
   * feels smooth and costs no allocations. Duration and ease: lib/motion.ts MOTION.follow.
   */
  quickTo(target: string): (value: number) => void {
    let setter = this.quickSetters.get(target);
    if (!setter) {
      setter = gsap.quickTo(this.base, target, {
        duration: MOTION.follow,
        ease: MOTION.ease.follow,
        onUpdate: () => {
          this.apply(target);
          this.notify(target, this.base[target], "ui");
          this.scheduleSettle();
        },
      });
      this.quickSetters.set(target, setter);
    }
    return setter;
  }

  /** Animate many sliders at once (random face, reset). Returns the GSAP tween. */
  tweenTo(weights: Weights, duration = MOTION.morph, ease = MOTION.ease.morph): gsap.core.Tween {
    const targets = Object.keys(weights);
    return gsap.to(this.base, {
      ...weights,
      duration,
      ease,
      overwrite: "auto",
      onUpdate: () => {
        for (const t of targets) {
          this.apply(t);
          this.notify(t, this.base[t], "tween");
        }
      },
      onComplete: () => this.settleNow(),
    });
  }

  reset(duration = MOTION.morph): gsap.core.Tween {
    return this.tweenTo({ ...this.defaults }, duration);
  }

  snapshot(): Weights {
    const out: Weights = {};
    for (const t of this.targets()) out[t] = this.base[t] ?? 0;
    return out;
  }

  // --- additive layers (blink, visemes) ---------------------------------------------------

  setLayerValue(layer: string, target: string, value: number): void {
    let l = this.layers.get(layer);
    if (!l) {
      l = {};
      this.layers.set(layer, l);
    }
    if (l[target] === value) return;
    l[target] = value;
    this.apply(target);
  }

  clearLayer(layer: string): void {
    const l = this.layers.get(layer);
    if (!l) return;
    this.layers.delete(layer);
    for (const t of Object.keys(l)) this.apply(t);
  }

  // --- listeners ---------------------------------------------------------------------------

  /** UI sync: the slider panel updates its DOM inputs from here (no React state). */
  onChange(fn: ChangeListener): () => void {
    this.changeListeners.add(fn);
    return () => this.changeListeners.delete(fn);
  }

  /** Fires ~120 ms after the last slider change or at the end of a tween: normals + pivots. */
  onSettle(fn: () => void): () => void {
    this.settleListeners.add(fn);
    return () => this.settleListeners.delete(fn);
  }

  /**
   * Settle before the next frame, once however many tweens land together (a Random character's face, emotion and
   * intensity end on the same frame: each settle recomputes the whole head's normals), after they have all written
   * their last values.
   */
  settleNow(): void {
    if (this.settleTimer) clearTimeout(this.settleTimer);
    this.settleTimer = null;
    if (this.settleQueued) return;
    this.settleQueued = true;
    queueMicrotask(() => {
      this.settleQueued = false;
      for (const fn of this.settleListeners) fn();
    });
  }

  private notify(target: string, value: number, source: ChangeSource): void {
    this.shapeVersion++;
    limiter.changed(target); // a slider's cached limits hold only while the other sliders stay where they are
    for (const fn of this.changeListeners) fn(target, value, source);
  }

  /** The shape changed outside the slider layer (emotion blends): see shapeVersion. */
  markShapeChanged(): void {
    this.shapeVersion++;
  }

  private scheduleSettle(): void {
    if (this.settleTimer) clearTimeout(this.settleTimer);
    this.settleTimer = setTimeout(() => this.settleNow(), 120);
  }
}

/** App-wide singleton. */
export const morphs = new MorphStore();
