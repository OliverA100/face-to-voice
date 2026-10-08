/**
 * English letters → Oculus visemes.
 *
 * Adapted from met4citizen/TalkingHead `modules/lipsync-en.mjs`
 * (https://github.com/met4citizen/TalkingHead), Copyright (c) 2023-2024 Mika Suominen, MIT License
 * (see NOTICE). Its rules come from NRL Report 7948, "Automatic Translation of English Text to
 * Phonetics by Means of Letter-to-Sound Rules" (Elovitz, Johnson, McHugh, Shore, 1976).
 * Changes: TypeScript; a "w" (also in one, once, qu, gu) is rounded lips (U), not the lower lip on the teeth (FF) as in
 * the original; and each viseme records the character span it was produced from, so the timing
 * can come from ElevenLabs' per-character timestamps instead of average durations. The original's
 * number/symbol expansion is left out: the input is ElevenLabs' `normalized_alignment`, which is
 * already the spoken text (digits that remain are spelled out in cues.ts numberToWords).
 */

const RULES: Record<string, string[]> = {
  A: [
    "[A] =aa", " [ARE] =aa RR", " [AR]O=aa RR", "[AR]#=E RR", " ^[AS]#=E SS", "[A]WA=aa", "[AW]=aa", " :[ANY]=E nn I",
    "[A]^+#=E", "#:[ALLY]=aa nn I", " [AL]#=aa nn", "[AGAIN]=aa kk E nn", "#:[AG]E=I kk", "[A]^+:#=aa", ":[A]^+ =E", "[A]^%=E",
    " [ARR]=aa RR", "[ARR]=aa RR", " :[AR] =aa RR", "[AR] =E", "[AR]=aa RR", "[AIR]=E RR", "[AI]=E", "[AY]=E", "[AU]=aa",
    "#:[AL] =aa nn", "#:[ALS] =aa nn SS", "[ALK]=aa kk", "[AL]^=aa nn", " :[ABLE]=E PP aa nn", "[ABLE]=aa PP aa nn", "[ANG]+=E nn kk", "[A]=aa",
  ],
  B: [" [BE]^#=PP I", "[BEING]=PP I I nn", " [BOTH] =PP O TH", " [BUS]#=PP I SS", "[BUIL]=PP I nn", "[B]=PP"],
  C: [" [CH]^=kk", "^E[CH]=kk", "[CH]=CH", " S[CI]#=SS aa", "[CI]A=SS", "[CI]O=SS", "[CI]EN=SS", "[C]+=SS", "[CK]=kk", "[COM]%=kk aa PP", "[C]=kk"],
  D: ["#:[DED] =DD I DD", ".E[D] =DD", "#^:E[D] =DD", " [DE]^#=DD I", " [DO] =DD U", " [DOES]=DD aa SS", " [DOING]=DD U I nn", " [DOW]=DD aa", "[DU]A=kk U", "[D]=DD"],
  E: [
    "#:[E] =", "'^:[E] =", " :[E] =I", "#[ED] =DD", "#:[E]D =", "[EV]ER=E FF", "[E]^%=I", "[ERI]#=I RR I", "[ERI]=E RR I",
    "#:[ER]#=E", "[ER]#=E RR", "[ER]=E", " [EVEN]=I FF E nn", "#:[E]W=", "@[EW]=U", "[EW]=I U", "[E]O=I", "#:&[ES] =I SS",
    "#:[E]S =", "#:[ELY] =nn I", "#:[EMENT]=PP E nn DD", "[EFUL]=FF U nn", "[EE]=I", "[EARN]=E nn", " [EAR]^=E", "[EAD]=E DD", "#:[EA] =I aa",
    "[EA]SU=E", "[EA]=I", "[EIGH]=E", "[EI]=I", " [EYE]=aa", "[EY]=I", "[EU]=I U", "[E]=E",
  ],
  F: ["[FUL]=FF U nn", "[F]=FF"],
  G: ["[GIV]=kk I FF", " [G]I^=kk", "[GE]T=kk E", "SU[GGES]=kk kk E SS", "[GG]=kk", " B#[G]=kk", "[G]+=kk", "[GREAT]=kk RR E DD", "#[GH]=", "[G]=kk"],
  H: [" [HAV]=I aa FF", " [HERE]=I I RR", " [HOUR]=aa EE", "[HOW]=I aa", "[H]#=I", "[H]="],
  I: [
    " [IN]=I nn", " [I] =aa", "[IN]D=aa nn", "[IER]=I E", "#:R[IED] =I DD", "[IED] =aa DD", "[IEN]=I E nn", "[IE]T=aa E",
    " :[I]%=aa", "[I]%=I", "[IE]=I", "[I]^+:#=I", "[IR]#=aa RR", "[IZ]%=aa SS", "[IS]%=aa SS", "[I]D%=aa", "+^[I]^+=I",
    "[I]T%=aa", "#^:[I]^+=I", "[I]^+=aa", "[IR]=E", "[IGH]=aa", "[ILD]=aa nn DD", "[IGN] =aa nn", "[IGN]^=aa nn", "[IGN]%=aa nn", "[IQUE]=I kk", "[I]=I",
  ],
  J: ["[J]=kk"],
  K: [" [K]N=", "[K]=kk"],
  L: ["[LO]C#=nn O", "L[L]=", "#^:[L]%=aa nn", "[LEAD]=nn I DD", "[L]=nn"],
  M: ["[MOV]=PP U FF", "[M]=PP"],
  N: ["E[NG]+=nn kk", "[NG]R=nn kk", "[NG]#=nn kk", "[NGL]%=nn kk aa nn", "[NG]=nn", "[NK]=nn kk", " [NOW] =nn aa", "[N]=nn"],
  O: [
    "[OF] =aa FF", "[OROUGH]=E O", "#:[OR] =E", "#:[ORS] =E SS", "[OR]=aa RR", " [ONE]=U aa nn", "[OW]=O", " [OVER]=O FF E",
    "[OV]=aa FF", "[O]^%=O", "[O]^EN=O", "[O]^I#=O", "[OL]D=O nn", "[OUGHT]=aa DD", "[OUGH]=aa FF", " [OU]=aa", "H[OU]S#=aa",
    "[OUS]=aa SS", "[OUR]=aa RR", "[OULD]=U DD", "^[OU]^L=aa", "[OUP]=U OO", "[OU]=aa", "[OY]=O", "[OING]=O I nn", "[OI]=O",
    "[OOR]=aa RR", "[OOK]=U kk", "[OOD]=U DD", "[OO]=U", "[O]E=O", "[O] =O", "[OA]=O", " [ONLY]=O nn nn I", " [ONCE]=U aa nn SS",
    "[ON'T]=O nn DD", "C[O]N=aa", "[O]NG=aa", " ^:[O]N=aa", "I[ON]=aa nn", "#:[ON] =aa nn", "#^[ON]=aa nn", "[O]ST =O",
    "[OF]^=aa FF", "[OTHER]=aa TH E", "[OSS] =aa SS", "#^:[OM]=aa PP", "[O]=aa",
  ],
  P: ["[PH]=FF", "[PEOP]=PP I PP", "[POW]=PP aa", "[PUT] =PP U DD", "[P]=PP"],
  Q: ["[QUAR]=kk U aa RR", "[QU]=kk U", "[Q]=kk"],
  R: [" [RE]^#=RR I", "[R]=RR"],
  S: [
    "[SH]=SS", "#[SION]=SS aa nn", "[SOME]=SS aa PP", "#[SUR]#=SS E", "[SUR]#=SS E", "#[SU]#=SS U", "#[SSU]#=SS U", "#[SED] =SS DD",
    "#[S]#=SS", "[SAID]=SS E DD", "^[SION]=SS aa nn", "[S]S=", ".[S] =SS", "#:.E[S] =SS", "#^:##[S] =SS", "#^:#[S] =SS",
    "U[S] =SS", " :#[S] =SS", " [SCH]=SS kk", "[S]C+=", "#[SM]=SS PP", "#[SN]'=SS aa nn", "[S]=SS",
  ],
  T: [
    " [THE] =TH aa", "[TO] =DD U", "[THAT] =TH aa DD", " [THIS] =TH I SS", " [THEY]=TH E", " [THERE]=TH E RR", "[THER]=TH E", "[THEIR]=TH E RR",
    " [THAN] =TH aa nn", " [THEM] =TH E PP", "[THESE] =TH I SS", " [THEN]=TH E nn", "[THROUGH]=TH RR U", "[THOSE]=TH O SS",
    "[THOUGH] =TH O", " [THUS]=TH aa SS", "[TH]=TH", "#:[TED] =DD I DD", "S[TI]#N=CH", "[TI]O=SS", "[TI]A=SS", "[TIEN]=SS aa nn",
    "[TUR]#=CH E", "[TU]A=CH U", " [TWO]=DD U", "[T]=DD",
  ],
  U: [
    " [UN]I=I U nn", " [UN]=aa nn", " [UPON]=aa PP aa nn", "@[UR]#=U RR", "[UR]#=I U RR", "[UR]=E", "[U]^ =aa",
    "[U]^^=aa", "[UY]=aa", " G[U]#=", "G[U]%=", "G[U]#=U", "#N[U]=I U", "@[U]=U", "[U]=I U",
  ],
  V: ["[VIEW]=FF I U", "[V]=FF"],
  W: [" [WERE]=U E", "[WA]S=U aa", "[WA]T=U aa", "[WHERE]=U E RR", "[WHAT]=U aa DD", "[WHOL]=I O nn", "[WHO]=I U", "[WH]=U", "[WAR]=U aa RR", "[WOR]^=U E", "[WR]=RR", "[W]=U"],
  X: [" [X]=SS", "[X]=kk SS"],
  Y: ["[YOUNG]=I aa nn", " [YOU]=I U", " [YES]=I E SS", " [Y]=I", "#^:[Y] =I", "#^:[Y]I=I", " :[Y] =aa", " :[Y]#=aa", " :[Y]^+:#=I", " :[Y]^#=I", "[Y]=I"],
  Z: ["[Z]=SS"],
};

