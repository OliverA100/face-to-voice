"use client";

/**
 * "Chat with Hamish": a live voice conversation with the character, in the Meet step. Shown to invited visitors only
 * while talking is invite-only (lib/talk/invite.ts). The LiveKit code (lib/talk/session.ts) loads when the pointer
 * reaches the button or the button is pressed, never with the page.
 *
 *   idle      a surface tray with the black "Chat" pill
 *   live      the state (Connecting / Waking … / Listening / Thinking / … is speaking), the character's words as they
 *             are spoken, Mute and End; "30 seconds left" only near the end (the character says goodbye itself)
 *   ended     why it ended, and "Have another chat", which starts the next one straight away
 */
import { useEffect, useRef, useState, useSyncExternalStore } from "react";

import { Alert } from "@/components/ui/Alert";
import { BusySwap } from "@/components/ui/Spinner";
import { Status } from "@/components/ui/Status";
import { speechPlayer } from "@/lib/lipsync/player";
import { talkInvite } from "@/lib/talk/invite";
import type { EndReason, TalkSession, TalkSnapshot } from "@/lib/talk/session";
import { requestTalk, VoiceApiError, type DesignResult } from "@/lib/voice/client";

type SessionModule = typeof import("@/lib/talk/session");
let loading: Promise<SessionModule> | null = null;
/** The LiveKit code, fetched once (on hover or press). */
const loadSession = () => (loading ??= import("@/lib/talk/session"));

const ENDED: Record<EndReason, string> = {
  user: "",
  time_up: "That's the time for this conversation.",
  idle: "They waited a while, then went back to what they were doing.",
  voice_error: "Their voice stopped working. Try again in a moment.",
  left: "",
  disconnected: "The connection dropped.",
  no_agent: "They couldn't make it right now. Please try again in a minute.",
  mic_denied: "To talk, allow the microphone for this site in your browser's settings, then try again.",
  no_mic: "No microphone was found. Connect one, then try again.",
  mic_busy: "Another app is using the microphone. Close it, then try again.",
  error: "Something went wrong with the call. Please try again.",
};

/**
 * The chats' AudioContext, running: made in the first tap and kept for every chat after it (a session pauses it when
 * it ends). A new context per chat was the second chat's undoing: in "Have another chat" the new context's clock ran
 * ahead of the voice it was measuring (headless Chrome: 120 s of context time in 5 s), and the mouth read silence.
 * Resumed synchronously, inside the tap (Safari); null without Web Audio.
 */
let chatCtx: AudioContext | null = null;
function audioContextNow(): AudioContext | null {
  try {
    if (!chatCtx || chatCtx.state === "closed") chatCtx = new AudioContext();
    void chatCtx.resume();
    return chatCtx;
  } catch {
    return null;
  }
}

/** This page's last conversation room: the next one ends it ("Have another chat"), even from a new panel. */
let lastRoom: string | undefined;

/** The time left is shown only in the last stretch: a clock running all along makes a chat feel like a test. */
const SHOW_LEFT_SECONDS = 30;

