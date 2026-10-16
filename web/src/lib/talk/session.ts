/**
 * A live conversation with the character, browser side. Loaded only when "Talk to …" is pressed (it carries
 * livekit-client, ~140 KB gzip), never with the page.
 *
 *   mic permission first (no room, no agent, no cost if it is refused)
 *   → POST /api/talk/token → Room.connect(serverUrl, token) → publish the microphone
 *   → the agent joins (dispatched by the token) and speaks first
 *
 * What the room tells us, all from the agent participant:
 *   - its audio track: the character's voice, played through the lip sync's audio graph, held back a moment
 *     (lib/lipsync/live.ts; livekit-client's own <audio> element stays muted unless that graph can't play)
 *   - attribute "lk.agent.state": listening / thinking / speaking (set by the LiveKit Agents framework)
 *   - attribute "ftv.mood": "happy:0.75", the mood of the current reply (ours)
 *   - attribute "ftv.end": why the agent ended it (time_up, idle, voice_error, left)
 *   - text stream "lk.transcription": the character's words as they are spoken, and the visitor's as transcribed
 *   - text stream "ftv.words": each reply's word timings, ahead of its audio, where its voice starts on their clock, and
 *     its loudness as the agent made it (10 ms blocks), for the lip sync (lib/lipsync/live.ts)
 *
 * The face follows: the mouth from the voice (LiveSpeech, registered with LipSync), the expression from the mood, and
 * nods while the visitor talks and as the character answers (lib/talk/face.ts).
 */
import { MediaDeviceFailure, type Participant, type RemoteTrack, Room, RoomEvent, Track } from "livekit-client";

import { LIVE, LiveSpeech, type LiveWord } from "@/lib/lipsync/live";
import { restOutput } from "@/lib/lipsync/output";
import { isAppleTouch } from "@/lib/lipsync/staleTab";
import { setLiveSpeech } from "@/lib/lipsync/source";
import { HeardLine } from "@/lib/talk/heard";
import { chatFaceEnd, chatFaceStart, chatListening, chatMood, chatNod } from "@/lib/talk/face";
import type { TalkTicket } from "@/lib/voice/client";

export type TalkState = "connecting" | "waking" | "listening" | "thinking" | "speaking" | "ended";
export type EndReason = "user" | "time_up" | "idle" | "voice_error" | "left" | "disconnected" | "no_agent" | "mic_denied" | "no_mic" | "mic_busy" | "error";

export interface TalkSnapshot {
  state: TalkState;
  /** The character's current line, as it is spoken. */
  caption: string;
  /** What the visitor said last, as the agent heard it. */
  heard: string;
  mood: { emotion: string; intensity: number } | null;
  endReason: EndReason | null;
  /** When the character joined (the clock starts then), ms since epoch. */
  joinedAt: number | null;
  muted: boolean;
  /** The browser blocked playback: a tap on "Tap to hear them" (room.startAudio) unblocks it. */
  needsAudioTap: boolean;
}

/** No agent after this long: it is starting up from cold (LiveKit Cloud's free plan sleeps idle agents). */
const WAKING_AFTER_MS = 2500;
/**
 * No agent after this long: it isn't coming. LiveKit quotes 10–20 s for a cold start, but waking this agent from sleep
 * took longer than 30 s, and leaving sooner empties the room, which cancels the agent's wake-up: every chat after a
 * quiet spell failed until the next deploy (2026-10-12).
 */
const GIVE_UP_MS = 90_000;

type AudioSessionNavigator = Navigator & { audioSession?: { type: string } };
/** iPhone and iPad: talking needs the play-and-record session (speaker and mic together); computers are left alone (lib/lipsync/player.ts). */
function audioSession(type: "play-and-record" | "auto") {
  const nav = navigator as AudioSessionNavigator;
  if (nav.maxTouchPoints > 1 && nav.audioSession) nav.audioSession.type = type;
}

/** Ask for the microphone before anything is paid for. Null when it is allowed, else why not. */
export async function checkMicrophone(): Promise<EndReason | null> {
  if (!navigator.mediaDevices?.getUserMedia) return "no_mic";
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    stream.getTracks().forEach((t) => t.stop());
    return null;
  } catch (e) {
    return micFailure(e);
  }
}

