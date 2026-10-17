# Architecture

Face to Voice has two halves joined by files: an offline Python **pipeline** that turns the GNM head model into
morph targets, limiter data and assets, and a **web app** that renders, constrains and voices the head. A third part,
the **agent** (`agent/`), plays the character in a live conversation on LiveKit. Only the web app's server side and the
agent talk to Claude and ElevenLabs; the browser never holds a key.

```
 pipeline/ (uv, numpy)                         web/public, web/src/data              web/ (Next.js)
 ────────────────────────────                  ─────────────────────────             ──────────────────────────────────────────
 gnm.py        GNM npz (sha-pinned)  ──┐
 export_glb.py parts + morph targets ──┼──►  models/head.glb, head.extra.glb   ──►  Head.tsx      meshes, eye pivots, materials
 semantic.py   Shape directions      ──┤      data/sliders.json, ageing.json    ──►  morphs/store  weights → morphTargetInfluences
 emotions.py   ExpressionSampler means ┘      data/random.json                  ──►  morphs/random Random face, Distinctiveness
 validate/     ranges, exact checks  ──────►  data/limits.json, fxReach.json    ──►  morphs/limits limiter (page + Web Worker)
               stress test  ◄───────────── headless Chrome drives the real app through window.__faceToVoice (dev / ?debug)
 groom.py …    hair, brows, lashes,  ──────►  models/hair, models/addons        ──►  groom.ts      strands on the GPU, roots on the skin
               beards, glasses                                                        glassesFit.ts seat and splay at runtime
                                                                                      lipsync/       PCM player, live voice, cues, evaluator
                                                                                      server/        /api/voice/{design,select,speak}
                                                                                         │  Claude (casting)  ElevenLabs (design, TTS)
                                                                                         │  /api/character/profile  Claude (profile)
                                                                                         │  /api/talk/token  LiveKit token + dispatch
                                                                                         └─ Upstash Redis (limits, caches) + Vercel Blob (audio)
                                                                                      talk/          the conversation in the browser
                                                                                                         │ LiveKit room
                                                                                      agent/ (Node)  STT → Claude Haiku 5.5 → ElevenLabs v4 Turbo
```

## Numbers

| | |
|---|---|
| Model export | 125 morph targets, every vertex and delta within 6 µm of the source; 2.88 MB brotli for both files |
| Limiter | blocks only impossible geometry; a slider grab costs one frame, per-face animation caps run off the main thread |
| Stress test | 8 families of states, each exact-checked: Random face, Random character and animation driven in the real app in headless Chrome, single sliders, pairs, multi-slider faces, fine-tune and add-ons generated with the limiter's Python mirror; 0 of 223 single-slider ends and 0 of 4,224 slider pairs broken ([table](#the-limiter-and-the-stress-test)) |
| Load | head visible after 0.43 s on desktop, 0.68 s on a phone (4× CPU); 532 KB of JS in the page's HTML (gzip), the 3D scene loading after it |
| Frame time | 60 fps on a phone profile while dragging, switching emotions and speaking; Lighthouse performance 99 desktop / 62 mobile |
| Accessibility | WCAG 2.2 AA: radio-group chip rows, sliders that announce their value in words, a text alternative for the head; axe finds nothing on desktop or phone; Lighthouse 100 / 100 |
| Tests | 439 vitest tests for the web app, 32 for the agent and 158 pytest tests for the pipeline, plus a smoke test of the built app in headless Chrome, run in CI on every push |

Measured on an M4 Pro with headless Chrome; phone numbers use a 390×844 viewport at DPR 3 with 4× CPU throttling.

## Pipeline → morph targets

- **One linear model, exact targets.** A GNM face is `mean + Σ wᵢ·componentᵢ`, so a component at kσ is an exact morph
  target (k = 3; weight 1 in the app = 3σ). 30 identity and 40 expression components go into `head.glb`; the 33 Shape
  sliders and 12 emotions (each split into upper and lower face) go into `head.extra.glb`, which loads after the first
  frame and is appended to the same meshes by index. A part carries only the targets that move it by more than 0.01 mm.
