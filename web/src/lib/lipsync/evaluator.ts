/**
 * Per-frame viseme activations from cues. Each cue ramps in before its onset (anticipation),
 * holds, and ramps out after; closed shapes (PP/FF) dominate open ones so lips can actually
 * close mid-vowel; the mouth group is capped at 1 so additive morphs never over-drive; and a
 * frame-rate-independent exponential smoothing removes flicker. Tune attack/release first.
 */
import { VISEME_IDS, type Cue, type VisemeId } from "./cues";

export const LIPSYNC = {
  /** Seconds the mouth runs ahead (+) or behind (−) the sound: the whole mouth (shapes and loudness) is evaluated this
   *  far ahead. ?lipsyncOffsetMs= overrides. 0 put the mouth on the sound as computed (against a forced aligner,
   *  2026-10-09), but as drawn it trailed by 20–30 ms (smoothing, speed limit, the frame reaching the screen), and a
   *  real mouth moves before its sound: 30 ms looked right by eye (live chats, 2026-10-11: 60 "a slight
   *  delay", 90 "ahead"), then 80 once the shapes followed the voice more closely (2026-10-11: "−50 ms makes it good"
   *  on the Sync slider, Speak and chats). Measured on real devices (2026-10-13, qa/lipsync, LIPSYNC_REPORT.md) 80 put
   *  the whole mouth 50–75 ms ahead and parted the lips before each p/b burst; with the closures placed on the audio
   *  (placePhrases, the pause rule in syllableBetween) 30 lands the releases on the bursts as drawn in Chrome, Firefox
   *  and Safari (20 was +6 ms on the bench's perfect clock, +17–23 ms in the browsers). The moving ahead a real mouth
   *  does is per sound: closures start forming attack + closureOnShift before their silence. */
  lead: 0.03,
  attack: 0.06, // s before a cue starts that its shape begins to form
  release: 0.09, // s after a cue ends that its shape has faded
  /** Closures snap shut and let go fast, so the vowels around a "p" stay open. */
  attackFor: { PP: 0.03, FF: 0.04, TH: 0.04, DD: 0.03 } as Record<string, number>,
  releaseFor: { PP: 0.03, FF: 0.06, TH: 0.06, DD: 0.04 } as Record<string, number>,
  /** Smoothing time constants (s). The speed limit (gapSpeed / jawSpeed) keeps the motion calm, so the open shapes can
   *  follow quickly (default 0.06 → 0.04 on 2026-10-09: vowel peaks ~15 ms earlier, closures press better). */
  tau: { PP: 0.03, FF: 0.035, TH: 0.035, default: 0.04 } as Record<string, number>,
  /** Vowels and lip closures are what the eye reads; quick consonants stay subtle. */
  peak: { PP: 1, FF: 1, TH: 0.85, DD: 0.35, SS: 0.5, CH: 0.8, default: 1 } as Record<string, number>,
  /** An unstressed vowel (a schwa: "a", "the", "of", "-ably", Cue.weak) opens only this far, however long it is. 0.45
   *  with the calmer 2026-10-15 shapes left "A king…", "A cup…" barely moving (user review). */
  weakPeak: 0.6,
  /** An "r" (a glide folded to the "oo" shape) rounds the lips only this much, however long: at full it puckered in
   *  the middle of "grass" and "through" ("an extra movement", user review 2026-10-15). */
  rPeak: 0.4,
  /** How much of an "l"'s tongue pose (visemes.json "ll": the tip at the edge of the upper teeth) shows; the rest is the
   *  "d"'s, behind the teeth. At 1 "soldiers" and "tool" showed "too much tongue" (user review 2026-10-15). */
  lateralShare: 0.4,
  /** s: an f/v or th lasts at most this long from where its hiss begins (a misplaced one took a whole word: "fast"). */
  hissMaxDur: 0.2,
  /** A hiss (s, sh, f, th) is loud, and the loudness gate opened the vowel before it again ("grass": open, half shut,
   *  open on the "s"; user review 2026-10-15). Where the treble outweighs the loudness (both over their own line peaks:
   *  vowel peaks ~0.55, f/v/th ~2.1, s ~2.8 on the Harvard lines) from `from` to `to`, the vowels' opening fades by up to
   *  `amount`: the jaw comes up for the hiss. The hiss shapes (s, sh, f, th) are left alone. */
  hissClose: { from: 1.2, to: 2.5, amount: 0.6 },
  /** How strongly the strongest shape suppresses the others (0 = plain additive, 1 = winner only). */
  emphasis: 0.45,
  maxGroupSum: 1.3,
  /** Open shapes are scaled by the audio's own loudness: fully open only while there is sound.
   *  gateFloor keeps quiet vowels visible; gateLevel is the loudness (0..1 of the loudest moment around it) at
   *  which the gate is fully open. Near 1, the loudness rather than the letters decides how far the mouth opens, so
   *  each syllable opens and closes with the sound (was 0.2 / 0.3: open for whole words; mouth vs loudness correlation
   *  0.62 → 0.76 on real chat replies, and it looked more like speaking, 2026-10-11). openGain then opens the
   *  shapes wider (capped at 1): "too closed" at 1. */
  gateFloor: 0.25, // 0.05 until 2026-10-15: with the calmer shapes a quiet "A" or "the" barely opened (user review); late releases 32 → 24 on the tuning lines
  gateLevel: 0.9,
  openGain: 1.5,
  /** The lips hold a vowel's shape while the loudness only takes the opening away, as in real speech (the jaw beats
   *  once a syllable; the lips stay rounded or spread through it). Gated as a whole, a quiet "oo" also lost its
   *  rounding: vowels reached 45–63% of their pose, and the mouth made ~3.5 open-close cycles a second ("too stiff",
   *  "o and u not round enough", 2026-10-11). As the gate closes, an "o" keeps its rounding in "u" (rounded,
   *  jaw nearly shut) and an "eh" its spread in "ee" (O, E: share of the vowel handed over); "ee" and "oo", mostly lip
   *  shape themselves, keep at least this much of themselves (I, U). The poses stay the solved, capped ones. */
  shapeHold: { O: 0.7, E: 0.5, I: 0.8, U: 0.85 } as Record<"O" | "E" | "I" | "U", number>,
  /** s ahead the gate reads the loudness (negative: behind). 0.03 opened the mouth as the sound started, but real lips
   *  (GRID, 4 talkers, qa/lipsync/human.py) start closing for a p/b/m ~90 ms before the sound falls and open widest
   *  ~27 ms after a vowel's loudest moment: at 0.03 the app closed ~100 ms ahead and peaked ~22 ms before; at 0, −86 ms
   *  and −12 ms; at −0.04 (with closureOffShift 0), −89 ms and +5 ms, f/v +67 ms vs the talkers' +74 (2026-10-14). */
  gateLookahead: -0.04,
  /** … for a chat (live.ts): its f/v stay on the agent's word times, and reading behind held the vowel before them open
   *  (live bench f/v +62 → +102 ms vs the talkers' +74). */
  liveGateLookahead: 0,
  /** The open gate measures the loudness against the loudest moment within ±gateLocal (s), not the line's peak: a voice
   *  trails off toward the end of a line ("…about it" ~20 dB down), and its last words would barely open. The reference
   *  never drops below gateLocalFloor (of the line's peak), so real pauses stay shut. 0 = the line's peak. */
  gateLocal: 0.75,
  gateLocalFloor: 0.15,
  /** The open gate reads the loudness averaged over this window (s), centred on t + gateLookahead:
   *  one 10 ms block flickers with pitch pulses and bursts, but the jaw only follows the syllable
   *  envelope. Symmetric, so it adds no delay. 0 = a single block. The closure
   *  gate and closure snapping keep the raw loudness: a "p" needs the real dip. */
  gateWindow: 0.06,
  /** The jaw is the heavy articulator: after the per-viseme smoothing, its morph goes through a
   *  second stage with this time constant (s), so it swings in syllable-rate arcs instead of
   *  kinking at every cue edge and slamming shut on a "p". Lips and the seal keep only the faster
   *  per-viseme smoothing. Costs ~10 ms of jaw lag at 0.03; 0 = off. Off since the speed limit (jawSpeed) took over
   *  calming the jaw (2026-10-09). */
  jawTau: 0,
  /** Closures are suppressed above this loudness (0..1 of the clip's peak) over a band this wide. */
  closureLoud: 0.4,
  closureBand: 0.3,
  /** Closures move to the nearest loudness dip in [stamp − snapBefore, stamp + snapAfter]. Most stamps run early, but
   *  a fast voice's can be 140 ms late ("peppers", a happy young voice, 2026-10-14): 0.12 missed those, 0.2 found them
   *  with no closure worse across 7 voices. */
  snapBefore: 0.2,
  /** Score candidate dips in dB (quiet − snapDbPerS × distance from the stamp), so a real silence a little further from
   *  the stamp beats a soft consonant next to it; 0 = the plain loudness + distance score. */
  snapDbPerS: 150,
  snapAfter: 0.16,
  /** A p/b/m then spans the closure the audio shows: from where the sound drops into the dip to the burst (the
   *  steepest rise after it), so the lips part when the sound comes back and back-to-back closures keep the vowel
   *  between them. The edges are moved earlier by these (s): the mouth's smoothing and LIPSYNC.lead take the rest.
   *  Set (2026-10-14) from real lips (GRID corpus, 4 talkers, qa/lipsync/grid.py and human.py, measured the same way):
   *  after a vowel they are shut ~4 ms after the sound falls and part ~24 ms after the burst; with 0.03 / 0.02 the
   *  mouth shut ~13 ms early and parted on the burst. */
  closureOnShift: 0,
  /** … an f/v or th starts this much earlier still (s): the lower lip is on the teeth (the tongue between them) as the
   *  hiss begins, not 25 ms into it */
  hissOnShift: 0.025,
  closureOffShift: 0, // s before the burst a p/b/m's cue ends (−0.01 until the gate read behind: releases +27 → +31 ms)
  nasalRelease: 0.02, // s added to an "m"'s end (its release is read from the treble coming back, which rises gradually)
  closureMinDur: 0.09, // s: shorter closures start earlier (the lips need this long to meet), still parting at the burst (0.05 → 0.09: tuning lines sealed 388 → 390, closing starts −85 → −91 ms vs GRID talkers −90)
  closureSearch: 0.12, // s searched before the dip (for the drop) and after it (for the burst)
  hissSearch: 0.25, // … before an f/v's dip: a hiss can be longer than a closure, so the vowel before it lies further back
  closureMinDb: 6, // a dip shallower than this (dB below the sound around it) is not trusted: the cue stays centred on it
  closureMaxDur: 0.2,
  closureBurstDb: 6, // a rise of this much (dB per 10 ms) after the dip counts as the burst
  closureApart: 0.04, // s: gap kept between two p/b/m closures (no two letters share one quiet stretch)
  /** alignLine: how far (s) a sound may move, how much a sound left unmatched costs (in (offset/spread)²), the spread
   *  (s) of a p/b/m's and a vowel's stamps around their sound, where a p/b/m's cue centre sits after its closure's dip
   *  (s), how much audio (s) past a batch must be decoded before it is aligned, and how often (s of new audio) to align. */
  alignMaxShift: 0.35,
  alignSkip: 8,
  alignSkipWeak: 1,
  alignSpreadClosure: 0.08,
  alignSpreadVowel: 0.08,
  alignClosureBias: 0,
  alignVowelBias: 0.02,
  alignAhead: 0.45,
  alignPeakProm: 1.5, // dB: a syllable peak for alignLine (gentler than vowelProm: a peak left over costs nothing, a missed one shifts the order)
  alignEvery: 0.25,
  squeezedPerCue: 0.06, // s per mouth shape: a first word stamped tighter than this is squeezed (placeLine)
  vowelBoundSlack: 0.03, // s: a closure's dip may lie this far past the centre of the vowel stamped after it
  vowelBoundBefore: 0.04, // s: … and lies after the centre of the vowel stamped before it, less this (−1: no such bound)
  joinWithin: 0.25, // s: two p/b/m with no vowel between, their dips this close, are one closure (joinClosure)
  /** A closure the letters put after a vowel ("pro-b", "Bo-b") goes on a dip with that vowel's syllable before it: the
   *  loudest moment since the previous closure must come within this many dB of the loudest one just after the dip.
   *  eleven_v4_turbo spaces a word's letters evenly, so a stamp can sit on an earlier, shallower dip (the "r" of
   *  "probably"), and every later cue then takes its neighbour's place. */
  closureSyllableDb: 10,
  /** A closure ends at the latest where the sound has come back up to this many dB below the vowel before it (and
   *  closureBurstDb above the dip): "-bab-" in "probably", where the next "b"'s burst outshone the vowel's onset. */
  closureVowelDb: 12,
  /** Two closures with a vowel spelled between ("-bab-" in "probably") start at least this long (s) after the first
   *  one's end, so the lips can open for the vowel (its release and the next attack take ~0.06), still sealing by the
   *  second one's burst: it keeps at least closureKeep (s). */
  closureGapMin: 0.07,
  closureKeep: 0.035,
  closureAhead: 0.04, // s: an audio-anchored closure skips the closure gate once its dip is this close (audioClosureAt)
  /** The tongue tip for d/t/n/l (tongueAt): up against the ridge behind the upper teeth at full height (the "dd" pose's
   *  tongue), rising tongueAhead (s) before the contact and down again tongueAfter after it. Formed with the rest of
   *  the "d" (LIPSYNC.peak.DD, 0.35, behind the vowels' emphasis) it reached 10% of its pose: "D should have the tongue
   *  on the roof of the mouth" (2026-10-11). */
  tongueAhead: 0.05,
  tongueAfter: 0.05,
  /** followRelease: the sounds after a p/b/m or f/v in its word start at most releaseGap (s) after it lets go, moved
   *  up by at most releaseMaxShift (s), when the voice is louder than releaseLoud (0..1 of the line's peak) after it. */
  releaseGap: 0.06,
  releaseMaxShift: 0.3,
  releaseLoud: 0.1,
  /** eleven_v4_turbo stamps the first word off from the voice (a silent audio tag in front takes stamp time: "Test"
   *  after "[worried, tense and quick]" came 100 ms late; untagged lines start 40–70 ms early). placeLine moves the
   *  cues earlier by how late the first word is stamped (voice onset − its stamp), at most lineMaxShift (s), fading to
   *  nothing over lineFade (s) of the line: later words are as often early as late. Only late stamps are moved: the
   *  closure and vowel snapping already look further after a stamp than before it, for early ones. The voice onset
   *  is the first 10 ms louder than lineOnsetDb. */
  lineOnsetDb: -30,
  lineOnsetGap: 0.1, // s: a sound this far apart (in silence) from the first word's stretch of voice is not the line's start
  lineMaxShift: 0.3,
  lineFade: 1.5,
  /** placePhrases: after a pause (pauseLevel for pauseMin), the first word stamped after the voice stopped moves onto
   *  where the voice comes back, with the rest of its phrase, when it is more than phraseSlack (s) off, by at most
   *  phraseMaxShift (s). Smaller offsets are stamp jitter, left to the closure and vowel snapping. */
  phraseSlack: 0.03,
  /** jawSplit: the lips' shape (every target but the jaw's) follows its own, softer gate on the local loudness: none in
   *  silence (below `from`), full once the voice is `full` of the loudest moment nearby, so a quiet word keeps its
   *  rounding or spread while the jaw (the loudness gate) opens it only a little. */
  shapeGate: { from: 0.05, full: 0.3 },
  phraseMaxShift: 0.35,
  /** Vowels move onto the loudest moment of their syllable (snapVowels): eleven_v4_turbo spreads the letters evenly over
   *  a word, so a vowel's stamp can sit far from its sound. The cue's centre goes to the nearest loudness peak within
   *  vowelSearch (s) that stands vowelProm dB above the dips on both sides, plus vowelShift (s; − = earlier, to
   *  make up for the smoothing). Each peak takes one vowel; the letters still choose the shape. */
  vowelSearch: 0.15,
  /** A peak quieter than vowelSilence (of the line's peak, in a 40 ms window) is a breath or a click, not a vowel; a
   *  vowel stamped that quiet, with no peak within vowelSearch, looks up to vowelRescue (s) for its syllable. eleven_v4_turbo stamped "like"
   *  in "…what I sound like" 0.16 s after it was said, its nearest peak was a breath 31 dB down, and the mouth stayed
   *  shut while it was heard (2026-10-11). */
  vowelRescue: 0.35,
  vowelSilence: 0.08,
  /** fitPhrases: a pause is the voice quieter than pauseLevel (of the line's peak, 40 ms window) for at least pauseMin
   *  (s): lower than vowelSilence, which an f, th or s can fall under for as long. Longer than a stop's closure: at 0.15
   *  the 160 ms "b" of a stressed "best" was taken for a pause and placePhrases moved "the best pumpkin bread" 0.23 s
   *  late (2026-10-15). */
  pauseLevel: 0.03,
  pauseMin: 0.2,
  holdLevel: 0.2, // … and holds its last vowel while the voice is at least this loud (of the line's peak)
  vowelProm: 3,
  vowelShift: 0,
  /** A p/b/m next to a rounded vowel is made with the lips already rounded ("blue", "boots", "moving"): the PP shape
   *  blends into visemes.json "ppr" (lips sealed, pushed forward and in) by the rounding of a U (1) or O (roundO) cue
   *  that starts within roundAhead (s) or ended within roundAfter (s), eased with time constant roundTau (s). */
  roundAhead: 0.2,
  roundAfter: 0.05,
  roundO: 0.6,
  roundTau: 0.04,
  /** The emotion's mouth part and the mouth sliders step back while speaking: while there is voice (louder than
   *  speechLoud, 0..1 of the clip's peak) within speechHold (s) before or speechAhead (s) after now, eased with time
   *  constant speechFade (s). Once per phrase, not after every word: following the mouth's own activity makes them
   *  pump back in between words, which reads as the mouth moving after the sound. When the voice stops they come back
   *  over speechRelease (s), eased in and out: with speechFade they snapped back to the expression in a few frames. */
  speechHold: 0.35,
  speechAhead: 0.15,
  speechLoud: 0.06,
  speechFade: 0.1,
  speechRelease: 0.8,
  /** Closure activation (PP + FF, after smoothing) at which the open shapes are fully suppressed,
   *  so the lips really meet on a "p"/"b"/"m" instead of hovering over a fading vowel. */
  sealAt: 0.9,
  /** The fastest the lips (mm/s of opening between them) and the jaw (mm/s, nose to chin) may move: real lips and jaws
   *  have a top speed, and moving faster in one frame reads as a jump. Each frame the whole mouth moves only as far
   *  toward its new shape as both allow (its path is kept, only slowed). From visemes.json "speed". 0 = no limit. */
  gapSpeed: 150,
  jawSpeed: 100,
  /** gapSpeed, jawSpeed and speedUp are this many times higher while a p/b/m or f/v pulls the mouth shut: real lips
   *  shut at 200–300 mm/s, and at the calm speeds a short closure after a wide vowel ("copper", "rubbish": 16 mm open,
   *  60 ms shut) never met. Opening keeps the calm speeds. 1 = no difference. */
  closeBoost: 2, // tuning lines: sealed 385 → 388 of 402, sharp speed changes unchanged (closeBoostUp 1.5: 392, but 3.4 → 3.9 m/s²)
  /** As closeBoost, for how fast a closing may speed up (speedUp). */
  closeBoostUp: 1,
  /** How fast (m/s², lips and jaw alike) a movement may speed up: the smoothing moves fastest the moment a shape is
   *  asked for, so every movement started with a jolt ("still a little jumpy", 2026-10-11). Slowing down is
   *  left alone, so the mouth never overshoots (a p/b/m still shuts). Sharp speed changes p95 4.0 → 3.2 m/s² on the
   *  saved clips, timing unchanged. 0 = no limit. */
  speedUp: 3,
  /** Top speeds (mm/s) for the mouth's width (corners spread or pulled in) and its rounding (lips pushed forward),
   *  like gapSpeed / jawSpeed: unlimited, they jumped between spread and rounded sounds ("we should": up to 420 mm/s at
   *  the corners, 140 mm/s forward; "still jumpy" in testing). Per unit of each shape (mm), measured on the shapes
   *  (pipeline viseme_solve: "ee" spreads 1.6 mm, "oo" corners in 8.7 and lips +4.8, "oh" 5.6 and +2.5, "sh" 6 and +3). */
  widthSpeed: 120,
  roundSpeed: 50,
  shapeMm: { width: { I: 1.6, O: -5.6, U: -8.7, CH: -6 }, round: { O: 2.5, U: 4.8, CH: 3 } } as { width: Partial<Record<VisemeId, number>>; round: Partial<Record<VisemeId, number>> },
  /** While the audio stays above this loudness (0..1 of the clip's peak) with no vowel cue active, the last vowel
   *  is held at sustainLevel. */
  sustainLoud: 0.45,
  sustainLevel: 0.7,
};

