"use client";

/**
 * Face → voice. This is ordinary React UI (a handful of state changes per session), kept
 * separate from the render loop. Flow: "Find my voice" (screenshot + sliders → Claude casts the
 * character, gender included → ElevenLabs previews) → listen → "Use voice" (saves it to the ElevenLabs account; the
 * button reads "Setting up…") → Speak → Meet (the character's profile, lazy-loaded CharacterCard, and the download).
 *
 * Looks like the voice list in ElevenLabs' text-to-speech page: a white card with a step
 * breadcrumb, a light headline while idle, and preview rows where the orb is the play
 * button and a black "Use voice" pill sits at the end.
 * Black pills are each step's way on: "Find my voice" while idle, "Use voice" on the takes, "Meet" once a voice is
 * ready (Speak is a secondary action), and "Chat" on Meet.
 * Tokens and pill/card classes: globals.css.
 */
import dynamic from "next/dynamic";
import { type CSSProperties, type KeyboardEvent, useEffect, useId, useRef, useState, useSyncExternalStore } from "react";

import { captureFace } from "@/components/scene/Capture";
import { extraReady } from "@/lib/headExtra";
import { characterSettled } from "@/lib/character";
import { Alert } from "@/components/ui/Alert";
import { ExportButton } from "@/components/ui/ExportButton";
import { ProfileSkeleton } from "@/components/ui/ProfileSkeleton";
import { SpeakBar } from "@/components/ui/SpeakBar";
import { BusySwap } from "@/components/ui/Spinner";
import { Status } from "@/components/ui/Status";
import { useHeightTransition } from "@/components/ui/useHeightTransition";
import { VoiceBlob, VoiceBlobPlaceholder, usePrefetchVoiceBlobs } from "@/components/ui/VoiceBlob";
import type { ProfileResult } from "@/lib/character/profile";
import { speechPlayer } from "@/lib/lipsync/player";
import { talkInvite } from "@/lib/talk/invite";
import { currentFaceSignature, requestDesign, requestSelect, VoiceApiError, type DesignResult, type Preview, type SelectResult } from "@/lib/voice/client";
import { saveVoiceSession, subscribeVoiceSession, voiceSession } from "@/lib/voice/voiceSession";

type Phase = "idle" | "designing" | "previews" | "selecting" | "ready" | "meet";

// The character's profile (the Meet step) only shows once a voice is ready: its code loads then, not with the page.
const loadCharacterCard = () => import("@/components/ui/CharacterCard");
// While its code loads (fetched ahead on the Speak step), the Meet step shows its placeholder, not nothing.
const CharacterCard = dynamic(() => loadCharacterCard().then((m) => m.CharacterCard), { ssr: false, loading: () => <ProfileSkeleton /> });