- **Verified, not trusted.** gltfpack quantises positions to 16 bits and reorders vertices. `uv run verify` decodes the
  packed files, maps vertices back, and checks every position and morph delta against the float32 source (max 5.8 µm
  and 3.5 µm), and that both files share vertex order per mesh.
- **Shape sliders are solved, not picked.** For each slider `semantic.py` solves one direction over the 170 head
  components: maximise the change of its own landmark measurement (a distance, a position, or movement along the surface
  for "fullness") subject to holding every other measurement and the guards (lip seal, eye clearance), with a penalty
  for movement outside its face region and a prior that keeps the face likely under the model. Linearity makes the
  whole thing a small least-squares problem per slider.
- **Ranges from anthropometry.** `validate/ranges.py` measures the GNM mean against pooled adult surveys (ANSUR II,
  NIOSH, 3DFN) and sets each end at ±4.5 SD of the feature, pulled back where any measurement it moves would leave the
  published adult range or where a single slider first breaks geometry (`--sweep`). The UI shows −1 … +1 with each half
  scaled to its own end.
- **Age** is a mix of Shape directions taken from facial-ageing studies (`config/age.toml`) plus wrinkles drawn by the
  skin shader from landmarks, so nothing extra is downloaded. **Random face** samples the model, and a Distinctiveness
  slider pushes 2–4 striking features from different face areas toward their ends.
- **Expressions.** Twelve emotions are label means over 1,024 samples each from GNM's ExpressionSampler; sad, angry and
  afraid are composed per face part with millimetre goals, since GNM has no such labels. Each is split into an
  upper-face and a lower-face target so the mouth can step back while the voice speaks. Eleven Fine-tune controls add
  to the emotion, and their travel scales to what the emotion leaves room for (`validate --fx-reach` →
  `fxReach.json`): no measure goes past the furthest a real expression takes it.

## The limiter and the stress test

The rule is "weird faces yes, impossible faces no". Two implementations of the same checks:

| | Pipeline (`validate/checks.py`) | App (`web/src/lib/morphs/limits.ts`) |
|---|---|---|
| Purpose | the exact verdict, offline | stop sliders and animations before they break, in real time |
| Eyes | skin inside the visible eyeball; rays from the eye pivot through every eye point | closest point on candidate eye triangles; K = 32 ray candidates |
| Crossings | triangle/triangle intersection depth on the full mesh | the same test on the 6,829 triangles that ever crossed in a broken face (grid broad phase) |
| Lips | inner edge past the other lip's outer edge | same |

The app's limiter is a strict superset of the exact check (slightly tighter thresholds), so a face it lets through
passes the exact check. It answers three questions:

1. **span** (on grab): how far this slider may go each way with the others fixed, by bisection along the slider's line
   (positions are linear in one slider). The span becomes the track, so the thumb never meets a wall.
2. **caps** (on settle): how strongly blink, emotion and each viseme may play on this face, judged against the average
   face doing the same thing plus 0.5 mm, so GNM's own motion is never "broken".
3. **reach** (Random face): how far a striking feature may be pushed.

Caps, look-ahead spans and the reach questions of Random face and Random character run in a Web Worker
(`capsWorker.ts`) on a copy of the tested vertices; the page keeps a lazy stand-in (`limiter.ts`) so the 80 KB-gzip
limiter chunk loads after the head's first frame. Morph targets carry no normals, so `normals.ts` recomputes them as
the shape moves; on a slow device the live recomputes run in `normalsWorker.ts` (same arithmetic), the final one here.

**Coverage grows from failures.** `validate --vlimits` and `validate --grow` find broken faces (slider pairs, random
multi-slider rays, failing animation poses) and add their crossing triangles to `limits.json`.

**Stress test.** `uv run validate --stress` writes identities, runs `web/scripts/stress-states.mjs` against the app in
headless Chrome (through the `window.__faceToVoice` debug handle), and exact-checks every state the app produced:

