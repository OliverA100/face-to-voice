/**
 * ElevenLabs character alignment → timed viseme cues for the 10 mouth shapes in visemes.json.
 *
 * Words are found in the character stream, each word runs through the letter-to-viseme rules,
 * and every viseme takes its start/end from the timestamps of the exact characters it came
 * from (rules that emit several visemes share their span in proportion to typical durations).
 * Then: Oculus' 15 visemes fold to our 10, repeats merge, plosive closures are pulled forward
 * a little (they happen before the burst you hear), and other cues shorter than MIN_DURATION
 * (80 ms) are stretched so they register at all.
 */
import { wordToVisemes } from "./lipsync-en";

export type VisemeId = "PP" | "FF" | "TH" | "DD" | "SS" | "aa" | "E" | "I" | "O" | "U";
export const VISEME_IDS: VisemeId[] = ["PP", "FF", "TH", "DD", "SS", "aa", "E", "I", "O", "U"];

/** Oculus / rule tokens → our compact set (null = silence). */
const FOLD: Record<string, VisemeId | null> = {
  sil: null, PP: "PP", FF: "FF", TH: "TH", DD: "DD", kk: "DD", nn: "DD", CH: "SS", SS: "SS", RR: "U",
  aa: "aa", E: "E", I: "I", O: "O", U: "U", ih: "I", oh: "O", ou: "U", OO: "U", EE: "I",
};

/**
 * Plosive closures (p/b/m, d/t/k) happen BEFORE the sound: the lips or tongue shut, then the
 * burst is the release. So their cue runs from a little before the character's start to just
 * after it, instead of covering the whole character (which would keep the mouth shut through
 * the following vowel). Fricatives (f/v, th, s) are sustained and keep the full span.
 */
const CLOSURE: Partial<Record<VisemeId, { before: number; after: number }>> = { PP: { before: 0.06, after: 0.02 }, DD: { before: 0.04, after: 0.02 } };
const ANTICIPATION: Partial<Record<VisemeId, number>> = { FF: 0.02 }; // on top of LIPSYNC.lead
const MIN_DURATION = 0.08;

export interface Alignment {
  characters: string[];
  character_start_times_seconds: number[];
  character_end_times_seconds: number[];
}

export interface Cue {
  viseme: VisemeId;
  start: number; // seconds from the start of the clip
  end: number;
  text: string; // the letters it came from (debugging / overlay)
  ws?: number; // the stamped start of the word it came from (placeLine shifts by how far that word is from the voice)
}

const isWordChar = (c: string) => /[A-Za-z0-9']/.test(c);

const ONES = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve",
  "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen"];
const TENS = ["", "", "twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety"];
function below1000(n: number): string {
  const h = Math.floor(n / 100), r = n % 100;
  const rest = r < 20 ? ONES[r] : TENS[Math.floor(r / 10)] + (r % 10 ? " " + ONES[r % 10] : "");
  return h ? ONES[h] + " hundred" + (r ? " " + rest : "") : rest;
}
function cardinal(n: number): string {
  if (n < 1000) return below1000(n);
  for (const [size, word] of [[1e9, "billion"], [1e6, "million"], [1e3, "thousand"]] as const) {
    if (n >= size) return cardinal(Math.floor(n / size)) + " " + word + (n % size ? " " + cardinal(n % size) : "");
  }
  return below1000(n);
}
function ordinal(words: string): string {
  const parts = words.split(" ");
  const last = parts.pop()!;
  const IRREGULAR: Record<string, string> = { one: "first", two: "second", three: "third", five: "fifth", eight: "eighth", nine: "ninth", twelve: "twelfth" };
  return [...parts, IRREGULAR[last] ?? (last.endsWith("y") ? last.slice(0, -1) + "ieth" : last + "th")].join(" ");
}

/**
 * How a number token is said ("21" → "twenty one", "1984" → "nineteen eighty four", "3.5" → "three point five",
 * "2nd" → "second"), so the mouth moves for it: the letter rules only read letters. ElevenLabs' alignment keeps the
 * digits as written.
 */
export function numberToWords(token: string): string {
  const ord = token.match(/^(\d+)(st|nd|rd|th)$/i);
  if (ord) return ordinal(cardinal(Number(ord[1])));
  const t = token.replace(/,/g, "");
  const dec = t.match(/^(\d+)\.(\d+)$/);
  if (dec) return cardinal(Number(dec[1])) + " point " + [...dec[2]].map((d) => ONES[Number(d)]).join(" ");
  if (!/^\d+$/.test(t)) return t.replace(/\d/g, (d) => " " + ONES[Number(d)] + " ").replace(/\s+/g, " ").trim();
  const n = Number(t);
  if (t.length > 9) return [...t].map((d) => ONES[Number(d)]).join(" ");
  if (t.length === 4 && ((n >= 1100 && n < 2000) || (n >= 2010 && n < 2100))) {
    const r = n % 100; // a year: "nineteen eighty four", "nineteen hundred", "nineteen oh five"
    return below1000(Math.floor(n / 100)) + " " + (r === 0 ? "hundred" : r < 10 ? "oh " + ONES[r] : below1000(r));
  }
  return cardinal(n);
}

