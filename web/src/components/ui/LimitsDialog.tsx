"use client";

/**
 * "Today's limits": what this browser has used of its own daily limits (voices picked), why, and a countdown to
 * midnight UTC, when they reset. A browser without the visitor cookie is counted with its whole network
 * (lib/server/visitor.ts), and a network that reached its ceiling shows as paused even with picks left. Opened from
 * the header's Limits button and from any limit error's "See your limits" (lib/limits/open.ts). A native <dialog>: Escape, the backdrop and the
 * page behind made inert come with it. Asks GET /api/limits each time it opens (asking counts nothing).
 *
 * Focus: it opens on its title (mostly text to read: the title is announced, and nothing shows a ring; the native first
 * button, Close, showed one in Safari, which never focuses a clicked button and so took it for keyboard focus). Tab and
 * Shift+Tab go round its own controls and never leave it (the native dialog let Tab out to the page and the browser,
 * and Safari's Tab skips buttons unless asked). Closing gives focus back to what opened it.
 */
import { useEffect, useRef, useState } from "react";

import { useScrollEdges } from "@/components/ui/useScrollEdges";

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
  const paused = !out && row.network.used >= row.network.limit; // picks left, but the network's ceiling is reached
  const share = row.limit ? Math.min(1, row.used / row.limit) : 0;
  return (
    <li className="flex flex-col gap-1">
      <div className="flex items-baseline justify-between gap-3 text-label">
        <span className="text-ink first-letter:uppercase">{row.label}</span>
        <span className={out || paused ? "text-danger" : "text-ink-3"}>
          {out ? "used up · " : paused ? "paused on your network · " : ""}
          {row.used.toLocaleString()} of {row.limit.toLocaleString()}
        </span>
      </div>
      <div aria-hidden className="h-1 overflow-hidden rounded-full bg-track">
        <div className={`h-full rounded-full ${out ? "bg-danger" : "bg-fill"}`} style={{ width: `${share * 100}%` }} />
      </div>
    </li>
  );
}

/** The dialog's controls, in order (Close, and Try again when the limits didn't load). */
const controls = (dialog: HTMLElement) => [...dialog.querySelectorAll<HTMLElement>('button, a[href], input, [tabindex]:not([tabindex="-1"])')].filter((el) => !el.matches(":disabled"));

export function LimitsDialog() {
  const ref = useRef<HTMLDialogElement>(null);
  const title = useRef<HTMLHeadingElement>(null);
  const opener = useRef<HTMLElement | null>(null); // focus goes back here on close
  const body = useRef<HTMLDivElement>(null); // scrolls on short screens: its edges fade while there's more (.edge-fades)
  useScrollEdges(body);
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
        const from = document.activeElement;
        opener.current = from instanceof HTMLElement && from !== document.body ? from : null;
        ref.current?.showModal();
        title.current?.focus(); // (after showModal, which focused Close)
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
  const picks = limits?.yours.find((row) => row.id === "select"); // the numbers in the note under the rows

  return (
    <dialog
      ref={ref}
      aria-labelledby="limits-title"
      onClose={() => {
        setOpen(false);
        if (opener.current?.isConnected) opener.current.focus();
        opener.current = null;
      }}
      onKeyDown={(e) => {
        // the trap: Tab and Shift+Tab go round the dialog's own controls (from the title, to the first or the last)
        if (e.key !== "Tab" || !ref.current) return;
        const items = controls(ref.current);
        if (!items.length) return;
        e.preventDefault();
        const i = items.indexOf(document.activeElement as HTMLElement);
        const next = e.shiftKey ? (i <= 0 ? items.length - 1 : i - 1) : i < 0 || i === items.length - 1 ? 0 : i + 1;
        items[next].focus();
      }}
      // a click on the backdrop lands on the dialog itself, outside its padding box's content
      onClick={(e) => e.target === e.currentTarget && close()}
      // dialog-in (globals.css): it fades in and rises into place as it opens, its backdrop fading in with it
      className="dialog-in m-auto w-[calc(100%-32px)] max-w-[420px] rounded-card bg-card p-0 text-ink shadow-float backdrop:bg-black/25"
    >
      <div ref={body} className="edge-fades flex max-h-[calc(100dvh-64px)] flex-col gap-4 overflow-y-auto p-5 [--fade-inset:--spacing(5)]">
        <div className="flex items-start justify-between gap-3">
          {/* focused on open (tabIndex -1: not a Tab stop), with no ring: it isn't a control */}
          <h2 ref={title} id="limits-title" tabIndex={-1} className="display text-[20px] outline-none">
            Today’s limits
          </h2>
          <button type="button" onClick={close} className="pill-secondary -mr-1 -mt-1 h-8 px-3 text-label">
            Close
          </button>
        </div>

        <p className="text-label text-ink-2">
          Speaking, chatting and finding voices have no limits. Picking a voice makes a new voice at ElevenLabs, which
          has room for only so many, so each browser can pick a few a day.
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
              <p className="text-meta text-ink-3">
                {limits.per === "browser" ? (
                  <>
                    {picks?.limit ?? 10} a day on this browser, counted with a cookie that holds only a random id. Each network can pick{" "}
                    {picks?.network.limit ?? 30} a day in all, so a very busy Wi-Fi can run out sooner.
                  </>
                ) : (
                  "This browser isn’t keeping cookies, so these are counted per network connection: people on the same Wi-Fi share them."
                )}
              </p>
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
