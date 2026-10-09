"use client";

/**
 * Face → voice. This is ordinary React UI (a handful of state changes per session), kept
 * separate from the render loop. Flow: "Find my voice" (screenshot + sliders → Claude casts the
 * character, gender included → ElevenLabs previews) → listen → "Use voice" (saves it to the ElevenLabs account; the button reads "Setting up…").
 *
 * Looks like the voice list in ElevenLabs' text-to-speech page: a white card with a step
 * breadcrumb, a light headline while idle, and preview rows where the orb is the play
 * button and a white "Use voice" pill sits at the end.
 * One black pill per state: "Find my voice" while idle, "Speak" once a voice is ready.
 * Tokens and pill/card classes: globals.css.
 */
import { type KeyboardEvent, useEffect, useId, useRef, useState, useSyncExternalStore } from "react";

import { captureFace } from "@/components/scene/Capture";
import { extraReady } from "@/lib/headExtra";
import { characterSettled } from "@/lib/character";
import { Alert } from "@/components/ui/Alert";
import { ExportButton } from "@/components/ui/ExportButton";
import { SpeakBar } from "@/components/ui/SpeakBar";
import { BusySwap } from "@/components/ui/Spinner";
import { Status } from "@/components/ui/Status";
import { useHeightTransition } from "@/components/ui/useHeightTransition";
import { VoiceBlob, VoiceBlobPlaceholder, usePrefetchVoiceBlobs } from "@/components/ui/VoiceBlob";
import { speechPlayer } from "@/lib/lipsync/player";
import { currentFaceSignature, requestDesign, requestSelect, VoiceApiError, type DesignResult, type Preview, type SelectResult } from "@/lib/voice/client";
import { saveVoiceSession, subscribeVoiceSession, voiceSession } from "@/lib/voice/voiceSession";

type Phase = "idle" | "designing" | "previews" | "selecting" | "ready";

const STEPS = ["Face", "Voice", "Speak"] as const;
const SAME_FACE_HINT = "Change the face to find a new voice";

/** "grizzled sea captain, masculine, in their 70s, scottish (larger than life): gruff and jovial, …; chuckles between sentences." */
function readsAs(f: DesignResult["fields"]): string {
  const heritage = f.ethnicity && f.ethnicity !== "unclear" ? `, ${f.ethnicity}` : "";
  const quirk = f.quirk ? `; ${f.quirk}` : "";
  const feeling = f.emotion && f.emotion !== "neutral" ? `${f.emotion}, ` : "";
  return (
    `${f.persona}, ${f.presentation}, in their ${f.ageRange}${heritage} (${f.character}): ${feeling}${f.mood1} and ${f.mood2}, ${f.energy} energy, ` +
    `${f.pitch} pitch, ${f.timbre} timbre, ${f.accentStrength} ${f.accent} accent${quirk}.`
  );
}