/** Pieces of the lip sync that /dev/lipsync switches off to compare on the same clip by eye. Always all on in the app. */
export const LIPSYNC_PARTS = {
  placeLine: true, // move the cues by how late the first word is stamped (placeLine)
  snapClosures: true, // p/b/m, f/v, th onto their quiet stretch in the audio (snapClosures, audioClosureAt)
  snapVowels: true, // vowels onto their syllable's loudness peak (snapVowels)
  gates: true, // open shapes scaled by the loudness, closures held back while it is loud (loudnessGate, closureGate)
  rounding: true, // p/b/m before oo/oh made with rounded lips (roundingAt)
  seal: true, // a formed closure pushes the open shapes out of the way (sealWeight)
  trebleM: true, // an "m" closure found in the treble (its hum keeps the line loud), not in the loudness (snapClosures)
  tongue: true, // the tongue tip up for d/t/n/l at full height, on its own track (tongueAt)
  fitPhrases: true, // each phrase's last vowel held until the voice stops, the next started where it comes back (fitPhrases)
  followRelease: true, // the sounds after a p/b/m or f/v in its word start where it lets go (followRelease)
  shapeHold: true, // the lips hold a vowel's rounding or spread while the loudness takes the opening away (LIPSYNC.shapeHold)
  placePhrases: true, // each phrase after a pause starts where the voice comes back, when its stamps are far off (placePhrases)
  pauseBoundary: true, // a pause counts as the syllable between two closures (syllableBetween)
  silenceSpan: true, // a p/b/m after silence spans up to its burst (closureSpan)
  jawSplit: true, // the loudness opens the jaw; the lips keep the sound's shape (LIPSYNC.shapeGate, mouth.ts)
  lateral: true, // an "l" shows the tongue tip at the edge of the upper teeth (visemes.json "ll", lateralAt)
  joinClosures: true, // two p/b/m with no vowel between ("Bob bought", "I'm managing") share one closure (snapClosures)
  ppFirst: true, // p/b/m find their silences before f/v and th, which then keep off them (snapClosures)
  offglide: true, // a diphthong's second half moves with its first instead of taking a loudness peak of its own (snapVowels)
  keepOrder: true, // an r, w or y spelled before a p/b/m in its word stays before its closure once it is placed (snapClosures)
  hissGate: true, // vowels fade where the treble outweighs the loudness: the jaw comes up for s, sh, f, th (LIPSYNC.hissClose)
  sustainYield: true, // the held last vowel (sustainLoud) gives way to a th, f, s or sh being made
  vowelBounds: true, // a p/b/m's closure lies between the vowels around it, not on the next word's (snapClosures)
  onsetGap: true, // a sound apart from the first word by a silence doesn't count as the line's start (placeLine)
  alignPhrases: true, // the line's p/b/m and vowels matched in order to the audio's dips and syllable peaks (alignLine)
  squeezedFirst: true, // a first word squeezed after an audio tag is spread back to the voice's onset, alone (placeLine)
};

