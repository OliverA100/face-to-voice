"use client";

/**
 * "Today's limits": what this visitor has used of their own daily limits, what the whole site has used of its daily
 * budget, why both exist, and a countdown to midnight UTC, when both reset. Opened from the header's Limits button
 * and from any limit error's "See your limits" (lib/limits/open.ts). A native <dialog>: focus, Escape and the
 * backdrop come with it. Asks GET /api/limits each time it opens (asking counts nothing).
 */
import { useEffect, useRef, useState } from "react";

import { onOpenLimits, openLimits } from "@/lib/limits/open";
import type { LimitRow, Limits } from "@/lib/limits/types";

/** "4 h 12 min", "12 min 5 s", "40 s" */
function left(ms: number): string {
  const s = Math.max(0, Math.ceil(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h) return `${h} h ${m} min`;
  if (m) return `${m} min ${s % 60} s`;
  return `${s} s`;
}

function Row({ row }: { row: LimitRow }) {
  const out = row.used >= row.limit;
  const share = row.limit ? Math.min(1, row.used / row.limit) : 0;
  return (
    <li className="flex flex-col gap-1">
      <div className="flex items-baseline justify-between gap-3 text-label">
        <span className="text-ink first-letter:uppercase">{row.label}</span>
        <span className={out ? "text-danger" : "text-ink-3"}>
          {out ? "used up · " : ""}
          {row.used.toLocaleString()} of {row.limit.toLocaleString()}
        </span>
      </div>
      <div aria-hidden className="h-1 overflow-hidden rounded-full bg-track">
        <div className={`h-full rounded-full ${out ? "bg-danger" : "bg-fill"}`} style={{ width: `${share * 100}%` }} />
      </div>
    </li>
  );
}

export function LimitsDialog() {
  const ref = useRef<HTMLDialogElement>(null);
  const [limits, setLimits] = useState<Limits | null>(null);
  const [failed, setFailed] = useState(false);
  const [open, setOpen] = useState(false);
  const [now, setNow] = useState(() => Date.now());

  const load = () => {
    setFailed(false);
    fetch("/api/limits", { cache: "no-store" })
      .then((res) => (res.ok ? (res.json() as Promise<Limits>) : Promise.reject(new Error(String(res.status)))))
      .then(setLimits)
      .catch(() => setFailed(true));
  };

  useEffect(
    () =>
      onOpenLimits(() => {
        if (ref.current?.open) return;
        ref.current?.showModal();
        setOpen(true);
        setNow(Date.now());
        load();
      }),
    [],
  );

  // The countdown ticks while open; at midnight UTC everything resets, so ask again.
  const resetAt = limits ? Date.parse(limits.resetAt) : 0;
  useEffect(() => {
    if (!open) return;
    const id = setInterval(() => {
      const t = Date.now();
      setNow(t);
      if (resetAt && t >= resetAt) {
        setLimits(null); // once: the next one is asked when the new day's limits arrive
        load();
      }
    }, 1000);
    return () => clearInterval(id);
  }, [open, resetAt]);

  const close = () => ref.current?.close();
  const localTime = resetAt ? new Date(resetAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) : "";

  return (
    <dialog
      ref={ref}
      aria-labelledby="limits-title"
      onClose={() => setOpen(false)}
      // a click on the backdrop lands on the dialog itself, outside its padding box's content
      onClick={(e) => e.target === e.currentTarget && close()}
      className="m-auto w-[calc(100%-32px)] max-w-[420px] rounded-card bg-card p-0 text-ink shadow-float backdrop:bg-black/25"
    >
      <div className="flex max-h-[calc(100dvh-64px)] flex-col gap-4 overflow-y-auto p-5">
        <div className="flex items-start justify-between gap-3">
          <h2 id="limits-title" className="display text-[20px]">
            Today’s limits
          </h2>
          <button type="button" onClick={close} className="pill-secondary -mr-1 -mt-1 h-8 px-3 text-label">
            Close
          </button>
        </div>

        <p className="text-label text-ink-2">
          Every voice, line, profile and chat here calls paid services (Claude by Anthropic, and ElevenLabs). The demo is
          free, so each visitor gets a daily allowance, and the whole site has a daily budget that everyone shares. They
          keep it running, and fair for everyone.
        </p>

        <p className="rounded-tray bg-surface px-3 py-2 text-label text-ink" aria-live="off">
          {limits ? (
            <>
              Everything resets in <span className="font-medium tabular-nums">{left(resetAt - now)}</span>
              <span className="text-ink-3">
                {" "}
                · midnight UTC ({localTime} your time)
              </span>
            </>
          ) : (
            "Everything resets at midnight UTC."
          )}
        </p>

        {failed ? (
          <p className="text-label text-danger">
            Couldn’t load your limits.{" "}
            <button type="button" onClick={load} className="text-ink underline underline-offset-2 hover:text-ink-hover">
              Try again
            </button>
          </p>
        ) : !limits ? (
          <p className="text-label text-ink-3">Loading…</p>
        ) : (
          <>
            <section aria-labelledby="limits-yours" className="flex flex-col gap-2">
              <h3 id="limits-yours" className="text-label font-medium text-ink">
                Yours
              </h3>
              <ul className="flex flex-col gap-3">
                {limits.yours.map((row) => (
                  <Row key={row.id} row={row} />
                ))}
              </ul>
              <p className="text-meta text-ink-3">Counted per network connection, so people on the same Wi-Fi share them.</p>
            </section>
            <section aria-labelledby="limits-site" className="flex flex-col gap-2">
              <h3 id="limits-site" className="text-label font-medium text-ink">
                The whole site
              </h3>
              <ul className="flex flex-col gap-3">
                {limits.site.map((row) => (
                  <Row key={row.id} row={row} />
                ))}
              </ul>
              <p className="text-meta text-ink-3">When one of these runs out, that step pauses for everyone until the reset.</p>
            </section>
          </>
        )}
      </div>
    </dialog>
  );
}

/** The header's button: opens the dialog (mounted once, here). */
export function LimitsButton() {
  return (
    <>
      <button type="button" onClick={openLimits} className="pill-secondary h-8 px-3 text-label sm:h-9 sm:px-4 sm:text-body">
        Limits
      </button>
      <LimitsDialog />
    </>
  );
}
