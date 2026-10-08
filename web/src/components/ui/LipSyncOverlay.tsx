"use client";

/**
 * ?lipsync=1 — a timeline of viseme cues with a playhead on the same clock the mouth uses,
 * plus latency numbers. If the mouth and the sound disagree, this shows which side is off.
 */
import { useEffect, useRef } from "react";

import { VISEME_IDS } from "@/lib/lipsync/cues";
import { speechPlayer } from "@/lib/lipsync/player";
import { lipsyncState } from "@/lib/lipsync/state";

/** Canvas paint, spelled out because a 2D context can't read Tailwind classes (row and label match app/tokens.css). */
const PAINT = {
  row: "#f5f3f1", // --surface
  label: "#746e66", // --ink-3
  cue: (activation: number) => `rgba(0, 0, 0, ${(0.2 + 0.8 * activation).toFixed(3)})`,
  playhead: "#dc2626", // red-600
};

export function LipSyncOverlay() {
  const canvas = useRef<HTMLCanvasElement>(null);
  const pre = useRef<HTMLPreElement>(null);
  const wrap = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (new URLSearchParams(window.location.search).get("lipsync") !== "1" || !wrap.current) return;
    wrap.current.hidden = false;
    // The canvas inherits font-mono from the card; read it once so the labels use the same face.
    const font = `10px ${canvas.current ? getComputedStyle(canvas.current).fontFamily : "monospace"}`;
    let raf = 0;
    const draw = () => {
      raf = requestAnimationFrame(draw);
      const c = canvas.current;
      if (!c) return;
      const ctx = c.getContext("2d")!;
      const W = c.width, H = c.height;
      ctx.clearRect(0, 0, W, H);
      const cues = speechPlayer.cues;
      const end = Math.max(1, ...cues.map((q) => q.end));
      const row = H / VISEME_IDS.length;
      const x = (t: number) => (t / end) * W;
      ctx.font = font;
      VISEME_IDS.forEach((v, i) => {
        ctx.fillStyle = PAINT.row;
        ctx.fillRect(0, i * row, W, row - 1);
        const a = lipsyncState.activations[v];
        for (const q of cues) {
          if (q.viseme !== v) continue;
          ctx.fillStyle = PAINT.cue(a);
          ctx.fillRect(x(q.start), i * row + 1, Math.max(1, x(q.end) - x(q.start)), row - 3);
        }
        ctx.fillStyle = PAINT.label;
        ctx.fillText(v, 4, i * row + row - 3);
      });
      const t = lipsyncState.clipTime;
      if (t >= 0) {
        ctx.fillStyle = PAINT.playhead;
        ctx.fillRect(x(t), 0, 1.5, H);
      }
      if (pre.current) {
        const m = speechPlayer.metrics;
        pre.current.textContent =
          `state ${speechPlayer.state}  t ${t >= 0 ? t.toFixed(2) : "-"} s  cues ${cues.length}\n` +
          `tap→first byte ${m.firstByteMs ?? "-"} ms  tap→scheduled ${m.firstScheduledMs ?? "-"} ms  tap→audible ${m.firstAudibleMs ?? "-"} ms\n` +
          `output latency ${m.outputLatencyMs} ms  sample rate ${m.sampleRate}  underruns ${m.underruns}  mouth lead ${lipsyncState.leadMs} ms (?lipsyncOffsetMs=)  sync delay ${speechPlayer.syncDelayMs} ms (?syncMs=)`;
      }
    };
    draw();
    return () => cancelAnimationFrame(raf);
  }, []);

  return (
    <div
      ref={wrap}
      hidden
      className="pointer-events-none absolute right-5 top-42 w-[min(60vw,520px)] rounded-tray bg-card/95 p-3 font-mono text-[11px] text-ink-2 shadow-float backdrop-blur"
    >
      <pre ref={pre} className="mb-2 whitespace-pre-wrap leading-relaxed" />
      <canvas ref={canvas} width={500} height={130} className="block w-full rounded-lg" />
    </div>
  );
}