const OPS: Record<string, string> = {
  "#": "[AEIOUY]+", // one or more vowels
  ".": "[BDVGJLMNRWZ]", // one voiced consonant
  "%": "(?:ER|E|ES|ED|ING|ELY)",
  "&": "(?:[SCGZXJ]|CH|SH)",
  "@": "(?:[TSRDLZNJ]|TH|CH|SH)",
  "^": "[BCDFGHJKLMNPQRSTVWXZ]", // one consonant
  "+": "[EIY]",
  ":": "[BCDFGHJKLMNPQRSTVWXZ]*", // zero or more consonants
  " ": "\\b",
};

/** Relative viseme durations (1 = average), used to split a rule's span between its visemes. */
const VISEME_DURATIONS: Record<string, number> = {
  aa: 0.95, E: 0.9, I: 0.92, O: 0.96, U: 0.95, PP: 1.08, SS: 1.23, TH: 1, DD: 1.05, FF: 1.0, kk: 1.21, nn: 0.88, RR: 0.88, sil: 1,
};

type Rule = { regex: RegExp; move: number; visemes: string[] };

const compiled: Record<string, Rule[]> = {};
for (const [letter, rules] of Object.entries(RULES)) {
  compiled[letter] = rules.map((rule) => {
    const posL = rule.indexOf("[");
    const posR = rule.indexOf("]");
    const posE = rule.indexOf("=");
    const left = rule.substring(0, posL);
    const letters = [...rule.substring(posL + 1, posR)];
    const right = rule.substring(posR + 1, posE);
    const visemes = rule.substring(posE + 1);
    letters[0] = letters[0].toLowerCase(); // marks the current position in the test string
    const exp = [...left].map((x) => OPS[x] ?? x).join("") + letters.join("") + [...right].map((x) => OPS[x] ?? x).join("");
    return { regex: new RegExp(exp), move: letters.length, visemes: visemes.length ? visemes.split(" ") : [] };
  });
}

