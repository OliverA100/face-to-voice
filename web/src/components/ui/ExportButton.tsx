"use client";

/**
 * "Download character": once a voice is ready, the face and the voice as one zip (lib/export/files.ts). Everything is
 * built in the browser from what the tab already has, so it costs no credits or server time; the export code loads
 * only on the first click.
 */
import { useState } from "react";

import { Alert } from "@/components/ui/Alert";
import { BusySwap, afterEntrance } from "@/components/ui/Spinner";
import { Status } from "@/components/ui/Status";
import type { DesignResult, SelectResult } from "@/lib/voice/client";

export function ExportButton({ design, selection, chosen }: { design: DesignResult; selection: SelectResult; chosen: number | null }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [said, setSaid] = useState({ message: "", count: 0 });

  const download = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    setSaid((s) => ({ message: "Packing your character…", count: s.count + 1 }));
    try {
      await afterEntrance(); // the spinner starts growing (on the compositor) before the packing holds the page
      const { buildExport } = await import("@/lib/export/files");
      // The take the saved voice came from: the server's record wins (another visitor may have saved this voice first).
      const take = selection.chosenIndex ?? design.chosenIndex ?? chosen ?? 0;
      const { blob, filename } = await buildExport({ design, take, studioFallback: !selection.saved || design.studioFallback });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      document.body.append(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
      setSaid((s) => ({ message: `Downloaded ${filename}.`, count: s.count + 1 }));
    } catch (e) {
      console.error("[export]", e);
      setError("Couldn't build the download. Please try again.");
      setSaid((s) => ({ message: "", count: s.count + 1 })); // the Alert says it
    } finally {
      setBusy(false);
    }
  };

  // Its own row after the Speak loop (a gap, not a line: the panel has none): what you get on the left, the action on
  // the right, lined up with Speak.
  return (
    <div className="mt-3 flex flex-col gap-2">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="text-label text-ink">Your character</p>
          <p className="text-meta text-ink-3">Portrait, voice and licence</p>
        </div>
        <button
          type="button"
          onClick={download}
          aria-disabled={busy} // not disabled: the keyboard focus stays on it while it packs
          aria-busy={busy}
          aria-label="Download character"
          className="pill-secondary grid h-8 min-w-28 shrink-0 px-3 text-label"
        >
          {/* busy: the spinner in place of the arrow and label, like every busy pill (the status line says "Packing…") */}
          <BusySwap busy={busy}>
            <span className="flex items-center gap-1.5">
              <DownloadIcon />
              Download
            </span>
          </BusySwap>
        </button>
      </div>
      {error && <Alert>{error}</Alert>}
      <Status message={said.message} count={said.count} />
    </div>
  );
}

function DownloadIcon() {
  return (
    <svg viewBox="0 0 16 16" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M8 2.5v8M4.5 7 8 10.5 11.5 7M3 13.5h10" />
    </svg>
  );
}
