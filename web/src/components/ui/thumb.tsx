/**
 * The round style thumbnails of the hair and add-on rows (Style tab). Their images fade in once loaded
 * (`.thumb img[data-loaded]` in app/globals.css).
 */

/**
 * Spread onto the <img>: onLoad marks it, and the ref marks an image that was already loaded (cached) before
 * React attached the handler.
 */
export const thumbImg = {
  onLoad: (e: { currentTarget: HTMLImageElement }) => {
    e.currentTarget.dataset.loaded = "";
  },
  ref: (el: HTMLImageElement | null) => {
    if (el?.complete && el.naturalWidth) el.dataset.loaded = "";
  },
};

/** A thumbnail button's classes (role="radio", .choice ring); `pulse` while its piece is downloading. */
export const thumbClass = (selected: boolean, pulse: boolean) =>
  `choice thumb relative size-11 shrink-0 rounded-full shadow-control transition-shadow ${selected ? "" : "hover:shadow-control-hover"} ${pulse ? "animate-pulse" : ""}`;

/** The "None" thumbnail's mark: an empty outlined circle with a faint slash. */
export function NoneMark() {
  return (
    <svg viewBox="0 0 44 44" aria-hidden className="absolute inset-0 size-full text-ink-4" fill="none" stroke="currentColor" strokeWidth={1.25} strokeLinecap="round">
      <path d="M14 30L30 14" />
    </svg>
  );
}