export function TalkPanel({ design, take, name }: { design: Pick<DesignResult, "faceKey" | "descKey">; take: number | null; name: string }) {
  const [session, setSession] = useState<TalkSession | null>(null);
  const [maxSeconds, setMaxSeconds] = useState(180);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [chats, setChats] = useState(0); // a fresh panel for every chat

  // A conversation outlives nothing: leaving the step (or the page) hangs up, even one still starting.
  const live = useRef<TalkSession | null>(null);
  const gone = useRef(false);
  useEffect(() => {
    gone.current = false;
    return () => {
      gone.current = true;
      live.current?.end();
    };
  }, []);

  const start = async () => {
    if (busy) return;
    // Before any await: Safari only lets audio start inside the tap (the lip sync's meter, and on Safari the voice).
    const ctx = audioContextNow();
    setBusy(true);
    setError(null);
    speechPlayer.stop(); // one voice at a time
    let s: TalkSession | null = null;
    // hung up while it started (End, or the panel went away): the ended view, or nothing, says so
    const over = () => s?.snapshot().state === "ended";
    try {
      const mod = await loadSession();
      if (gone.current) return void ctx?.suspend();
      s = live.current = new mod.TalkSession(ctx);
      s.unlockAudio(); // still inside the tap on iOS when the module was already loaded on hover
      const mic = await mod.checkMicrophone(); // before the token: a refused mic costs nothing
      if (over()) return;
      if (mic) {
        s.end(mic); // lets go of the audio (and the iPhone's call audio)
        setError(ENDED[mic]);
        return;
      }
      const ticket = await requestTalk(design, take, talkInvite(), lastRoom);
      lastRoom = ticket.room;
      if (over()) return;
      setMaxSeconds(ticket.maxSeconds);
      setSession(s);
      setChats((n) => n + 1);
      await s.start(ticket);
    } catch (e) {
      if (over()) return; // e.g. End while connecting: the connection is cancelled, which is no error
      if (!(e instanceof VoiceApiError)) console.error("[talk]", e);
      if (s) s.end("error");
      else void ctx?.suspend();
      setSession(null);
      setError(e instanceof VoiceApiError ? e.message : ENDED.error);
    } finally {
      setBusy(false);
    }
  };

  if (!session) {
    return (
      <div className="flex flex-col gap-2">
        <div className="flex items-center justify-between gap-3 rounded-tray bg-surface p-4">
          <div className="min-w-0">
            <p className="text-body text-ink">Chat with {name}</p>
            <p className="text-meta text-ink-3">A live voice conversation, up to {Math.round(maxSeconds / 60)} minutes</p>
          </div>
          <button
            type="button"
            onClick={start}
            onPointerEnter={() => void loadSession()}
            onFocus={() => void loadSession()}
            aria-disabled={busy}
            aria-busy={busy}
            aria-label={busy ? "Connecting…" : `Chat with ${name}`}
            data-step-focus
            className="pill-primary grid h-10 shrink-0 px-5"
          >
            <BusySwap busy={busy}>
              <span className="flex items-center gap-2">
                <MicIcon />
                Chat
              </span>
            </BusySwap>
          </button>
        </div>
        {/* credited where it comes in, as ElevenLabs is beside "Find my voice" (VoicePanel) */}
        <p className="text-meta text-ink-3">
          Live on{" "}
          <a href="https://livekit.io" target="_blank" rel="noreferrer" className="underline-offset-2 transition-colors hover:text-ink hover:underline">
            LiveKit<span className="sr-only"> (opens in a new tab)</span>
          </a>
          . Not affiliated.
        </p>
        {error && <Alert>{error}</Alert>}
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-2">
      <LiveTalk key={chats} session={session} name={name} maxSeconds={maxSeconds} starting={busy} onAgain={start} />
      {error && <Alert>{error}</Alert>}
    </div>
  );
}

function LiveTalk({ session, name, maxSeconds, starting, onAgain }: { session: TalkSession; name: string; maxSeconds: number; starting: boolean; onAgain: () => void }) {
  const snap: TalkSnapshot = useSyncExternalStore(session.subscribe, session.snapshot, session.snapshot);
  // The clock, from when the character joined.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (snap.state === "ended") return;
    const id = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(id);
  }, [snap.state]);
  const left = snap.joinedAt ? Math.ceil(maxSeconds - (now - snap.joinedAt) / 1000) : maxSeconds;

  const label: Record<TalkSnapshot["state"], string> = {
    connecting: "Connecting…",
    waking: `Waking ${name} up…`,
    listening: "Listening",
    thinking: "Thinking…",
    speaking: `${name} is speaking`,
    ended: "Conversation over",
  };
  const ended = snap.state === "ended";
  const reason = snap.endReason ? ENDED[snap.endReason] : "";

  return (
    <section aria-label={`Conversation with ${name}`} className="enter flex flex-col gap-3 rounded-tray bg-surface p-4">
      <header className="flex items-center justify-between gap-3">
        <p className="flex items-center gap-2 text-label text-ink">
          <span aria-hidden className={`size-2 rounded-full ${snap.state === "speaking" ? "bg-ink" : snap.state === "listening" ? "animate-pulse bg-ink" : "bg-ink-4"}`} />
          {label[snap.state]}
        </p>
        {!ended && snap.joinedAt && left <= SHOW_LEFT_SECONDS && <span className="enter text-meta tabular-nums text-ink-3">{Math.max(0, left)} seconds left</span>}
      </header>
      {snap.caption && <p className="text-body text-ink">“{snap.caption}”</p>}
      {snap.heard && !ended && <p className="text-meta text-ink-3">You: {snap.heard}</p>}
      {snap.state === "waking" && <p className="text-meta text-ink-3">The first conversation in a while can take up to a minute to start.</p>}
      {snap.needsAudioTap && !ended && (
        <button type="button" onClick={() => void session.room.startAudio()} className="pill-secondary h-8 self-start px-3 text-label">
          Tap to hear them
        </button>
      )}
      {ended && reason && <p className="text-label text-ink-2">{reason}</p>}
      <div className="flex items-center justify-end gap-2">
        {ended ? (
          <button
            key="again" // its own element: reusing Mute's would fade it from white to black
            type="button"
            onClick={onAgain}
            aria-disabled={starting}
            aria-busy={starting}
            aria-label={starting ? "Connecting…" : undefined}
            data-step-focus
            className="pill-primary grid h-10 px-5"
          >
            <BusySwap busy={starting}>Have another chat</BusySwap>
          </button>
        ) : (
          <>
            {/* the label says what it does; no aria-pressed as well ("Unmute, pressed" reads backwards) */}
            <button type="button" onClick={() => void session.setMuted(!snap.muted)} className="pill-secondary h-10 px-4">
              {snap.muted ? "Unmute" : "Mute"}
            </button>
            <button type="button" onClick={() => session.end()} data-step-focus className="pill-primary h-10 px-5">
              End
            </button>
          </>
        )}
      </div>
      {/* announced: connecting, joining and the end; not every turn (it would talk over the character) */}
      <Status message={ended ? `Conversation over. ${reason}` : snap.joinedAt ? `${name} has joined` : label[snap.state]} />
    </section>
  );
}

function MicIcon() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden className="size-3.5" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round">
      <rect x="5.5" y="1.75" width="5" height="8" rx="2.5" />
      <path d="M3 7.5a5 5 0 0 0 10 0M8 12.5v2" />
    </svg>
  );
}
