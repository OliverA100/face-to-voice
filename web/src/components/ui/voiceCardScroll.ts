import { reducedMotion } from "@/lib/reducedMotion";

/**
 * The voice card back to its top, so a step (or a recast profile) is seen from its start: on large screens the card
 * scrolls inside itself; below lg the page scrolls, and the card's top comes back just under the sticky header and head
 * (its scroll-margin-top, globals.css). Only when the top is out of sight: a card already showing its top stays put.
 */
export function scrollVoiceCardTop(card: Element | null): void {
  if (!(card instanceof HTMLElement)) return;
  const behavior: ScrollBehavior = reducedMotion.on ? "auto" : "smooth";
  if (card.scrollTop > 0) card.scrollTo({ top: 0, behavior });
  const margin = parseFloat(getComputedStyle(card).scrollMarginTop) || 0;
  if (card.getBoundingClientRect().top < margin - 1) card.scrollIntoView({ block: "start", behavior });
}