/**
 * Drop audio tags ("[happy] ") from an alignment. The speak route prefixes lines with an emotion tag for
 * eleven_v4_turbo; ElevenLabs returns the tag's characters in the alignment, but they are not spoken.
 */
export function stripTags(a: Alignment): Alignment {
  const keep: number[] = [];
  let inTag = false;
  let afterTag = false;
  a.characters.forEach((c, i) => {
    if (c === "[") inTag = true;
    else if (inTag) {
      if (c === "]") {
        inTag = false;
        afterTag = true;
      }
    } else if (afterTag && /\s/.test(c)) {
      // the space after a tag
    } else {
      afterTag = false;
      keep.push(i);
    }
  });
  if (keep.length === a.characters.length) return a;
  return {
    characters: keep.map((i) => a.characters[i]),
    character_start_times_seconds: keep.map((i) => a.character_start_times_seconds[i]),
    character_end_times_seconds: keep.map((i) => a.character_end_times_seconds[i]),
  };
}

export function alignmentToCues(raw: Alignment): Cue[] {
  const cues: Cue[] = [];
  const a = stripTags(raw);
  const chars = a.characters;
  const isDigit = (c: string | undefined) => !!c && /[0-9]/.test(c);
  let i = 0;
  while (i < chars.length) {
    if (!isWordChar(chars[i])) {
      i++;
      continue;
    }
    let j = i;
    // a token: letters/digits/apostrophes, and "," or "." between digits ("2,000", "3.5")
    while (j < chars.length && (isWordChar(chars[j]) || ((chars[j] === "," || chars[j] === ".") && isDigit(chars[j - 1]) && isDigit(chars[j + 1])))) j++;
    const token = chars.slice(i, j).join("");
    const ws = a.character_start_times_seconds[i];
    if (/[0-9]/.test(token)) {
      // a number: its spoken words, spread evenly over the digits' time
      const spoken = numberToWords(token);
      const S = ws, E = a.character_end_times_seconds[j - 1], n = spoken.length;
      let off = 0;
      for (const word of spoken.split(" ")) {
        const o = off;
        cues.push(...wordCues(word, (k) => S + ((E - S) * (o + k)) / n, (k) => S + ((E - S) * (o + k + 1)) / n, ws));
        off += word.length + 1;
      }
    } else {
      cues.push(...wordCues(token, (k) => a.character_start_times_seconds[i + k], (k) => a.character_end_times_seconds[i + k], ws));
    }
    i = j;
  }
  // Anticipation can move a closure ahead of the previous cue; the evaluator needs start order.
  cues.sort((p, q) => p.start - q.start);
  return cues;
}

/** The cues of one word, its letters timed by charStart/charEnd (seconds of letter k). */
function wordCues(word: string, charStart: (k: number) => number, charEnd: (k: number) => number, ws: number): Cue[] {
  const out: Cue[] = [];
  for (const v of wordToVisemes(word)) {
    const folded = FOLD[v.viseme];
    if (!folded) continue;
    const spanStart = charStart(v.charStart);
    const spanEnd = charEnd(v.charEnd - 1);
    let start = spanStart + (spanEnd - spanStart) * v.from;
    let end = spanStart + (spanEnd - spanStart) * v.to;
    const closure = CLOSURE[folded];
    if (closure) {
      // A closure is a brief flick: its own length, not stretched to the minimum.
      end = start + closure.after;
      start = Math.max(0, start - closure.before);
    } else {
      start = Math.max(0, start - (ANTICIPATION[folded] ?? 0));
      if (end - start < MIN_DURATION) end = start + MIN_DURATION;
    }
    const last = out[out.length - 1];
    // Repeats inside a word ("pp" in peppers) merge; across words each closure stays its own cue.
    if (last && last.viseme === folded && start <= last.end + 0.04) {
      last.end = Math.max(last.end, end);
      last.text += word.slice(v.charStart, v.charEnd);
    } else {
      out.push({ viseme: folded, start, end, text: word.slice(v.charStart, v.charEnd), ws });
    }
  }
  return out;
}

/** Merge alignment chunks from the stream (times are absolute, so this is a plain concat). */
export function mergeAlignments(parts: Alignment[]): Alignment {
  return {
    characters: parts.flatMap((p) => p.characters),
    character_start_times_seconds: parts.flatMap((p) => p.character_start_times_seconds),
    character_end_times_seconds: parts.flatMap((p) => p.character_end_times_seconds),
  };
}
