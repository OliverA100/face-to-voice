/**
 * A box that eases to its new height when its content changes (the voice card between its steps), like the panel's
 * groups opening (--dur-3 + --ease-in-out-soft, read from app/tokens.css, so reduced motion turns it off).
 *
 * `outer` is the box (its height is animated), `inner` wraps its content (watched). A ResizeObserver sees the content
 * change after layout and before paint, so the box starts from the height it had: no frame at the new size first. A
 * change mid-animation starts from wherever the box is. Width changes (window resize, rotation) are not animated.
 * The animation is a Web Animation on `height` (layout on a small box for --dur-3), cleared at the end: the box is
 * back to its natural height and its own overflow rules.
 */
import { type RefObject, useEffect } from "react";

/** A CSS time as milliseconds ("400ms", or ".4s" once the build has minified it). */
const toMs = (v: string) => {
  const t = v.trim();
  return t.endsWith("ms") ? parseFloat(t) : parseFloat(t) * 1000;
};

export function useHeightTransition(outer: RefObject<HTMLElement | null>, inner: RefObject<HTMLElement | null>) {
  useEffect(() => {
    const box = outer.current;
    const content = inner.current;
    if (!box || !content) return;
    let last = box.getBoundingClientRect().height;
    let width = content.offsetWidth;
    let anim: Animation | null = null;
    const overflow = () => box.style.removeProperty("overflow-y");

    const ro = new ResizeObserver(() => {
      const shown = anim ? box.getBoundingClientRect().height : last; // mid-animation: where it is now
      anim?.cancel();
      anim = null;
      const to = box.getBoundingClientRect().height; // the natural height with the new content
      const w = content.offsetWidth;
      const resized = w !== width;
      width = w;
      last = to;
      if (resized || Math.abs(to - shown) < 1) return;
      const css = getComputedStyle(document.documentElement);
      const ms = toMs(css.getPropertyValue("--dur-3")); // 400; ~0 with reduced motion
      if (!(ms > 1)) return;
      box.style.overflowY = "clip"; // the content may be taller than the box for a moment: no scrollbar flash
      anim = box.animate([{ height: `${shown}px` }, { height: `${to}px` }], { duration: ms, easing: css.getPropertyValue("--ease-in-out-soft").trim() || "ease" });
      anim.onfinish = () => {
        anim = null;
        overflow();
      };
      anim.oncancel = overflow;
    });
    ro.observe(content);
    return () => {
      ro.disconnect();
      anim?.cancel();
    };
  }, [outer, inner]);
}
