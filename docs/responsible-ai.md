# Responsible AI

Face to Voice turns a synthetic face into a synthetic voice. Two models make judgements about how a character looks
(Claude) and how it sounds (ElevenLabs Voice Design). This page says what they are allowed to do, what they are not,
and how that is enforced.

## Synthetic faces only

- The head is generated from Google's GNM model and shaped with sliders. The app has no photo upload and no camera:
  the image Claude sees is a screenshot of the 3D canvas, taken in the browser when the visitor asks for a voice.
- The casting brief tells Claude that the image is a synthetic head, not a photograph, and that it must **never name or
  guess a real person** or write a real person's name in any field. A real name in the voice description would make
  Voice Design imitate that person, and guessing identities from faces is face recognition; neither has a place here.
- Limit: the design route checks that the image is a same-origin JPEG of bounded size, not that it is a render. A
  scripted client could send another picture; the guard in the brief and the rate limits still apply to it, and what
  Claude reads from it is cached for that visitor only, so it never becomes another visitor's casting.

## No real voices

- Every voice is new. Voice Design creates voices from a text description; nothing in the app records, uploads or
  clones a voice, and there is no instant or professional voice cloning anywhere in the code.
- The exported voice sample comes with terms: it is AI-generated, must not be presented as a real person, and must not
  be used to clone a voice or to train, fine-tune or test a model (ElevenLabs Prohibited Use Policy).
- The UI says where voices come from ("Voices by ElevenLabs. Not affiliated.").

## How the casting reads a face

The product idea is that everything visible shapes the voice, the way a game casts a character from its model. That
includes features people care about, so the choices are explicit and inspectable:

| Field | Who decides | Guard |
|---|---|---|
| Gender of the voice | Claude, from the whole look (face, hair, facial hair, lashes, styling) | `neutral` is allowed when the character reads as neither; shown to the visitor next to the voices |
| Age | Claude, from the face and the Age slider (passed as a number) | the age range is a fixed enum |
| Expression | the visitor's chosen emotion, set by the server, not inferred | fixed list of 12 emotions |
| Ethnicity label | Claude: a broad group ("black", "east asian") or "unclear"; a region only when styling or persona points there | free text of 1–3 words, used only as part of the voice persona |
| Accent | Claude proposes three plausible accents; the server picks one per face | the brief says skin tone alone does not say where someone grew up and asks for a spread of plausible places, so one look does not map to one accent (on darker-skinned faces the most common accent fell from about 70 % of castings to about a third) |
| The character's line | Claude | two sentences, family-friendly, no slurs, never about the character's skin or ethnicity, no real people |

These are casting choices for a synthetic character and lean into stereotypes on purpose, the way game casting does.
They say nothing about real people. The visitor sees the reading next to the three voices ("Reads as …") and can open
the exact prompt sent to ElevenLabs. The same face keeps the accent it was first cast with whatever its expression, so changing the mood never
changes who the character is.

## Character profiles

Once a voice is chosen, the visitor can meet the character: Claude writes a profile (a name and a game-style title,
a short backstory, traits, habits, quirks, loves and hates, catchphrases, what they want right now, a mood and the
first words of a conversation) that a live conversation will play.

- **Always made up.** The brief says the character is invented and must never take the name of a real person, living
  or dead, or of a famous fictional character, nor describe one. Fixed fields (traits, pace, vocabulary, mood) are
  JSON Schema enums; free text is cut to fixed lengths and cleaned of brackets and markup.
- **Written from server data.** Claude reads the casting the server cached for this visitor and face, and the look the
  server kept with it (as ids); the browser only names which face and voice. A profile is shared by everyone who meets that voice, like the
  voice itself; "Reimagine" writes another one for that visitor only. Visitors can't edit a profile.
- **What they want stays in the story.** A character's want is a small goal from their own life ("to find whoever
  keeps moving my lobster pots"), never dangerous; asking the visitor's opinion or help with it is part of the game,
  and nothing they want needs anything from the visitor in real life (no money, details or meetings).
- **Limits.** 20 new profiles per visitor a day; 100 a day in total (`DAILY_CAP_PROFILES`).

## Live conversations

