/**
 * The Face to Voice character agent: a LiveKit agent server ("worker") that registers as "ftv-character" and is
 * dispatched into a room only when the web server's token asks for it (explicit dispatch). Each job is one
 * conversation with one visitor. The pipeline (mic to voice) is drawn in agent/README.md.
 *
 * Limits are the agent's own, whatever the browser does: the conversation ends at metadata.maxSeconds (never more than
 * HARD_MAX_SECONDS), or when the visitor has been quiet for a while, or leaves. Nothing is recorded here: LiveKit
 * Cloud's session recording is off for every session, and the logs carry timings and token counts, never words (the
 * Dockerfile keeps the framework's own logs, which can quote them, to fatal errors). The providers keep their own
 * request logs (docs/responsible-ai.md).
 *
 *   node src/main.ts dev     run against LIVEKIT_URL (the local `livekit-server --dev`, or the Cloud project)
 *   FTV_MOCK_AGENT=1         a canned character instead (canned.ts): no STT, LLM or TTS calls
 */
import { type JobContext, type JobProcess, ServerOptions, cli, defineAgent, inference, voice } from "@livekit/agents";
import * as anthropic from "@livekit/agents-plugin-anthropic";
import * as elevenlabs from "@livekit/agents-plugin-elevenlabs";
import * as silero from "@livekit/agents-plugin-silero";
import { fileURLToPath } from "node:url";

import { runCanned } from "./canned.ts";
import { againNote, CharacterAgent, LLM_MODEL, log, TTS_MODEL } from "./character.ts";
import { fixWordTimings } from "./elevenTimings.ts";
import { parseMetadata } from "./metadata.ts";
import { moodIntensity, type Mood } from "./mood.ts";

export const AGENT_NAME = "ftv-character";
/** Quiet this long (seconds) and the visitor counts as away: one nudge, then the conversation ends. */
const AWAY_SECONDS = 15;
/** The goodbye starts this many seconds before the limit. */
const GOODBYE_SECONDS = 12;
/** After giving up (Claude failed twice), the chat ends this many seconds later even if the goodbye never plays. */
const GIVE_UP_SECONDS = 10;

