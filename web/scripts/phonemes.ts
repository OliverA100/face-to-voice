/**
 * Writes src/data/phonemes.json, the CMU Pronouncing Dictionary (BSD-2, third_party/cmudict/LICENSE, NOTICE) as
 * { word: "PH0 PH1 …" }, for the server: the speak route sends each line's words with the line (lib/server/pronounce.ts),
 * so the browser never loads the dictionary. Also reports how many words the letter rules shape differently.
 *
 *   cd web && ./node_modules/.bin/jiti scripts/phonemes.ts
 *
 * The dictionary is fetched once into pipeline/.cache/cmudict (pinned commit below). First pronunciation only; words
 * with digits or other symbols are skipped.
 */
import fs from "node:fs";
import path from "node:path";

import { FOLD } from "../src/lib/lipsync/cues";
import { wordToVisemes, type WordViseme } from "../src/lib/lipsync/lipsync-en";
import { phonemesToVisemes } from "../src/lib/lipsync/phonemes";

const COMMIT = "74790861f652b15e4ac49015a90074ad62a27690"; // cmusphinx/cmudict
const HERE = path.dirname(new URL(import.meta.url).pathname);
const CACHE = path.join(HERE, "../../pipeline/.cache/cmudict");
const OUT = path.join(HERE, "../src/data/phonemes.json");

async function dictionary(): Promise<string> {
  const file = path.join(CACHE, `cmudict-${COMMIT.slice(0, 8)}.dict`);
  if (!fs.existsSync(file)) {
    fs.mkdirSync(CACHE, { recursive: true });
    const res = await fetch(`https://raw.githubusercontent.com/cmusphinx/cmudict/${COMMIT}/cmudict.dict`);
    if (!res.ok) throw new Error(`cmudict: ${res.status}`);
    fs.writeFileSync(file, await res.text());
  }
  return fs.readFileSync(file, "utf8");
}

/** The shapes as the mouth gets them: folded to the 10 visemes, schwas marked, repeats merged. */
const shapesOf = (vs: WordViseme[]) => {
  const out: string[] = [];
  for (const v of vs) {
    const f = FOLD[v.viseme];
    if (!f) continue;
    const s = f + (v.viseme === "AX" ? "~" : "");
    if (out.at(-1) !== s) out.push(s);
  }
  return out.join(" ");
};

const entries: Record<string, string> = {};
let differ = 0;
let total = 0;
for (const line of (await dictionary()).split("\n")) {
  const m = /^([a-z']+) (.+?)(\s+#.*)?$/.exec(line.trim()); // primary entries only: "word(2)" has a parenthesis
  if (!m) continue;
  total++;
  const [, word, pron] = m;
  const phones = pron.split(" ");
  entries[word] = pron;
  if (shapesOf(phonemesToVisemes(word, phones)) !== shapesOf(wordToVisemes(word))) differ++;
}
fs.writeFileSync(OUT, JSON.stringify(entries));
console.log(`${total} words → ${OUT} (${(fs.statSync(OUT).size / 1024).toFixed(0)} KB); the letter rules shape ${differ} of them differently`);
