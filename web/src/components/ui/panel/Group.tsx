/**
 * Building blocks of the slider panel: a tab's hint line, a titled block of rows and a collapsible group.
 * No lines between them: spacing and soft surface fills do the separating. Tokens: app/tokens.css.
 */
import type { ReactNode } from "react";

/** The one-line hint at the top of a tab: quiet text, no band. */
export function Hint({ children }: { children: ReactNode }) {
  return <p className="px-5 pt-1 text-label text-ink-3">{children}</p>;
}

/** Section label of a block (Colouring, Features …), also used for the Pose groups. */
export const blockTitle = "text-label font-medium tracking-[0.01em] text-ink-3";

/** A titled block inside a tab (Colouring, Hair, Fine-tune …): a small label, then its rows. */
export function Block({ title, note, children }: { title: string; note?: ReactNode; children: ReactNode }) {
  return (
    <section aria-label={title} className="pt-5">
      <h3 className={`px-5 ${blockTitle}`}>
        {title}
        {note && <span className="font-normal text-ink-4"> · {note}</span>}
      </h3>
      <div className="pt-1">{children}</div>
    </section>
  );
}

/** Right-pointing chevron that turns down when its <details> opens (pass the group's open: variant). */
export function Chevron({ className }: { className: string }) {
  return (
    <svg
      viewBox="0 0 16 16"
      aria-hidden
      className={`size-4 shrink-0 text-ink-4 transition-transform duration-(--dur-3) ease-(--ease-in-out-soft) ${className}`}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M6 4l4 4-4 4" />
    </svg>
  );
}

/** One collapsible group: an inset row (label, muted count, chevron) that eases open (details.disclose, globals.css). */
export function Group({ label, count, open = false, children }: { label: string; count?: number; open?: boolean; children: ReactNode }) {
  return (
    <details open={open} className="disclose group">
      <summary className="mx-3 flex cursor-pointer list-none select-none items-center justify-between gap-3 rounded-row px-2 py-2.5 text-body text-ink transition-colors hover:bg-surface [&::-webkit-details-marker]:hidden">
        <span className="flex items-baseline gap-2">
          {label}
          {count !== undefined && (
            <span className="text-meta tabular-nums text-ink-4">
              {count}
              <span className="sr-only"> sliders</span>
            </span>
          )}
        </span>
        <Chevron className="group-open:rotate-90" />
      </summary>
      {children}
    </details>
  );
}
