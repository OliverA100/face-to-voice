/**
 * Marks a panel that scrolls inside itself with whether there is more to scroll: `data-more-top` once it has scrolled
 * down, `data-more-bottom` while there is more below. The panel's `.edge-fades` class (globals.css) fades its top and
 * bottom edges in on those, so it's clear there's more. Checked on scroll and whenever the panel or its content changes
 * size (a group opening, a step changing); at most once a frame. A panel that doesn't scroll (below lg, where the page
 * scrolls instead) gets neither.
 */
import { type RefObject, useEffect } from "react";

export function useScrollEdges(ref: RefObject<HTMLElement | null>) {
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    let frame = 0;
    const update = () => {
      frame = 0;
      el.toggleAttribute("data-more-top", el.scrollTop > 1);
      el.toggleAttribute("data-more-bottom", el.scrollTop + el.clientHeight < el.scrollHeight - 1);
    };
    const later = () => {
      frame ||= requestAnimationFrame(update);
    };
    // the panel and each of its children: content growing or shrinking changes what there is to scroll
    const ro = new ResizeObserver(later);
    const watch = () => {
      ro.disconnect();
      ro.observe(el);
      for (const child of el.children) ro.observe(child);
      later();
    };
    const mo = new MutationObserver(watch);
    mo.observe(el, { childList: true });
    el.addEventListener("scroll", later, { passive: true });
    watch();
    return () => {
      cancelAnimationFrame(frame);
      ro.disconnect();
      mo.disconnect();
      el.removeEventListener("scroll", later);
    };
  }, [ref]);
}
