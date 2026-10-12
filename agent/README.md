# The character agent

A [LiveKit Agents](https://docs.livekit.io/agents/) worker (Node, TypeScript) that plays a Face to Voice character in a
live voice conversation. The web app's token route dispatches it by name (`ftv-character`) into a new room with the
character's voice, instructions and greeting signed into the token, so nothing it trusts comes from the browser.

```
visitor's mic ─► Silero VAD + turn detector (local) ─► speech to text (LiveKit Inference, AssemblyAI)
              ─► Claude Haiku 5.5 (character.ts llmNode: thinking off, prompt caching)
              ─► ElevenLabs eleven_v4_turbo in the character's designed voice ─► the room
```

| File | What it does |
|---|---|
| `src/main.ts` | The session: limits (time, goodbye, idle end after one check-in), errors, logs, the opening line |
| `src/character.ts` | The agent: Claude, the conversation as Claude reads it, mood tags, word timings and loudness for the lip sync |
| `src/elevenTimings.ts` | Word times rebased onto the reply's own clock (the plugin's are off on v4's dialogue socket) |
| `src/onset.ts` | Where the voice starts and its loudness, 10 ms at a time, as the browser measures them |
| `src/mood.ts` | The leading `[happy 2]` of a reply: a v4 audio tag for the voice, `ftv.mood` for the face |
| `src/metadata.ts` | The dispatch metadata, checked, with limits the metadata can't raise |
| `src/canned.ts` | A development stand-in with no AI behind it (`FTV_MOCK_AGENT=1`) |

How it fits with the web app: [docs/architecture.md](../docs/architecture.md#live-conversations). What it stores and
logs: [docs/responsible-ai.md](../docs/responsible-ai.md#live-conversations).

## Run it locally

Requirements: Node 24+ (it runs the TypeScript directly) and pnpm.

```bash
cd agent && pnpm install
node --env-file=../web/.env.local src/main.ts dev
```

It reads `LIVEKIT_URL`, `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET`, `ELEVENLABS_API_KEY` and `ANTHROPIC_API_KEY`
(optional: `CLAUDE_MODEL_TALK`, `TTS_MODEL_TALK`). Run the web app with the same LiveKit project and open Chat on the
Meet step.

A worker registers with the whole project: while one runs on your machine, the project's conversations, the live
site's included, can be sent to it. Use a separate LiveKit project for development.

**Without paid calls:** run a local LiveKit server and the canned agent, which plays recorded clips (from
`pipeline/tests/fixtures`, or `pipeline/out/lipsync/clips` once the app has saved some in development):

```bash
livekit-server --dev
LIVEKIT_URL=ws://127.0.0.1:7880 LIVEKIT_API_KEY=devkey LIVEKIT_API_SECRET=secret FTV_MOCK_AGENT=1 node src/main.ts dev
```

with the web app on the same server (`LIVEKIT_URL=ws://127.0.0.1:7880`, `LIVEKIT_API_KEY=devkey`,
`LIVEKIT_API_SECRET=secret`) and both mocks on.

```bash
pnpm test && pnpm typecheck
```

## Deploy (LiveKit Cloud)

The `Dockerfile` builds the image; `livekit.toml` names the project and the agent.

```bash
lk cloud auth                     # once: link the CLI to the project
lk agent deploy                   # from agent/: build and roll out the current code
lk agent status
lk agent update-secrets --secrets "ANTHROPIC_API_KEY=…"   # restarts the agent
```

LiveKit Cloud provides `LIVEKIT_URL`, `LIVEKIT_API_KEY` and `LIVEKIT_API_SECRET` itself; the secrets are
`ELEVENLABS_API_KEY` and `ANTHROPIC_API_KEY`. The image runs with `LOG_LEVEL=fatal`, because the framework's own log
lines can quote what was said. On the free plan an idle agent sleeps, so the first conversation after a while takes
10–20 s to start (the browser says "Waking … up").