export interface WordViseme {
  viseme: string; // Oculus name: aa E I O U PP FF TH DD SS CH kk nn RR (plus a few odd tokens the rules contain)
  charStart: number; // index into the word, inclusive
  charEnd: number; // exclusive
  /** 0..1 position of this viseme inside the span of the rule that produced it (rules can emit several). */
  from: number;
  to: number;
}

/** Visemes for one word (letters and apostrophes only), each with the letters it came from. */
export function wordToVisemes(word: string): WordViseme[] {
  const upper = word.toUpperCase();
  const chars = [...upper];
  const out: WordViseme[] = [];
  let i = 0;
  while (i < chars.length) {
    const c = chars[i];
    const ruleset = compiled[c];
    if (!ruleset) {
      i++;
      continue;
    }
    let matched = false;
    for (const rule of ruleset) {
      const test = upper.substring(0, i) + c.toLowerCase() + upper.substring(i + 1);
      if (!rule.regex.test(test)) continue;
      matched = true;
      const total = rule.visemes.reduce((s, v) => s + (VISEME_DURATIONS[v] ?? 1), 0);
      let acc = 0;
      for (const v of rule.visemes) {
        const d = VISEME_DURATIONS[v] ?? 1;
        const last = out[out.length - 1];
        if (last && last.viseme === v && last.charEnd === i) {
          last.charEnd = i + rule.move; // merge a repeat (e.g. "LL") into the previous viseme
          last.to = 1;
        } else {
          out.push({ viseme: v, charStart: i, charEnd: i + rule.move, from: acc / total, to: (acc + d) / total });
        }
        acc += d;
      }
      i += rule.move;
      break;
    }
    if (!matched) i++;
  }
  return out;
}
