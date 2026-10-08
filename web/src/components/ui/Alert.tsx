import type { ReactNode } from "react";

/** Error message: a white row with a hairline ring and a small mark, so it never looks like an input. */
export function Alert({ children }: { children: ReactNode }) {
  return (
    <p role="alert" className="enter flex items-start gap-2 rounded-tray bg-card p-3 text-label text-danger shadow-hairline">
      <svg viewBox="0 0 16 16" aria-hidden className="mt-[3px] size-3 shrink-0" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round">
        <circle cx="8" cy="8" r="6.25" />
        <path d="M8 5v3.5M8 11h.01" />
      </svg>
      <span>{children}</span>
    </p>
  );
}