function micFailure(e: unknown): EndReason {
  const failure = MediaDeviceFailure.getFailure(e);
  return failure === MediaDeviceFailure.PermissionDenied ? "mic_denied" : failure === MediaDeviceFailure.NotFound ? "no_mic" : failure === MediaDeviceFailure.DeviceInUse ? "mic_busy" : "error";
}

/**
 * iPhones and iPads: the microphone without echo cancellation (or the other voice processing), and muted while the
 * character speaks. On an iPhone's loudspeaker the chats popped all through the character's speech, with headphones they
 * didn't (2026-10-16): iOS's echo canceller chops the call's playback. Without it the microphone would hear the
 * character, so it listens only between replies (no interrupting it mid-sentence). Checked on an iPhone: no pops, the
 * character never heard itself.
 */
const echoOff = () => isAppleTouch();
/** After the character stops (its state), the microphone waits this long (ms): the voice is held back and still heard. */
const DUPLEX_TAIL_MS = 400;
/**
 * Without the echo canceller iOS plays the voice much quieter on the loudspeaker (2026-10-16: a plain 10x gain into a
 * limiter "could be higher"; the voice already peaks at full scale, so gain alone only clips). It is compressed and
 * made up (live.ts: +5 dB of speech loudness at this make-up gain, nothing clipped; louder and it clips again).
 */
const CHAT_MAKEUP = 2;

export class TalkSession {
  private readonly halfDuplex = echoOff();
  readonly room = new Room({ audioCaptureDefaults: { echoCancellation: !this.halfDuplex, noiseSuppression: !this.halfDuplex, autoGainControl: !this.halfDuplex } });
  private duplexTimer: ReturnType<typeof setTimeout> | null = null;
  private snap: TalkSnapshot = { state: "connecting", caption: "", heard: "", mood: null, endReason: null, joinedAt: null, muted: false, needsAudioTap: false };
  private readonly listeners = new Set<() => void>();
  private readonly audio: HTMLMediaElement[] = [];
  private wakeTimer: ReturnType<typeof setTimeout> | null = null;
  private giveUpTimer: ReturnType<typeof setTimeout> | null = null;
  private micTrackSid: string | null = null;
  // what the visitor has said since the character last spoke, by transcript segment (a pause starts a new one)
  private heard = new HeardLine(); // the "You:" line
  private ctx: AudioContext | null = null;
  private live: LiveSpeech | null = null;
  private captionDelayMs = 0;
  private agentState = "";
  private wordsStream = 0; // the newest "ftv.words" stream: a late line from an older one is dropped
  private readonly unlisten = new AbortController(); // listeners on the shared AudioContext, removed when the chat ends

  /**
   * `ctx`: the lip sync's AudioContext, made and resumed synchronously in the tap that started the call (Safari only
   * starts audio there); null without Web Audio (the call still works, the mouth stays still).
   */
  constructor(ctx: AudioContext | null) {
    this.ctx = ctx;
  }

  /** Call inside the tap that starts the call (iOS only lets audio start from a user gesture). */
  unlockAudio(): void {
    audioSession("play-and-record");
    void this.room.startAudio();
  }

