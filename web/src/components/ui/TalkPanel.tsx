"use client";

/**
 * "Chat with Hamish": a live voice conversation with the character, in the Meet step. Shown to invited visitors only
 * while talking is invite-only (lib/talk/invite.ts). The LiveKit code (lib/talk/session.ts) loads when the pointer
 * reaches the button or the button is pressed, never with the page.
 *
 *   idle      a surface tray with the black "Chat" pill
 *   live      the loader's sphere answering whoever talks (CHAT_SPHERE), the state (Connecting / Waking … / Listening /
 *             Thinking / … is speaking), the character's words as they are spoken, Mute and End; "30 seconds left" only
 *             near the end (the character says goodbye itself)
 *   ended     why it ended, and "Have another chat", which starts the next one straight away
 */
import { useEffect, useRef, useState, useSyncExternalStore } from "react";

import { Alert } from "@/components/ui/Alert";
import { BALL_IN_FRAME, CHROME, VOICE_STYLE, VOICE_STYLES } from "@/components/ui/loader/chrome";
import type { ChromeVoice, ChromeVoiceStyle } from "@/components/ui/loader/chromeGl";
import { LoaderSphere } from "@/components/ui/loader/LoaderSphere";
import { BusySwap } from "@/components/ui/Spinner";
import { Status } from "@/components/ui/Status";
import { isLimitError } from "@/lib/limits/open";
import { outputOf, restOutput, wakeOutput } from "@/lib/lipsync/output";
import { speechPlayer } from "@/lib/lipsync/player";
import { talkInvite } from "@/lib/talk/invite";
import type { EndReason, TalkSession, TalkSnapshot } from "@/lib/talk/session";
import { requestTalk, VoiceApiError, withCasting, type DesignResult } from "@/lib/voice/client";

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
    // Safari: the voice plays through an <audio> element (lib/lipsync/output.ts), made and played in this tap
    outputOf(chatCtx);
    wakeOutput(chatCtx);
    return chatCtx;
  } catch {
    return null;
  }
}

/** This page's last conversation room: the next one ends it ("Have another chat"), even from a new panel. */
let lastRoom: string | undefined;

/** The time left is shown only in the last stretch: a clock running all along makes a chat feel like a test. */
const SHOW_LEFT_SECONDS = 30;
const secondsLeft = (left: number) => {
  const n = Math.max(0, left);
  return `${n} ${n === 1 ? "second" : "seconds"} left`;
};

/**
 * The sphere beside the chat's state. While someone talks it answers their voice (how: ./loader/chrome.tsx
 * VOICE_STYLES, compared in /dev/voice-sphere), holding `polish` (0 = the loader's lumpy white blob, 1 = the soap
 * bubble with its rainbow): mostly white while the character talks, colourful while you do. Thinking, it swings as
 * the busy spinner does (the loader's whole swing, quicker, the rainbow at 30 %); connecting and waking, as the loader
 * does; once the chat is over it rests on the bubble.
 */
export const CHAT_SPHERE = {
  size: 34, // px, the sphere's --orb size, as the Voice step's orbs (the ball is CHROME.ball of it; its box adds room for the bumps)
  polish: { listening: 1, speaking: 0.4, ended: 1 },
  // the spinner's: blob → bubble in 1.2 s (the loader's 1.5 s), the rainbow at 30 %, and the lumpy blob end keeps a
  // little of it (colourFloor). evenBumps (chromeGl.ts evenBumped) stays off: the swing as the loader's
  thinking: { swing: true, pace: 3 / 2.4, rainbow: 0.3, evenBumps: 0, colourFloor: 0.25 },
};

/** What the live view needs from a session: a TalkSession (the voice lab passes a stand-in). */
export type LiveTalkSession = Pick<TalkSession, "subscribe" | "snapshot" | "setMuted" | "end" | "level"> & { room: Pick<TalkSession["room"], "startAudio"> };

