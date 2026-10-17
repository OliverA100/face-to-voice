"use client";

/** Preset lines + a short custom line; Speak streams the voice and drives the mouth. */
import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";

import { Alert } from "@/components/ui/Alert";
import { RadioGroup } from "@/components/ui/RadioGroup";
import { Status } from "@/components/ui/Status";
import { paintRange, speakRange } from "@/components/ui/panel/rangeFill";
import { currentEmotion } from "@/lib/emotion";
import { isLimitError } from "@/lib/limits/open";
import { speechPlayer, type PlayerState } from "@/lib/lipsync/player";
import { perf } from "@/lib/perf";
import { NETWORK_MESSAGE } from "@/lib/voice/client";

const PRESET_LINES = [
  "Hello there. I'm the face you just made, and this is what I sound like.",
  "Now give me a new expression and play this again. Happy, sad, terrified… I'll sound exactly how I look.",
  "Type over this and I'll say whatever you like: a poem, a pun, or a perfectly preposterous tongue twister.",
  "Want to know who I really am? Press Meet for my name and my story. Then we can have a proper chat.",
];
const MAX_CHARS = 300;

/**
 * `take`: the preview the voice came from (each take is its own saved voice; server: selectPreview). `onRetired`: the
 * server retired that voice (410), with the message to show; the panel goes back to the takes.
 */
export function SpeakBar({ descKey, take, onRetired }: { descKey: string; take?: number | null; onRetired?: (message: string) => void }) {
  const [text, setText] = useState(PRESET_LINES[0]);
  const [state, setState] = useState<PlayerState>(speechPlayer.state);
  const [error, setError] = useState<{ message: string; limits?: boolean } | null>(null);
  const [showSync, setShowSync] = useState(false);
  const lineIds = useId();
  const box = useRef<HTMLTextAreaElement>(null);

  // The box grows with its line instead of scrolling: two rows at least, and refitted when its width changes (the
  // window, or the card's scrollbar while the card eases to a new height). Only the width: its own height changes too.
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    const fit = () => {
      el.style.height = "auto";
      el.style.height = `${el.scrollHeight}px`;
    };
    fit();
    let width = el.clientWidth;
    const watch = new ResizeObserver(() => {
      if (el.clientWidth === width) return;
      width = el.clientWidth;
      fit();
    });
    watch.observe(el);
    return () => watch.disconnect();
  }, [text]);

  useEffect(() => {
    const fn = () => setState(speechPlayer.state);
    speechPlayer.listeners.add(fn);
    return () => {
      speechPlayer.listeners.delete(fn);
    };
  }, []);

  const active = state === "loading" || state === "playing"; // the pill is Stop meanwhile
  const speak = () => {
    setError(null);
    const line = text.trim().slice(0, MAX_CHARS);
    if (!line) {
      setError({ message: "Type a line for the voice to say first." });
      return;
    }
    // unlock() runs synchronously inside the tap (iOS autoplay rule) before the fetch.
    speechPlayer
      .speak(async (signal) => {
        const res = await fetch("/api/voice/speak", { signal, method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ descKey, ...(take != null ? { take } : {}), text: line, ...currentEmotion() }) });
        if (res.status === 410 && onRetired) {
          const { message } = (await res.clone().json().catch(() => ({}))) as { message?: string };
          setTimeout(() => onRetired(message ?? "This voice was removed to make room for newer ones. Choose it again to bring it back."), 0); // after the player has settled
        }
        return res;
      })
      .then(() => {
        perf.speakFirstAudibleMs = speechPlayer.metrics.firstAudibleMs;
      })
      // A server reply carries a code and a message written for visitors; anything else is the browser's own wording
      // for a dropped connection ("Failed to fetch", "Load failed").
      .catch((e: unknown) => setError({ message: e instanceof Error && "code" in e ? e.message : NETWORK_MESSAGE, limits: isLimitError(e) }));
  };

  return (
    <div className="flex flex-col gap-3">
      {/* Preset lines as small chips; the chosen one fills with ink like the emotion pills (.pill-choice). One Tab stop, the
          arrows move and choose (RadioGroup); each chip's description is its line. */}
      <RadioGroup label="Preset lines" className="flex flex-wrap gap-2">
        {PRESET_LINES.map((line, i) => (
          <button
            key={i}
            type="button"
            role="radio"
            aria-checked={text === line}
            aria-describedby={`${lineIds}-${i}`}
            onClick={() => setText(line)}
            className="pill-secondary pill-choice h-8 px-3 text-label"
          >
            Line {i + 1}
            <span id={`${lineIds}-${i}`} hidden>
              {line}
            </span>
          </button>
        ))}
      </RadioGroup>
      {/* The textarea is its own tray: no border box, just the surface colour. */}
      <textarea
        ref={box}
        value={text}
        maxLength={MAX_CHARS}
        onChange={(e) => setText(e.target.value)}
        rows={2}
        aria-label="Text to speak"
        placeholder="Type a line for the voice to say"
        className="w-full resize-none overflow-hidden rounded-tray bg-surface px-4 py-3 text-input text-ink placeholder:text-ink-3"
      />
      <div className="flex items-center justify-between gap-2">
        <span className="text-label tabular-nums text-ink-3">
          {state === "loading" ? "Generating…" : state === "playing" ? "Speaking…" : `${text.trim().length}/${MAX_CHARS}`}
        </span>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => setShowSync((v) => !v)}
            aria-expanded={showSync}
            // hover as the breadcrumb links: grey → ink, no underline; ink while the sync slider is open
            className={`min-h-8 px-2 text-label transition-colors ${showSync ? "text-ink" : "text-ink-3 hover:text-ink"}`}
          >
            Sync
          </button>
          {/* One pill: Speak, and Stop while a line is generated or plays (the counter says which). Same element and
              width, so the keyboard focus stays on it and nothing beside it moves. */}
          <button
            type="button"
            onClick={active ? () => speechPlayer.stop() : speak}
            aria-keyshortcuts={active ? "Escape" : undefined}
            data-step-focus
            className="pill-secondary h-10 min-w-21 px-5"
          >
            {active ? "Stop" : "Speak"}
          </button>
        </div>
      </div>
      {showSync && <SyncControl />}
      {error && <Alert limits={error.limits}>{error.message}</Alert>}
      {/* The speaking state for screen readers (the counter above changes on every key, so it is not a live region). */}
      <Status message={state === "loading" ? "Generating the line…" : state === "playing" ? "Speaking." : state === "done" ? "Finished speaking." : ""} />
    </div>
  );
}