  snapshot = (): TalkSnapshot => this.snap;
  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };
  private set(patch: Partial<TalkSnapshot>) {
    this.snap = { ...this.snap, ...patch };
    this.listeners.forEach((fn) => fn());
  }

  private ended = () => this.snap.state === "ended";

  async start(ticket: TalkTicket): Promise<void> {
    if (this.ended()) return;
    const room = this.room;
    // Made now, not when the voice's track arrives: the agent may say "speaking" and send its words first.
    this.live = this.ctx ? new LiveSpeech(this.ctx) : null;
    room.on(RoomEvent.TrackSubscribed, (track: RemoteTrack, _pub, participant: Participant) => {
      if (track.kind !== Track.Kind.Audio || !participant.isAgent) return;
      const el = track.attach();
      el.style.display = "none";
      document.body.append(el);
      this.audio.push(el);
      if (this.ctx && this.live && track.mediaStreamTrack) {
        const live = this.live;
        // The voice plays from the lip sync's own audio graph, so what the mouth measures is what is heard
        // (lib/lipsync/live.ts); the captions wait for the voice, which is held back
        this.captionDelayMs = LIVE.delay * 1000;
        live.attach(track.mediaStreamTrack, true, LIVE.delay, this.halfDuplex ? CHAT_MAKEUP : 1).then(
          () => {
            if (this.snap.state === "ended") return; // over while the meter was loading
            // the element stays the voice until the graph really plays (and becomes it again if Safari suspends it).
            // Kept that way: livekit-client's startAudio() unmutes every attached element, and it runs it by itself
            // when the mic starts (and on iPhones when the page becomes visible again); both playing, the element's
            // copy would come first and the mouth look late.
            const ctx = this.ctx!;
            const route = () => {
              const muted = ctx.state === "running";
              if (el.muted !== muted) el.muted = muted;
            };
            route();
            ctx.addEventListener("statechange", route, { signal: this.unlisten.signal });
            el.addEventListener("volumechange", route, { signal: this.unlisten.signal });
            setLiveSpeech(live);
          },
          (e) => console.warn("[talk] lip sync off:", e),
        );
      }
    });
    room.on(RoomEvent.ParticipantConnected, (p: Participant) => p.isAgent && this.agentJoined());
    room.on(RoomEvent.ParticipantAttributesChanged, (changed: Record<string, string>, p: Participant) => {
      if (!p.isAgent) return;
      const state = changed["lk.agent.state"];
      if (state === "listening" || state === "thinking" || state === "speaking") {
        if (state === "speaking" && this.agentState !== "speaking") {
          this.live?.replyStarted();
          chatListening(false); // the character talks now, not the visitor
          this.heard.clear(); // the visitor's next words start a new line under "You:"
        }
        if (state !== "speaking" && this.agentState === "speaking") this.live?.replyEnded();
        if (state === "thinking" && this.agentState === "listening") chatNod(); // heard: a nod, then the answer
        if (this.halfDuplex) this.duplex(state);
        this.agentState = state;
        this.set({ state });
      }
      const mood = changed["ftv.mood"];
      if (mood) {
        const [emotion, intensity] = mood.split(":");
        this.set({ mood: { emotion, intensity: Number(intensity) || 0 } });
        chatMood({ emotion, intensity: Number(intensity) || 0 });
      }
      const end = changed["ftv.end"];
      if (end) this.finish(end === "time_up" || end === "idle" || end === "voice_error" || end === "left" ? end : "disconnected");
    });
    room.on(RoomEvent.AudioPlaybackStatusChanged, () => this.set({ needsAudioTap: !room.canPlaybackAudio }));
    room.on(RoomEvent.MediaDevicesError, (e: Error) => this.finish(micFailure(e)));
    room.on(RoomEvent.Disconnected, () => this.finish("disconnected"));
    // The visitor talking (livekit-client's own voice detection on the mic): the character nods along while it listens.
    room.on(RoomEvent.ActiveSpeakersChanged, (speakers: Participant[]) => chatListening(speakers.some((p) => p.isLocal) && this.agentState !== "speaking"));
    // Each reply's word timings, ahead of its audio (one stream per reply, JSON lines): the lip sync's cues. One line
    // is {onset}: where the voice starts on the words' clock; others are {k, env}: the reply's loudness from block k
    // (agent/src/onset.ts). Only the newest stream is read: an interrupted reply's last lines can come after the next
    // reply's stream opened, and would land in its words and loudness.
    room.registerTextStreamHandler("ftv.words", async (reader) => {
      const mine = ++this.wordsStream;
      this.live?.wordsStarted();
      let rest = "";
      for await (const piece of reader) {
        if (mine !== this.wordsStream) return;
        rest += piece;
        const lines = rest.split("\n");
        rest = lines.pop() ?? "";
        const words: LiveWord[] = [];
        for (const l of lines) {
          try {
            const m = JSON.parse(l) as LiveWord | { onset: number } | { k: number; env: number[] };
            if ("onset" in m) {
              if (Number.isFinite(m.onset)) this.live?.voiceOnset(m.onset);
            } else if ("env" in m) {
              if (Number.isInteger(m.k) && Array.isArray(m.env)) this.live?.addEnvelope(m.k, m.env);
            } else if (typeof m.w === "string" && Number.isFinite(m.s) && Number.isFinite(m.e)) words.push(m);
          } catch {}
        }
        if (words.length) this.live?.addWords(words);
      }
    });
    room.registerTextStreamHandler("lk.transcription", async (reader, from) => {
      // The visitor's words are transcriptions of their own microphone track; everything else is the character's.
      const mine = !!this.micTrackSid && reader.info.attributes?.["lk.transcribed_track_id"] === this.micTrackSid;
      if (from.identity !== room.localParticipant.identity && !mine) {
        let line = "";
        for await (const piece of reader) {
          const caption = (line += piece);
          // paced to the voice as the agent sends it: shown when it is heard (the voice is held back, LIVE.delay)
          if (this.captionDelayMs) setTimeout(() => this.snap.state !== "ended" && this.set({ caption }), this.captionDelayMs);
          else this.set({ caption });
        }
      } else {
        // the line is every final segment since the character last spoke, once each, and the draft now (lib/talk/heard.ts)
        const final = reader.info.attributes?.["lk.transcription_final"] !== "false";
        this.heard.add(reader.info.attributes?.["lk.segment_id"] ?? reader.info.id, await reader.readAll(), final);
        this.set({ heard: this.heard.text });
      }
    });

    chatFaceStart();
    await room.connect(ticket.serverUrl, ticket.token);
    if (this.ended()) return;
    try {
      const pub = await room.localParticipant.setMicrophoneEnabled(true);
      this.micTrackSid = pub?.trackSid ?? null;
      // iPhones and iPads (halfDuplex): the greeting can start before the microphone is published (duplex found nothing to mute, and the
      // character heard itself on its first reply: 2026-10-16)
      if (this.halfDuplex && this.agentState === "speaking") this.duplex("speaking");
    } catch (e) {
      this.finish(micFailure(e));
      return;
    }
    if ([...room.remoteParticipants.values()].some((p) => p.isAgent)) this.agentJoined();
    else {
      this.wakeTimer = setTimeout(() => this.snap.state === "connecting" && this.set({ state: "waking" }), WAKING_AFTER_MS);
      this.giveUpTimer = setTimeout(() => !this.snap.joinedAt && this.finish("no_agent"), GIVE_UP_MS);
    }
    this.set({ needsAudioTap: !room.canPlaybackAudio });
  }

  private agentJoined() {
    if (this.snap.joinedAt) return;
    if (this.wakeTimer) clearTimeout(this.wakeTimer);
    if (this.giveUpTimer) clearTimeout(this.giveUpTimer);
    this.set({ joinedAt: Date.now(), state: this.snap.state === "ended" ? "ended" : "listening" });
  }

  /** iPhones and iPads (halfDuplex): the microphone off while the character speaks, back on just after (unless the
   *  visitor muted it). */
  private duplex(state: string) {
    const track = this.room.localParticipant.getTrackPublication(Track.Source.Microphone)?.track;
    if (!track) return;
    if (this.duplexTimer) clearTimeout(this.duplexTimer);
    this.duplexTimer = null;
    if (state === "speaking") void track.mute().catch(() => {});
    else
      this.duplexTimer = setTimeout(() => {
        if (!this.snap.muted && !this.ended()) void track.unmute().catch(() => {});
      }, DUPLEX_TAIL_MS);
  }

  async setMuted(muted: boolean): Promise<void> {
    try {
      await this.room.localParticipant.setMicrophoneEnabled(!muted);
      this.set({ muted });
    } catch (e) {
      console.warn("[talk] mute failed:", e); // stays as it was; the button shows which
    }
  }

  /** The visitor hangs up (or the chat stops before it started: `reason`). */
  end(reason: EndReason = "user"): void {
    this.finish(reason);
  }

  private finish(reason: EndReason) {
    if (this.snap.state === "ended") return;
    if (this.wakeTimer) clearTimeout(this.wakeTimer);
    if (this.giveUpTimer) clearTimeout(this.giveUpTimer);
    this.set({ state: "ended", endReason: reason });
    void this.room.disconnect();
    this.unlisten.abort();
    this.audio.splice(0).forEach((el) => el.remove());
    setLiveSpeech(null);
    this.live?.detach();
    if (this.ctx) void restOutput(this.ctx).catch(() => {}); // kept for the next chat (TalkPanel audioContextNow)
    chatFaceEnd();
    audioSession("auto");
  }
}