/** The mouth lead in seconds: LIPSYNC.lead, or a `?lipsyncOffsetMs=` value (ms) kept to ±500 ms. */
export function mouthLead(param: string | null): number {
  const ms = param !== null && Number.isFinite(Number(param)) ? Math.max(-500, Math.min(500, Number(param))) : LIPSYNC.lead * 1000;
  return ms / 1000;
}

export const OPEN_VISEMES: VisemeId[] = ["aa", "E", "I", "O", "U", "DD", "SS", "CH"];
/** Shapes made on quiet sounds (a closure, or the hiss of f/v/th): held back while the voice is loud, never scaled
 *  down by the loudness (that left a "th" at a fifth of its shape), and placed on their quiet stretch in the audio. */
export const CLOSED_VISEMES: VisemeId[] = ["PP", "FF", "TH"];

/**
 * Lips cannot be shut while the voice is at full volume, and ElevenLabs stamps a "p"/"m" a
 * little before its sound; so closures are held back while the audio is loud and let through
 * as it dips. Returns a multiplier for the closed shapes.
 */
export function closureGate(loudness: number): number {
  const x = Math.min(1, Math.max(0, (loudness - LIPSYNC.closureLoud) / LIPSYNC.closureBand));
  return 1 - x * x * (3 - 2 * x);
}

/** 0..1: how rounded the lips should be for a closure at time t (LIPSYNC.roundAhead): the coming or just-ended U / O. */
export function roundingAt(cues: Cue[], t: number): number {
  let r = 0;
  for (const c of cues) {
    if (c.start - LIPSYNC.roundAhead > t) break; // sorted by start
    if ((c.viseme !== "U" && c.viseme !== "O") || c.glide || t > c.end + LIPSYNC.roundAfter) continue; // an r or w rounds no closure
    r = Math.max(r, c.viseme === "U" ? 1 : LIPSYNC.roundO);
  }
  return r;
}

/** Multiplier for the open shapes from the audio loudness at this instant. */
export function loudnessGate(loudness: number): number {
  const x = Math.min(1, loudness / LIPSYNC.gateLevel);
  const smooth = x * x * (3 - 2 * x);
  return LIPSYNC.gateFloor + (1 - LIPSYNC.gateFloor) * smooth;
}

/** The loudness the open gate is measured against at t (LIPSYNC.gateLocal): the loudest 10 ms block within ±gateLocal,
 *  at least gateLocalFloor; 1 (the line's peak) when gateLocal is 0. */
export function localPeak(loudness: (t: number) => number, t: number): number {
  if (!(LIPSYNC.gateLocal > 0)) return 1;
  let m = LIPSYNC.gateLocalFloor;
  for (let x = t - LIPSYNC.gateLocal; x <= t + LIPSYNC.gateLocal; x += 0.01) m = Math.max(m, loudness(x));
  return Math.min(1, m);
}

/** Mean of `loudness` over a window `width` seconds wide centred on t, one sample per 10 ms block
 *  (width 0 = the single block at t). */
export function windowedLoudness(loudness: (t: number) => number, t: number, width: number): number {
  const n = Math.round(width * 100) + 1;
  let sum = 0;
  for (let k = 0; k < n; k++) sum += loudness(t - width / 2 + k * 0.01);
  return sum / n;
}

export type Activations = Record<VisemeId, number>;

export function emptyActivations(): Activations {
  return Object.fromEntries(VISEME_IDS.map((v) => [v, 0])) as Activations;
}

function envelope(cue: Cue, t: number): number {
  const a = LIPSYNC.attackFor[cue.viseme] ?? LIPSYNC.attack;
  const r = LIPSYNC.releaseFor[cue.viseme] ?? LIPSYNC.release;
  if (t < cue.start - a || t > cue.end + r) return 0;
  const isR = cue.glide && cue.viseme === "U" && /^r/i.test(cue.text);
  const peak = cue.weak ? LIPSYNC.weakPeak : isR ? LIPSYNC.rPeak : (cue.peak ?? LIPSYNC.peak[cue.viseme] ?? LIPSYNC.peak.default);
  const long = cue.end - cue.start > 0.12 && !cue.weak && !isR && cue.peak === undefined && !["DD", "SS", "TH"].includes(cue.viseme) ? 1 : peak;
  if (t < cue.start) return long * (1 - (cue.start - t) / a);
  if (t <= cue.end) return long;
  return long * (1 - (t - cue.end) / r);
}

/** Raw targets for time t (no smoothing). */
export function targetsAt(cues: Cue[], t: number, out: Activations): Activations {
  for (const v of VISEME_IDS) out[v] = 0;
  for (const v of VISEME_IDS) peakCap[v] = 1;
  for (const cue of cues) {
    if (cue.end + LIPSYNC.release < t) continue; // release is the longest fade, so this is safe
    if (cue.start - LIPSYNC.attack > t) break; // cues are sorted by start
    const e = envelope(cue, t);
    if (e > out[cue.viseme]) {
      out[cue.viseme] = e;
      peakCap[cue.viseme] = cue.peak ?? 1;
    }
  }
  // Closure dominance: lips pressed / lip under teeth suppress open shapes.
  const closed = Math.max(out.PP, out.FF);
  if (closed > 0) for (const v of ["aa", "E", "I", "O", "U", "TH"] as VisemeId[]) out[v] *= 1 - closed;
  // Winner emphasis: during transitions the strongest shape stays crisp instead of averaging into mush.
  let top: VisemeId = "aa";
  for (const v of VISEME_IDS) if (out[v] > out[top]) top = v;
  const topValue = out[top];
  if (topValue > 0) for (const v of VISEME_IDS) if (v !== top) out[v] *= 1 - LIPSYNC.emphasis * topValue;
  // Cap the mouth group so additive presets never over-drive.
  const sum = VISEME_IDS.reduce((s, v) => s + out[v], 0);
  if (sum > LIPSYNC.maxGroupSum) for (const v of VISEME_IDS) out[v] *= LIPSYNC.maxGroupSum / sum;
  return out;
}

/** Per shape, the `peak` of the cue that drew it in the last targetsAt (1 if none): frameTargets holds the shape there
 *  after the loudness gate, whose openGain would otherwise take a "sun" as wide as a "father". */
const peakCap = emptyActivations();

/**
 * How far the tongue tip is up against the ridge behind the upper teeth at t (0..1): the d/t/n/l cues (DD, not a k or
 * g), eased up from LIPSYNC.tongueAhead before each and down by tongueAfter after it. On its own track, at full height:
 * the tongue competes with no lip shape, so the vowels around it don't push it aside.
 */
export function tongueAt(cues: Cue[], t: number): number {
  let v = 0;
  for (const c of cues) {
    if (c.start - LIPSYNC.tongueAhead > t) break; // sorted by start
    if (c.viseme !== "DD" || c.back || t > c.end + LIPSYNC.tongueAfter) continue;
    const x = t < c.start ? 1 - (c.start - t) / LIPSYNC.tongueAhead : t > c.end ? 1 - (t - c.end) / LIPSYNC.tongueAfter : 1;
    const e = Math.max(0, Math.min(1, x));
    v = Math.max(v, e * e * (3 - 2 * e));
  }
  return v;
}

/** How much of the tongue's raise at t is an "l" (tongueAt's track, from lateral cues only): the tongue blends from the
 *  "d" pose (tip behind the upper teeth) to visemes.json "ll" (tip at their edge, showing). */
export function lateralAt(cues: Cue[], t: number): number {
  let v = 0;
  for (const c of cues) {
    if (c.start - LIPSYNC.tongueAhead > t) break; // sorted by start
    if (!c.lateral || t > c.end + LIPSYNC.tongueAfter) continue;
    const x = t < c.start ? 1 - (c.start - t) / LIPSYNC.tongueAhead : t > c.end ? 1 - (t - c.end) / LIPSYNC.tongueAfter : 1;
    const e = Math.max(0, Math.min(1, x));
    v = Math.max(v, e * e * (3 - 2 * e));
  }
  return v;
}