/**
 * Browsers only know the latency of the audio device they can see; a monitor's HDMI speakers,
 * Bluetooth headphones or a TV add more, and the mouth then runs ahead of the sound. The listener
 * sets the difference once here; it is kept in localStorage (see SpeechPlayer.syncDelayMs).
 * Rendered only after a click, so the stored value never takes part in server rendering.
 */
function SyncControl() {
  const [ms, setMs] = useState(() => speechPlayer.syncDelayMs);
  return (
    <div className="enter flex flex-col gap-1 text-label text-ink-3">
      <p>Lips ahead of the sound? Slide right. Behind it? Slide left.</p>
      <div className="flex items-center gap-3">
        <input
          type="range"
          min={-200}
          max={300}
          step={10}
          value={ms}
          onChange={(e) => {
            const v = Number(e.target.value);
            setMs(v);
            speechPlayer.syncDelayMs = v;
          }}
          aria-label="Lip sync offset"
          ref={(el) => {
            if (!el) return;
            speakRange(el, (v) => `${v} milliseconds${v > 0 ? ", the mouth later" : v < 0 ? ", the mouth earlier" : ""}`);
            paintRange(el);
          }}
          className="range range-mid"
        />
        <output aria-hidden className="w-14 shrink-0 text-right text-meta tabular-nums text-ink">{ms > 0 ? `+${ms}` : ms} ms</output>
      </div>
    </div>
  );
}