export function VoicePanel({ onVoiceReady }: { onVoiceReady?: (voiceId: string, descKey: string) => void }) {
  const [phase, setPhase] = useState<Phase>("idle");
  const [design, setDesign] = useState<DesignResult | null>(null);
  // The face the voices were designed for, and the face now (lib/voice/faceSignature.ts): the same face always gets the
  // same voices (the design cache), so "Find a new voice" waits until it changes. Checked twice a second while there is
  // a design (skin, eyes and pose have no change events; a rounding pass, well under a ms).
  const [designedFace, setDesignedFace] = useState<string | null>(null);
  const [faceNow, setFaceNow] = useState<string | null>(null);
  useEffect(() => {
    if (!designedFace) return;
    const id = setInterval(() => setFaceNow(currentFaceSignature()), 500);
    return () => clearInterval(id);
  }, [designedFace]);
  const sameFace = designedFace !== null && (faceNow === null || faceNow === designedFace);
  const hintId = useId();
  const [selection, setSelection] = useState<SelectResult | null>(null);
  const [chosen, setChosen] = useState<number | null>(null);
  const [error, setError] = useState<{ code: string; message: string } | null>(null);
  const [showPrompt, setShowPrompt] = useState(false);
  const [stage, setStage] = useState<"describe" | "design">("describe");
  // The voice step before a reload (lib/voice/voiceSession.ts): the server renders the first visit, the client then
  // picks up where this tab left off, once.
  const restored = useSyncExternalStore(subscribeVoiceSession, voiceSession, () => null);
  const [restoredOnce, setRestoredOnce] = useState(false);
  if (restored && !restoredOnce) {
    setRestoredOnce(true);
    setDesign(restored.design);
    setSelection(restored.selection);
    setChosen(restored.chosen);
    setDesignedFace(restored.designedFace);
    setPhase(restored.selection ? "ready" : "previews");
  }
  // … and kept as it changes (never cleared here: a new design replaces it)
  useEffect(() => {
    if (design) saveVoiceSession({ design, selection, chosen, designedFace });
  }, [design, selection, chosen, designedFace]);
  const card = useRef<HTMLElement>(null);
  const cardContent = useRef<HTMLDivElement>(null);
  useHeightTransition(card, cardContent);

  // Keyboard focus never falls off the card: when the focused control goes away with its step (Use voice, a breadcrumb
  // that became the current step, the first-run Find my voice), focus moves to the new step's first control
  // ([data-step-focus]). Only then: focus that left the card on purpose (a click elsewhere) stays where it went.
  const lostFocus = useRef<Node | null>(null); // the card's control that last lost focus to nothing (removed, or a click on blank space)
  useEffect(() => {
    const el = card.current;
    if (!el) return;
    const onOut = (e: FocusEvent) => {
      if (!e.relatedTarget) lostFocus.current = e.target as Node;
      else if (!el.contains(e.relatedTarget as Node)) lostFocus.current = null;
    };
    el.addEventListener("focusout", onOut);
    return () => el.removeEventListener("focusout", onOut);
  }, []);
  useEffect(() => {
    const lost = lostFocus.current;
    const active = document.activeElement;
    if (!lost || lost.isConnected || (active && active !== document.body)) return; // still there: the visitor moved on
    lostFocus.current = null;
    card.current?.querySelector<HTMLElement>("[data-step-focus]")?.focus();
  }, [phase]);

  // Escape inside the card stops whatever is playing (a preview or the spoken line).
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key !== "Escape") return;
    const audios = [...(card.current?.querySelectorAll("audio") ?? [])].filter((a) => !a.paused);
    const speaking = speechPlayer.state === "loading" || speechPlayer.state === "playing";
    if (!audios.length && !speaking) return;
    audios.forEach((a) => a.pause());
    if (speaking) speechPlayer.stop();
    e.preventDefault();
  };

  const fail = (e: unknown) => {
    if (!(e instanceof VoiceApiError)) console.error("[voice]", e);
    setError(e instanceof VoiceApiError ? { code: e.code, message: e.message } : { code: "upstream", message: "Something went wrong. Please try again." });
  };

  const findVoice = async () => {
    setError(null);
    setSelection(null);
    setChosen(null);
    setPhase("designing");
    setStage("describe");
    // Claude answers in ~3 s, ElevenLabs takes ~8 s more: switch the hint so the wait reads as progress.
    const stageTimer = setTimeout(() => setStage("design"), 3500);
    try {
      await extraReady; // the picture must show every slider: wait for head.extra.glb's targets (lib/headExtra.ts)
      await characterSettled(); // and a Random character / Reset mid-change: wait for its morph and piece fade (lib/character.ts)
      const image = captureFace();
      const face = currentFaceSignature(); // as sent with the picture
      const result = await requestDesign(image);
      clearTimeout(stageTimer);
      setDesign(result);
      setDesignedFace(face);
      setFaceNow(null);
      if (result.voiceId) {
        setSelection({ voiceId: result.voiceId, saved: !result.studioFallback, chosenIndex: result.chosenIndex ?? undefined });
        setPhase("ready");
        onVoiceReady?.(result.voiceId, result.descKey);
      } else {
        setPhase("previews");
      }
    } catch (e) {
      clearTimeout(stageTimer);
      fail(e);
      setPhase(design ? "previews" : "idle");
    }
  };

  const chooseVoice = async (index: number) => {
    if (!design) return;
    setError(null);
    setChosen(index);
    setPhase("selecting");
    try {
      const result = await requestSelect(design.descKey, index, design.previews[index]?.generatedVoiceId);
      setSelection(result);
      setPhase("ready");
      onVoiceReady?.(result.voiceId, design.descKey);
    } catch (e) {
      fail(e);
      // These previews can't become a voice any more (expired, or designed again): "Find a new voice" gets new ones,
      // even for the same face.
      if (e instanceof VoiceApiError && e.code === "expired") setDesignedFace(null);
      setPhase("previews");
    }
  };

  // The voice in use was retired while speaking (the pool made room for newer ones): back to the takes, where choosing
  // it saves it again.
  const retired = (message: string) => {
    setSelection(null);
    setError({ code: "expired", message });
    setPhase("previews");
  };

  const busy = phase === "designing" || phase === "selecting";
  const step = phase === "idle" ? 0 : phase === "ready" ? 2 : 1;
  // The take the voice in use came from (each take is its own saved voice).
  const inUse = selection ? (selection.chosenIndex ?? design?.chosenIndex ?? chosen) : null;
  // The breadcrumb walks back and forth without losing anything: Face (the face is always editable; from here "Find a
  // new voice" designs for it as it looks now), Voice (the three takes: listen again or switch), Speak (the voice).
  const reachable = [phase !== "idle", !!design, !!selection];
  const goTo = (i: number) => {
    setError(null);
    setPhase(i === 0 ? "idle" : i === 1 ? "previews" : "ready");
  };
  // First run: the big black pill sits in the footer. Later runs ("Find a new voice") are a
  // retreat, so the same button becomes a white pill at the end of the breadcrumb row.
  const firstRun = phase === "idle" || (phase === "designing" && !design);
  // What a screen reader hears as the card moves on (the error itself is an Alert).
  const said =
    phase === "designing"
      ? stage === "describe"
        ? "Reading the face…"
        : "Designing three voices…"
      : phase === "previews"
        ? "Three voices are ready. Play each one, then choose Use voice."
        : phase === "selecting" && chosen !== null
          ? `Setting up voice ${chosen + 1}…`
          : phase === "ready"
            ? "The voice is ready. Pick a line and press Speak."
            : "";
  // While designing the pill shows the spinner alone (BusySwap) over its own label, so it keeps its width (with the
  // stage in it, "Designing three voices…" would not fit beside the steps and would wrap below them); the stage is a
  // caption over the skeleton rows instead (and the pill's accessible name).
  const stageText = stage === "describe" ? "Reading the face…" : "Designing three voices…";
  const findLabel = !design ? "Find my voice" : "Find a new voice";
  // The same face: greyed out with a hint (aria-disabled, so it stays focusable and says why: the app's tooltip on a
  // wrapper, as an aria-disabled pill takes no pointer events, and a description for screen readers). Its three voices
  // are still one step back: Voice.
  const waiting = sameFace && phase !== "designing";
  const findButton = (
    <span data-tip={waiting ? SAME_FACE_HINT : undefined} className="inline-flex">
      <button
        type="button"
        onClick={() => !busy && !waiting && findVoice()}
        // designing: aria-disabled, so the focus stays on the working pill; while a voice is set up it is simply disabled
        disabled={phase === "selecting"}
        aria-disabled={phase === "designing" || waiting}
        aria-busy={phase === "designing"}
        aria-label={phase === "designing" ? stageText : undefined}
        aria-describedby={waiting ? hintId : undefined}
        data-step-focus={phase === "idle" ? "" : undefined}
        className={`grid ${firstRun ? "pill-primary h-10" : "pill-secondary h-8 px-3 text-label"} ${phase === "designing" ? "disabled:opacity-100" : ""} ${waiting ? "opacity-40" : ""}`}
      >
        <BusySwap busy={phase === "designing"}>{findLabel}</BusySwap>
      </button>
      {waiting && (
        <span id={hintId} className="sr-only">
          {SAME_FACE_HINT}
        </span>
      )}
    </span>
  );

  return (
    // The card eases to each step's height (useHeightTransition) while the step's content fades in (.enter).
    <section
      ref={card}
      aria-label="Voice"
      onKeyDown={onKeyDown}
      className="card pointer-events-auto flex w-full min-w-0 flex-col p-5 lg:w-[360px] lg:min-h-0 lg:overflow-y-auto lg:shadow-float xl:w-[392px]"
    >
      <div ref={cardContent} className="flex min-w-0 shrink-0 flex-col gap-3">
        <header className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
          {/* Step breadcrumb: the current step black, the rest muted; the steps you can go back (or forward) to are links. */}
          <nav aria-label="Steps" className="flex items-center gap-1.5 text-body">
            {STEPS.map((s, i) => (
              <span key={s} className="flex items-center gap-1.5">
                {i > 0 && (
                  <svg viewBox="0 0 16 16" aria-hidden className="size-3 text-ink-4" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round">
                    <path d="M6 4l4 4-4 4" />
                  </svg>
                )}
                {i !== step && reachable[i] && !busy ? (
                  // hover as the panel tabs (SliderPanel): grey → ink, no underline (an underline here stands out from the rest)
                  <button type="button" onClick={() => goTo(i)} className="text-ink-3 transition-colors hover:text-ink">
                    {s}
                  </button>
                ) : (
                  <span className={`transition-colors ${i === step ? "text-ink" : "text-ink-3"}`} aria-current={i === step ? "step" : undefined}>
                    {s}
                  </span>
                )}
              </span>
            ))}
          </nav>
          {!firstRun && findButton}
        </header>

        {phase === "idle" && (
          <div className="enter flex flex-col gap-1.5 py-1">
            <h2 className="display text-title text-ink md:text-[28px]">Give this face a voice</h2>
            <p className="text-body text-ink-3">ElevenLabs designs three voices from the face as it looks now. Pick the one that fits.</p>
          </div>
        )}

        {/* While designing, three skeleton rows pre-shape the card into the list it is about to become, under the stage
            it is at (a caption where the voices will appear; it fades in anew at each stage; the Status says it aloud). */}
        {phase === "designing" && (
          <div className="enter flex flex-col gap-1" aria-hidden>
            <p key={stage} className="enter text-meta text-ink-3">
              {stageText}
            </p>
            <ul className="-mx-2 flex flex-col">
              {[0, 1, 2].map((i) => (
                <li key={i} className="flex h-14 items-center gap-3 px-2">
                  <VoiceBlobPlaceholder index={i} />
                  <span className="h-3.5 w-16 animate-pulse rounded-full bg-surface" />
                </li>
              ))}
            </ul>
          </div>
        )}

        {design && phase !== "idle" && phase !== "designing" && (
          <div className="enter flex flex-col gap-1">
            <p className="text-body text-ink-2">
              <span className="text-ink-3">Reads as </span>
              {readsAs(design.fields)}
            </p>
            <button
              type="button"
              onClick={() => setShowPrompt((v) => !v)}
              aria-expanded={showPrompt}
              className="group/prompt -ml-1 inline-flex min-h-8 items-center gap-1 self-start px-1 text-label text-ink-3 transition-colors hover:text-ink"
            >
              <svg viewBox="0 0 16 16" aria-hidden className="size-3 transition-transform duration-(--dur-2) ease-soft group-aria-expanded/prompt:rotate-90" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round">
                <path d="M6 4l4 4-4 4" />
              </svg>
              {showPrompt ? "Hide" : "Show"} the voice prompt sent to ElevenLabs
            </button>
            {showPrompt && (
              <div className="enter rounded-tray bg-surface p-3 font-mono text-meta leading-relaxed text-ink-2">
                <p>{design.description}</p>
                {/* The words the three previews say: their text alternative (also each play button's description). */}
                {design.recipe.text && <p className="mt-2">Each voice says: “{design.recipe.text}”</p>}
              </div>
            )}
          </div>
        )}

        {(phase === "previews" || phase === "selecting") && design && (
          <PreviewList
            previews={design.previews}
            line={design.recipe.text}
            busy={busy}
            saving={phase === "selecting" ? chosen : null}
            inUse={phase === "previews" ? inUse : null}
            onChoose={(i) => (i === inUse ? setPhase("ready") : chooseVoice(i))}
          />
        )}

        {phase === "ready" && selection && design && (
          <div className="enter flex flex-col gap-3">
            {selection.message && (
              <p className="flex items-center gap-2 text-label text-ink-2">
                <CheckIcon />
                {selection.message}
              </p>
            )}
            <SpeakBar descKey={design.descKey} take={inUse} onRetired={retired} />
            <ExportButton design={design} selection={selection} chosen={chosen} />
          </div>
        )}

        {error && <Alert>{error.message}</Alert>}
        <Status message={said} />

        {firstRun && (
          <div className="flex items-center justify-between gap-3">
            <p className="min-w-0 text-meta text-ink-3">
              Voices by{" "}
              <a href="https://elevenlabs.io" target="_blank" rel="noreferrer" className="underline-offset-2 transition-colors hover:text-ink hover:underline">
                ElevenLabs<span className="sr-only"> (opens in a new tab)</span>
              </a>
              . Not affiliated.
            </p>
            <div className="shrink-0">{findButton}</div>
          </div>
        )}
      </div>
    </section>
  );
}

