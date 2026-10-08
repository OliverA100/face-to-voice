"use client";

/**
 * The face panel: a title, a sticky tab bar (pinned to the screen's bottom on phones) and one tab at a time.
 *   Shape       Random face, Age, one group per feature (the semantic sliders), raw GNM sliders (Advanced)
 *   Style       skin and eye colour, hair, brows, lashes, facial hair, glasses
 *   Expression  emotion buttons + intensity, fine-tune sliders
 *   Pose        head turn, bend, tilt and gaze; look at cursor
 *
 * Every tab stays mounted (hidden ones get `hidden`): the sliders are uncontrolled, so unmounting one
 * would reset it to its default on the way back. Every morph slider writes straight into the morph
 * store (panel/SliderRow.tsx), so React never re-renders while dragging. When the store changes for
 * another reason (random face, reset) the inputs are synced from a store listener, again without state.
 */
import { type KeyboardEvent, useEffect, useLayoutEffect, useRef, useState } from "react";

import { EmotionSection } from "@/components/ui/panel/EmotionSection";
import { PoseSection } from "@/components/ui/panel/PoseSection";
import { ShapeSection } from "@/components/ui/panel/ShapeSection";
import { setRange } from "@/components/ui/panel/rangeFill";
import { fmt, type RowRefs, syncRow } from "@/components/ui/panel/SliderRow";
import { StyleSection } from "@/components/ui/panel/StyleSection";
import { morphs } from "@/lib/morphs/store";
import { sliderFor, toUi } from "@/lib/morphs/travel";

const TABS = [
  { id: "shape", label: "Shape" },
  { id: "style", label: "Style" },
  { id: "expression", label: "Expression" },
  { id: "pose", label: "Pose" },
] as const;
type TabId = (typeof TABS)[number]["id"];