export function TalkPanel({
  design,
  take,
  name,
  onRetired,
  onStale,
}: {
  design: Pick<DesignResult, "faceKey" | "descKey" | "sent">;
  take: number | null;
  name: string;
  onRetired: (message: string) => void; // code "expired": the voice was retired; the voice panel goes back to the takes
  onStale: () => void; // code "stale": the character can't be recast; "New voices" may design for this face again
}) {
  const [session, setSession] = useState<TalkSession | null>(null);
  const [maxSeconds, setMaxSeconds] = useState(180);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ message: string; limits?: boolean } | null>(null);
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
    // One voice at a time, and Speak's audio let go before the chat's starts: on an iPhone, a chat begun while a line
    // still played got a context that never ran (the lips stayed still).
    speechPlayer.release();
    // Before any await: Safari only lets audio start inside the tap (the lip sync's meter, and on Safari the voice).
    const ctx = audioContextNow();
    setBusy(true);
    setError(null);
    let s: TalkSession | null = null;
    // hung up while it started (End, or the panel went away): the ended view, or nothing, says so
    const over = () => s?.snapshot().state === "ended";
    try {
      const mod = await loadSession();
      if (gone.current) return void (ctx && restOutput(ctx).catch(() => {}));
      s = live.current = new mod.TalkSession(ctx);
      s.unlockAudio(); // still inside the tap on iOS when the module was already loaded on hover
      const mic = await mod.checkMicrophone(); // before the token: a refused mic costs nothing
      if (over()) return;
      if (mic) {
        s.end(mic); // lets go of the audio (and the iPhone's call audio)
        setError({ message: ENDED[mic] });
        return;
      }
      const ticket = await withCasting(design, () => requestTalk(design, take, talkInvite(), lastRoom));
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
      else if (ctx) void restOutput(ctx).catch(() => {});
      setSession(null);
      if (e instanceof VoiceApiError && e.code === "expired") return onRetired(e.message); // the voice panel says it, on the takes
      if (e instanceof VoiceApiError && e.code === "stale") onStale();
      setError({ message: e instanceof VoiceApiError ? e.message : ENDED.error, limits: isLimitError(e) });
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
          <a href="https://livekit.io" target="_blank" rel="noreferrer" className="underline underline-offset-2 transition-colors hover:text-ink">
            LiveKit<span className="sr-only"> (opens in a new tab)</span>
          </a>
          . Not affiliated.
        </p>
        {error && <Alert limits={error.limits}>{error.message}</Alert>}
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-2">
      <LiveTalk key={chats} session={session} name={name} maxSeconds={maxSeconds} starting={busy} onAgain={start} />
      {error && <Alert limits={error.limits}>{error.message}</Alert>}
    </div>
  );
}

export function LiveTalk({
  session,
  name,
  maxSeconds,
  starting,
  onAgain,
  sphere,
}: {
  session: LiveTalkSession;
  name: string;
  maxSeconds: number;
  starting: boolean;
  onAgain: () => void;
  sphere?: { style: ChromeVoiceStyle; size: number }; // the voice lab's
}) {
  const snap: TalkSnapshot = useSyncExternalStore(session.subscribe, session.snapshot, session.snapshot);
  // read every frame by the sphere, from the session itself (not this render's snapshot)
  const [voice] = useState(() => ({
    read: (): ChromeVoice | null => {
      const state = session.snapshot().state;
      if (state === "listening" || state === "speaking") return { polish: CHAT_SPHERE.polish[state], level: session.level() };
      if (state === "thinking") return { polish: 0, level: 0, ...CHAT_SPHERE.thinking };
      return state === "ended" ? { polish: CHAT_SPHERE.polish.ended, level: 0 } : null;
    },
  }));
  const size = sphere?.size ?? CHAT_SPHERE.size;
  const pad = (size * (CHROME.ball / BALL_IN_FRAME - CHROME.ball)) / 2; // the box's room around the ball: the ball lines up with the text
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
    reconnecting: "Reconnecting…",
    ended: "Conversation over",
  };
  const ended = snap.state === "ended";
  const reason = snap.endReason ? ENDED[snap.endReason] : "";

  return (
    <section aria-label={`Conversation with ${name}`} className="enter flex flex-col gap-3 rounded-tray bg-surface p-4">
      <header className="flex items-center gap-3">
        <div className="shrink-0" style={{ margin: -pad }}>
          <LoaderSphere size={`${size}px`} voice={{ style: sphere?.style ?? VOICE_STYLES[VOICE_STYLE.id].style, read: voice.read }} />
        </div>
        <p className="min-w-0 flex-1 text-label text-ink">{label[snap.state]}</p>
        {!ended && snap.joinedAt && left <= SHOW_LEFT_SECONDS && <span className="enter text-meta tabular-nums text-ink-3">{secondsLeft(left)}</span>}
      </header>
      {snap.caption && <p className="text-body text-ink">“{snap.caption}”</p>}
      {snap.heard && !ended && <p className="text-meta text-ink-3">You: {snap.heard}</p>}
      {snap.state === "waking" && <p className="text-meta text-ink-3">The first conversation in a while can take up to a minute to start.</p>}
      {snap.needsAudioTap && !ended && (
        <button type="button" onClick={() => void session.room.startAudio()} className="pill-secondary h-8 self-start px-3 text-label">
          Tap to hear them
        </button>
      )}
      {snap.muteFailed && !ended && <Alert>Couldn&apos;t switch the microphone. Try again.</Alert>}
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
      {/* announced: connecting, joining, a reconnect, the last seconds and the end; not every turn (it would talk over the character) */}
      <Status
        message={
          ended
            ? `Conversation over. ${reason}`
            : snap.state === "reconnecting"
              ? label.reconnecting
              : snap.joinedAt && left <= SHOW_LEFT_SECONDS
                ? `Less than ${SHOW_LEFT_SECONDS} seconds left`
                : snap.joinedAt
                  ? `${name} has joined`
                  : label[snap.state]
        }
      />
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
