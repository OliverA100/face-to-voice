/**
 * Studio voices: pre-designed voices the app falls back to once the day's or month's new voices are spent
 * (STUDIO_VOICE_IDS). They are cast with the app's own prompt template, so they sound like the voices
 * visitors get. Run from web/ (needs ELEVENLABS_API_KEY in .env.local; jiti resolves the `@/` imports of prompt.ts):
 *
 *   JITI_ALIAS="{\"@\":\"$PWD/src\"}" pnpm exec jiti scripts/studio-voices.ts design [slot …] --yes
 *       designs every CAST entry (or only the named slots) → .studio/ (gitignored): the previews as mp3,
 *       candidates.json, and index.html to listen and pick. Voice Design is paid (~1 credit per preview-text
 *       character), so without --yes it only prints what it would design and the estimated cost
 *   JITI_ALIAS="{\"@\":\"$PWD/src\"}" pnpm exec jiti scripts/studio-voices.ts save masculine-20s=a2 feminine-70s=b1 …
 *       saves the picks (one voice slot and one monthly add/edit each) and prints the STUDIO_VOICE_IDS line
 *
 * Each design call returns 3 previews of one description; variant "a" is everyday, "b" more of a character.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";

import { buildVoiceDescription, previewText, type DescriptionFields } from "../src/lib/server/prompt.ts";

process.loadEnvFile(".env.local");
const KEY = process.env.ELEVENLABS_API_KEY ?? "";
const OUT = ".studio";

type Slot = `${DescriptionFields["presentation"]}-${DescriptionFields["ageRange"]}`;
interface CastEntry { slot: Slot; variant: "a" | "b"; fields: DescriptionFields }

/** A plain everyday line every candidate reads, so they can be compared side by side. */
const LINE =
  "Oh, hello there. I was not expecting anyone this early, but come on in. Mind the step, it has been loose for years. So, what can I do for you today?";

const base = (f: Partial<DescriptionFields>): DescriptionFields => ({
  presentation: "masculine", ageRange: "30s", character: "everyday", build: "average", energy: "relaxed", pacing: "measured",
  pitch: "medium", mood1: "friendly", mood2: "warm", accent: "general american", accentStrength: "slight", ethnicity: "unclear",
  persona: "everyday speaker", timbre: "clear", quirk: "", line: LINE, emotion: "neutral", emotionIntensity: 0, ...f,
} as DescriptionFields);

/** Six slots, man and woman at three ages; "a" = everyday, "b" = more of a character. */
const CAST: CastEntry[] = [
  { slot: "masculine-20s", variant: "a", fields: base({ presentation: "masculine", ageRange: "20s", pitch: "medium", timbre: "clear, easygoing", persona: "friendly young guy" }) },
  { slot: "masculine-20s", variant: "b", fields: base({ presentation: "masculine", ageRange: "20s", character: "distinct", energy: "lively", pacing: "brisk", accent: "london", accentStrength: "moderate", timbre: "bright, cheeky", persona: "cocky young rogue" }) },
  { slot: "masculine-40s", variant: "a", fields: base({ presentation: "masculine", ageRange: "40s", pitch: "medium-low", build: "sturdy", timbre: "warm, steady", persona: "dependable family man" }) },
  { slot: "masculine-40s", variant: "b", fields: base({ presentation: "masculine", ageRange: "40s", character: "distinct", pitch: "low", build: "heavy", accent: "scottish", accentStrength: "moderate", timbre: "gravelly, rich", persona: "gruff innkeeper" }) },
  { slot: "masculine-70s", variant: "a", fields: base({ presentation: "masculine", ageRange: "70s", pitch: "medium-low", energy: "calm", pacing: "slow", timbre: "soft, weathered", persona: "kindly grandfather" }) },
  { slot: "masculine-70s", variant: "b", fields: base({ presentation: "masculine", ageRange: "70s", character: "distinct", pitch: "low", energy: "calm", pacing: "slow", accent: "irish", accentStrength: "moderate", timbre: "creaky, gravelly", persona: "old storyteller", quirk: "chuckles between sentences" }) },
  { slot: "feminine-20s", variant: "a", fields: base({ presentation: "feminine", ageRange: "20s", pitch: "medium-high", timbre: "clear, light", persona: "friendly young woman" }) },
  { slot: "feminine-20s", variant: "b", fields: base({ presentation: "feminine", ageRange: "20s", character: "distinct", energy: "lively", pacing: "brisk", pitch: "high", accent: "australian", accentStrength: "moderate", timbre: "bright, bubbly", persona: "upbeat adventurer" }) },
  { slot: "feminine-40s", variant: "a", fields: base({ presentation: "feminine", ageRange: "40s", pitch: "medium", timbre: "warm, smooth", persona: "calm professional" }) },
  { slot: "feminine-40s", variant: "b", fields: base({ presentation: "feminine", ageRange: "40s", character: "distinct", pitch: "medium-low", accent: "southern american", accentStrength: "moderate", timbre: "husky, rich", persona: "sharp-witted tavern owner" }) },
  { slot: "feminine-70s", variant: "a", fields: base({ presentation: "feminine", ageRange: "70s", pitch: "medium", energy: "calm", pacing: "slow", timbre: "soft, thin", persona: "gentle grandmother" }) },
  { slot: "feminine-70s", variant: "b", fields: base({ presentation: "feminine", ageRange: "70s", character: "distinct", energy: "lively", accent: "northern english", accentStrength: "moderate", timbre: "reedy, crackly", persona: "feisty old village gossip" }) },
];