| Family | Tested | Broken |
|---|---:|---:|
| Single sliders at both ends | 223 | 0 |
| Slider pairs at the limiter's stop | 4,224 | 0 |
| Multi-slider faces at the limiter's stop (held-out seed) | 3,000 | 3 (0.10 %) |
| Random face, Distinctiveness 0.5–2.5 | 1,500 | 2 |
| Random character | 50 | 0 |
| Extreme faces × animation | 1,470 | 8 (≤ 1.2 mm) |
| Extreme faces × fine-tune sliders | 3,395 | 14 (≤ 0.5 mm, inside the eyelid) |

The remaining multi-slider failures are the documented coverage gap: the limiter only knows crossings the pipeline has
seen. Thin-lipped extremes keep their mouth shapes capped low on purpose (teeth would otherwise show through the lips).

## Hair and add-ons

- **Strands** (`.strands.bin`, gzip, decoded in a worker) store root positions and points per strand. `groom.ts` draws
  each as a camera-facing ribbon in the vertex shader; per-tier child strands are generated on the GPU around each
  guide; alpha-to-coverage under MSAA replaces sorting; Kajiya-Kay shading with a per-point baked self-shadow; no shadow
  maps.
- **Following the skin.** Each root is tied to its three nearest skin vertices at load (by the strands worker while it
  decodes, `skinTie.ts`). Per frame only the morph weights that changed
  are summed into a root-offset texture, so hair, brows and lashes follow sliders, blinks, expressions and speech.
  Lashes also turn with the live eye and their own skin's shape change; brows follow shape changes per point.
- **Glasses** are built from numbers (`config/glasses.toml`) and seated on the average head by an optician's solver
  (pads on the nose, arms past the temples onto the ears). In the app they are rigid: identity targets on their anchor
  points (best-fit transform plus arm splay) and, when the
  shape settles, a ray-parity inside test on the skin decides how far to slide them forward (≤ 6 mm) and open the arms
  (in a worker: `glassesWorker.ts`; a new frame shows once its first fit is on).
- **Pipeline fits.** Hair is fitted onto the GNM head by similarity ICP on the cranium, roots snapped to the scalp,
  strands pushed out of the skin. Brows and beards grow inside outlines read from saved CC0 guides
  (`pipeline/config/guides/`); lashes grow along the lid margins. The stress test's add-on family checks clipping and
  floating on extreme heads.

## Voice and lip sync

```
browser                         server (route handlers)                         providers
───────                         ───────────────────────                         ─────────
screenshot, sliders, look ids ─► guards (same-origin, BotID) → visitor limit → daily cap
                                 casting cache hit? (visitor + face) ────────► Claude: casting fields (structured)
                                 prompt.ts template → descKey cache hit? ────► ElevenLabs Voice Design (3 previews)
choose a take ─────────────────► save as voice (pool LRU, slots, studio fallback) ► ElevenLabs voices
speak a line ──────────────────► tts cache (Blob) hit? ──────────────────────► ElevenLabs TTS stream + timestamps
                                 whole line in → forced alignment on its audio ► ElevenLabs Forced Alignment
PCM + aligned times ◄─────────── NDJSON with the aligned line in front, then written to Blob
```

- **Casting.** The browser sends a 768 px screenshot of the character as styled, the Shape slider values and the look
  as ids. Claude (Sonnet 5, vision, structured output held to a fixed schema) casts it like a game voice director:
  gender, age range, how much of a character it is, build, energy, pacing, pitch, two moods, three candidate accents, a
  persona, a timbre, a delivery quirk and a two-sentence line. `prompt.ts` turns that into the Voice Design prompt; the
  expression on the face opens the prompt's emotion and the line is written in that state. The accent is remembered per
  face at rest, so an angry and a calm version of a face get different voices of the same character.
