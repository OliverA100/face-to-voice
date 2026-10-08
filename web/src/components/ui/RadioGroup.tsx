"use client";

/**
 * A row of role="radio" buttons (emotions, hair filters and styles, swatches, add-ons, Line chips) with the WAI-ARIA
 * radio group keyboard: the group is ONE Tab stop (the chosen radio, or the first when none is chosen in view), and the
 * arrow keys move to the next or previous radio and choose it (Home / End: the first / last). Disabled radios are
 * skipped. Renders the role="radiogroup" <div>; the radios inside need no extra props.
 *
 * The roving tabindex is written on the DOM by a MutationObserver watching aria-checked, so nothing re-renders.
 */
import { type KeyboardEvent, type ReactNode, useLayoutEffect, useRef } from "react";

const radiosIn = (group: HTMLElement) => [...group.querySelectorAll<HTMLButtonElement>('[role="radio"]')].filter((r) => !r.disabled);

/** The Tab stop: the radio the visitor is on (mid-arrow), else the chosen one, else the first. */
function rove(group: HTMLElement) {
  const enabled = radiosIn(group);
  const focused = enabled.find((r) => r === document.activeElement);
  const stop = focused ?? enabled.find((r) => r.getAttribute("aria-checked") === "true") ?? enabled[0];
  for (const r of group.querySelectorAll<HTMLElement>('[role="radio"]')) r.tabIndex = r === stop ? 0 : -1;
}

export function RadioGroup({ label, className, children }: { label: string; className?: string; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const group = ref.current;
    if (!group) return;
    rove(group);
    const mo = new MutationObserver(() => rove(group));
    mo.observe(group, { subtree: true, childList: true, attributes: true, attributeFilter: ["aria-checked", "disabled"] });
    return () => mo.disconnect();
  }, []);

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.altKey || e.ctrlKey || e.metaKey) return;
    const radios = radiosIn(e.currentTarget);
    const at = radios.indexOf(e.target as HTMLButtonElement);
    if (at < 0) return;
    const n = radios.length;
    const k = e.key;
    const next = k === "ArrowRight" || k === "ArrowDown" ? (at + 1) % n : k === "ArrowLeft" || k === "ArrowUp" ? (at - 1 + n) % n : k === "Home" ? 0 : k === "End" ? n - 1 : -1;
    if (next < 0) return;
    e.preventDefault();
    const r = radios[next];
    for (const x of radios) x.tabIndex = x === r ? 0 : -1;
    r.focus();
    if (r.getAttribute("aria-checked") !== "true") r.click();
  };

  return (
    <div ref={ref} role="radiogroup" aria-label={label} className={className} onKeyDown={onKeyDown}>
      {children}
    </div>
  );
}