/** Factor the open shapes are scaled by once a closure has actually formed (post-smoothing).
 *  1 = untouched, 0 = fully sealed; a smooth ramp so small closure residue does no harm. */
export function sealWeight(act: Activations): number {
  const d = Math.min(1, (act.PP + act.FF) / LIPSYNC.sealAt);
  return 1 - d * d * (3 - 2 * d);
}

/** The share (0..1) of this frame's step the mouth may take: the lips may open or close by at most LIPSYNC.gapSpeed and
 *  the jaw by jawSpeed (mm/s) over `dt` seconds. dGap / dJaw: the step's change in mm. */
export function speedShare(dGap: number, dJaw: number, dt: number, closing = false): number {
  let share = 1;
  const boost = closing ? LIPSYNC.closeBoost : 1;
  const gapSpeed = LIPSYNC.gapSpeed * (dGap < 0 ? boost : 1);
  const jawSpeed = LIPSYNC.jawSpeed * (dJaw < 0 ? boost : 1);
  if (gapSpeed > 0 && Math.abs(dGap) > gapSpeed * dt) share = Math.min(share, (gapSpeed * dt) / Math.abs(dGap));
  if (jawSpeed > 0 && Math.abs(dJaw) > jawSpeed * dt) share = Math.min(share, (jawSpeed * dt) / Math.abs(dJaw));
  return share;
}

/**
 * The share of this frame's step (dGap, dJaw: mm) the mouth takes when it may speed up by at most LIPSYNC.speedUp:
 * `share` from speedShare, and last frame's lip and jaw velocities (mm/s, signed: a turn starts again from rest).
 * Slowing down is never limited.
 */
export function speedUpShare(dGap: number, dJaw: number, share: number, gapVel: number, jawVel: number, dt: number, closing = false): number {
  if (!(LIPSYNC.speedUp > 0) || dt <= 0) return share;
  const grow = LIPSYNC.speedUp * 1000 * dt; // mm/s the speed may grow by this frame
  const boost = closing ? LIPSYNC.closeBoostUp : 1;
  let k = share;
  for (const [d, last] of [[dGap, gapVel], [dJaw, jawVel]]) {
    const g = d < 0 ? grow * boost : grow;
    const speed = (Math.abs(d) * share) / dt;
    const from = Math.sign(d) === Math.sign(last) ? Math.abs(last) : 0;
    if (speed > from + g) k = Math.min(k, (share * (from + g)) / speed);
  }
  return k;
}

/**
 * The share of this frame's step the mouth takes when its width and rounding may change at most LIPSYNC.widthSpeed /
 * roundSpeed: `share` so far, the activations as drawn (`drawn`, open shapes after the seal) and the ones asked for.
 */
export function shapeShare(drawn: Activations, target: Activations, share: number, dt: number): number {
  let dW = 0;
  let dR = 0;
  for (const [v, mm] of Object.entries(LIPSYNC.shapeMm.width)) dW += (target[v as VisemeId] - drawn[v as VisemeId]) * mm;
  for (const [v, mm] of Object.entries(LIPSYNC.shapeMm.round)) dR += (target[v as VisemeId] - drawn[v as VisemeId]) * mm;
  let k = share;
  if (LIPSYNC.widthSpeed > 0 && Math.abs(dW) * k > LIPSYNC.widthSpeed * dt) k = (LIPSYNC.widthSpeed * dt) / Math.abs(dW);
  if (LIPSYNC.roundSpeed > 0 && Math.abs(dR) * k > LIPSYNC.roundSpeed * dt) k = (LIPSYNC.roundSpeed * dt) / Math.abs(dR);
  return k;
}

/** Smoothed activations; call once per frame with the elapsed time. */
export function smoothTowards(current: Activations, target: Activations, dt: number): void {
  for (const v of VISEME_IDS) {
    const tau = LIPSYNC.tau[v] ?? LIPSYNC.tau.default;
    const k = 1 - Math.exp(-dt / tau);
    current[v] += (target[v] - current[v]) * k;
    if (current[v] < 0.002) current[v] = 0;
  }
}

// What the audio snapping below has done to each cue, held weakly so a line's cues are forgotten with it.
/** Cues already moved by placeLine (built from the alignment, cues carry `ws`; hand-made ones without it count as placed). */
const lined = new WeakSet<Cue>();
/** Cues whose phrase has been placed (placePhrases): the audio after their stamp has been looked at for pauses. */
const phrased = new WeakSet<Cue>();
/** Cues alignLine has placed (or left: live replies, ?lipsyncOff=alignPhrases). */
const aligned = new WeakSet<Cue>();
const isPlaced = (c: Cue) => c.ws === undefined || (lined.has(c) && phrased.has(c) && aligned.has(c));
const dipOf = new WeakMap<Cue, number>(); // the loudness dip a closure cue was moved to (snapClosures)
const claimOf = new WeakMap<Cue, [number, number]>(); // the stretch of audio a p/b/m cue took (snapClosures)
/** Closure cues whose span came from the audio (closureSpan): audioClosureAt lets them past the closure gate. */
const fromAudio = new WeakSet<Cue>();

const vowelBefore = new Map<Cue, Cue | null>(); // snapClosures: each p/b/m's vowel before it, in spoken order (reused)
const midOf = (v: Cue | null | undefined) => (v ? (v.start + v.end) / 2 : NaN);

/**
 * Two p/b/m with no vowel between, each snapped to a quiet stretch of its own: they are one closure. Two halves of
 * one stretch become the whole (both cues). Otherwise the second takes the first's, if that lies between the vowel
 * before the first and the vowel after the second (a pause before the word, or a "d" after its vowel, is quieter than
 * an "m" but in the wrong place) and the second's own is out of place, shallower, or not a closure at all. Only the
 * second moves there: moving the first, with the words after it already placed on it, did more harm than good.
 */
function joinClosure(first: Cue, second: Cue, order: Cue[], env: (t: number) => number): boolean {
  const a = dipOf.get(first)!, b = dipOf.get(second)!;
  if (Math.abs(a - b) >= LIPSYNC.joinWithin) return false;
  const own = fromAudio.has(second); // it found a closure of its own (else it sits on its stamp)
  if (own && second.start <= first.end + LIPSYNC.closureApart) {
    first.start = second.start = Math.min(first.start, second.start);
    first.end = second.end = Math.max(first.end, second.end);
    return true;
  }
  const lo = midOf(vowelBefore.get(first));
  let hi = NaN;
  for (let k = order.indexOf(second) + 1; k < order.length; k++) {
    if (VOWELS.has(order[k].viseme)) {
      hi = midOf(order[k]);
      break;
    }
  }
  const fits = (t: number) => !(t <= lo) && !(t >= hi);
  if (!fits(a) || (own && fits(b) && env(b) < env(a))) return false;
  second.start = first.start;
  second.end = first.end;
  dipOf.set(second, a);
  fromAudio.add(second);
  return true;
}

/**
 * Character timestamps are only approximate (eleven_v4_turbo spreads the letters evenly over each word); the audio
 * knows when the lips were shut (a dip in loudness). Each closure cue moves to the quietest moment near its stamp,
 * and a p/b/m then takes its length from the audio too (closureSpan). Cues whose window is not decoded
 * yet are left for a later frame; pass Infinity once the whole line is decoded (the window can then run past
 * the end of the audio). Returns true if any moved.
 */
