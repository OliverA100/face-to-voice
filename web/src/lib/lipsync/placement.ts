/**
 * Cue placement on the audio: the character timestamps are only approximate, so before the shapes are drawn the cues
 * are moved onto what the decoded loudness shows. placeLine (the line's start), placePhrases (each phrase after a
 * pause), alignLine (the line's sounds in order), snapClosures / snapVowels (each closure on its dip, each vowel on its
 * syllable's peak), followRelease, fitPhrases and bridgeVowels. Each pass moves cues in place, remembers what it has
 * done per cue (the WeakSets below, so a line's cues are forgotten with it) and waits until the audio it needs is
 * decoded.
 */
import type { Cue, VisemeId } from "./cues";
import { CLOSED_VISEMES, cueEnvelope, VOWELS, windowedLoudness } from "./shapes";
import { LIPSYNC, LIPSYNC_PARTS } from "./tuning";

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
      // an s or sh is found on its hiss too (LIPSYNC_PARTS.snapHiss), but is no closure for the p/b/m rules around it
      const hissOnly = LIPSYNC_PARTS.snapHiss && (c.viseme === "SS" || c.viseme === "CH");
      if (!CLOSED_VISEMES.includes(c.viseme) && !hissOnly) continue;
      // the voiced th of "the", "this", "that" (DH) has no quiet stretch of its own: looking for one put "The" on the
      // silence before the voice and it opened twice; it stays where it is stamped
      if (LIPSYNC_PARTS.voicedTh && c.viseme === "TH" && /^DH\b/.test(c.text)) continue;
      const before = hissOnly ? null : prev, needSyllable = !hissOnly && vowelSince && prev !== null && snapped.has(prev);
      if (!hissOnly) {
        prev = c;
        vowelSince = false;
      }
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
        if ((blocked && taken(t)) || !allowed(t) || (c.viseme !== "PP" && env(t) < LIPSYNC.hissFloor)) continue;
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
        // an f/v or th right after a t, d, k or g gets no head start: the stop is still being made ("weed found": the
        // lips went to the teeth during the d)
        const prevCue = order[order.indexOf(c) - 1];
        const afterStop = LIPSYNC_PARTS.afterStop && c.viseme !== "PP" && prevCue?.viseme === "DD" && span[0] - prevCue.end < 0.1;
        const onShift = LIPSYNC.closureOnShift + (c.viseme === "PP" || afterStop ? 0 : LIPSYNC.hissOnShift);
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
 * "rea", stamped from 1.17 s, so the mouth said it after the sound). Only moves them earlier, by more than
 * LIPSYNC.releaseGap, at most LIPSYNC.releaseMaxShift, up to the word's next closure, and only into sound.
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
export function placeLine(cues: Cue[], loudness: (t: number) => number, decodedSeconds: number, enabled = LIPSYNC_PARTS.placeLine, voiceStart?: number): boolean {
  let first = Infinity;
  for (const c of cues) if (c.ws !== undefined && c.ws < first) first = c.ws;
  if (first === Infinity || !cues.some((c) => c.ws !== undefined && !lined.has(c))) return false;
  const until = first + LIPSYNC.lineMaxShift;
  if (voiceStart === undefined && until > decodedSeconds) return false;
  const level = Math.pow(10, LIPSYNC.lineOnsetDb / 20);
  let onset: number | null = voiceStart ?? null;
  for (let t = 0, quiet = Infinity; voiceStart === undefined && t <= until; t += 0.01) {
    if (loudness(t) > level) {
      // the start of the stretch of voice the first word is in: a sound before it, apart from it by a silence
      // (lineOnsetGap: the voice sounding an audio tag, "[suspicious, low and guarded] Open…"), is not the line's start
      if (onset === null || (LIPSYNC_PARTS.onsetGap && quiet >= LIPSYNC.lineOnsetGap && t <= first + 0.05)) onset = t;
      quiet = 0;
    } else quiet += 0.01;
  }
  const d0 = onset === null || !enabled ? 0 : Math.max(-LIPSYNC.lineMaxShift, Math.min(0, onset - first)); // late stamps only
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

/**
 * Two of the same vowel with only a quick t, d, n or k between ("spot on", "got a", "but I") are held as one: the
 * tongue makes the consonant (tongueAt) while the jaw stays open. Apart, the mouth opened wide, half shut and opened
 * wide again ("The spot on…" looked very jumpy). Gaps up to LIPSYNC.bridgeGap; idempotent.
 */
export function bridgeVowels(cues: Cue[]): void {
  for (let i = 0; i < cues.length; i++) {
    const a = cues[i];
    if (!VOWELS.has(a.viseme)) continue;
    for (let j = i + 1; j < cues.length && cues[j].start <= a.end + LIPSYNC.bridgeGap; j++) {
      const b = cues[j];
      if (b.viseme === a.viseme) {
        if (b.start > a.end) {
          a.bridge = [a.end, b.start];
          a.end = b.start;
        }
        break;
      }
      if (b.viseme !== "DD" || b.start < a.start) {
        if (VOWELS.has(b.viseme) || CLOSED_VISEMES.includes(b.viseme) || b.viseme === "SS" || b.viseme === "CH") break;
      }
    }
  }
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


/** Move each vowel cue onto its syllable's loudness peak (LIPSYNC.vowelSearch). Same contract as snapClosures. */
export function snapVowels(cues: Cue[], loudness: (t: number) => number, decodedSeconds: number, snapped: WeakSet<Cue>, aligned = false): boolean {
  const L = LIPSYNC;
  const search = aligned ? L.alignedVowelSearch : L.vowelSearch;
  const rescue = aligned ? L.alignedVowelRescue : L.vowelRescue;
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
    if (centre + rescue + 0.1 > decodedSeconds) continue;
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
    const best = nearest(search) ?? (quiet ? nearest(rescue) : null);
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
    const e = cueEnvelope(c, t);
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
