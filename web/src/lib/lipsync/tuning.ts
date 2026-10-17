/**
 * The lip sync's tuning: every timing, level and speed that the cue placement (placement.ts), the per-frame shapes
 * (shapes.ts, evaluator.ts) and the mouth (mouth.ts) read. Each value says what set it; how they were arrived at is in
 * docs/lipsync-report.md and the git history.
 */
import type { VisemeId } from "./cues";

export const LIPSYNC = {
  /** s the whole mouth (shapes and loudness) runs ahead (+) or behind (−) the sound; ?lipsyncOffsetMs= overrides. As
   *  drawn the mouth trails its computed time by 20–30 ms (smoothing, speed limit, the frame reaching the screen), and
   *  with the closures placed on the audio (placePhrases, the pause rule in syllableBetween) 30 ms lands the p/b/m
   *  releases on their bursts in Chrome, Firefox and Safari (real devices, qa/lipsync). The moving ahead a real mouth
   *  does is per sound: closures start forming attack + closureOnShift before their silence. */
  lead: 0.03,

  // The cue envelope (targetsAt).
  attack: 0.06, // s before a cue starts that its shape begins to form
  release: 0.09, // s after a cue ends that its shape has faded
  /** Closures snap shut and let go fast, so the vowels around a "p" stay open. */
  attackFor: { PP: 0.03, FF: 0.04, TH: 0.04, DD: 0.03 } as Record<string, number>,
  releaseFor: { PP: 0.03, FF: 0.06, TH: 0.06, DD: 0.04 } as Record<string, number>,
  /** Smoothing time constants (s). The speed limit (gapSpeed / jawSpeed) keeps the motion calm, so the open shapes can
   *  follow quickly: at 0.04 the vowel peaks land ~15 ms earlier than at 0.06 and closures press better. */
  tau: { PP: 0.03, FF: 0.035, TH: 0.035, default: 0.04 } as Record<string, number>,
  /** Vowels and lip closures are what the eye reads; quick consonants stay subtle. */
  peak: { PP: 1, FF: 1, TH: 0.85, DD: 0.35, SS: 0.5, CH: 0.8, default: 1 } as Record<string, number>,
  /** An unstressed vowel (a schwa: "a", "the", "of", "-ably", Cue.weak) opens only this far, however long it is: at
   *  0.45 "A king…", "A cup…" barely moved. */
  weakPeak: 0.6,
  /** An "r" (a glide folded to the "oo" shape) rounds the lips only this much, however long: at full it puckered in
   *  the middle of "grass" and "through". */
  rPeak: 0.4,
  /** How strongly the strongest shape suppresses the others (0 = plain additive, 1 = winner only). */
  emphasis: 0.45,
  maxGroupSum: 1.3,

  // The loudness gate (frameTargets).
  /** Open shapes are scaled by the audio's own loudness: fully open only while there is sound. gateLevel is the
   *  loudness (0..1 of the loudest moment around it) at which the gate is fully open: near 1 the loudness rather than
   *  the letters decides how far the mouth opens, so each syllable opens and closes with the sound (mouth vs loudness
   *  correlation 0.76 on real chat replies; at 0.2–0.3 the mouth stayed open for whole words, 0.62). */
  gateLevel: 0.9,
  /** The least the gate lets through, so quiet vowels stay visible: at 0.05 a quiet "A" or "the" barely opened (late
   *  releases on the tuning lines: 24 at 0.25, 32 at 0.05). */
  gateFloor: 0.25,
  /** The gated shapes then open this much wider (capped at 1): at 1 the mouth looked too closed. */
  openGain: 1.5,
  /** s ahead the gate reads the loudness (negative: behind). Real lips (GRID, 4 talkers, qa/lipsync/human.py) start
   *  closing for a p/b/m ~90 ms before the sound falls and open widest ~27 ms after a vowel's loudest moment; at −0.04
   *  (with closureOffShift 0) the app closes 89 ms before and peaks 5 ms after, f/v +67 ms vs the talkers' +74. */
  gateLookahead: -0.04,
  /** … for a chat (live.ts): its f/v stay on the agent's word times, and reading behind held the vowel before them open
   *  (live bench f/v +102 ms at −0.04, +62 at 0, vs the talkers' +74). */
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
  /** jawSplit: the lips' shape (every target but the jaw's) follows its own, softer gate on the local loudness: none in
   *  silence (below `from`), full once the voice is `full` of the loudest moment nearby, so a quiet word keeps its
   *  rounding or spread while the jaw (the loudness gate) opens it only a little. */
  shapeGate: { from: 0.05, full: 0.3 },
  /** The lips hold a vowel's shape while the loudness only takes the opening away, as in real speech (the jaw beats
   *  once a syllable; the lips stay rounded or spread through it). Gated as a whole, vowels reached 45–63% of their
   *  pose and the mouth made ~3.5 open-close cycles a second, with "o" and "u" not round enough. As the gate closes, an
   *  "o" keeps its rounding in "u" (rounded, jaw nearly shut) and an "eh" its spread in "ee" (O, E: share of the vowel
   *  handed over); "ee" and "oo", mostly lip shape themselves, keep at least this much of themselves (I, U). The poses
   *  stay the solved, capped ones. */
  shapeHold: { O: 0.7, E: 0.5, I: 0.8, U: 0.85 } as Record<"O" | "E" | "I" | "U", number>,
  /** A hiss (s, sh, f, th) is loud, and the loudness gate opened the vowel before it again ("grass": open, half shut,
   *  open on the "s"). Where the treble outweighs the loudness (both over their own line peaks: vowel peaks ~0.55,
   *  f/v/th ~2.1, s ~2.8 on the Harvard lines) from `from` to `to`, the vowels' opening fades by up to `amount`: the jaw
   *  comes up for the hiss. The hiss shapes (s, sh, f, th) are left alone. */
  hissClose: { from: 1.2, to: 2.5, amount: 0.6 },

  // The closure gate and seal.
  /** Closures are suppressed above this loudness (0..1 of the clip's peak) over a band this wide. */
  closureLoud: 0.4,
  closureBand: 0.3,
  closureAhead: 0.04, // s: an audio-anchored closure skips the closure gate once its dip is this close (audioClosureAt)
  /** Closure activation (PP + FF, after smoothing) at which the open shapes are fully suppressed,
   *  so the lips really meet on a "p"/"b"/"m" instead of hovering over a fading vowel. */
  sealAt: 0.9,

  // Closures and hisses onto the audio (snapClosures, closureSpan).
  /** Closures move to the nearest loudness dip in [stamp − snapBefore, stamp + snapAfter]. Most stamps run early, but
   *  a fast voice's can be 140 ms late ("peppers"): 0.2 finds those with no closure worse across 7 voices (0.12 missed
   *  them). */
  snapBefore: 0.2,
  snapAfter: 0.16,
  /** Score candidate dips in dB (quiet − snapDbPerS × distance from the stamp), so a real silence a little further from
   *  the stamp beats a soft consonant next to it; 0 = the plain loudness + distance score. */
  snapDbPerS: 150,
  /** A p/b/m then spans the closure the audio shows: from where the sound drops into the dip to the burst (the
   *  steepest rise after it), so the lips part when the sound comes back and back-to-back closures keep the vowel
   *  between them. Its start moves earlier by closureOnShift and its end by closureOffShift (s): the mouth's smoothing
   *  and LIPSYNC.lead take the rest. Real lips (GRID corpus, 4 talkers, qa/lipsync/grid.py and human.py, measured the
   *  same way) are shut ~4 ms after the sound falls and part ~24 ms after the burst, which 0 and 0 match (0.03 / 0.02
   *  shut ~13 ms early and parted on the burst). */
  closureOnShift: 0,
  closureOffShift: 0,
  /** … an f/v or th starts this much earlier still (s): the lower lip is on the teeth (the tongue between them) as the
   *  hiss begins, not 25 ms into it */
  hissOnShift: 0.025,
  nasalRelease: 0.02, // s added to an "m"'s end (its release is read from the treble coming back, which rises gradually)
  /** s: shorter closures start earlier (the lips need this long to meet), still parting at the burst: closing then
   *  starts ~91 ms before the sound falls, as the GRID talkers' ~90 (390 of 402 tuning-line closures sealed). */
  closureMinDur: 0.09,
  closureSearch: 0.12, // s searched before the dip (for the drop) and after it (for the burst)
  hissSearch: 0.25, // … before an f/v's dip: a hiss can be longer than a closure, so the vowel before it lies further back
  closureMinDb: 6, // a dip shallower than this (dB below the sound around it) is not trusted: the cue stays centred on it
  closureMaxDur: 0.2,
  closureBurstDb: 6, // a rise of this much (dB per 10 ms) after the dip counts as the burst
  closureApart: 0.04, // s: gap kept between two p/b/m closures (no two letters share one quiet stretch)
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
  joinWithin: 0.25, // s: two p/b/m with no vowel between, their dips this close, are one closure (joinClosure)
  vowelBoundSlack: 0.03, // s: a closure's dip may lie this far past the centre of the vowel stamped after it
  vowelBoundBefore: 0.04, // s: … and lies after the centre of the vowel stamped before it, less this (−1: no such bound)
  /** s: an f/v or th lasts at most this long from where its hiss begins (a misplaced one took a whole word: "fast"). */
  hissMaxDur: 0.2,
  /** An f/v or th is a hiss: never on a stretch quieter than this (of the line's peak; ~−48 dB), where there is no
   *  sound at all ("The tiny…": the th was put on the silence before the voice, and "The" opened twice). */
  hissFloor: 0.004,

  // The whole line onto the audio (placeLine).
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
  squeezedPerCue: 0.06, // s per mouth shape: a first word stamped tighter than this is squeezed (placeLine)

  // Each phrase onto the audio (placePhrases).
  /** After a pause (pauseLevel for pauseMin), the first word stamped after the voice stopped moves onto where the voice
   *  comes back, with the rest of its phrase, when it is more than phraseSlack (s) off, by at most phraseMaxShift (s).
   *  Smaller offsets are stamp jitter, left to the closure and vowel snapping. */
  phraseSlack: 0.03,
  phraseMaxShift: 0.35,

  // The line's sounds in order onto the audio (alignLine).
  /** How far (s) a sound may move, how much a sound left unmatched costs (in (offset/spread)²), the spread (s) of a
   *  p/b/m's and a vowel's stamps around their sound, where a p/b/m's cue centre sits after its closure's dip (s), how
   *  much audio (s) past a batch must be decoded before it is aligned, and how often (s of new audio) to align. */
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

  // Pauses (fitPhrases, placePhrases, syllableBetween).
  /** A pause is the voice quieter than pauseLevel (of the line's peak, 40 ms window) for at least pauseMin (s): lower
   *  than vowelSilence, which an f, th or s can fall under for as long. Longer than a stop's closure: at 0.15 the
   *  160 ms "b" of a stressed "best" was taken for a pause and placePhrases moved "the best pumpkin bread" 0.23 s
   *  late. */
  pauseLevel: 0.03,
  pauseMin: 0.2,
  holdLevel: 0.2, // fitPhrases: a phrase's last vowel holds while the voice is at least this loud (of the line's peak)

  // Vowels onto the audio (snapVowels).
  /** eleven_v4_turbo spreads the letters evenly over a word, so a vowel's stamp can sit far from its sound. The cue's
   *  centre goes to the nearest loudness peak within vowelSearch (s) that stands vowelProm dB above the dips on both
   *  sides, plus vowelShift (s; − = earlier, to make up for the smoothing). Each peak takes one vowel; the letters
   *  still choose the shape. */
  vowelSearch: 0.15,
  vowelProm: 3,
  vowelShift: 0,
  /** A peak quieter than vowelSilence (of the line's peak, in a 40 ms window) is a breath or a click, not a vowel; a
   *  vowel stamped that quiet, with no peak within vowelSearch, looks up to vowelRescue (s) for its syllable.
   *  eleven_v4_turbo stamped "like" in "…what I sound like" 0.16 s after it was said, its nearest peak was a breath
   *  31 dB down, and the mouth stayed shut while it was heard. */
  vowelSilence: 0.08,
  vowelRescue: 0.35,
  /** A line timed by forced alignment on its own audio (speech.ts: SpeechSource.aligned) has its vowels close to their
   *  sound already: they look only this far (s) for their peak, and placeLine, placePhrases and alignLine stay out.
   *  300 Harvard lines in six voices all passed the line-test review this way. */
  alignedVowelSearch: 0.06,
  alignedVowelRescue: 0.06,

  // Sounds after a closure (followRelease) and between two of the same vowel (bridgeVowels).
  /** The sounds after a p/b/m or f/v in its word start at most releaseGap (s) after it lets go, moved up by at most
   *  releaseMaxShift (s), when the voice is louder than releaseLoud (0..1 of the line's peak) after it. */
  releaseGap: 0.06,
  releaseMaxShift: 0.3,
  releaseLoud: 0.1,
  /** s: the longest t, d, n or k gap that bridgeVowels holds a vowel through */
  bridgeGap: 0.1,

  // The tongue (tongueAt, lateralAt, mouth.ts).
  /** The tongue tip for d/t/n/l: up against the ridge behind the upper teeth at full height (the "dd" pose's tongue),
   *  rising tongueAhead (s) before the contact and down again tongueAfter after it. On its own track: formed with the
   *  rest of the "d" (LIPSYNC.peak.DD, 0.35, behind the vowels' emphasis) it reached 10% of its pose. */
  tongueAhead: 0.05,
  tongueAfter: 0.05,
  /** How much of a t/d/n/l's tongue raise gives way while "ah", "eh" or "oh" is still formed (their sum, up to 1). */
  tongueYield: 0.7,
  /** How much of an "l"'s tongue pose (visemes.json "ll": the tip at the edge of the upper teeth) shows; the rest is the
   *  "d"'s, behind the teeth. At 1 "soldiers" and "tool" showed too much tongue. */
  lateralShare: 0.4,

  // Rounded closures (roundingAt, mouth.ts).
  /** A p/b/m next to a rounded vowel is made with the lips already rounded ("blue", "boots", "moving"): the PP shape
   *  blends into visemes.json "ppr" (lips sealed, pushed forward and in) by the rounding of a U (1) or O (roundO) cue
   *  that starts within roundAhead (s) or ended within roundAfter (s), eased with time constant roundTau (s). */
  roundAhead: 0.2,
  roundAfter: 0.05,
  roundO: 0.6,
  roundTau: 0.04,

  // The expression while speaking (mouth.ts).
  /** The emotion's mouth part and the mouth sliders step back while speaking: while there is voice (louder than
   *  speechLoud, 0..1 of the clip's peak) within speechHold (s) before or speechAhead (s) after now, eased with time
   *  constant speechFade (s). Once per phrase, not after every word: following the mouth's own activity makes them
   *  pump back in between words, which reads as the mouth moving after the sound. When the voice stops they come back
   *  over speechRelease (s), eased in and out: with speechFade they would snap back to the expression in a few
   *  frames. */
  speechHold: 0.35,
  speechAhead: 0.15,
  speechLoud: 0.06,
  speechFade: 0.1,
  speechRelease: 0.8,

  // Speed limits (speedShare, speedUpShare, shapeShare).
  /** The fastest the lips (mm/s of opening between them) and the jaw (mm/s, nose to chin) may move: real lips and jaws
   *  have a top speed, and moving faster in one frame reads as a jump. Each frame the whole mouth moves only as far
   *  toward its new shape as both allow (its path is kept, only slowed). From visemes.json "speed". 0 = no limit. */
  gapSpeed: 150,
  jawSpeed: 100,
  /** gapSpeed, jawSpeed and speedUp are this many times higher while a p/b/m or f/v pulls the mouth shut: real lips
   *  shut at 200–300 mm/s, and at the calm speeds a short closure after a wide vowel ("copper", "rubbish": 16 mm open,
   *  60 ms shut) never met. Opening keeps the calm speeds. 1 = no difference. At 2, 388 of the tuning lines' 402
   *  closures seal (385 at 1) with sharp speed changes unchanged. */
  closeBoost: 2,
  /** As closeBoost, for how fast a closing may speed up (speedUp): at 1.5, 392 sealed but sharp speed changes rose from
   *  3.4 to 3.9 m/s². */
  closeBoostUp: 1,
  /** How fast (m/s², lips and jaw alike) a movement may speed up: the smoothing moves fastest the moment a shape is
   *  asked for, so every movement started with a jolt. Slowing down is left alone, so the mouth never overshoots (a
   *  p/b/m still shuts). Sharp speed changes p95 3.2 m/s² on the saved clips (4.0 unlimited), timing unchanged.
   *  0 = no limit. */
  speedUp: 3,
  /** Top speeds (mm/s) for the mouth's width (corners spread or pulled in) and its rounding (lips pushed forward), like
   *  gapSpeed / jawSpeed: unlimited, they jumped between spread and rounded sounds ("we should": up to 420 mm/s at the
   *  corners, 140 mm/s forward). Per unit of each shape (mm), measured on the shapes (pipeline viseme_solve: "ee"
   *  spreads 1.6 mm, "oo" corners in 8.7 and lips +4.8, "oh" 5.6 and +2.5, "sh" 6 and +3). */
  widthSpeed: 120,
  roundSpeed: 50,
  shapeMm: { width: { I: 1.6, O: -5.6, U: -8.7, CH: -6 }, round: { O: 2.5, U: 4.8, CH: 3 } } as { width: Partial<Record<VisemeId, number>>; round: Partial<Record<VisemeId, number>> },

  /** While the audio stays above this loudness (0..1 of the clip's peak) with no vowel cue active, the last vowel
   *  is held at sustainLevel. */
  sustainLoud: 0.45,
  sustainLevel: 0.7,
};