export function snapClosures(cues: Cue[], loudness: (t: number) => number, decodedSeconds: number, snapped: WeakSet<Cue>, treble: (t: number) => number = loudness): boolean {
  let moved = false;
  // a closure holds one p/b/m: two letters on the same quiet stretch ("probably", "Mom made") would lose one
  const claimed: [number, number][] = [];
  for (const c of cues) if (snapped.has(c) && claimOf.has(c)) claimed.push(claimOf.get(c)!);
  const taken = (t: number) => claimed.some(([a, b]) => t > a - LIPSYNC.closureApart / 2 && t < b + LIPSYNC.closureApart / 2);
  vowelBefore.clear();
  const order = spoken(cues);
  // p/b/m first (LIPSYNC_PARTS.ppFirst): their silences are the surest, and an f/v or th placed before them took one
  // ("the best": the th of "the", stamped late, sat on the b's silence and every closure after it moved one along)
  for (const pass of LIPSYNC_PARTS.ppFirst ? ["pp", "rest"] : ["all"]) {
  let prev: Cue | null = null; // the closure before this one, in spoken order
  let vowelSince = false; // a vowel came between it and this one
  let prevPP: Cue | null = null; // the p/b/m before this one, and whether a vowel came since
  let vowelSincePP = false;
  let lastVowel: Cue | null = null;
  for (const c of order) {
    if (VOWELS.has(c.viseme)) lastVowel = c;
    if (VOWELS.has(c.viseme) && !c.glide) vowelSince = vowelSincePP = true;
    if (!CLOSED_VISEMES.includes(c.viseme)) continue;
    const before = prev, needSyllable = vowelSince && prev !== null && snapped.has(prev);
    prev = c;
    vowelSince = false;
    // a p/b/m right after another with no vowel between is the same closure ("Bob bought", "I'm managing": the lips
    // close once), but each finds a quiet stretch of its own (the first one's is taken): one of the two is wrong
    const joinTo = c.viseme === "PP" && LIPSYNC_PARTS.joinClosures && !vowelSincePP && prevPP && fromAudio.has(prevPP) ? prevPP : null;
    if (c.viseme === "PP") {
      prevPP = c;
      vowelSincePP = false;
      vowelBefore.set(c, lastVowel);
    }
    if ((pass === "pp" && c.viseme !== "PP") || (pass === "rest" && c.viseme === "PP")) continue;
    // … and an f/v or th never takes a p/b/m's stretch
    const blocked = c.viseme === "PP" || pass === "rest";
    if (snapped.has(c) || !isPlaced(c)) continue;
    const centre = (c.start + c.end) / 2;
    const lo = Math.max(0, centre - LIPSYNC.snapBefore);
    const hi = centre + LIPSYNC.snapAfter;
    if (hi + LIPSYNC.closureSearch > decodedSeconds) continue;
    // with a vowel between, only dips that have a syllable since the previous closure (LIPSYNC.closureSyllableDb)
    const from = before ? before.end + LIPSYNC.closureOffShift : 0;
    // a p/b/m lies between the vowel before it and the one after it (eleven_v4_turbo spaces a word's letters evenly: its
    // vowels are stamped close to the sound, a consonant starting the word up to ~170 ms late, where the next word's
    // closure can be nearer: "blue" took "bat"'s, "bat" took "before"'s)
    let vLo = -Infinity, vHi = Infinity;
    if (c.viseme === "PP" && LIPSYNC_PARTS.vowelBounds) {
      if (lastVowel && LIPSYNC.vowelBoundBefore >= 0) vLo = midOf(lastVowel) - LIPSYNC.vowelBoundBefore;
      for (let k = order.indexOf(c) + 1; k < order.length; k++) {
        if (VOWELS.has(order[k].viseme)) {
          vHi = midOf(order[k]) + LIPSYNC.vowelBoundSlack;
          break;
        }
      }
    }
    const allowed = (t: number) => t > vLo && t < vHi && (!needSyllable || syllableBetween(loudness, from, t));
    // an "m" hums on through the nose: its closure shows in the treble, not in the loudness
    const env = c.nasal ? treble : loudness;
    // Nearest dip wins over the deepest one: quiet + a small penalty for distance from the stamp.
    let bestT = centre, best = Infinity;
    for (let t = lo; t <= hi; t += 0.01) {
      if ((blocked && taken(t)) || !allowed(t)) continue;
      const score = LIPSYNC.snapDbPerS > 0 ? 20 * Math.log10(Math.max(env(t), 1e-3)) + LIPSYNC.snapDbPerS * Math.abs(t - centre) : env(t) + 0.5 * (Math.abs(t - centre) / LIPSYNC.snapAfter);
      if (score < best) {
        best = score;
        bestT = t;
      }
    }
    // the stamp can sit on the edge of a dip (even just past the burst): take the quietest moment around it
    const near = bestT;
    for (let t = near - 0.03; t <= near + 0.03; t += 0.01) {
      if (env(t) < env(bestT) && !(blocked && taken(t)) && allowed(t)) bestT = t;
    }
    // an "m" fades into its closure (the hum's treble sinks gradually): follow it down to the bottom of the dip
    if (c.nasal) {
      for (const dir of [1, -1]) {
        let t = bestT + dir * 0.01;
        while (Math.abs(t - near) <= LIPSYNC.closureSearch && env(t) < env(bestT) && !taken(t) && allowed(t)) {
          bestT = t;
          t += dir * 0.01;
        }
      }
    }
    dipOf.set(c, bestT);
    // p/b/m: the closure; f/v, th: the hiss (quieter than the vowels around it) up to where the vowel comes back
    const span = closureSpan(env, bestT, c.viseme === "PP" ? LIPSYNC.closureSearch : LIPSYNC.hissSearch, !!c.nasal);
    if (c.viseme === "PP") {
      claimOf.set(c, span ?? [bestT, bestT]);
      claimed.push(claimOf.get(c)!);
    }
    if (span) {
      c.end = span[1] - LIPSYNC.closureOffShift + (c.nasal ? LIPSYNC.nasalRelease : 0);
      const onShift = LIPSYNC.closureOnShift + (c.viseme === "PP" ? 0 : LIPSYNC.hissOnShift);
      c.start = Math.max(0, Math.min(span[0] - onShift, c.end - LIPSYNC.closureMinDur));
      if (c.viseme !== "PP" && LIPSYNC.hissMaxDur > 0) c.end = Math.min(c.end, span[0] + LIPSYNC.hissMaxDur);
      if (needSyllable && before) c.start = Math.max(c.start, Math.min(before.end + LIPSYNC.closureGapMin, c.end - LIPSYNC.closureKeep));
      fromAudio.add(c);
      // a glide its word says before it stays before it ("storm": the m's closure, found early, had the r after it, and
      // the lips rounded again once shut)
      if (c.viseme === "PP" && LIPSYNC_PARTS.keepOrder)
        for (let j = order.indexOf(c) - 1; j >= 0 && order[j].ws === c.ws; j--) {
          const x = order[j];
          if (!x.glide || x.end <= c.start) continue; // an r, w or y (vowels before it have vowelBounds)
          const dur = x.end - x.start;
          x.end = Math.max(x.start + 0.02, c.start);
          if (x.end - x.start > dur || x.start > c.start - 0.02) x.start = Math.max(0, x.end - Math.min(dur, 0.06));
        }
    } else {
      const dur = c.viseme !== "PP" && LIPSYNC.hissMaxDur > 0 ? Math.min(c.end - c.start, LIPSYNC.hissMaxDur) : c.end - c.start;
      c.start = Math.max(0, bestT - dur / 2);
      c.end = c.start + dur;
    }
    snapped.add(c);
    moved = true;
    // ...so they become one (joinClosure). Done here, so the stretch this one had taken is free for the closures after
    // it ("mum made muffins": "made" took the "d", where "muffins" closes).
    if (joinTo && joinClosure(joinTo, c, order, c.nasal ? treble : loudness)) {
      const own = claimed.lastIndexOf(claimOf.get(c)!);
      if (own >= 0) claimed.splice(own, 1);
      claimOf.set(c, claimOf.get(joinTo)!);
    }
  }
  }
  if (moved) cues.sort((p, q) => p.start - q.start);
  return moved;
}

const followed = new WeakSet<Cue>(); // closures whose word has been moved up to their release (followRelease)
const fitted = new WeakMap<Cue[], number>(); // how far into the line its pauses have been fitted (fitPhrases)

/**
 * A phrase's last vowel holds while the voice draws it out, up to the pause after it (the voice under LIPSYNC.pauseLevel
 * for at least pauseMin) and while it is at least holdLevel: eleven_v4_turbo times its words from the text, so a word
 * the voice stretches ends early in the stamps. "Well…" in "Ask me anything. Well… almost anything." was held 350 ms
 * past its stamps, "Honestly," 130 ms, and the mouth closed while it was heard. (Starting each phrase where the voice
 * comes back was tried too: the stamps were already within ~50 ms there, and moving them made it worse.) Each pause is
 * fitted once decoded; the line's end once the stream is done. While the voice is still sounding at the edge of what is
 * decoded with no stamped sound left to cover it (a live reply's audio is measured only ~0.05–0.1 s ahead of the mouth), the last
 * vowel holds up to that edge already.
 */
export function fitPhrases(cues: Cue[], loudness: (t: number) => number, decodedSeconds: number): boolean {
  const L = LIPSYNC;
  const voiced = (t: number) => windowedLoudness(loudness, t, 0.04) >= L.pauseLevel;
  const end = decodedSeconds === Infinity ? (cues.at(-1)?.end ?? 0) + 1 : decodedSeconds - 0.1;
  let from = fitted.get(cues) ?? 0;
  let moved = false;
  const holdTo = (stop: number) => {
    // the last vowel before the voice stops holds while the voice is still clearly sounding (LIPSYNC.holdLevel)
    let last: Cue | null = null;
    for (const c of cues) if (VOWELS.has(c.viseme) && !c.glide && c.start < stop && c.start > stop - 1) last = c;
    if (!last) return;
    let until = last.end;
    while (until + 0.01 < stop && windowedLoudness(loudness, until + 0.01, 0.04) >= L.holdLevel) until += 0.01;
    if (until > last.end + 0.04) {
      last.end = until;
      moved = true;
    }
  };
  let t = from;
  while (t < end) {
    // the next pause: quiet from `a` to `b`
    while (t < end && !voiced(t)) t += 0.01;
    while (t < end && voiced(t)) t += 0.01;
    const a = t;
    while (t < end && !voiced(t)) t += 0.01;
    if (t >= end) {
      if (decodedSeconds === Infinity) {
        if (a > from) holdTo(a); // the voice's end
        from = Infinity; // the whole line is fitted
      } else if (voiced(end)) {
        // still sounding at the edge, with nothing stamped between the last vowel and it: the stamps ran out early
        const last = cues.findLast((c) => VOWELS.has(c.viseme) && !c.glide && c.start < end);
        if (last && !cues.some((c) => c.start > last.end && c.start < end)) holdTo(end);
      }
      break;
    }
    const b = t;
    from = b;
    if (b - a < L.pauseMin) continue;
    holdTo(a);
  }
  fitted.set(cues, from);
  if (moved) cues.sort((p, q) => p.start - q.start);
  return moved;
}

/**
 * The sounds after a p/b/m or f/v in the same word start where it lets go (its end, found in the audio): the lips
 * release straight into them. eleven_v4_turbo can stamp them well after ("bread": the b let go at 0.95 s into a loud
 * "rea", stamped from 1.17 s, so the mouth said it after the sound; 2026-10-11). Only moves them earlier, by
 * more than LIPSYNC.releaseGap, at most LIPSYNC.releaseMaxShift, up to the word's next closure, and only into sound.
 */
export function followRelease(cues: Cue[], loudness: (t: number) => number, snapped: WeakSet<Cue>): boolean {
  let moved = false;
  const order = spoken(cues);
  for (let k = 0; k < order.length; k++) {
    const c = order[k];
    if ((c.viseme !== "PP" && c.viseme !== "FF") || !fromAudio.has(c) || followed.has(c)) continue;
    followed.add(c);
    const rest: Cue[] = [];
    for (let j = k + 1; j < order.length && order[j].ws === c.ws && !CLOSED_VISEMES.includes(order[j].viseme); j++) rest.push(order[j]);
    if (!rest.length || rest.some((r) => snapped.has(r))) continue;
    const late = Math.min(...rest.map((r) => r.start)) - c.end;
    if (late <= LIPSYNC.releaseGap) continue;
    let sound = 0;
    for (let t = c.end; t <= c.end + 0.08; t += 0.01) sound = Math.max(sound, loudness(t));
    if (sound < LIPSYNC.releaseLoud) continue; // a pause after it: the stamps may be right
    const shift = Math.min(late - LIPSYNC.releaseGap, LIPSYNC.releaseMaxShift);
    for (const r of rest) {
      r.start -= shift;
      r.end -= shift;
    }
    moved = true;
  }
  if (moved) cues.sort((p, q) => p.start - q.start);
  return moved;
}

/** Whether the sound since `from` (a closure's release) has had a syllable before the dip at t: its loudest moment comes
 *  within LIPSYNC.closureSyllableDb of the loudest one in the closureSearch after t (the vowel the dip leads into).
 *  A pause on the way counts too (a new phrase starts: "peppers, but"): the phrase before often trails off more than
 *  closureSyllableDb below the next one's first vowel, and the closure was then pushed past its own vowel. */
