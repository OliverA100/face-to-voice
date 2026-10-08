"use client";

/**
 * The viseme tuner. The head is the normal scene; the chosen preset is applied through the
 * `viseme` morph layer at full strength, and the sliders below edit that preset's weights
 * (not the face). "Copy JSON" puts the whole visemes.json on the clipboard with tuned: true; its note is kept.
 */
import { useEffect, useMemo, useRef, useState } from "react";

import { FaceCanvas } from "@/components/scene/FaceCanvas";
import { sliders, visemes as initial, type Weights } from "@/lib/data";
import { VISEME_IDS } from "@/lib/lipsync/cues";
import { morphs } from "@/lib/morphs/store";

morphs.configure(sliders.sliders);

type Doc = typeof initial & { tuned?: boolean }; // plus the file's version and note, carried through untouched
const ROLES = ["blinkLeft", "blinkRight", "jawOpen", "pupils"] as const;
type Key = { kind: "viseme"; id: string } | { kind: "role"; id: (typeof ROLES)[number] };

const mouthSliders = sliders.sliders.filter((s) => s.kind === "expression");

/** Dotted divider between slider rows (globals.css --line-dotted). */
const dotted = "border-dotted border-[#d9d5d0]";

export default function VisemeTuner() {
  const [doc, setDoc] = useState<Doc>(() => structuredClone(initial) as Doc);
  const [key, setKey] = useState<Key>({ kind: "viseme", id: "aa" });
  const [copied, setCopied] = useState(false);
  const preset: Weights = useMemo(() => (key.kind === "viseme" ? (doc.visemes[key.id.toLowerCase()] ?? {}) : doc.roles[key.id]), [doc, key]);
  const applied = useRef<string[]>([]);

  // Show the current preset on the head (layer "viseme"), clearing targets that dropped out.
  useEffect(() => {
    for (const t of applied.current) if (!(t in preset)) morphs.setLayerValue("viseme", t, 0);
    for (const [t, w] of Object.entries(preset)) morphs.setLayerValue("viseme", t, w);
    applied.current = Object.keys(preset);
  }, [preset]);
  useEffect(() => () => morphs.clearLayer("viseme"), []);

  const setWeight = (target: string, value: number) => {
    setDoc((d) => {
      const next = structuredClone(d) as Doc;
      const p: Weights = key.kind === "viseme" ? (next.visemes[key.id.toLowerCase()] ??= {}) : next.roles[key.id];
      if (Math.abs(value) < 0.005) delete p[target];
      else p[target] = Math.round(value * 100) / 100;
      return next;
    });
  };

  const copy = async () => {
    const out = { ...doc, tuned: true };
    await navigator.clipboard.writeText(JSON.stringify(out, null, 2) + "\n");
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  // Selected preset = black pill, the rest = quiet surface pills.
  const chip = (active: boolean) => `${active ? "pill-primary" : "pill-ghost"} h-8 px-3 text-[13px]`;

  return (
    <div className="flex h-dvh w-dvw flex-col bg-page text-ink">
      <header className="flex h-14 shrink-0 items-center justify-between px-4 md:px-5">
        <div className="flex items-baseline gap-3">
          <h1 className="text-[15px] font-medium tracking-[-0.01em]">Face to Voice</h1>
          <p className="hidden text-[13px] text-ink-3 sm:block">/dev/visemes — tune a mouth shape, then paste the JSON into src/data/visemes.json.</p>
        </div>
        <button type="button" onClick={copy} className="pill-primary h-9 px-3.5 text-[13px]">
          {copied ? "Copied!" : "Copy JSON"}
        </button>
      </header>

      <main className="grid min-h-0 flex-1 grid-rows-[50dvh_1fr] gap-3 px-3 pb-3 md:grid-cols-[1fr_380px] md:grid-rows-1 md:px-5 md:pb-5">
        <section className="relative min-h-0 overflow-hidden rounded-3xl bg-surface shadow-hairline" aria-label="The face">
          <FaceCanvas />
        </section>

        <aside className="card flex min-h-0 flex-col overflow-hidden" aria-label="Mouth shape tuner">
          <div className="shrink-0 px-5 pt-5">
            <p className="text-[13px] text-ink-3">Mouth shape</p>
            <h2 className="display mt-1 flex items-baseline gap-3 text-[28px]">
              {key.id}
              <span className="font-normal text-[13px] tracking-normal text-ink-3">
                {Object.keys(preset).length} {Object.keys(preset).length === 1 ? "component" : "components"}
              </span>
            </h2>
            <div className="mt-4 flex flex-wrap gap-1.5">
              {VISEME_IDS.map((v) => (
                <button key={v} type="button" onClick={() => setKey({ kind: "viseme", id: v })} className={chip(key.kind === "viseme" && key.id === v)}>
                  {v}
                </button>
              ))}
            </div>
            <div className="mt-2 flex flex-wrap gap-1.5">
              {ROLES.map((r) => (
                <button key={r} type="button" onClick={() => setKey({ kind: "role", id: r })} className={chip(key.kind === "role" && key.id === r)}>
                  {r}
                </button>
              ))}
            </div>
          </div>

          <div className="mt-4 min-h-0 flex-1 overflow-y-auto px-5 pb-3">
            {mouthSliders.map((s) => {
              const value = preset[s.target] ?? 0;
              return (
                <label key={s.id} className={`block border-t ${dotted} py-2`} title={s.description}>
                  <span className="flex items-baseline justify-between gap-3 leading-[18px]">
                    <span className={`truncate text-[13px] ${value ? "text-ink" : "text-ink-2"}`}>{s.name}</span>
                    <span className="shrink-0 font-mono text-[12px] tabular-nums text-ink-3">{value ? (value > 0 ? "+" : "") + value.toFixed(2) : "–"}</span>
                  </span>
                  <input type="range" min={s.min} max={s.max} step={0.01} value={value} onChange={(e) => setWeight(s.target, e.currentTarget.valueAsNumber)} className="range" />
                </label>
              );
            })}
          </div>
        </aside>
      </main>
    </div>
  );
}