async function el(path: string, init: RequestInit = {}) {
  const res = await fetch(`https://api.elevenlabs.io${path}`, { ...init, headers: { "xi-api-key": KEY, "content-type": "application/json" } });
  if (!res.ok) throw new Error(`${init.method ?? "GET"} ${path} -> ${res.status} ${await res.text()}`);
  return res.json();
}
const credits = async () => (await el("/v1/user/subscription")).character_count as number;

interface Candidate { slot: Slot; variant: string; description: string; previews: { generatedVoiceId: string; file: string }[] }

async function design(only: string[], yes: boolean) {
  const known = new Set(CAST.flatMap((c) => [c.slot, `${c.slot}=${c.variant}`]));
  const unknown = only.filter((o) => !known.has(o));
  if (unknown.length) throw new Error(`Unknown slot ${unknown.join(", ")} (slots: ${[...new Set(CAST.map((c) => c.slot))].join(", ")}; or slot=a / slot=b)`);
  const todo = [...CAST.entries()].filter(([, c]) => !only.length || only.includes(c.slot) || only.includes(`${c.slot}=${c.variant}`));
  // Voice Design bills ~1 credit per character of the preview text (each call returns 3 previews of it)
  const cost = todo.reduce((sum, [, c]) => sum + previewText(c.fields).length, 0);
  if (!yes) {
    console.log(`Would design ${todo.length} voice${todo.length === 1 ? "" : "s"} (${todo.map(([, c]) => `${c.slot}=${c.variant}`).join(" ")}),`);
    console.log(`~${cost.toLocaleString("en")} credits. Add --yes to run it.`);
    return;
  }
  mkdirSync(OUT, { recursive: true });
  const path = `${OUT}/candidates.json`;
  const all: Candidate[] = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : [];
  for (const [i, c] of todo) {
    const description = buildVoiceDescription(c.fields);
    const before = await credits();
    const data = await el("/v1/text-to-voice/design?output_format=mp3_44100_128", {
      method: "POST",
      body: JSON.stringify({ model_id: "eleven_ttv_v3", voice_description: description, text: previewText(c.fields), guidance_scale: 8, loudness: 0.5, seed: 1000 + i }),
    });
    const previews = (data.previews as { audio_base_64: string; generated_voice_id: string }[]).map((p, n) => {
      const file = `${c.slot}-${c.variant}${n + 1}.mp3`;
      writeFileSync(`${OUT}/${file}`, Buffer.from(p.audio_base_64, "base64"));
      return { generatedVoiceId: p.generated_voice_id, file };
    });
    const idx = all.findIndex((x) => x.slot === c.slot && x.variant === c.variant);
    const entry = { slot: c.slot, variant: c.variant, description, previews };
    if (idx >= 0) all[idx] = entry; else all.push(entry);
    writeFileSync(path, JSON.stringify(all, null, 2));
    console.log(`${c.slot} ${c.variant}: 3 previews, ${(await credits()) - before} credits`);
  }
  writeFileSync(`${OUT}/index.html`, page(all));
  console.log(`\nListen: ${OUT}/index.html`);
}