function syllableBetween(loudness: (t: number) => number, from: number, t: number): boolean {
  let before = 0, after = 0, quiet = 0;
  for (let x = from; x < t; x += 0.01) {
    const l = loudness(x);
    before = Math.max(before, l);
    quiet = l < LIPSYNC.pauseLevel ? quiet + 0.01 : 0;
    if (LIPSYNC_PARTS.pauseBoundary && quiet >= LIPSYNC.pauseMin && before > LIPSYNC.pauseLevel) return true;
  }
  for (let x = t; x <= t + LIPSYNC.closureSearch; x += 0.01) after = Math.max(after, loudness(x));
  return 20 * Math.log10(Math.max(before, 1e-3) / Math.max(after, 1e-3)) >= -LIPSYNC.closureSyllableDb;
}

/** Move the cues by where the voice really starts vs the first word's stamp (LIPSYNC.lineOnsetDb). Run before the
 *  closure and vowel snapping, which wait for it. Returns true if anything moved. */
export function placeLine(cues: Cue[], loudness: (t: number) => number, decodedSeconds: number): boolean {
  let first = Infinity;
  for (const c of cues) if (c.ws !== undefined && c.ws < first) first = c.ws;
  if (first === Infinity || !cues.some((c) => c.ws !== undefined && !lined.has(c))) return false;
  const until = first + LIPSYNC.lineMaxShift;
  if (until > decodedSeconds) return false;
  const level = Math.pow(10, LIPSYNC.lineOnsetDb / 20);
  let onset: number | null = null;
  for (let t = 0, quiet = Infinity; t <= until; t += 0.01) {
    if (loudness(t) > level) {
      // the start of the stretch of voice the first word is in: a sound before it, apart from it by a silence
      // (lineOnsetGap: the voice sounding an audio tag, "[suspicious, low and guarded] Open…"), is not the line's start
      if (onset === null || (LIPSYNC_PARTS.onsetGap && quiet >= LIPSYNC.lineOnsetGap && t <= first + 0.05)) onset = t;
      quiet = 0;
    } else quiet += 0.01;
  }
  const d0 = onset === null || !LIPSYNC_PARTS.placeLine ? 0 : Math.max(-LIPSYNC.lineMaxShift, Math.min(0, onset - first)); // late stamps only
  // A first word squeezed after an audio tag ("[happy, bright and bouncy] Peter Piper…": "Peter" stamped in 30 ms at
  // 0.37 s, said from 0 to 0.35): only that word is late. Spread it back over where the voice starts; the words after
  // it are stamped where they are said, and moving them by its lateness put "Piper" and "picked" ~270 ms early.
  let next = Infinity, n = 0;
  for (const c of cues) {
    if (c.ws === first) n++;
    else if (c.ws !== undefined && c.ws > first && c.ws < next) next = c.ws;
  }
  const squeezed = LIPSYNC_PARTS.squeezedFirst && d0 < 0 && next < Infinity && (next - first) / Math.max(1, n) < LIPSYNC.squeezedPerCue;
  for (const c of cues) {
    if (c.ws === undefined || lined.has(c)) continue;
    if (squeezed) {
      if (c.ws === first) {
        const k = (next - (first + d0)) / (next - first); // [first, next] onto [onset, next]
        c.start = Math.max(0, first + d0 + (c.start - first) * k);
        c.end = first + d0 + (c.end - first) * k;
      }
    } else {
      const d = d0 * Math.max(0, 1 - (c.ws! - first) / LIPSYNC.lineFade);
      c.start = Math.max(0, c.start + d);
      c.end += d;
    }
    lined.add(c);
  }
  cues.sort((p, q) => p.start - q.start);
  return true;
}

/** How far alignLine has gone in a line (the decoded audio it last ran on). */
const alignedAt = new WeakMap<Cue[], number>();

/**
 * The words' sounds in spoken order onto the audio, as one sequence (eleven_v4_turbo stamps a word's vowels near the
 * sound but its first consonant up to ~170 ms late, and snapping each p/b/m on its own then took a neighbour's quiet
 * stretch and pushed the next sounds along: "blue" took "bat"'s, "my" took "mood"'s). The line's p/b/m and vowel nuclei
 * are matched, in order, to the audio's dips (closureSpan) and syllable peaks by dynamic programming: a match costs
 * ((audio − stamp) / spread)², a sound left unmatched alignSkip, a landmark left over nothing (t/d/k closures, unstressed
 * bumps). The matches then move every cue between them (piecewise linear), and the snapping refines from there. Runs in
 * batches as the line is decoded (alignAhead past the batch), after placeLine and placePhrases; the snapping waits for it.
 */
export function alignLine(cues: Cue[], loudness: (t: number) => number, treble: (t: number) => number, decodedSeconds: number, enabled = LIPSYNC_PARTS.alignPhrases): boolean {
  if (!enabled) {
    for (const c of cues) aligned.add(c);
    return false;
  }
  const L = LIPSYNC;
  const last = alignedAt.get(cues) ?? -Infinity;
  if (decodedSeconds !== Infinity && decodedSeconds - last < L.alignEvery) return false;
  const horizon = decodedSeconds === Infinity ? Infinity : decodedSeconds - L.alignAhead;
  const order = spoken(cues);
  const batch: Cue[] = [];
  for (const c of order) {
    if (aligned.has(c)) continue;
    if (c.ws === undefined) aligned.add(c);
    else if (lined.has(c) && phrased.has(c) && (c.start + c.end) / 2 < horizon) batch.push(c);
  }
  if (!batch.length) return false;
  alignedAt.set(cues, decodedSeconds);
  // the sounds: p/b/m (two with no vowel between are one closure) and vowel nuclei (a diphthong's second part is not a
  // syllable of its own)
  type Ev = { cue: Cue; s: number; closure: boolean; nasal: boolean; weak: boolean };
  const evs: Ev[] = [];
  let prev: Cue | null = null;
  for (const c of batch) {
    const mid = (c.start + c.end) / 2;
    if (c.viseme === "PP") {
      if (!(prev && prev.viseme === "PP")) evs.push({ cue: c, s: mid - L.alignClosureBias, closure: true, nasal: !!c.nasal, weak: false });
      prev = c;
    } else if (VOWELS.has(c.viseme) && !c.glide) {
      if (!(prev && VOWELS.has(prev.viseme) && prev.ws === c.ws)) evs.push({ cue: c, s: mid - L.alignVowelBias, closure: false, nasal: false, weak: !!c.weak });
      prev = c;
    } else if (!VOWELS.has(c.viseme)) prev = c;
  }
  const done = () => {
    for (const c of batch) aligned.add(c);
    return false;
  };
  if (evs.length < 2) return done();
  // the audio's landmarks around them: dips with a closure's shape, in the loudness (and the treble, for an "m"), and
  // syllable peaks (as snapVowels finds them)
  const t0 = Math.max(0.01, evs[0].s - L.alignMaxShift);
  const t1 = Math.min(evs[evs.length - 1].s + L.alignMaxShift, decodedSeconds === Infinity ? Infinity : decodedSeconds - 0.05);
  const db = (env: (t: number) => number, t: number) => 20 * Math.log10(Math.max(env(t), 1e-3));
  const lv = (t: number) => 20 * Math.log10(Math.max(windowedLoudness(loudness, t, 0.04), 1e-3));
  const audible = 20 * Math.log10(L.vowelSilence);
  type Mark = { t: number; kind: "dip" | "mdip" | "peak" };
  const marks: Mark[] = [];
  for (let t = t0; t <= t1 && t < t0 + 60; t += 0.01) {
    const v = lv(t);
    if (v >= audible && v >= lv(t - 0.01) && v > lv(t + 0.01)) {
      let left = v, right = v;
      for (let k = 1; k <= 8; k++) {
        left = Math.min(left, lv(t - k * 0.01));
        right = Math.min(right, lv(t + k * 0.01));
      }
      if (v - Math.max(left, right) >= L.alignPeakProm) marks.push({ t, kind: "peak" });
    }
    for (const [env, kind] of [[loudness, "dip"], [treble, "mdip"]] as const) {
      if (kind === "mdip" && treble === loudness) continue;
      const d = db(env, t);
      if (d <= db(env, t - 0.01) && d <= db(env, t - 0.02) && d < db(env, t + 0.01) && d < db(env, t + 0.02) && closureSpan(env, t, L.closureSearch, kind === "mdip")) marks.push({ t, kind });
    }
  }
  if (!marks.length) return done();
  // the ordered match: D[i][j] = least cost of the first i sounds over the first j landmarks
  const n = evs.length, m = marks.length, W = m + 1;
  const D = new Float64Array((n + 1) * W), how = new Uint8Array((n + 1) * W); // 0 skip landmark, 1 skip sound, 2 match
  const skip = (e: Ev) => (e.weak ? L.alignSkipWeak : L.alignSkip);
  for (let i = 1; i <= n; i++) {
    D[i * W] = D[(i - 1) * W] + skip(evs[i - 1]);
    how[i * W] = 1;
  }
  for (let i = 1; i <= n; i++) {
    const e = evs[i - 1];
    const spread = e.closure ? L.alignSpreadClosure : L.alignSpreadVowel;
    for (let j = 1; j <= m; j++) {
      let best = D[i * W + j - 1], h = 0;
      const sk = D[(i - 1) * W + j] + skip(e);
      if (sk < best) {
        best = sk;
        h = 1;
      }
      const k = marks[j - 1];
      const fits = e.closure ? k.kind === "dip" || (k.kind === "mdip" && e.nasal) : k.kind === "peak";
      const off = k.t - e.s;
      if (fits && Math.abs(off) <= L.alignMaxShift) {
        const mc = D[(i - 1) * W + j - 1] + (off / spread) ** 2;
        if (mc < best) {
          best = mc;
          h = 2;
        }
      }
      D[i * W + j] = best;
      how[i * W + j] = h;
    }
  }
  // back through the choices: each matched sound's cue centre (as stamped) and where it goes
  const anchors: [number, number][] = [];
  for (let i = n, j = m; i > 0 && j >= 0; ) {
    const h = how[i * W + j];
    if (j > 0 && h === 0) j--;
    else if (h === 1 || j === 0) i--;
    else {
      const e = evs[i - 1];
      anchors.push([(e.cue.start + e.cue.end) / 2, marks[j - 1].t + (e.closure ? L.alignClosureBias : L.alignVowelBias)]);
      i--;
      j--;
    }
  }
  anchors.reverse();
  const keep: [number, number][] = [];
  for (const a of anchors) if (!keep.length || (a[0] > keep[keep.length - 1][0] && a[1] > keep[keep.length - 1][1])) keep.push(a);
  if (!keep.length) return done();
  // every cue of the batch moves by the offset at its centre, interpolated between the matched sounds
  const offsetAt = (x: number) => {
    if (x <= keep[0][0]) return keep[0][1] - keep[0][0];
    for (let k = 1; k < keep.length; k++) {
      const [a, b] = keep[k - 1], [c2, d2] = keep[k];
      if (x <= c2) return b - a + ((x - a) / (c2 - a)) * (d2 - c2 - (b - a));
    }
    const [a, b] = keep[keep.length - 1];
    return b - a;
  };
  for (const c of batch) {
    const off = offsetAt((c.start + c.end) / 2);
    c.start = Math.max(0, c.start + off);
    c.end += off;
    aligned.add(c);
  }
  cues.sort((p, q) => p.start - q.start);
  return true;
}