export default defineAgent({
  prewarm: async (proc: JobProcess) => {
    // Loaded once per process, before any job: the VAD model is ~2 MB and takes a moment.
    proc.userData.vad = await silero.VAD.load();
  },
  entry: async (ctx: JobContext) => {
    let meta;
    try {
      meta = parseMetadata(ctx.job.metadata);
    } catch {
      // only the web server signs dispatches, so this is a version mismatch: say so to the browser rather than leave it waiting
      log("bad metadata");
      await ctx.connect();
      await ctx.room.localParticipant?.setAttributes({ "ftv.end": "error" }).catch(() => {});
      return ctx.shutdown("bad metadata");
    }
    if (process.env.FTV_MOCK_AGENT === "1") return runCanned(ctx, meta);
    const started = Date.now();

    const voiceOut = new elevenlabs.TTS({
      apiKey: process.env.ELEVENLABS_API_KEY,
      voiceId: meta.voiceId,
      model: TTS_MODEL,
      syncAlignment: true, // word timings for the captions and the lip sync
    });
    fixWordTimings(voiceOut.sampleRate); // rebased onto the reply's own clock (elevenTimings.ts)
    const session = new voice.AgentSession({
      vad: ctx.proc.userData.vad as silero.VAD,
      stt: new inference.STT({ model: "assemblyai/universal-streaming:en" }),
      // Never called: CharacterAgent.llmNode talks to Claude itself. The session needs an LLM to run the pipeline.
      llm: new anthropic.LLM({ model: LLM_MODEL }),
      tts: voiceOut,
      turnHandling: { turnDetection: new inference.TurnDetector({ version: "v1-mini" }) },
      userAwayTimeout: AWAY_SECONDS,
      // The default markdown filter holds text back while a "[" is open, which would delay every audio tag.
      ttsTextTransforms: ["filter_emoji"],
    });

    const me = () => ctx.room.localParticipant;
    const setMood = (mood: Mood) => void me()?.setAttributes({ "ftv.mood": `${mood.emotion}:${moodIntensity(mood.strength)}` });
    let ending = false;
    /** `drain`: let the reply that is playing finish first. The browser is told why (at most a second's wait for it). */
    const end = async (reason: string, drain = true) => {
      if (ending) return;
      ending = true;
      log("end", { reason, seconds: Math.round((Date.now() - started) / 1000) });
      const told = me()?.setAttributes({ "ftv.end": reason }).catch(() => {});
      await Promise.race([told, new Promise((r) => setTimeout(r, 1000))]);
      session.shutdown({ drain });
    };

    // a goodbye before the limit, then a hard stop at it whatever is still playing
    const goodbye = setTimeout(async () => {
      if (ending) return;
      try {
        const handle = session.generateReply({ instructions: "Time is up. Say a short, warm goodbye in character, in one sentence.", allowInterruptions: false });
        await handle.waitForPlayout();
      } catch {
        // the session closed meanwhile
      }
      await end("time_up", false); // said goodbye: a reply queued behind it is not played
    }, Math.max(1, meta.maxSeconds - GOODBYE_SECONDS) * 1000);
    // The limit holds even when an ending is already under way (a drain plays what is queued, and a second shutdown
    // is ignored while the first runs): cut what is playing, and end the job a moment later whatever happens.
    const hardStop = setTimeout(() => {
      try {
        session.interrupt({ force: true });
      } catch {
        // not running any more
      }
      void end("time_up", false);
      setTimeout(() => ctx.shutdown("time_up"), 3000).unref();
    }, meta.maxSeconds * 1000);

    // Away: one nudge, then the end if they stay quiet. The framework marks them away once and doesn't again while they
    // stay away, so the second wait is the agent's own, from when the nudge has been said; any word from them cancels it.
    let nudged = false;
    let idle: ReturnType<typeof setTimeout> | null = null;
    const stillThere = () => {
      nudged = false;
      if (idle) clearTimeout(idle);
      idle = null;
    };
    session.on(voice.AgentSessionEventTypes.UserStateChanged, (ev) => {
      if (ev.newState === "speaking" || ev.newState === "listening") return stillThere();
      if (ev.newState !== "away" || ending) return;
      if (nudged) return void end("idle");
      nudged = true;
      const handle = session.generateReply({ instructions: "The visitor has gone quiet. Check in with them in one short sentence, in character." });
      void handle
        .waitForPlayout()
        .then(() => {
          if (nudged && !ending) idle = setTimeout(() => void end("idle"), AWAY_SECONDS * 1000);
        })
        .catch(() => {});
    });
    session.on(voice.AgentSessionEventTypes.Error, (ev) => {
      const e = ev.error as { type?: string; recoverable?: boolean; error?: Error };
      // the error's name only: a provider's message can quote the text it was given
      log("error", { type: e.type, recoverable: e.recoverable, name: e.error?.name });
      if (e.type === "tts_error" && !e.recoverable) void end("voice_error");
    });
    session.on(voice.AgentSessionEventTypes.Close, (ev) => {
      clearTimeout(goodbye);
      clearTimeout(hardStop);
      if (idle) clearTimeout(idle);
      log("closed", { reason: ev.reason, error: !!ev.error });
    });
    session.on(voice.AgentSessionEventTypes.MetricsCollected, (ev) => {
      const m = ev.metrics as { type?: string; ttfbMs?: number; endOfUtteranceDelayMs?: number; transcriptionDelayMs?: number };
      if (m.type === "tts_metrics") log("tts", { firstAudioMs: Math.round(m.ttfbMs ?? -1) });
      if (m.type === "eou_metrics") log("end of turn", { afterSpeechMs: Math.round(m.endOfUtteranceDelayMs ?? -1), transcriptMs: Math.round(m.transcriptionDelayMs ?? -1) });
    });

    // Claude failed twice in a row: the character says goodbye (character.ts Trouble), and the chat ends once it has
    // been said, or after GIVE_UP_SECONDS if it never plays.
    let givingUp = false;
    const giveUp = () => {
      givingUp = true;
      setTimeout(() => void end("error", false), GIVE_UP_SECONDS * 1000).unref();
    };
    session.on(voice.AgentSessionEventTypes.AgentStateChanged, (ev) => {
      if (givingUp && ev.oldState === "speaking") void end("error", false);
    });
    const character = new CharacterAgent(meta, setMood, () => ctx.room.localParticipant!.streamText({ topic: "ftv.words" }), giveUp);
    // each reply keeps the mood it was spoken in, on its own history item (toClaude puts the tags back)
    session.on(voice.AgentSessionEventTypes.ConversationItemAdded, (ev) => character.keepMood(ev.item));
    await session.start({
      agent: character,
      room: ctx.room,
      inputOptions: { closeOnDisconnect: true, deleteRoomOnClose: true },
      record: false, // no audio, transcripts, traces or logs uploaded to LiveKit Cloud
    });
    await ctx.connect();

    // The character speaks first, in the mood the face is in: its greeting, word for word; or, when the visitor comes
    // back for another chat, a new opening (the greeting again sounded like a recording).
    const start: Mood = meta.startMood;
    setMood(start);
    if (meta.again) session.generateReply({ instructions: againNote(meta.greeting) });
    else {
      character.script(meta.greeting, start);
      session.generateReply();
    }
  },
});

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  cli.runApp(new ServerOptions({ agent: fileURLToPath(import.meta.url), agentName: AGENT_NAME }));
}
