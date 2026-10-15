/**
 * Words → mouth shapes from how they are said, not spelled: the CMU Pronouncing Dictionary (BSD-2, see NOTICE) gives the
 * phonemes, this table gives each phoneme's mouth shape and typical length. The dictionary stays on the server: each
 * spoken line arrives with its own words' phonemes (lib/server/pronounce.ts, the speak route's first NDJSON line), and
 * addPhonemes() keeps them here. A word without an entry (a name the dictionary doesn't know) keeps the letter rules
 * (lipsync-en.ts).
 *
 * The output has wordToVisemes' shape (lipsync-en.ts), so cues.ts times it the same way: a phoneme's share of the word
 * comes from the lengths below (eleven_v4_turbo spreads a word's letters evenly anyway; the audio snapping places the
 * closures and vowels afterwards).
 */
import { numberToWords } from "./cues";
import type { WordViseme } from "./lipsync-en";

/** One phoneme's mouth: rule tokens (cues.ts FOLD; two for a diphthong), its typical length (relative), flags. */
interface Phone {
  shapes: string[];
  len: number;
  /** the share of `len` the first shape takes (diphthongs) */
  split?: number;
}

/**
 * ARPAbet (stress digits removed) → mouth. Tweak here: a shape is one of the rule tokens cues.ts folds (aa E I O U PP FF
 * TH DD SS CH kk nn RR AX). "HH" has no shape of its own: it takes the next vowel's (the mouth is already shaped for it).
 */
export const PHONES: Record<string, Phone> = {
  // vowels: stressed ones are longer (STRESSED), unstressed AH/IH/ER are schwas (WEAK_VOWELS)
  AA: { shapes: ["aa"], len: 1 }, // f-a-ther, h-o-t
  AE: { shapes: ["aa"], len: 1 }, // c-a-t
  AH: { shapes: ["aa"], len: 0.8 }, // c-u-t (AH0 = a schwa: AX)
  AO: { shapes: ["O"], len: 1 }, // th-ou-ght
  AW: { shapes: ["aa", "U"], len: 1.2, split: 0.6 }, // h-ow
  AY: { shapes: ["aa", "I"], len: 1.2, split: 0.6 }, // m-y
  EH: { shapes: ["E"], len: 0.9 }, // b-e-d
  ER: { shapes: ["U"], len: 1 }, // b-ir-d: a little rounding (ER0 = a schwa: AX)
  EY: { shapes: ["E", "I"], len: 1.1, split: 0.6 }, // s-ay
  IH: { shapes: ["I"], len: 0.8 }, // b-i-t
  IY: { shapes: ["I"], len: 1 }, // s-ee
  OW: { shapes: ["O", "U"], len: 1.2, split: 0.6 }, // g-o
  OY: { shapes: ["O", "I"], len: 1.2, split: 0.5 }, // b-oy
  UH: { shapes: ["U"], len: 0.8 }, // b-oo-k
  UW: { shapes: ["U"], len: 1 }, // f-oo-d
  // consonants
  B: { shapes: ["PP"], len: 0.6 },
  P: { shapes: ["PP"], len: 0.6 },
  M: { shapes: ["PP"], len: 0.7 }, // nasal: found in the treble (cues.ts `nasal`)
  F: { shapes: ["FF"], len: 0.8 },
  V: { shapes: ["FF"], len: 0.7 },
  TH: { shapes: ["TH"], len: 0.8 },
  DH: { shapes: ["TH"], len: 0.6 },
  T: { shapes: ["DD"], len: 0.6 },
  D: { shapes: ["DD"], len: 0.6 },
  N: { shapes: ["nn"], len: 0.7 },
  L: { shapes: ["nn"], len: 0.7 },
  S: { shapes: ["SS"], len: 0.8 },
  Z: { shapes: ["SS"], len: 0.7 },
  SH: { shapes: ["CH"], len: 0.8 },
  ZH: { shapes: ["CH"], len: 0.7 },
  CH: { shapes: ["CH"], len: 0.9 },
  JH: { shapes: ["CH"], len: 0.9 },
  K: { shapes: ["kk"], len: 0.6 },
  G: { shapes: ["kk"], len: 0.6 },
  NG: { shapes: ["kk"], len: 0.7 }, // the back of the tongue, like k/g (cues.ts `back`)
  HH: { shapes: [], len: 0.5 }, // takes the next vowel's shape
  W: { shapes: ["U"], len: 0.6 }, // rounded, a glide: no syllable of its own
  Y: { shapes: ["I"], len: 0.5 }, // spread, a glide
  R: { shapes: ["RR"], len: 0.6 },
};
/** Unstressed vowels said as a schwa: an "aa" made weak (cues.ts AX → Cue.weak). */
const WEAK_VOWELS = new Set(["AH", "IH", "ER"]);
/** A stressed vowel is this much longer than its table length. */
const STRESSED = 1.3;

/** One word's phonemes (ARPAbet with stress digits, "HH AH0 L OW1") → shapes over the whole word (charStart 0 to the
 *  word's length), each a from/to share of it. */