/** How far placePhrases has read a line's loudness, and what it was reading (per cue list). */
const phraseScan = new WeakMap<Cue[], { t: number; quiet: number; voiced: boolean }>();
/**
 * After a pause, the next phrase's stamps can be far off: eleven_v4_turbo times its words from the text, and "mood,
 * mostly" came 300 ms late, out of the closure snapping's reach, so "mostly" was never mouthed. Where the voice comes
 * back after a pause (pauseLevel for pauseMin), the first word stamped after the voice stopped moves onto it with the
 * rest of its phrase, but only when it is more than phraseSlack off: smaller offsets are stamp jitter that the snapping
 * handles (moving every phrase start onto the voice was tried before and made lines worse). Reads the loudness as it is
 * decoded; cues count as placed (isPlaced) once the scan has passed their stamp by phraseMaxShift. Run after
 * placeLine, before the snapping. Returns true if anything moved.
 */
export function placePhrases(cues: Cue[], loudness: (t: number) => number, decodedSeconds: number, enabled = LIPSYNC_PARTS.placePhrases): boolean {
  let last = 0;
  for (const c of cues) if (c.ws !== undefined && c.ws > last) last = c.ws;
  const end = decodedSeconds === Infinity ? last + LIPSYNC.phraseMaxShift + LIPSYNC.pauseMin + 0.5 : decodedSeconds - 0.05;
  const scan = phraseScan.get(cues) ?? phraseScan.set(cues, { t: 0, quiet: 0, voiced: false }).get(cues)!;
  let moved = false;
  for (; scan.t < end; scan.t += 0.01) {
    if (!enabled) {
      scan.t = end;
      break;
    }
    const l = loudness(scan.t);
    if (l < LIPSYNC.pauseLevel) {
      scan.quiet += 0.01;
      continue;
    }
    if (scan.voiced && scan.quiet >= LIPSYNC.pauseMin) {
      const onset = scan.t, stopped = scan.t - scan.quiet;
      // the first word stamped after the voice stopped, and where it is now (an earlier phrase may have moved it)
      let first = Infinity;
      for (const c of cues) if (c.ws !== undefined && c.ws >= stopped - 0.1 && c.ws < first) first = c.ws;
      let at = Infinity;
      for (const c of cues) if (c.ws === first && c.start < at) at = c.start;
      const off = onset - at;
        if (at !== Infinity && Math.abs(off) > LIPSYNC.phraseSlack && Math.abs(off) <= LIPSYNC.phraseMaxShift) {
        for (const c of cues) {
          if (c.ws === undefined || c.ws < first) continue;
          c.start = Math.max(0, c.start + off);
          c.end += off;
        }
        moved = true;
      }
    }
    scan.voiced = true;
    scan.quiet = 0;
  }
  const settled = Math.min(scan.t, end) - LIPSYNC.phraseMaxShift - LIPSYNC.pauseMin;
  for (const c of cues) if (!phrased.has(c) && (!enabled || c.ws === undefined || c.ws < settled || (scan.t >= end && decodedSeconds === Infinity))) phrased.add(c);
  if (moved) cues.sort((p, q) => p.start - q.start);
  return moved;
}

const VOWELS = new Set<VisemeId>(["aa", "E", "I", "O", "U"]);
/**
 * The cues in the order they are said (Cue.n; hand-made cues without it keep their start order). Sorted once per line
 * when every cue has its `n` (the snapping moves starts, never `n`), not every frame.
 */
const spokenOrder = new WeakMap<Cue[], Cue[]>();
const bySpoken = (p: Cue, q: Cue) => (p.n ?? 0) - (q.n ?? 0) || p.start - q.start;
const spoken = (cues: Cue[]) => {
  if (cues.some((c) => c.n === undefined)) return [...cues].sort(bySpoken);
  let order = spokenOrder.get(cues);
  if (!order || order.length !== cues.length) {
    order = [...cues].sort(bySpoken);
    spokenOrder.set(cues, order);
  }
  return order;
};
const peakOf = new WeakMap<Cue, number>(); // the syllable peak a vowel cue took (snapVowels)

/** Move each vowel cue onto its syllable's loudness peak (LIPSYNC.vowelSearch). Same contract as snapClosures. */
export function snapVowels(cues: Cue[], loudness: (t: number) => number, decodedSeconds: number, snapped: WeakSet<Cue>): boolean {
  const L = LIPSYNC;
  const cache = new Map<number, number>();
  const lv = (t: number) => {
    const i = Math.round(t * 100);
    let v = cache.get(i);
    if (v === undefined) cache.set(i, (v = 20 * Math.log10(Math.max(windowedLoudness(loudness, i / 100, 0.04), 1e-3))));
    return v;
  };
  const claimed: number[] = [];
  for (const c of cues) if (snapped.has(c) && peakOf.has(c)) claimed.push(peakOf.get(c)!);
  let moved = false;
  const order = spoken(cues);
  for (let k = 0; k < order.length; k++) {
    const c = order[k];
    if (snapped.has(c) || !VOWELS.has(c.viseme) || c.glide || !isPlaced(c)) continue;
    // the "oo" of "go": the same syllable as the "o", it follows it (taking a peak of its own, "coat" was mouthed "co-t-oo")
    if (c.offglide && LIPSYNC_PARTS.offglide) continue;
    const centre = (c.start + c.end) / 2;
    if (centre + L.vowelRescue + 0.1 > decodedSeconds) continue;
    // A vowel is said between the closures spelled around it: its peak lies after the one before has let go and before
    // the next one's quiet stretch (both placed on the audio already: wait for the next one).
    let after = 0, before = Infinity, waiting = false;
    for (let j = k - 1; j >= 0; j--) if (CLOSED_VISEMES.includes(order[j].viseme)) {
      if (fromAudio.has(order[j])) after = order[j].end;
      break;
    }
    for (let j = k + 1; j < order.length; j++) if (CLOSED_VISEMES.includes(order[j].viseme)) {
      if (fromAudio.has(order[j])) before = dipOf.get(order[j]) ?? order[j].start;
      else waiting = !snapped.has(order[j]) && decodedSeconds !== Infinity;
      break;
    }
    if (waiting) continue;
    // the nearest syllable peak within vowelSearch, else within vowelRescue
    const audible = 20 * Math.log10(L.vowelSilence);
    const nearest = (search: number) => {
    let best: number | null = null;
    for (let t = Math.max(0.01, centre - search); t <= centre + search; t += 0.01) {
      if (t <= after || t >= before) continue;
      const v = lv(t);
      if (v < audible) continue; // a breath or a click, not a vowel
      if (v < lv(t - 0.01) || v < lv(t + 0.01)) continue; // not a peak
      let left = v, right = v;
      for (let k = 1; k <= 8; k++) {
        left = Math.min(left, lv(t - k * 0.01));
        right = Math.min(right, lv(t + k * 0.01));
      }
      if (v - Math.max(left, right) < L.vowelProm) continue; // a bump, not a syllable
      if (claimed.some((p) => Math.abs(p - t) < 0.06)) continue;
      if (best === null || Math.abs(t - centre) < Math.abs(best - centre)) best = t;
    }
    return best;
    };
    // stamped where nothing sounds, it is certainly misplaced: it may look further (a vowel on a flat stretch stays put)
    const quiet = 20 * Math.log10(Math.max(windowedLoudness(loudness, centre, 0.04), 1e-3)) < audible;
    const best = nearest(L.vowelSearch) ?? (quiet ? nearest(L.vowelRescue) : null);
    snapped.add(c);
    if (best === null) continue;
    const half = (c.end - c.start) / 2;
    const was = c.start;
    c.start = Math.max(0, best + L.vowelShift - half);
    c.end = c.start + 2 * half;
    const glide = order[k + 1];
    if (LIPSYNC_PARTS.offglide && glide && glide.offglide && glide.ws === c.ws) {
      glide.start = Math.max(0, glide.start + c.start - was);
      glide.end += c.start - was;
      snapped.add(glide);
    }
    peakOf.set(c, best);
    claimed.push(best);
    moved = true;
  }
  if (moved) cues.sort((p, q) => p.start - q.start);
  return moved;
}

/**
 * The strongest audio-anchored closure of one kind (PP or FF) at audio time t (raw envelope, before smoothing). LipSync
 * lets this much of it past the closure gate, so the lips can start to close just before the sound drops and stay shut through an "m",
 * whose hum stays loud. Only up to the burst, and only while the closure's own dip is at most `closureAhead` away:
 * after the burst, or on a dip that was the wrong one, the closure gate applies as usual.
 */
export function audioClosureAt(cues: Cue[], t: number, loudness: (t: number) => number, viseme: VisemeId = "PP", treble: (t: number) => number = loudness): number {
  let v = 0;
  for (const c of cues) {
    if (c.start - LIPSYNC.attack > t) break; // sorted by start; PP's and FF's attack is shorter than the default
    if (c.viseme !== viseme || !fromAudio.has(c) || t > c.end) continue;
    const e = envelope(c, t);
    if (e <= v) continue;
    const env = c.nasal ? treble : loudness; // the envelope its dip was found in (snapClosures)
    let ahead = Infinity;
    for (let k = 0; k <= LIPSYNC.closureAhead + 1e-6; k += 0.01) ahead = Math.min(ahead, env(t + k));
    if (ahead <= 2 * env(dipOf.get(c)!) + 0.02) v = e;
  }
  return v;
}

/**
 * The closure around a loudness dip at `dip` (s), from the 10 ms loudness: [where the sound fell halfway (in dB) from
 * the loudest moment before it into the dip, the steepest rise after the dip (the burst, or the vowel after an "m")].
 * After silence the closure runs up to the burst (no drop to measure). Null when nothing rises out of the dip
 * (LIPSYNC.closureMinDb).
 */