const STEPS = ["Face", "Voice", "Speak", "Meet"] as const;
const SAME_FACE_HINT = "Change the face to find new voices";

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
  // An invite code in the URL (/?talk=…) is kept for this tab and taken out of the address bar, after the first render
  useEffect(() => void talkInvite(), []);
  // On the Speak step, the Meet step's code is fetched ahead, so its card is there when Meet is pressed.
  useEffect(() => {
    if (phase === "ready") void loadCharacterCard();
  }, [phase]);
  const [design, setDesign] = useState<DesignResult | null>(null);
  // The design now, for answers that come back later (a profile asked for before "Find my voice" found new voices)
  const designNow = useRef(design);
  useEffect(() => {
    designNow.current = design;
  }, [design]);
  // The face the voices were designed for, and the face now (lib/voice/faceSignature.ts): the same face always gets the
  // same voices (the design cache), so "New voices" waits until it changes. Checked twice a second while there is
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
  // The character's profile (CharacterCard): one per voice description and persona, kept while the takes change.
  const [profile, setProfile] = useState<ProfileResult | null>(null);
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
    setProfile(restored.profile ?? null);
    setPhase(restored.selection ? "ready" : "previews");
  }
  // … and kept as it changes (never cleared here: a new design replaces it)
  useEffect(() => {
    if (design) saveVoiceSession({ design, selection, chosen, designedFace, profile });
  }, [design, selection, chosen, designedFace, profile]);
  const card = useRef<HTMLElement>(null);
  const cardContent = useRef<HTMLDivElement>(null);
  useHeightTransition(card, cardContent);

  // Keyboard focus never falls off the card: when the focused control goes away (Use voice, a breadcrumb that became
  // the current step, the first-run Find my voice, Chat, End), focus moves to the nearest control that takes over
  // ([data-step-focus]): in what is left of the control's surroundings first, else in the card. It waits for one to
  // appear (the Meet step's profile is a skeleton at first). Only then: focus that left the card on purpose (a click
  // elsewhere) stays where it went.
  useEffect(() => {
    const el = card.current;
    if (!el) return;
    let focused: Element[] = []; // the focused control and its ancestors in the card, from when it had focus
    let lost: Element[] | null = null; // … once it lost focus to nothing (removed, or a click on blank space)
    const onIn = (e: FocusEvent) => {
      focused = [];
      for (let n = e.target as Element | null; n && n !== el; n = n.parentElement) focused.push(n);
      lost = null;
    };
    const onOut = (e: FocusEvent) => {
      const forget = () => {
        lost = null;
        focused = [];
      };
      if (e.relatedTarget) {
        if (!el.contains(e.relatedTarget as Node)) forget();
        return;
      }
      lost = focused;
      // focus put down on purpose (a tap on the head or the page): the control is still there, and focus stays put
      queueMicrotask(() => (e.target as Element).isConnected && forget());
    };
    const restore = () => {
      const active = document.activeElement;
      // (a browser that sends no focusout for a removed control: it is gone and nothing has focus)
      const from = lost ?? (focused[0] && !focused[0].isConnected ? focused : null);
      if (!from?.length || from[0].isConnected || (active && active !== document.body)) return; // still there, or the visitor moved on
      for (const scope of [...from.slice(1).filter((n) => n.isConnected), el]) {
        const next = scope.querySelector<HTMLElement>("[data-step-focus]");
        if (next) return next.focus();
      }
    };
    const watch = new MutationObserver(restore);
    watch.observe(el, { childList: true, subtree: true, attributes: true, attributeFilter: ["data-step-focus"] });
    el.addEventListener("focusin", onIn);
    el.addEventListener("focusout", onOut);
    return () => {
      watch.disconnect();
      el.removeEventListener("focusin", onIn);
      el.removeEventListener("focusout", onOut);
    };
  }, []);

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
      // Another face or another voice is another character (the server keys profiles the same way).
      if (result.faceKey !== design?.faceKey || result.descKey !== design?.descKey) setProfile(null);
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
      // These previews can't become a voice any more (expired, or designed again): "New voices" gets new ones,
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
  const step = phase === "idle" ? 0 : phase === "ready" ? 2 : phase === "meet" ? 3 : 1;
  // Which way the steps moved (globals.css .step-enter, as the panel tabs: forward from the right, back from the left)
  const [stepMove, setStepMove] = useState({ step, phase, dir: 0 });
  if (stepMove.phase !== phase) setStepMove({ step, phase, dir: Math.sign(step - stepMove.step) }); // 0 within a step: a fade
  // The take the voice in use came from (each take is its own saved voice).
  const inUse = selection ? (selection.chosenIndex ?? design?.chosenIndex ?? chosen) : null;
  // The breadcrumb walks back and forth without losing anything: Face (the face is always editable; from here "Find a
  // new voice" designs for it as it looks now), Voice (the three takes: listen again or switch), Speak (the voice),
  // Meet (who the character is: their profile, written the first time it is opened).
  const reachable = [phase !== "idle", !!design, !!selection, !!selection];
  const goTo = (i: number) => {
    setError(null);
    setPhase((["idle", "previews", "ready", "meet"] as const)[i]);
  };
  // First run: the big black pill sits in the footer. Later runs ("New voices") are a
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
            : phase === "meet"
              ? "Meet the character."
            : "";
  // While designing the pill shows the spinner alone (BusySwap) over its own label, so it keeps its width (with the
  // stage in it, "Designing three voices…" would not fit beside the steps and would wrap below them); the stage is a
  // caption over the skeleton rows instead (and the pill's accessible name).
  const stageText = stage === "describe" ? "Reading the face…" : "Designing three voices…";
  // The footer pill (the Face step) is always "Find my voice"; the small pill beside the four steps (the Voice step) is
  // "New voices", named in full for screen readers.
  const findLabel = firstRun ? "Find my voice" : "New voices";
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
        aria-label={phase === "designing" ? stageText : !firstRun ? "Find new voices" : undefined}
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
    // The card eases to each step's height (useHeightTransition) while the step's content comes in from its side (.step-enter).
    <section
      ref={card}
      aria-label="Voice"
      onKeyDown={onKeyDown}
      className="card pointer-events-auto flex w-full min-w-0 flex-col p-5 lg:w-[360px] lg:min-h-0 lg:overflow-y-auto lg:shadow-float xl:w-[392px]"
    >
      <div ref={cardContent} className="flex min-w-0 shrink-0 flex-col gap-3" style={{ "--tab-dir": stepMove.dir } as CSSProperties}>
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
          {/* "New voices" belongs to the Voice step (the takes); Speak and Meet are about the voice already chosen. */}
          {!firstRun && phase !== "ready" && phase !== "meet" && findButton}
        </header>

        {phase === "idle" && (
          <div className="step-enter flex flex-col gap-1.5 py-1">
            <h2 className="display text-title text-ink md:text-[28px]">Give this face a voice</h2>
            <p className="text-body text-ink-3">ElevenLabs designs three voices from the face as it looks now. Pick the one that fits.</p>
          </div>
        )}

        {/* While designing, three skeleton rows pre-shape the card into the list it is about to become, under the stage
            it is at (a caption where the voices will appear; it fades in anew at each stage; the Status says it aloud). */}
        {phase === "designing" && (
          <div className="step-enter flex flex-col gap-1" aria-hidden>
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

        {design && phase !== "idle" && phase !== "designing" && phase !== "meet" && (
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
              </div>
            )}
          </div>
        )}

        {(phase === "previews" || phase === "selecting") && design && (
          <div className="step-enter">
            <PreviewList
              previews={design.previews}
              line={design.recipe.text}
              busy={busy}
              saving={phase === "selecting" ? chosen : null}
              inUse={phase === "previews" ? inUse : null}
              onChoose={(i) => (i === inUse ? setPhase("ready") : chooseVoice(i))}
            />
          </div>
        )}

        {phase === "ready" && selection && design && (
          <div className="step-enter flex flex-col gap-3">
            {selection.message && (
              <p className="flex items-center gap-2 text-label text-ink-2">
                <CheckIcon />
                {selection.message}
              </p>
            )}
            <SpeakBar descKey={design.descKey} take={inUse} onRetired={retired} />
            <MeetRow onMeet={() => goTo(3)} />
          </div>
        )}

        {/* The end of the flow: who the character is, then everything to take away (the zip carries the profile too). */}
        {phase === "meet" && selection && design && (
          <div className="step-enter flex flex-col gap-3">
            <CharacterCard
              design={design}
              take={inUse}
              result={profile}
              onResult={(r, asked) => asked.faceKey === designNow.current?.faceKey && asked.descKey === designNow.current?.descKey && setProfile(r)}
            />
            <ExportButton design={design} selection={selection} chosen={chosen} profile={profile?.profile ?? null} />
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

/** The way on from Speak to Meet: the step's next move, so a tray with a black pill rather than another white row. */
function MeetRow({ onMeet }: { onMeet: () => void }) {
  return (
    <div className="mt-3 flex items-center justify-between gap-3 rounded-tray bg-surface p-4">
      <div className="min-w-0">
        <p className="text-body text-ink">Meet the character</p>
        <p className="text-meta text-ink-3">Their name, story and quirks</p>
      </div>
      <button type="button" onClick={onMeet} className="pill-primary h-10 shrink-0 px-5">
        Meet
        <svg viewBox="0 0 16 16" aria-hidden className="size-3" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round">
          <path d="M3 8h10M9 4l4 4-4 4" />
        </svg>
      </button>
    </div>
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
            className={`${inUse === i ? "pill-ghost" : "pill-primary grid"} h-8 min-w-31 gap-1.5 px-3 text-label ${saving === i ? "disabled:opacity-100" : ""}`}
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