- **Speaking.** Each line goes to `eleven_v4_turbo` with an audio tag for the expression at three strengths (e.g.
  `[cheerful]`, `[happy, bright and bouncy]`, `[overjoyed, laughing, bursting with energy]`), built on the server from
  the emotion id. On the recorded test lines every p/b/m closure seals and the lips release within ~15 ms of the burst.
  The server reads the whole line (ElevenLabs streams it ~0.55 s after its first byte) and times it by forced alignment
  on its own audio (~0.3 s, `lib/server/alignSpeech.ts`): eleven_v4_turbo's own stamps come from the text and can put a
  word ~0.2 s off. The aligned times go to the browser as one NDJSON line before the audio, and into the cache, so a
  replay is free; a line cached before alignment is aligned on its next play. If the alignment can't be had, the line
  plays on its stamps.
- **Caching is the cost model.** Voices are keyed by the normalised description (`descriptionKey`), so everyday faces
  with the same casting share a voice and only characterful ones get their own; lines by voice, model and text. The
  casting is keyed by the visitor and the quantised face and look: it is read from a screenshot, and the same face
  renders to different bytes on every page load (idle motion), window size and GPU (measured), so the image can't be
  part of a shared key, and whatever a client sends as its screenshot must not reach another visitor. Every key carries
  `PROMPT_VERSION`.
- **No browser text in prompts.** The slider summary Claude reads is built on the server from the validated slider
  values; the look arrives as ids from the shipped lists.
- **Fail closed.** Deployed on Vercel (production and previews), the paid routes refuse to run without Redis or without
  `RATE_LIMIT_SALT`; in development everything falls back to memory. A slow Redis counts as a deny, never a free pass.
  Every paid call (casting, design, save, speech) reserves its share of the daily cap first and gives it back if the call
  fails. A spoken line is cached only when the stream was the whole line.
- **One paid job at a time.** A Redis lock per description (design) and per take (save): a second request waits for
  the first one's result instead of paying again. The voice pool is one hash field per take, so concurrent requests
  never drop each other's entries, and speaking with a voice moves it to the back of the eviction queue.
- **Lip sync: the clock** (`web/src/lib/lipsync/`). `player.ts` schedules PCM chunks gaplessly on the AudioContext
  clock and keeps a loudness envelope plus one above 2 kHz (`envelope.ts`). `clock.ts` turns that clock into what is
  heard now: the reported output delay, plus the measured extra for Bluetooth and iPhone Safari, smoothed between
  Chrome's 10.7 ms clock steps. The player's context rests (suspended) between lines, and a line's first audio waits
  until it runs again.
- **Lip sync: the sounds.** `cues.ts` maps words to visemes from their phonemes. The CMU Pronouncing Dictionary stays on
  the server: a spoken line arrives with its words' phonemes as its first NDJSON line (`lib/server/pronounce.ts`), and
  a live reply's words are looked up in one batched request to `/api/phonemes`. Words it doesn't know fall back to
  TalkingHead's letter rules (numbers spelled out, tag characters dropped, a silent "h" takes the next vowel's shape,
  unstressed "a/the/of/-ably" weak).