/** "0:13" from a duration in seconds. */
const clock = (secs: number) => `${Math.floor(secs / 60)}:${String(Math.round(secs % 60)).padStart(2, "0")}`;

/**
 * The three preview rows. Each keeps a hidden <audio> (no `controls`, so it has no box); the orb
 * is the play button, with the glyph shown on hover and while playing. Only one preview plays
 * at a time. Playback state is local to this list, so it resets whenever new previews arrive.
 * `inUse`: the take the current voice came from; its pill reads "In use" and goes back to Speak.
 */
function PreviewList({
  previews,
  line,
  busy,
  saving,
  inUse,
  onChoose,
}: {
  previews: Preview[];
  /** What every preview says: the play buttons' description. */
  line: string | null;
  busy: boolean;
  saving: number | null;
  inUse: number | null;
  onChoose: (index: number) => void;
}) {
  const audios = useRef<(HTMLAudioElement | null)[]>([]);
  usePrefetchVoiceBlobs(); // the playing strips, so the first play doesn't wait
  const [playing, setPlaying] = useState<number | null>(null);
  const lineId = useId();

  const toggle = (i: number) => {
    const el = audios.current[i];
    if (!el) return;
    if (playing === i) {
      el.pause();
      return;
    }
    audios.current.forEach((a, j) => {
      if (a && j !== i) a.pause();
    });
    el.play().catch(() => setPlaying(null));
  };

  return (
    <ul className="enter -mx-2 flex flex-col">
      {line && (
        <span id={lineId} hidden>
          Says: “{line}”
        </span>
      )}
      {previews.map((p, i) => (
        <li key={p.generatedVoiceId} className="group/row flex h-14 items-center gap-3 rounded-row px-2 transition-colors hover:bg-surface">
          <button
            type="button"
            onClick={() => toggle(i)}
            // one name, the state in aria-pressed (a name that flips between Play and Pause would say it twice)
            aria-label={`Play voice ${i + 1}`}
            aria-pressed={playing === i}
            aria-describedby={line ? lineId : undefined}
            data-step-focus={i === 0 ? "" : undefined}
            className="group/play relative h-9 w-9 shrink-0 rounded-full active:scale-[0.98]"
          >
            {/* darkens itself on hover / focus (40 %) and a little while playing (VoiceBlob), following its bumps */}
            <span className="block group-focus-visible/play:brightness-[0.4]">
              <VoiceBlob index={i} playing={playing === i} />
            </span>
            {/* black on the pale orb, white once it darkens (hover, focus); a white icon at rest would be faint, and an orb
                darkened at rest turns muddy grey. Playing dims it only a little, so the pause icon stays
                black (white on it would be nearly invisible) */}
            <span className="absolute inset-0 grid place-items-center text-ink transition-colors duration-(--dur-1) group-hover/row:text-white group-focus-visible/play:text-white">
              {playing === i ? (
                <svg viewBox="0 0 20 20" className="h-3.5 w-3.5" fill="currentColor" aria-hidden>
                  <path d="M5 4h4v12H5zM11 4h4v12h-4z" />
                </svg>
              ) : (
                <svg viewBox="0 0 20 20" className="ml-0.5 h-3.5 w-3.5" fill="currentColor" aria-hidden>
                  <path d="M6 3.5v13l11-6.5z" />
                </svg>
              )}
            </span>
          </button>
          <span className="min-w-0 flex-1 truncate text-body text-ink">Voice {i + 1}</span>
          <audio
            ref={(el) => {
              audios.current[i] = el;
            }}
            preload="none"
            src={p.url}
            onPlay={() => setPlaying(i)}
            onPause={() => setPlaying((v) => (v === i ? null : v))}
            onEnded={() => setPlaying((v) => (v === i ? null : v))}
          />
          {p.durationSecs > 0 && <span className="text-meta tabular-nums text-ink-3">{clock(p.durationSecs)}</span>}
          <button
            type="button"
            // the pill being set up keeps the focus (aria-disabled); the other two are disabled meanwhile
            disabled={busy && saving !== i}
            aria-disabled={saving === i}
            onClick={() => !busy && onChoose(i)}
            aria-busy={saving === i}
            aria-label={saving === i ? `Setting up voice ${i + 1}…` : inUse === i ? `In use: voice ${i + 1}` : `Use voice ${i + 1}`}
            // min-w: the same width in use (the check) as for use; setting up shows the spinner in the label's place (BusySwap;
            // the aria-label says "Setting up…")
            className={`${inUse === i ? "pill-ghost" : "pill-secondary grid"} h-8 min-w-31 gap-1.5 px-3 text-label ${saving === i ? "disabled:opacity-100" : ""}`}
          >
            {inUse === i ? (
              <>
                <CheckIcon />
                In use
              </>
            ) : (
              <BusySwap busy={saving === i}>Use voice</BusySwap>
            )}
          </button>
        </li>
      ))}
    </ul>
  );
}

function CheckIcon() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden className="size-3 shrink-0" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 8.5l3 3 7-7" />
    </svg>
  );
}