export function SliderPanel() {
  // Stable maps of DOM nodes (created once; never trigger a render).
  const [refs] = useState<RowRefs>(() => ({ inputs: new Map(), outputs: new Map() }));
  const [tab, setTab] = useState<TabId>("shape");
  const bar = useRef<HTMLDivElement>(null);
  const body = useRef<HTMLDivElement>(null);
  const sentinel = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const marker = useRef<HTMLSpanElement>(null);

  // The white marker sits under the chosen tab. Tabs are as wide as their label plus the same padding on every
  // tab, so the marker is measured: it slides on a tab change, and jumps (no animation) on first paint and resize.
  // data-ready on the list hands the white pill from the chosen button (server render) to the marker.
  const placeMarker = (animate: boolean) => {
    const l = list.current;
    const m = marker.current;
    const t = l?.querySelector<HTMLElement>('[aria-selected="true"]');
    if (!l || !m || !t) return;
    if (!animate) m.style.transition = "none";
    m.style.width = `${t.offsetWidth}px`;
    m.style.transform = `translateX(${t.offsetLeft}px)`;
    if (!animate) {
      void m.offsetWidth; // commit the jump before transitions come back
      m.style.transition = "";
    }
    l.setAttribute("data-ready", "");
  };
  useLayoutEffect(() => placeMarker(Boolean(list.current?.hasAttribute("data-ready"))), [tab]);
  useEffect(() => {
    const l = list.current;
    if (!l) return;
    const ro = new ResizeObserver(() => placeMarker(false));
    ro.observe(l);
    return () => ro.disconnect();
  }, []);

  // The tray's float shadow shows only once content scrolls under it (data-stuck; no React state).
  useEffect(() => {
    const s = sentinel.current;
    const b = bar.current;
    if (!s || !b) return;
    const io = new IntersectionObserver(([e]) => {
      b.toggleAttribute("data-stuck", !e.isIntersecting && e.boundingClientRect.top < b.getBoundingClientRect().bottom);
    });
    io.observe(s);
    return () => io.disconnect();
  }, []);

  useEffect(() => {
    const sync = (target: string, value: number) => {
      const def = sliderFor(target);
      const u = def ? toUi(def, value) : value; // store weights -> thumb positions (lib/morphs/travel.ts)
      const input = refs.inputs.get(target);
      if (input) {
        setRange(input, u);
        syncRow(input, u);
      }
      const out = refs.outputs.get(target);
      if (out) out.textContent = fmt(u);
    };
    // the inputs render at the defaults; a face restored after a reload (lib/faceSession.ts) is already in the store
    for (const target of refs.inputs.keys()) if (morphs.base[target] !== morphs.defaults[target]) sync(target, morphs.base[target]);
    return morphs.onChange((target, value, source) => {
      if (source !== "ui") sync(target, value); // the input itself is the source of truth while dragging
    });
  }, [refs]);

  const choose = (id: TabId) => {
    // The new tab's content fades in, sliding a few px from the side its tab is on (tab-in in globals.css).
    // The first visit to the page doesn't animate: data-switched only appears after a tab change.
    const b0 = body.current;
    if (b0 && id !== tab) {
      b0.style.setProperty("--tab-dir", String(Math.sign(TABS.findIndex((x) => x.id === id) - TABS.findIndex((x) => x.id === tab))));
      b0.setAttribute("data-switched", "");
    }
    setTab(id);
    // If the old tab was scrolled past its top, start the new one at its top (just below the bar where it sits on top).
    const b = body.current;
    const t = bar.current;
    if (b && t && t.hasAttribute("data-stuck")) {
      b.style.scrollMarginTop = getComputedStyle(t).top === "auto" ? "0px" : `${t.offsetHeight}px`;
      b.scrollIntoView({ block: "start" });
    }
  };

  // Arrow keys move between tabs, Home / End go to the first / last (the WAI-ARIA tabs pattern); only the chosen tab is
  // in the Tab order.
  const onKey = (e: KeyboardEvent) => {
    const at = TABS.findIndex((x) => x.id === tab);
    const to = e.key === "ArrowRight" ? at + 1 : e.key === "ArrowLeft" ? at - 1 : e.key === "Home" ? 0 : e.key === "End" ? TABS.length - 1 : null;
    if (to === null) return;
    e.preventDefault();
    const next = TABS[(to + TABS.length) % TABS.length].id;
    choose(next);
    document.getElementById(`tab-${next}`)?.focus();
  };

  // Below lg the whole column scrolls (FaceBuilder); from lg the panel scrolls inside its card.
  return (
    <div className="no-scrollbar relative flex flex-col rounded-card bg-card text-ink lg:h-full lg:overflow-y-auto">
      <header className="px-5 pt-5">
        <h2 className="display text-title">Shape the face</h2>
      </header>
      <div ref={sentinel} aria-hidden className="h-px" />
      {/* Segmented tray: one white marker slides under the chosen tab (placeMarker). The tray floats over the tab as it
          scrolls: the bar itself has no background and lets clicks through, so only the pill covers the content.
          Phones (below md): the bar comes last (order-last) and sticks to the bottom of the screen, in thumb reach, while the panel is in view. */}
      <div ref={bar} className="pointer-events-none sticky z-10 px-5 py-3 max-md:order-last max-md:bottom-0 md:top-0">
        <div ref={list} className="pointer-events-auto relative flex rounded-full bg-surface p-1 transition-shadow duration-(--dur-2) max-md:shadow-float md:in-data-stuck:shadow-float" role="tablist" aria-label="Face controls" onKeyDown={onKey}>
          <span ref={marker} aria-hidden className="absolute inset-y-1 left-0 w-0 rounded-full bg-card shadow-control transition-[transform,width] duration-(--dur-2) ease-soft" />
          {TABS.map((t) => (
            <button
              key={t.id}
              id={`tab-${t.id}`}
              type="button"
              role="tab"
              aria-selected={tab === t.id}
              aria-controls={`tabpanel-${t.id}`}
              tabIndex={tab === t.id ? 0 : -1}
              onClick={() => choose(t.id)}
              className={`relative h-8 flex-auto rounded-full px-3 text-label transition-colors ${
                tab === t.id ? "bg-card text-ink shadow-control in-data-ready:bg-transparent in-data-ready:shadow-none" : "text-ink-3 hover:text-ink"
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>
      </div>
      <div ref={body} className="pb-4">
        {TABS.map((t) => (
          <div key={t.id} id={`tabpanel-${t.id}`} role="tabpanel" aria-labelledby={`tab-${t.id}`} hidden={tab !== t.id}>
            {t.id === "shape" && <ShapeSection refs={refs} />}
            {t.id === "style" && <StyleSection />}
            {t.id === "expression" && <EmotionSection refs={refs} />}
            {t.id === "pose" && <PoseSection />}
          </div>
        ))}
      </div>
    </div>
  );
}