After meeting the character, a visitor can talk to them out loud for up to three minutes (LiveKit, Claude
Haiku 5.5, ElevenLabs v4 Turbo with the character's own designed voice).

- **The visitor's speech reaches a prompt.** Their microphone is transcribed (AssemblyAI, through LiveKit Inference) and
  the words become the user turns of Claude's conversation. They only ever reach the visitor's own conversation: the
  character's replies are spoken to that visitor alone and are not kept. The app's own notes to Claude can't be faked
  by saying them.
- **The character stays a made-up character.** The instructions are built on the server from the profile, quoted as
  data, with rules after it that always win: never claim to be or imitate a real person; say plainly that it is an AI
  character when sincerely asked; stay family-friendly and refuse harmful, sexual, hateful, dangerous or illegal
  requests in character; don't ask for personal details; no medical, legal or financial advice beyond common sense.
- **The browser can't change the character.** The voice id, the instructions and the limits are read from the
  server's own records and signed into the LiveKit token; the browser only names which face and voice. The token lets
  it join one room with a microphone and nothing else (no data, no video), within 20 seconds.
- **Limits, enforced by the server and the agent:** one conversation at a time; 10 a day per visitor and 20 a day in
  total; at most three minutes (the agent says goodbye and ends it, and never runs past five minutes whatever it is
  told); after 15 seconds of silence the character checks in once, and 15 more end it; the microphone is asked for
  before anything is paid for. Talking can also be made invite-only (`TALK_INVITE_CODES`, with `TALK_PUBLIC` unset).
- **What is stored:** by Face to Voice, nothing of the conversation (no audio, no transcripts); the agent's logs hold
  timings and token counts, never words (the agent framework's own logs, which can quote them, are kept to fatal
  errors). LiveKit carries the audio between the browser and the agent; its session recording is turned off for every
  conversation (`record: false`). The transcription, Claude and ElevenLabs requests
  fall under those providers' own API data policies.

## What reaches the models

- **From the browser:** the screenshot, the slider values (numbers in −1 … 1) and the look as short ids (hair style,
  colours, add-ons, emotion, pose). The server accepts only ids it ships and builds every sentence Claude reads (the
  slider summary, the look, the age and the expression) itself; no free text from the browser reaches a prompt, except
  the visitor's own speech in a live conversation (above).
- **To ElevenLabs:** a voice description built from a fixed template and Claude's enum fields, plus the line the
  character says; for speech, the visitor's line (at most 300 characters) with an audio tag built on the server from
  the emotion id.
- **Stored:** cached castings (per visitor), voice records and audio clips, keyed by hashes of the face and text;
  character profiles (shared per voice, or the visitor's own "Reimagine"), 30 days. No accounts, no
  screenshots, no raw IP addresses: visitors are counted by a salted HMAC of the IP. A character's rebuild link lives in
  the URL hash, which browsers never send to a server.

## Abuse and cost protection

Every paid route (`/api/voice/design`, `/select`, `/speak`, `/api/character/profile`, `/api/talk/token`) runs, in order:

1. a same-origin check (`Sec-Fetch-Site` and `Origin` must match; requests with no browser headers are refused in
   production);
2. Vercel BotID;
3. a per-visitor sliding window in Upstash Redis: 20 designs, 10 new voices, 100 lines, 20 new profiles and 10
   conversations a day;
4. a global daily cap: 200 castings, 20 designs, 10 saves, 20,000 spoken characters, 100 profiles, 20 conversations
   (configurable);
5. ElevenLabs' and Anthropic's own per-key quotas and spend limits, set in their dashboards.

Two routes charge only what they use. `/api/character/profile` spends the visitor's window and the cap only when it
writes a profile (a saved one is free). `/api/talk/token` (when invite-only, it first counts every try with an invite
code, 30 a day, so codes can't be guessed at) reserves the daily cap, and spends the visitor's conversation last, once a
conversation slot is theirs and the token is made; anything that fails before that gives the cap back.

Any Vercel deployment (production or preview) refuses the paid routes without Redis or without a rate-limit salt
(fail closed), and a slow Redis counts as a refusal. Speech reserves its characters against the daily cap before the
ElevenLabs call. Caches mean the same voice or line never costs twice. When a cap is reached the visitor gets a plain message or a pre-designed
studio voice, never an upstream error body.