export function phonemesToVisemes(word: string, phones: string[]): WordViseme[] {
  const items: { token: string; len: number; phone: string; offglide?: boolean }[] = [];
  for (let k = 0; k < phones.length; k++) {
    const m = /^([A-Z]+)([012])?$/.exec(phones[k]);
    if (!m) continue;
    const [, base, stress] = m;
    const p = PHONES[base];
    if (!p) continue;
    const len = p.len * (stress === "1" ? STRESSED : 1);
    if (base === "HH") {
      // the h takes the next vowel's shape
      const next = phones.slice(k + 1).map((x) => x.replace(/[012]$/, "")).find((x) => PHONES[x]?.shapes.length && /^[AEIOU]/.test(x));
      const shape = next ? PHONES[next].shapes[0] : null;
      if (shape) items.push({ token: shape, len, phone: base });
      continue;
    }
    if (stress === "0" && WEAK_VOWELS.has(base)) {
      // unstressed: a schwa ("a", "the") is a weak "ah"; an unstressed "er" ("water", "shimmered") barely opens and
      // rounds a little, an unstressed "i" ("roses", "wanted") a little spread (as an "ah" the loud "-ered" of
      // "shimmered" opened twice as wide as its stressed "shim": jumpy, user review 2026-10-15)
      items.push({ token: base === "ER" ? "UX" : base === "IH" ? "IX" : "AX", len: len * 0.8, phone: base });
      continue;
    }
    if (p.shapes.length === 2) {
      const s = p.split ?? 0.5;
      items.push({ token: p.shapes[0], len: len * s, phone: base }, { token: p.shapes[1], len: len * (1 - s), phone: base, offglide: true });
      continue;
    }
    items.push({ token: p.shapes[0], len, phone: base });
  }
  const total = items.reduce((a, b) => a + b.len, 0) || 1;
  const out: WordViseme[] = [];
  let at = 0;
  for (const it of items) {
    out.push({ viseme: it.token, charStart: 0, charEnd: word.length, from: at / total, to: (at + it.len) / total, phone: it.phone, ...(it.offglide ? { offglide: true } : {}) });
    at += it.len;
  }
  return out;
}

/** The phonemes received so far (word → ARPAbet), from each line's {"phonemes"} NDJSON line. */
const dict = new Map<string, string[]>();
/** Off = the letter rules only (`?lipsyncOff=phonemes`). */
export const PHONEMES = { enabled: true };

/** Keeps a line's words' phonemes: { word: "HH AH0 L OW1" }. */
export function addPhonemes(map: Record<string, string>): void {
  for (const [word, pron] of Object.entries(map)) if (typeof pron === "string") dict.set(word, pron.split(" "));
}

/** The word's phonemes, if a line brought them (lower case, straight apostrophes). */
export function phonemesOf(word: string): string[] | undefined {
  return PHONEMES.enabled ? dict.get(word.toLowerCase().replace(/[’‘]/g, "'")) : undefined;
}

/** The words of a line as they are said (numbers spelled out, audio tags left out), lower case: what to look up. */
export function spokenWords(text: string): string[] {
  const out: string[] = [];
  for (const token of text.replace(/\[[^\]]*\]/g, " ").match(/[A-Za-z0-9'’]+(?:[.,][0-9]+)*/g) ?? []) {
    for (const w of /[0-9]/.test(token) ? numberToWords(token).split(" ") : [token]) out.push(w.toLowerCase().replace(/[’‘]/g, "'"));
  }
  return out;
}

/** Words already asked for (found or not): each is fetched once per page. */
const asked = new Set<string>();
/** Words waiting for the next request, and who to tell when their phonemes have come. */
const queued: string[] = [];
let waiting: (() => void)[] = [];
let timer: ReturnType<typeof setTimeout> | null = null;
/** How long words gather before one request (s): the agent sends a reply's words one message at a time, and one request
 *  per word tripped the site's /api rate limit (a 429 that would hit the visitor's other requests too). */
export const PHONEME_BATCH = { wait: 0.15, max: 60 };

/**
 * A live conversation's words, looked up as they arrive (GET /api/phonemes, batched): the agent sends words, not
 * phonemes. `onAdded` runs once new phonemes are in (the cues are then built again). Failures leave the letter rules.
 */
export function queuePhonemes(words: string[], onAdded: () => void): void {
  if (!PHONEMES.enabled) return;
  const want = [...new Set(words)].filter((w) => /^[a-z']{1,40}$/.test(w) && !asked.has(w));
  if (!want.length) return;
  for (const w of want) asked.add(w);
  queued.push(...want);
  waiting.push(onAdded);
  if (queued.length >= PHONEME_BATCH.max) flush();
  else if (!timer) timer = setTimeout(flush, PHONEME_BATCH.wait * 1000);
}

function flush(): void {
  if (timer) clearTimeout(timer);
  timer = null;
  const words = queued.splice(0, PHONEME_BATCH.max);
  const callbacks = waiting;
  waiting = [];
  if (queued.length) timer = setTimeout(flush, 0);
  void requestPhonemes(words).then((added) => {
    if (added) for (const fn of callbacks) fn();
  });
}

/** One request for these words (already filtered). Resolves true when new phonemes came in. */
export async function requestPhonemes(words: string[]): Promise<boolean> {
  const want = words.filter((w) => /^[a-z']{1,40}$/.test(w));
  if (!want.length || !PHONEMES.enabled) return false;
  for (const w of want) asked.add(w);
  try {
    const res = await fetch(`/api/phonemes?w=${encodeURIComponent([...want].sort().join(","))}`);
    if (!res.ok) throw new Error(String(res.status));
    const { phonemes } = (await res.json()) as { phonemes?: Record<string, string> };
    if (!phonemes || !Object.keys(phonemes).length) return false;
    addPhonemes(phonemes);
    return true;
  } catch {
    for (const w of want) asked.delete(w); // a later reply tries again
    return false;
  }
}
