/**
 * Per-frame viseme activations from cues. Each cue ramps in before its onset (anticipation),
 * holds, and ramps out after; closed shapes (PP/FF) dominate open ones so lips can actually
 * close mid-vowel; the mouth group is capped at 1 so additive morphs never over-drive; and a
 * frame-rate-independent exponential smoothing removes flicker. Tune attack/release first.
 */
import { VISEME_IDS, type Cue, type VisemeId } from "./cues";

export const LIPSYNC = {
  /** Seconds the mouth runs ahead (+) or behind (−) ElevenLabs' character times. ?lipsyncOffsetMs= overrides. It was
   *  +0.02 to make up for the slower smoothing; with the quicker smoothing under the speed limit (2026-10-09) the mouth
   *  lands on the sound at 0 (lip releases and vowel peaks measured against a forced aligner on the saved clips). */
  lead: 0,
  attack: 0.06, // s before a cue starts that its shape begins to form
  release: 0.09, // s after a cue ends that its shape has faded
  /** Closures snap shut and let go fast, so the vowels around a "p" stay open. */
  attackFor: { PP: 0.03, FF: 0.04, TH: 0.04, DD: 0.03 } as Record<string, number>,
  releaseFor: { PP: 0.03, FF: 0.06, TH: 0.06, DD: 0.04 } as Record<string, number>,
  /** Smoothing time constants (s). The speed limit (gapSpeed / jawSpeed) keeps the motion calm, so the open shapes can
   *  follow quickly (default 0.06 → 0.04 on 2026-10-09: vowel peaks ~15 ms earlier, closures press better). */
  tau: { PP: 0.03, FF: 0.035, TH: 0.035, default: 0.04 } as Record<string, number>,
  /** Vowels and lip closures are what the eye reads; quick consonants stay subtle. */
  peak: { PP: 1, FF: 1, TH: 0.85, DD: 0.35, SS: 0.5, default: 1 } as Record<string, number>,
  /** An unstressed vowel (a schwa: "a", "the", "of", "-ably", Cue.weak) opens only this far, however long it is. */
  weakPeak: 0.45,
  /** How strongly the strongest shape suppresses the others (0 = plain additive, 1 = winner only). */
  emphasis: 0.45,
  maxGroupSum: 1.3,
  /** Open shapes are scaled by the audio's own loudness: fully open only while there is sound.
   *  gateFloor keeps quiet vowels visible; gateLevel is the loudness (0..1 of the clip's peak) at
   *  which the gate is fully open. */
  gateFloor: 0.2,
  gateLevel: 0.3,
  gateLookahead: 0.03, // s; the audio is decoded ahead of playback, so the gate can open as the sound starts
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
  /** Closures move to the nearest loudness dip in [stamp − snapBefore, stamp + snapAfter]; the
   *  stamps run early, so the true closure is usually a little after them. */
  snapBefore: 0.04,
  snapAfter: 0.16,
  /** A p/b/m then spans the closure the audio shows: from where the sound drops into the dip to the burst (the
   *  steepest rise after it), so the lips part when the sound comes back and back-to-back closures keep the vowel
   *  between them. The edges are moved earlier by these (s): the mouth's smoothing and LIPSYNC.lead take the rest. */
  closureOnShift: 0.03,
  closureOffShift: 0.02,
  closureMinDur: 0.05, // s: shorter closures start earlier (the lips need this long to meet), still parting at the burst
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
  closureAhead: 0.04, // s: an audio-anchored closure skips the closure gate once its dip is this close (audioClosureAt)
  /** eleven_v4_turbo stamps the first word off from the voice (a silent audio tag in front takes stamp time: "Test"
   *  after "[worried, tense and quick]" came 100 ms late; untagged lines start 40–70 ms early). placeLine moves the
   *  cues earlier by how late the first word is stamped (voice onset − its stamp), at most lineMaxShift (s), fading to
   *  nothing over lineFade (s) of the line: later words are as often early as late. Only late stamps are moved: the
   *  closure and vowel snapping already look further after a stamp than before it, for early ones. The voice onset
   *  is the first 10 ms louder than lineOnsetDb. */
  lineOnsetDb: -30,
  lineMaxShift: 0.3,
  lineFade: 1.5,
  /** Vowels move onto the loudest moment of their syllable (snapVowels): eleven_v4_turbo spreads the letters evenly over
   *  a word, so a vowel's stamp can sit far from its sound. The cue's centre goes to the nearest loudness peak within
   *  vowelSearch (s) that stands vowelProm dB above the dips on both sides, plus vowelShift (s; − = earlier, to
   *  make up for the smoothing). Each peak takes one vowel; the letters still choose the shape. */
  vowelSearch: 0.15,
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
   *  pump back in between words, which reads as the mouth moving after the sound. */
  speechHold: 0.35,
  speechAhead: 0.15,
  speechLoud: 0.06,
  speechFade: 0.1,
  /** Closure activation (PP + FF, after smoothing) at which the open shapes are fully suppressed,
   *  so the lips really meet on a "p"/"b"/"m" instead of hovering over a fading vowel. */
  sealAt: 0.9,
  /** The fastest the lips (mm/s of opening between them) and the jaw (mm/s, nose to chin) may move: real lips and jaws
   *  have a top speed, and moving faster in one frame reads as a jump. Each frame the whole mouth moves only as far
   *  toward its new shape as both allow (its path is kept, only slowed). From visemes.json "speed". 0 = no limit. */
  gapSpeed: 150,
  jawSpeed: 100,
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
};