/** Pieces of the lip sync, each switched off with ?lipsyncOff= (and a local dev page) to compare on the same clip by
 *  eye. All on in the app. */
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
  afterStop: true, // an f/v or th right after a t, d, k or g starts on its hiss, without hissOnShift's head start (snapClosures)
  bridgeVowels: true, // two of the same vowel with only a t, d, n or k between are held as one (bridgeVowels)
  voicedTh: true, // the voiced th of "the" (DH) is not looked for in the audio's quiet stretches (snapClosures)
  tongueYield: true, // the tongue's raise gives way to an open vowel still being made (LIPSYNC.tongueYield, mouth.ts)
  sustainNearest: true, // the voice sounding with no vowel stamped holds the nearer vowel, before or coming (frameTargets)
  weakNoRound: true, // a weak vowel ("-er") does not round the p/b/m before it (roundingAt)
  humEndsVowel: true, // a vowel an "m" ended is not held through the m's hum (frameTargets: sustainLoud)
  snapHiss: true, // an s or sh is placed on its hiss in the audio like an f/v or th (snapClosures): "the spot", aligned with the s after the p
  vowelBounds: true, // a p/b/m's closure lies between the vowels around it, not on the next word's (snapClosures)
  onsetGap: true, // a sound apart from the first word by a silence doesn't count as the line's start (placeLine)
  alignPhrases: true, // the line's p/b/m and vowels matched in order to the audio's dips and syllable peaks (alignLine)
  squeezedFirst: true, // a first word squeezed after an audio tag is spread back to the voice's onset, alone (placeLine)
  forcedAlignment: true, // a spoken line's times from forced alignment on its audio when the speak route sends them (player.ts)
  liveVoiceStart: true, // a chat's first word placed on the voice's start as the agent measured it, at once (live.ts voiceStart)
  liveAcross: true, // a chat's word stamped across a pause starts where the voice comes back (live.ts findAnchors)
};

/** The mouth lead in seconds: LIPSYNC.lead, or a `?lipsyncOffsetMs=` value (ms) kept to ±500 ms. */
export function mouthLead(param: string | null): number {
  const ms = param !== null && Number.isFinite(Number(param)) ? Math.max(-500, Math.min(500, Number(param))) : LIPSYNC.lead * 1000;
  return ms / 1000;
}
