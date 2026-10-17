import { type RefObject, useEffect } from "react";

type El = RefObject<HTMLElement | null>;
/** The sentinel just before the sticky element, the element, and (for a short card) a sentinel at its end. */
type Pair = [sentinel: El, sticky: El, end?: El];

/** How far above its bottom edge a card's end sentinel sits (its padding), and how tall the stuck cap's plate is
 *  (globals.css .tabs-cap::after: the radius plus the 24px fade): the cap lets go before its plate passes the card. */
const END_INSET = 20;
const PLATE = 48;

/**
 * Sets `data-stuck` on each sticky element once content scrolls under it (no React state), from the sentinel placed
 * just before it: the sentinel counts as gone once it passes the element's sticky top (globals.css .tabs-bar and
 * .tabs-cap paint their plates only while stuck). With an end sentinel, it lets go again once less of the card than
 * the plate is left under the sticky top, so the plate never hangs below the card. Watched again on resize, as the
 * sticky tops change with the layout.
 */
export function useStuck(...pairs: Pair[]): void {
  useEffect(() => {
    let ios: IntersectionObserver[] = [];
    const watch = () => {
      ios.forEach((io) => io.disconnect());
      ios = [];
      for (const [s, sticky, end] of pairs) {
        const el = sticky.current;
        if (!s.current || !el) continue;
        let started = false;
        let ended = false;
        const set = () => el.toggleAttribute("data-stuck", started && !ended);
        const top = stickyTop(el);
        const start = new IntersectionObserver(
          ([e]) => {
            started = !e.isIntersecting && e.boundingClientRect.top < el.getBoundingClientRect().bottom;
            set();
          },
          { rootMargin: `${-top}px 0px 0px 0px` },
        );
        start.observe(s.current);
        ios.push(start);
        if (end?.current) {
          const stop = new IntersectionObserver(
            ([e]) => {
              ended = !e.isIntersecting && e.boundingClientRect.top < top + PLATE - END_INSET;
              set();
            },
            { rootMargin: `${-(top + PLATE - END_INSET)}px 0px 0px 0px` },
          );
          stop.observe(end.current);
          ios.push(stop);
        }
      }
    };
    watch();
    window.addEventListener("resize", watch);
    return () => {
      window.removeEventListener("resize", watch);
      ios.forEach((io) => io.disconnect());
    };
    // the refs are stable; the elements are read once they are mounted
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}

/** Where a sticky element sticks, in px from the top of its scroller (0 when it has no top). */
export function stickyTop(el: HTMLElement): number {
  return parseFloat(getComputedStyle(el).top) || 0;
}