/** The mouth lead in seconds: LIPSYNC.lead, or a `?lipsyncOffsetMs=` value (ms) kept to ±500 ms. */
export function mouthLead(param: string | null): number {
  const ms = param !== null && Number.isFinite(Number(param)) ? Math.max(-500, Math.min(500, Number(param))) : LIPSYNC.lead * 1000;
  return ms / 1000;
}

export const OPEN_VISEMES: VisemeId[] = ["aa", "E", "I", "O", "U", "DD", "SS"];
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
  const peak = cue.weak ? LIPSYNC.weakPeak : (LIPSYNC.peak[cue.viseme] ?? LIPSYNC.peak.default);
  const long = cue.end - cue.start > 0.12 && !cue.weak && !["DD", "SS", "TH"].includes(cue.viseme) ? 1 : peak;
  if (t < cue.start) return long * (1 - (cue.start - t) / a);
  if (t <= cue.end) return long;
  return long * (1 - (t - cue.end) / r);
}

/** Raw targets for time t (no smoothing). */
export function targetsAt(cues: Cue[], t: number, out: Activations): Activations {
  for (const v of VISEME_IDS) out[v] = 0;
  for (const cue of cues) {
    if (cue.end + LIPSYNC.release < t) continue; // release is the longest fade, so this is safe
    if (cue.start - LIPSYNC.attack > t) break; // cues are sorted by start
    out[cue.viseme] = Math.max(out[cue.viseme], envelope(cue, t));
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

/** Factor the open shapes are scaled by once a closure has actually formed (post-smoothing).
 *  1 = untouched, 0 = fully sealed; a smooth ramp so small closure residue does no harm. */
export function sealWeight(act: Activations): number {
  const d = Math.min(1, (act.PP + act.FF) / LIPSYNC.sealAt);
  return 1 - d * d * (3 - 2 * d);
}

/** The share (0..1) of this frame's step the mouth may take: the lips may open or close by at most LIPSYNC.gapSpeed and
 *  the jaw by jawSpeed (mm/s) over `dt` seconds. dGap / dJaw: the step's change in mm. */
export function speedShare(dGap: number, dJaw: number, dt: number): number {
  let share = 1;
  if (LIPSYNC.gapSpeed > 0 && Math.abs(dGap) > LIPSYNC.gapSpeed * dt) share = Math.min(share, (LIPSYNC.gapSpeed * dt) / Math.abs(dGap));
  if (LIPSYNC.jawSpeed > 0 && Math.abs(dJaw) > LIPSYNC.jawSpeed * dt) share = Math.min(share, (LIPSYNC.jawSpeed * dt) / Math.abs(dJaw));
  return share;
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
const isPlaced = (c: Cue) => c.ws === undefined || lined.has(c);
const dipOf = new WeakMap<Cue, number>(); // the loudness dip a closure cue was moved to (snapClosures)
const claimOf = new WeakMap<Cue, [number, number]>(); // the stretch of audio a p/b/m cue took (snapClosures)
/** Closure cues whose span came from the audio (closureSpan): audioClosureAt lets them past the closure gate. */
const fromAudio = new WeakSet<Cue>();

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
  let prev: Cue | null = null; // the closure before this one, in spoken order
  let vowelSince = false; // a vowel came between it and this one
  for (const c of spoken(cues)) {
    if (VOWELS.has(c.viseme) && !c.glide) vowelSince = true;
    if (!CLOSED_VISEMES.includes(c.viseme)) continue;
    const before = prev, needSyllable = vowelSince && prev !== null && snapped.has(prev);
    prev = c;
    vowelSince = false;
    if (snapped.has(c) || !isPlaced(c)) continue;
    const centre = (c.start + c.end) / 2;
    const lo = Math.max(0, centre - LIPSYNC.snapBefore);
    const hi = centre + LIPSYNC.snapAfter;
    if (hi + LIPSYNC.closureSearch > decodedSeconds) continue;
    // with a vowel between, only dips that have a syllable since the previous closure (LIPSYNC.closureSyllableDb)
    const from = before ? before.end + LIPSYNC.closureOffShift : 0;
    const allowed = (t: number) => !needSyllable || syllableBetween(loudness, from, t);
    // an "m" hums on through the nose: its closure shows in the treble, not in the loudness
    const env = c.nasal ? treble : loudness;
    // Nearest dip wins over the deepest one: quiet + a small penalty for distance from the stamp.
    let bestT = centre, best = Infinity;
    for (let t = lo; t <= hi; t += 0.01) {
      if ((c.viseme === "PP" && taken(t)) || !allowed(t)) continue;
      const score = env(t) + 0.5 * (Math.abs(t - centre) / LIPSYNC.snapAfter);
      if (score < best) {
        best = score;
        bestT = t;
      }
    }
    // the stamp can sit on the edge of a dip (even just past the burst): take the quietest moment around it
    const near = bestT;
    for (let t = near - 0.03; t <= near + 0.03; t += 0.01) {
      if (env(t) < env(bestT) && !(c.viseme === "PP" && taken(t)) && allowed(t)) bestT = t;
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
      c.end = span[1] - LIPSYNC.closureOffShift;
      c.start = Math.max(0, Math.min(span[0] - LIPSYNC.closureOnShift, c.end - LIPSYNC.closureMinDur));
      if (needSyllable && before) c.start = Math.max(c.start, Math.min(before.end + LIPSYNC.closureGapMin, c.end - LIPSYNC.closureKeep));
      fromAudio.add(c);
    } else {
      const dur = c.end - c.start;
      c.start = Math.max(0, bestT - dur / 2);
      c.end = c.start + dur;
    }
    snapped.add(c);
    moved = true;
  }
  if (moved) cues.sort((p, q) => p.start - q.start);
  return moved;
}

/** Whether the sound since `from` (a closure's release) has had a syllable before the dip at t: its loudest moment comes
 *  within LIPSYNC.closureSyllableDb of the loudest one in the closureSearch after t (the vowel the dip leads into). */
function syllableBetween(loudness: (t: number) => number, from: number, t: number): boolean {
  let before = 0, after = 0;
  for (let x = from; x < t; x += 0.01) before = Math.max(before, loudness(x));
  for (let x = t; x <= t + LIPSYNC.closureSearch; x += 0.01) after = Math.max(after, loudness(x));
  return 20 * Math.log10(Math.max(before, 1e-3) / Math.max(after, 1e-3)) >= -LIPSYNC.closureSyllableDb;
}

/** Move the cues by where the voice really starts vs the first word's stamp (LIPSYNC.lineOnsetDb). Run before the
 *  closure and vowel snapping, which wait for it. Returns true if anything moved. */
export function placeLine(cues: Cue[], loudness: (t: number) => number, decodedSeconds: number): boolean {
  let first = Infinity;
  for (const c of cues) if (c.ws !== undefined && c.ws < first) first = c.ws;
  if (first === Infinity || !cues.some((c) => !isPlaced(c))) return false;
  const until = first + LIPSYNC.lineMaxShift;
  if (until > decodedSeconds) return false;
  const level = Math.pow(10, LIPSYNC.lineOnsetDb / 20);
  let onset: number | null = null;
  for (let t = 0; t <= until; t += 0.01) {
    if (loudness(t) > level) {
      onset = t;
      break;
    }
  }
  const d0 = onset === null || !LIPSYNC_PARTS.placeLine ? 0 : Math.max(-LIPSYNC.lineMaxShift, Math.min(0, onset - first)); // late stamps only
  for (const c of cues) {
    if (isPlaced(c)) continue;
    const d = d0 * Math.max(0, 1 - (c.ws! - first) / LIPSYNC.lineFade);
    c.start = Math.max(0, c.start + d);
    c.end += d;
    lined.add(c);
  }
  cues.sort((p, q) => p.start - q.start);
  return true;
}

const VOWELS = new Set<VisemeId>(["aa", "E", "I", "O", "U"]);
/** The cues in the order they are said (Cue.n; hand-made cues without it keep their start order). */
const spoken = (cues: Cue[]) => [...cues].sort((p, q) => (p.n ?? 0) - (q.n ?? 0) || p.start - q.start);
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
    const centre = (c.start + c.end) / 2;
    if (centre + L.vowelSearch + 0.1 > decodedSeconds) continue;
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
    let best: number | null = null;
    for (let t = Math.max(0.01, centre - L.vowelSearch); t <= centre + L.vowelSearch; t += 0.01) {
      if (t <= after || t >= before) continue;
      const v = lv(t);
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
    snapped.add(c);
    if (best === null) continue;
    const half = (c.end - c.start) / 2;
    c.start = Math.max(0, best + L.vowelShift - half);
    c.end = c.start + 2 * half;
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
 * Null when the dip is too shallow to trust (LIPSYNC.closureMinDb).
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
  if (Math.min(db(peak), after) - floor < LIPSYNC.closureMinDb) return null;
  // where the sound fell halfway (in dB) into the dip; an "m" fades in gradually, so its lips are shut once the treble is
  // closureVowelDb below the vowel, if that comes first
  const half = nasal ? Math.max((db(peak) + floor) / 2, db(peak) - LIPSYNC.closureVowelDb) : (db(peak) + floor) / 2;
  let on = dip;
  while (on - 0.01 > peak && db(on - 0.01) < half) on -= 0.01;
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