/** Self-contained listening page (audio inlined so it opens anywhere). */
function page(all: Candidate[]) {
  const rows = [...new Set(all.map((c) => c.slot))].map((slot) => {
    const cells = all.filter((c) => c.slot === slot).sort((a, b) => a.variant.localeCompare(b.variant)).map((c) => `
      <div class="v"><p class="d">${c.description}</p>${c.previews.map((p) => `
        <label><b>${p.file.replace(/^.*-(\w\d)\.mp3$/, "$1")}</b><audio controls preload="none" src="data:audio/mpeg;base64,${readFileSync(`${OUT}/${p.file}`).toString("base64")}"></audio></label>`).join("")}</div>`).join("");
    return `<section><h2>${slot}</h2><div class="g">${cells}</div></section>`;
  }).join("");
  return `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Studio voices</title>
<style>body{font:15px/1.4 system-ui,sans-serif;margin:24px auto;max-width:1100px;padding:0 16px;background:#fff;color:#000}
h1{font-size:28px;margin:0 0 4px}h2{font-size:18px;margin:28px 0 8px}.g{display:grid;grid-template-columns:repeat(auto-fit,minmax(300px,1fr));gap:16px}
.v{border:2px solid #000;border-radius:12px;padding:12px}.d{font-size:12px;color:#555;margin:0 0 8px}label{display:flex;align-items:center;gap:8px;margin:6px 0}audio{width:100%}</style>
<h1>Studio voices</h1><p>Pick one per slot, e.g. <code>masculine-20s=a2</code>. a = everyday, b = more of a character.</p>${rows}`;
}

async function save(picks: string[]) {
  if (!picks.length) throw new Error("save needs at least one pick, e.g. masculine-20s=a2");
  if (!existsSync(`${OUT}/candidates.json`)) throw new Error(`No ${OUT}/candidates.json: run design first`);
  const all: Candidate[] = JSON.parse(readFileSync(`${OUT}/candidates.json`, "utf8"));
  // check every pick before the first (paid) save, so a typo never leaves half the picks saved
  const chosen = picks.map((pick) => {
    const m = /^([a-z]+-[\w+ ]+)=([ab])([1-9])$/.exec(pick);
    if (!m) throw new Error(`Bad pick "${pick}": expected slot=<variant><take>, e.g. masculine-20s=a2`);
    const [, slot, variant, take] = m;
    const c = all.find((x) => x.slot === slot && x.variant === variant);
    const p = c?.previews[Number(take) - 1];
    if (!c || !p) throw new Error(`No candidate ${pick} in ${OUT}/candidates.json`);
    return { pick, slot, c, p };
  });
  const ids: string[] = [];
  for (const { pick, slot, c, p } of chosen) {
    const { voice_id } = await el("/v1/text-to-voice", {
      method: "POST",
      body: JSON.stringify({ voice_name: `studio ${slot}`, voice_description: c.description, generated_voice_id: p.generatedVoiceId, labels: { app: "face-to-voice-studio" } }),
    });
    ids.push(`${slot}:${voice_id}`);
    console.log(`${pick} -> ${voice_id}`);
  }
  console.log(`\nSTUDIO_VOICE_IDS=${ids.join(",")}`);
}

const [cmd, ...args] = process.argv.slice(2);
const usage = "usage: studio-voices.ts design [slot …] [--yes] | save slot=a1 …";
try {
  if (cmd === "design") await design(args.filter((a) => a !== "--yes"), args.includes("--yes"));
  else if (cmd === "save") await save(args);
  else console.log(usage);
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  console.error(usage);
  process.exit(1);
}
