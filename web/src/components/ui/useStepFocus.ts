import { type RefObject, useEffect } from "react";

/**
 * Keyboard focus never falls off the card: when the focused control goes away (Use voice, a breadcrumb that became
 * the current step, the first-run Find my voice, Chat, End), focus moves to the nearest control that takes over
 * ([data-step-focus]): in what is left of the control's surroundings first, else in the card. It waits for one to
 * appear (a recast profile is a skeleton at first). Only then: focus that left the card on purpose (a click
 * elsewhere) stays where it went.
 */
export function useStepFocus(card: RefObject<HTMLElement | null>): void {
  useEffect(() => {
    const el = card.current;
    if (!el) return;
    let focused: Element[] = []; // the focused control and its ancestors in the card, from when it had focus
    let lost: Element[] | null = null; // … once it lost focus to nothing (removed, or a click on blank space)
    const onIn = (e: FocusEvent) => {
      focused = [];
      for (let n = e.target as Element | null; n && n !== el; n = n.parentElement) focused.push(n);
      lost = null;
    };
    const onOut = (e: FocusEvent) => {
      const forget = () => {
        lost = null;
        focused = [];
      };
      if (e.relatedTarget) {
        if (!el.contains(e.relatedTarget as Node)) forget();
        return;
      }
      lost = focused;
      // focus put down on purpose (a tap on the head or the page): the control is still there, and focus stays put
      queueMicrotask(() => (e.target as Element).isConnected && forget());
    };
    const restore = () => {
      const active = document.activeElement;
      // (a browser that sends no focusout for a removed control: it is gone and nothing has focus)
      const from = lost ?? (focused[0] && !focused[0].isConnected ? focused : null);
      if (!from?.length || from[0].isConnected || (active && active !== document.body)) return; // still there, or the visitor moved on
      for (const scope of [...from.slice(1).filter((n) => n.isConnected), el]) {
        const next = scope.querySelector<HTMLElement>("[data-step-focus]");
        if (!next) continue;
        // Not scrolled to after a tap or click: a new step shows from its top (scrollVoiceCardTop), and its first
        // control can sit below the fold on a phone. After keyboard use the focus shows (:focus-visible), so it is
        // brought into view.
        next.focus({ preventScroll: true });
        if (next.matches(":focus-visible")) next.scrollIntoView({ block: "nearest" });
        return;
      }
    };
    const watch = new MutationObserver(restore);
    watch.observe(el, { childList: true, subtree: true, attributes: true, attributeFilter: ["data-step-focus"] });
    el.addEventListener("focusin", onIn);
    el.addEventListener("focusout", onOut);
    return () => {
      watch.disconnect();
      el.removeEventListener("focusin", onIn);
      el.removeEventListener("focusout", onOut);
    };
  }, [card]);
}
