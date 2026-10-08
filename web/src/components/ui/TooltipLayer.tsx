"use client";

/**
 * The app's one tooltip, the same everywhere ): any element with `data-tip="…"` shows it, a
 * soft warm-grey chip (--surface, a hairline, 13 px --ink-2 text, the list rows' radius, at most 288 px wide: a short
 * hint stays on one line), in place of the browser's own `title` tooltip, which can't be styled. Mounted once
 * (app/layout.tsx), and only one tooltip exists at a time, made when it shows: the ~230 hair swatches cost nothing.
 *
 * - Hover: after 300 ms (passing over doesn't flash it); moving straight on to another hint switches at once.
 *   Keyboard focus: at once. Gone on leaving, a press, scrolling or Escape. Not on touch (as with `title`).
 * - The pointer can move from the element onto the hint (and read it) without it going (WCAG 1.4.13): it stays while
 *   the pointer is over the element, the hint or the gap between them. It still lets clicks through to what is under it.
 * - Fixed to the viewport, below the element (a slider row: below its track), or above it when there is no room, kept
 *   8 px inside the edges: inside a scrolling panel (the voice card, the slider panel) a positioned hint would be cut off.
 * - It is visual only. Name or describe the element itself for screen readers (an aria-label on a swatch,
 *   aria-describedby on a pill).
 * - Works on an aria-disabled pill (no pointer events) when `data-tip` sits on a wrapper around it.
 * - While its hint is up, the element has `data-tip-shown`: what the hint covers (a slider's end labels, marked
 *   `data-tip-under`) fades out instead of peeking out from under it (globals.css).
 */
import { useEffect, useLayoutEffect, useRef, useState } from "react";

const TOOLTIP = {
  delayMs: 300, // hover → shown
  gap: 8, // px between the element and the tooltip
  sliderGap: 7, // … or a slider's track box: a slider row's hint hangs from the track, not the whole row (below its end
  // labels it would sit 24 px from the slider, further than every other hint); 7 px from the 20 px box is 8 px from the
  // 18 px thumb, the same as everywhere. It covers the end labels while shown and goes on a press
  edge: 8, // px kept from the viewport's edges
};

type Shown = { text: string; anchor: Element };

export function TooltipLayer() {
  const [shown, setShown] = useState<Shown | null>(null);
  const tip = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number; above: boolean } | null>(null);

  useEffect(() => {
    let timer = 0;
    let current: Element | null = null;
    let open = false; // a tooltip is up: the next hover shows at once
    let marked: Element | null = null; // the element whose hint is up: data-tip-shown (globals.css hides what it covers)
    const mark = (el: Element | null) => {
      marked?.removeAttribute("data-tip-shown");
      marked = el;
      el?.setAttribute("data-tip-shown", "");
    };
    const tipOf = (t: EventTarget | null) => (t instanceof Element ? t.closest("[data-tip]") : null);
    // Over the element, its hint or the gap between them (the box around both): the hint stays.
    const near = (x: number, y: number) => {
      const t = document.querySelector("[data-app-tooltip]")?.getBoundingClientRect();
      const a = current?.getBoundingClientRect();
      if (!t || !a) return false;
      return x >= Math.min(t.left, a.left) && x <= Math.max(t.right, a.right) && y >= Math.min(t.top, a.top) && y <= Math.max(t.bottom, a.bottom);
    };
    const show = (el: Element) => {
      const text = el.getAttribute("data-tip");
      if (!text) return;
      current = el;
      open = true;
      mark(el);
      setShown({ text, anchor: el });
    };
    const hide = () => {
      clearTimeout(timer);
      current = null;
      open = false;
      mark(null);
      setShown(null);
    };
    const over = (e: PointerEvent) => {
      if (e.pointerType === "touch") return;
      const el = tipOf(e.target);
      if (el === current) return;
      clearTimeout(timer);
      if (!el) return void (open && !near(e.clientX, e.clientY) && hide());
      current = el;
      if (open) show(el);
      else timer = window.setTimeout(() => show(el), TOOLTIP.delayMs);
    };
    const out = (e: PointerEvent) => {
      if (!current || tipOf(e.relatedTarget) === current) return;
      if (tipOf(e.relatedTarget)) return; // onto another hint's element: over() switches to it
      if (open && near(e.clientX, e.clientY)) return; // on its way to the hint: move() hides it once it leaves both
      hide();
    };
    // On the hint (it takes no pointer events) or the gap: it goes once the pointer leaves the box around both.
    const move = (e: PointerEvent) => {
      if (open && current && tipOf(e.target) !== current && !tipOf(e.target) && !near(e.clientX, e.clientY)) hide();
    };
    const focus = (e: FocusEvent) => {
      const el = tipOf(e.target);
      if (el && e.target instanceof Element && e.target.matches(":focus-visible")) show(el);
    };
    const blur = (e: FocusEvent) => {
      if (current && tipOf(e.target) === current) hide();
    };
    const key = (e: KeyboardEvent) => e.key === "Escape" && current && hide();
    document.addEventListener("pointerover", over);
    document.addEventListener("pointerout", out);
    document.addEventListener("pointermove", move, { passive: true });
    document.addEventListener("pointerdown", hide);
    document.addEventListener("focusin", focus);
    document.addEventListener("focusout", blur);
    document.addEventListener("keydown", key);
    window.addEventListener("scroll", hide, { capture: true, passive: true });
    return () => {
      clearTimeout(timer);
      mark(null);
      document.removeEventListener("pointerover", over);
      document.removeEventListener("pointerout", out);
      document.removeEventListener("pointermove", move);
      document.removeEventListener("pointerdown", hide);
      document.removeEventListener("focusin", focus);
      document.removeEventListener("focusout", blur);
      document.removeEventListener("keydown", key);
      window.removeEventListener("scroll", hide, { capture: true });
    };
  }, []);

  // Placed once it has rendered (its size is needed), before the browser paints it.
  useLayoutEffect(() => {
    if (!shown || !tip.current) return setPos(null);
    const track = shown.anchor.querySelector("input[type=range]");
    const a = (track ?? shown.anchor).getBoundingClientRect();
    const t = tip.current.getBoundingClientRect();
    const { edge } = TOOLTIP;
    const gap = track ? TOOLTIP.sliderGap : TOOLTIP.gap;
    const above = a.bottom + gap + t.height > window.innerHeight - edge && a.top - gap - t.height >= edge;
    const left = Math.min(Math.max(a.left + a.width / 2 - t.width / 2, edge), window.innerWidth - edge - t.width);
    setPos({ left, top: above ? a.top - gap - t.height : a.bottom + gap, above });
  }, [shown]);

  if (!shown) return null;
  return (
    <div
      ref={tip}
      role="tooltip"
      data-app-tooltip
      // measured invisible first, then placed and faded in (globals.css tooltip-in: from 4 px towards the element)
      className={`pointer-events-none fixed z-50 max-w-72 rounded-row bg-surface px-3 py-2 text-label text-ink-2 shadow-hairline ${pos ? "tooltip-in" : "invisible"}`}
      style={pos ? { left: pos.left, top: pos.top, ["--tip-from" as string]: pos.above ? "4px" : "-4px" } : { left: 0, top: 0 }}
    >
      {shown.text}
    </div>
  );
}