- **Lip sync: placing them on the audio.** A line on the voice's own stamps (a live reply, or a line the alignment
  failed for) goes through `placement.ts`: it is placed on the voice onset, and so is each phrase after a pause where
  its stamps are far off. Closures (p/b/m, f/v, th) snap to the quiet-then-burst in the audio (an "m", which hums on,
  in the treble; two p/b/m with no vowel between, "Bob bought", share one closure) and vowels to loudness peaks,
  keeping the sounds in spelled order (eleven_v4_turbo spaces a word's letters evenly). Because v4 times letters from
  the text, the audio corrects it: the sounds after a p/b/m or f/v follow its release, a vowel stamped in silence finds
  its syllable (a breath doesn't count), and a phrase's last vowel holds while the voice draws it out.
- **Lip sync: the mouth.** `evaluator.ts` blends the cues with anticipation, closure dominance and smoothing
  (`shapes.ts`), and `mouth.ts` (run by `LipSync.tsx`) writes them into the viseme morph layer, capped per face by the
  limiter and held to a top speed for the lips and the jaw (`visemes.json` "speed"). How far the jaw opens follows the
  loudness syllable by syllable, measured against the loudest moment nearby, so a line that trails off still forms its
  last words; the lips keep the sound's shape under a softer gate, and keep a vowel's rounding or spread while the
  loudness takes the opening away. The tongue tip rises for d/t/n/l on a track of its own, and every movement eases in.
- **Lip sync: on time.** The whole mouth runs 30 ms ahead of the sound: as drawn, the lips part on each p/b/m burst
  (measured in Chrome, Firefox and Safari with `qa/lipsync`; [the lip-sync report](lipsync-report.md)). Tuning values
  and the reason for each are in `tuning.ts`.
- **Safari's audio route.** In Safari (Mac, iPhone, iPad) the sound of lines and chats plays through a hidden `<audio>`
  element as a live MediaStream, not the context's own output (`lib/lipsync/output.ts`). That output, shared by every
  context in the tab, could fall behind and stay behind (0.8 s late or silent, reported on time, kept across a
  reload); a stream has no queue to fall behind in. The heard clock adds the route's 75 ms. Chrome and Firefox, given
  the same trigger, stayed on time.

## Live conversations

```
browser (Meet step)                    Next.js                                   LiveKit (room)              agent/ (Node worker)
Talk ─► mic permission ─► /api/talk/token: guards, invite, limits, a conversation slot
                          voice id (record) + profile (cache) → instructions (characterPrompt.ts)
      ◄─ token (20 s, mic only, roomConfig dispatches "ftv-character" + metadata)
room.connect ─────────────────────────────────────────────────────────────► talk-<uuid> ◄── job ── AgentSession
◄── voice track, lk.agent.state, lk.transcription, ftv.mood, ftv.end ◄──────────────────────── VAD + turn detector,
                                                                                             STT (Inference), Claude Haiku 5.5
                                                                                             (own llmNode), ElevenLabs v4 Turbo
```

- **Trust boundary.** The token is signed with the API secret, so the agent can trust its dispatch metadata; the
  browser can read it (a JWT) but not change it. Nothing secret goes in.
- **The agent's own LLM step.** The Anthropic plugin can't disable thinking or cache, so `CharacterAgent.llmNode`
  streams from Claude directly (thinking off; prompt caching on the instructions and, automatically, the conversation,
  which is rebuilt byte for byte each turn so every reply reads the whole conversation so far from the cache) and
  pulls the reply's leading `[mood n]` tag off: it becomes a v4 audio tag for the voice and the `ftv.mood` attribute
  for the face.
- **The voice stays put.** The token route pins the voice (`ftv:talk:pin:<id>`) so the LRU pool never evicts it
  mid-conversation (a save checks the pins again just before it deletes); a slot set in Redis, taken under a lock,
  allows five conversations at a time (`MAX_CONCURRENT_TALKS`), and LiveKit's own room list frees slots of
  conversations that ended early. The visitor is charged only once a slot is theirs, and "Have another chat" ends only
  the room it names.
- **Limits live in the agent too**: the conversation length (capped at five minutes whatever the metadata says),
  the away timeout, and close-on-disconnect; session recording is off.
- **Live lip sync.** The agent forwards each reply's word timings ahead of its audio (`ftv.words`): ElevenLabs'
  dialogue socket restarts each message's character times at 0, so `agent/src/elevenTimings.ts` rebases them onto the
  reply's clock (within a sentence, each message follows on from the last one's last character, but never starts later
  than its own audio) and times each word from its first letter to its last. It also sends where the
  voice starts on that clock and the reply's loudness as it made it, 10 ms at a time (`agent/src/onset.ts`). The
  browser plays the voice through Web Audio and meters it with an AudioWorklet (the player's envelopes). It pins each
  reply's words to the onset it hears, then keeps them on the voice by matching what it hears against the agent's
  loudness. Where the voice comes back after a pause in the agent's audio, the nearest word moves onto it, because v4
  Turbo's live stamps come from the text, not the audio ("Someone" 330 ms late). Bursts under 150 ms (breaths, clicks)
  don't count: matched on the heard audio instead, they pulled a greeting's last words a second early, and the error
  grew with every pause. `frameTargets` (shared with the speech player) reads both. The voice (and its captions) is
  held back 130 ms so the lip sync sees each sound before it is heard, as it does a recorded line.
- **The character.** The profile is written once per voice, under a lock (two visitors meeting the character at the
  same moment get one profile), from the visitor's cached casting and the look the server kept with it, never the
  look the browser sends later. It (`profileSchema.ts`) gives them a title and something they want right now; the
  instructions put the want first ("What's on your mind"), and the agent's first answer to the visitor carries a note
  to work it in (Haiku left it out otherwise). Recast sends Claude the current profile to share nothing with, and a
  life to centre the new one on.
- **What the visitor said, once.** LiveKit Inference's AssemblyAI stream sends each turn final twice, formatted and
  plain, and the session joins them: the agent drops the plain copy before Claude reads it
  (`withoutPlainCopies`), and the "You:" line keeps one of each (`lib/talk/heard.ts`).
- **One AudioContext for every chat.** Made in the first tap and paused between chats: a new one per chat ran its clock
  ahead of the voice in "Have another chat", and the mouth read silence.
- **The face reacts.** Each reply's mood blends the expression (`MOTION.blend`), the head nods along while the visitor
  talks and once as the character answers; the visitor's own expression returns after the chat.
- **Development without paid calls:** `livekit-server --dev` plus `FTV_MOCK_AGENT=1`, a canned character that plays
  recorded v4 clips with their real timings and takes turns on the visitor's loudness (`agent/src/canned.ts`).

## Export

Client-side only. `portrait.ts` renders the current character into a 1024² square on black and white and takes the
difference matte for transparency; `characterCode.ts` serialises the look (also the `/#c=` rebuild link, read before
anything restores so a reload shows exactly the linked character); `zip.ts` is a small store-only zip writer with
CRC-32; `licence.ts` decides the licence of each piece and of the whole face (the most restrictive wins). Voice
Design is not reproducible from a seed (probed), so the zip carries the chosen take's audio as the exact artefact.
When the character has been met, the zip also carries their profile (`profile.json`, and a Character section in its
README).

## Key decisions

| Decision | Why |
|---|---|
| Morph targets, not a runtime GNM | linear model → exact, GPU-native, no WASM; 2.9 MB brotli for 125 targets |
| Two GLB files | the first frame needs 70 targets; the other 55 load once the head is on screen (a face restored after a reload fetches them with the head) |
| Weights in a plain store, not React state | sliders, tweens and idle life write at 60 fps with zero re-renders |
| Limiter on vertices, not linear probes | per-slider linear limits did not converge on multi-slider faces; geometry tests do |
| Superset limiter + offline exact check + stress test | the app stays fast, the pipeline stays exact, the stress test proves the two agree |
| Strands over textured hair cards | cards read as flat caps; strands look like hair and follow the skin root by root |
| Claude fills a schema; a template writes the prompt | prompts stay consistent, cacheable and testable; browser text never reaches a prompt |
| Save per take, LRU pool + studio voices | voice slots and monthly add/edit operations are the scarce resource, not credits |
| Client-side export | no server cost, no storage of visitors' characters |
| A LiveKit agent for conversations, dispatched by a server-signed token | the browser only joins a room; the voice, the profile and the rules the agent trusts are signed by the server |
| The agent's own Claude step, not the plugin's | thinking off and prompt caching (the plugin sends neither), and the reply's mood tag taken off for the voice and the face |
| The live voice played through Web Audio, held back 130 ms | what the mouth measures is what is heard, and it sees each sound before the visitor hears it |
| Lip sync pinned to the agent's own audio, not to what is heard | breaths and clicks in the heard audio threw phrases off, more with every pause; the agent's loudness is clean and arrives first |