export function closureSpan(loudness: (t: number) => number, dip: number, back = LIPSYNC.closureSearch, nasal = false): [number, number] | null {
  const db = (t: number) => 20 * Math.log10(Math.max(loudness(t), 1e-3));
  const W = LIPSYNC.closureSearch;
  const floor = db(dip);
  let peak = dip;
  for (let t = dip - back; t < dip; t += 0.01) if (db(t) > db(peak)) peak = t;
  let after = floor;
  for (let t = dip; t <= dip + W; t += 0.01) after = Math.max(after, db(t));
  if (nasal && db(peak) - floor < LIPSYNC.closureMinDb) {
    // an "m" after silence (the line's start, a pause): the lips are shut through the silence and the hum, until the
    // treble comes back near the vowel's (the hum's own onset is a steep rise, but not the lips opening)
    if (after - floor < LIPSYNC.closureMinDb) return null;
    const open = Math.max(floor + LIPSYNC.closureBurstDb, after - LIPSYNC.closureVowelDb);
    let end = dip + 0.01;
    while (end < dip + W && db(end) < open) end += 0.01;
    const on = Math.max(0, dip - 0.03);
    return [on, Math.max(end, on + 0.03)];
  }
  if (after - floor < LIPSYNC.closureMinDb) return null;
  // the burst: the first strong rise after the dip (the steepest one can be a later vowel: "pr-o", "be-f-o")
  let steepest = 0;
  for (let t = dip; t < dip + W; t += 0.01) steepest = Math.max(steepest, db(t + 0.01) - db(t));
  let burst = dip + 0.01;
  for (let t = dip; t < dip + W; t += 0.01) {
    if (db(t + 0.01) - db(t) >= Math.min(steepest, Math.max(LIPSYNC.closureBurstDb, 0.5 * steepest))) {
      burst = t + 0.01;
      break;
    }
  }
  // after silence (a pause, the line's start: "peppers, but"): no drop into the dip to measure, the lips are shut
  // through it, and part at the burst
  if (db(peak) - floor < LIPSYNC.closureMinDb) return LIPSYNC_PARTS.silenceSpan ? [Math.max(0, burst - LIPSYNC.closureMinDur), burst] : null;
  // where the sound fell halfway (in dB) into the dip; an "m" fades in gradually, so its lips are shut once the treble is
  // closureVowelDb below the vowel, if that comes first
  const half = nasal ? Math.max((db(peak) + floor) / 2, db(peak) - LIPSYNC.closureVowelDb) : (db(peak) + floor) / 2;
  let on = dip;
  while (on - 0.01 > peak && db(on - 0.01) < half) on -= 0.01;
  // … or where the sound is back near the vowel before it, if that comes first: a later, louder burst ("-bab-") can make
  // the rise into the vowel between look too small to count
  const recovered = Math.max(floor + LIPSYNC.closureBurstDb, db(peak) - LIPSYNC.closureVowelDb);
  for (let t = dip + 0.01; t < burst; t += 0.01) {
    if (db(t) >= recovered) {
      burst = t;
      break;
    }
  }
  const end = Math.min(burst, on + LIPSYNC.closureMaxDur);
  return [on, Math.max(end, on + 0.03)];
}

/**
 * What the mouth reads speech from: the speech player (a line the visitor asked for, decoded ahead of playback) or a
 * live conversation's voice (lib/lipsync/live.ts, analysed a short delay ahead of what is heard). Times are seconds of
 * the current line; loudness is known up to decodedSeconds().
 */
export interface SpeechSource {
  readonly playing: boolean;
  /** The line's time as the listener hears it now (negative before it starts). */
  time(): number;
  readonly cues: Cue[];
  decodedSeconds(): number;
  /** The whole line is in: nothing more will be added to the loudness. */
  readonly streamDone: boolean;
  loudness(t: number): number;
  trebleLoudness(t: number): number;
  /** The source places each phrase on its sound itself (live.ts anchors): the evaluator's placePhrases stays out. */
  readonly phrasesPlaced?: boolean;
  /** The gate's own look-ahead instead of LIPSYNC.gateLookahead (live.ts: LIPSYNC.liveGateLookahead). */
  readonly gateLookahead?: number;
}

/** What one source's frames keep between frames (LipSync.tsx keeps one per source). */
export interface FrameMemory {
  snapped: WeakSet<Cue>;
  lastOpen: VisemeId; // the vowel held while the voice still sounds after its cue ended
}
export const frameMemory = (): FrameMemory => ({ snapped: new WeakSet<Cue>(), lastOpen: "aa" });

/**
 * The viseme targets at time t (into `out`): the cues placed on the audio (line start, closures, vowels), then gated by
 * the loudness so the sound decides how far the mouth opens and when the lips may shut. One frame of LipSync.tsx, also
 * run offline to compare live sources against a whole decoded line.
 */
export function frameTargets(src: SpeechSource, t: number, lead: number, out: Activations, mem: FrameMemory, shapes?: Activations): void {
  // once the stream has ended the whole line is decoded: the last word's windows reach past the audio's end
  const decoded = src.streamDone ? Infinity : src.decodedSeconds();
  const loudnessOf = (x: number) => src.loudness(x);
  placeLine(src.cues, loudnessOf, decoded); // the stamps' offset at the start
  placePhrases(src.cues, loudnessOf, decoded, LIPSYNC_PARTS.placePhrases && !src.phrasesPlaced); // … and after each pause, where they are far off
  // an "m" closure is found in the treble (its hum keeps the loudness up): LIPSYNC_PARTS.trebleM
  const treble = LIPSYNC_PARTS.trebleM ? (x: number) => src.trebleLoudness(x) : loudnessOf;
  alignLine(src.cues, loudnessOf, treble, decoded, LIPSYNC_PARTS.alignPhrases && !src.phrasesPlaced); // the words' sounds in order onto the audio
  if (LIPSYNC_PARTS.snapClosures) snapClosures(src.cues, loudnessOf, decoded, mem.snapped, treble);
  if (LIPSYNC_PARTS.snapClosures && LIPSYNC_PARTS.followRelease) followRelease(src.cues, loudnessOf, mem.snapped);
  if (LIPSYNC_PARTS.fitPhrases) fitPhrases(src.cues, loudnessOf, decoded);
  if (LIPSYNC_PARTS.snapVowels) snapVowels(src.cues, loudnessOf, decoded, mem.snapped);
  targetsAt(src.cues, t + lead, out);
  // The open shapes read a windowed loudness (no wobble on 10 ms dips); closures read the raw one.
  const at = t + (src.gateLookahead ?? LIPSYNC.gateLookahead);
  const loud = src.loudness(at);
  const loudSmooth = windowedLoudness(loudnessOf, at, LIPSYNC.gateWindow);
  // measured against the loudest moment nearby, so a line that trails off still opens its last words (gateLocal)
  const rel = Math.min(1, loudSmooth / localPeak(loudnessOf, at));
  const gate = LIPSYNC_PARTS.gates ? loudnessGate(rel) * LIPSYNC.openGain : 1;
  if (shapes) {
    // the lips' shapes: the same cues under the softer shape gate (LIPSYNC.shapeGate); the jaw keeps `out`
    const G = LIPSYNC.shapeGate;
    const sg = LIPSYNC_PARTS.gates ? Math.min(1, Math.max(0, (rel - G.from) / (G.full - G.from))) : 1;
    for (const v of OPEN_VISEMES) shapes[v] = Math.min(peakCap[v], out[v] * sg);
  }
  const [preE, preI, preO, preU] = [out.E, out.I, out.O, out.U];
  for (const v of OPEN_VISEMES) out[v] = Math.min(peakCap[v], out[v] * gate);
  if (LIPSYNC_PARTS.gates && LIPSYNC_PARTS.hissGate) {
    // the jaw comes up for a hiss (LIPSYNC.hissClose), read over the gate's own window
    const H = LIPSYNC.hissClose;
    const ratio = windowedLoudness((x) => src.trebleLoudness(x), at, LIPSYNC.gateWindow) / Math.max(loudSmooth, 1e-3);
    const x = Math.min(1, Math.max(0, (ratio - H.from) / (H.to - H.from)));
    const keep = 1 - H.amount * x * x * (3 - 2 * x);
    for (const v of VOWELS) out[v] *= keep;
  }
  if (LIPSYNC_PARTS.gates && LIPSYNC_PARTS.shapeHold) {
    // the lips keep the vowel's shape as the loudness takes the opening away (LIPSYNC.shapeHold)
    const quiet = 1 - Math.min(1, gate);
    const H = LIPSYNC.shapeHold;
    out.I = Math.min(1, Math.max(out.I, preI * H.I) + preE * quiet * H.E);
    out.U = Math.min(1, Math.max(out.U, preU * H.U) + preO * quiet * H.O);
  }
  const cg = LIPSYNC_PARTS.gates ? closureGate(loud) : 1;
  // closures and f/v/th hisses found in the audio itself pass
  const anchoredPP = Math.min(out.PP, audioClosureAt(src.cues, t + lead, loudnessOf, "PP", treble));
  const anchoredFF = Math.min(out.FF, audioClosureAt(src.cues, t + lead, loudnessOf, "FF"));
  const anchoredTH = Math.min(out.TH, audioClosureAt(src.cues, t + lead, loudnessOf, "TH"));
  for (const v of CLOSED_VISEMES) out[v] *= cg;
  out.PP = Math.max(out.PP, anchoredPP);
  out.FF = Math.max(out.FF, anchoredFF);
  out.TH = Math.max(out.TH, anchoredTH);
  // Hold the last vowel while the voice is still sounding but its (early) cue has ended.
  let openSum = 0;
  for (const v of ["aa", "E", "I", "O", "U"] as VisemeId[]) {
    openSum += out[v];
    if (out[v] > out[mem.lastOpen] && out[v] > 0.25) mem.lastOpen = v;
  }
  // … not over a consonant's own shape: a loud "th" brought the "a" of "passed" back between "passed" and "through"
  const consonant = out.TH + out.FF + out.SS + out.CH;
  if (loudSmooth > LIPSYNC.sustainLoud && openSum < 0.25 && cg > 0.5 && !(LIPSYNC_PARTS.sustainYield && consonant > 0.2)) {
    out[mem.lastOpen] = Math.max(out[mem.lastOpen], Math.min(1, LIPSYNC.sustainLevel * gate) * (1 - Math.max(out.PP, out.FF)));
  }
  if (shapes) {
    for (const v of CLOSED_VISEMES) shapes[v] = out[v];
    shapes[mem.lastOpen] = Math.max(shapes[mem.lastOpen], out[mem.lastOpen]); // the held vowel holds its shape too
  }
}
