/**
 * The export zip: everything a visitor needs to take the character elsewhere. Built in the browser from what the tab
 * already has, so it costs no ElevenLabs credits, no Claude calls and no server time.
 *
 *   face-to-voice-<name>/
 *     README.md               what's inside, the rebuild link, what the face may be used for
 *     portrait.png            1024² transparent portrait (lib/export/portrait.ts)
 *     character.json          the face as data; the rebuild link carries the same (lib/export/characterCode.ts)
 *     voice-sample.mp3        the take the voice came from, saying the character's line (.wav in mock mode)
 *     voice.md                casting, the Voice Design prompt and line, how to make a similar voice in your own account
 *     voice.json              the same, machine-readable
 *     LICENCE-AND-CREDITS.md  per character (lib/export/licence.ts)
 *
 * The exact voice can't be handed over (Voice Design voices stay in the workspace that made them) and re-running Voice
 * Design with the same prompt and seed gives a different voice (probed), so voice.md promises "similar".
 */
import { ADDON_CATEGORIES, ADDONS, addonState, addonStyleById } from "@/lib/addons";
import { addonIndex } from "@/lib/data";
import { hairState, hairStyleById } from "@/lib/hair";
import type { DesignResult, VoiceRecipe } from "@/lib/voice/client";

import { characterLink, currentCharacter } from "./character";
import { addonPiece, hairPiece, HEAD_PIECE, licenceMarkdown, overallUse, SKIN_PIECE, type Piece } from "./licence";
import { capturePortrait } from "./portrait";
import { makeZip, type ZipEntry } from "./zip";

export interface ExportVoice {
  design: DesignResult;
  take: number; // the preview the voice came from (the visitor's pick when a studio stand-in speaks)
  studioFallback: boolean; // the app spoke with a studio stand-in: the take and prompt are still this face's voice
}

export interface ExportResult {
  blob: Blob;
  filename: string;
  files: { name: string; bytes: number }[];
}

const json = (v: unknown) => JSON.stringify(v, null, 2) + "\n";
const slug = (s: string) => s.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "character";
const title = (s: string) => s.replace(/(^|\s)\S/g, (c) => c.toUpperCase());

export async function buildExport(voice: ExportVoice): Promise<ExportResult> {
  const { design, take, studioFallback } = voice;
  const f = design.fields;
  const name = title(f.persona || "Character");
  const folder = `face-to-voice-${slug(f.persona)}`;
  const date = new Date().toISOString().slice(0, 10);
  const appUrl = location.origin;

  const [portrait, sample] = await Promise.all([capturePortrait(), fetchSample(design.previews[take]?.url)]);
  const character = currentCharacter();
  const link = characterLink(character, appUrl);
  const pieces = facePieces();
  const sampleName = sample ? `voice-sample.${sample.ext}` : null;

  const entries: ZipEntry[] = [
    { name: "README.md", data: readme({ name, link, pieces, sampleName, date }) },
    { name: "portrait.png", data: new Uint8Array(await portrait.arrayBuffer()) },
    { name: "character.json", data: json(character) },
    ...(sample && sampleName ? [{ name: sampleName, data: sample.bytes }] : []),
    { name: "voice.md", data: voiceMarkdown({ name, design, take, studioFallback, sampleName }) },
    { name: "voice.json", data: json(voiceJson(design, take, studioFallback, sampleName)) },
    { name: "LICENCE-AND-CREDITS.md", data: licenceMarkdown({ name, pieces, appUrl, date, hasSample: !!sample }) },
  ].map((e) => ({ ...e, name: `${folder}/${e.name}` }));

  return {
    blob: makeZip(entries),
    filename: `${folder}.zip`,
    files: entries.map((e) => ({ name: e.name, bytes: typeof e.data === "string" ? new TextEncoder().encode(e.data).length : e.data.length })),
  };
}

/** The chosen take (public Blob MP3, or a data: URL in dev). Missing or unreachable: the zip goes without it. */
async function fetchSample(url: string | undefined): Promise<{ bytes: Uint8Array; ext: string } | null> {
  if (!url) return null;
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    const type = res.headers.get("content-type") ?? "";
    return { bytes: new Uint8Array(await res.arrayBuffer()), ext: type.includes("wav") ? "wav" : "mp3" };
  } catch {
    return null;
  }
}

/** Every piece the face wears, with its licence (lib/export/licence.ts). */
function facePieces(): Piece[] {
  const pieces = [HEAD_PIECE, SKIN_PIECE];
  const hair = hairState.style === "none" ? null : hairStyleById(hairState.style);
  const hp = hairPiece(hair ?? null);
  if (hp) pieces.push(hp);
  for (const c of ADDON_CATEGORIES) {
    const style = addonState[c] === "none" ? undefined : addonStyleById(c, addonState[c]);
    if (style) pieces.push(addonPiece(ADDONS[c].label, style, addonIndex[c].licence));
  }
  return pieces;
}

const USE_SHORT = { commercial: "yes", "share-alike": "yes, share alike (CC BY-SA 4.0)", "non-commercial": "no, non-commercial only" };

function readme(o: { name: string; link: string; pieces: Piece[]; sampleName: string | null; date: string }): string {
  return [
    `# ${o.name}`,
    "",
    `A character made with Face to Voice on ${o.date}: the face, and what you need to give it its voice in your own projects.`,
    "",
    "| File | What it is |",
    "| --- | --- |",
    "| portrait.png | The face, 1024 × 1024, transparent background |",
    "| character.json | The face as data: every slider, the expression, pose, hair, add-ons, skin and eyes |",
    ...(o.sampleName ? [`| ${o.sampleName} | The voice, saying the character's own line |`] : []),
    "| voice.md | Who the voice is, the ElevenLabs Voice Design prompt, and how to make a similar voice in your own account |",
    "| voice.json | The same, machine-readable |",
    "| LICENCE-AND-CREDITS.md | What you may do with each part, and the credits to keep with it |",
    "",
    "## Open it in Face to Voice again",
    "",
    "This link rebuilds the face in the app (everything is inside the link itself; nothing is stored on a server):",
    "",
    o.link,
    "",
    "## Can I use it commercially?",
    "",
    `The face: ${USE_SHORT[overallUse(o.pieces)]}. ${o.sampleName ? "The voice sample: yes, with conditions. " : ""}See LICENCE-AND-CREDITS.md.`,
    "",
  ].join("\n");
}

/** The casting as the app shows it in "Reads as", one line per field. */
function castingLines(f: DesignResult["fields"]): string[] {
  const rows: [string, string][] = [
    ["Persona", f.persona],
    ["Character", f.character],
    ["Voice", `${f.presentation}, in their ${f.ageRange}`],
    ["Heritage", f.ethnicity && f.ethnicity !== "unclear" ? f.ethnicity : ""],
    ["Accent", `${f.accentStrength} ${f.accent}`],
    ["Pitch", f.pitch],
    ["Timbre", f.timbre],
    ["Energy and pace", `${f.energy}, ${f.pacing}`],
    ["Mood", `${f.mood1}, ${f.mood2}`],
    ["Emotion", f.emotion && f.emotion !== "neutral" ? `${f.emotion} (${Math.round(f.emotionIntensity * 100)}%)` : "neutral"],
    ["Build", f.build],
    ["Quirk", f.quirk],
  ];
  return rows.filter(([, v]) => v && v.trim()).map(([k, v]) => `- **${k}:** ${v}`);
}

/** The Voice Design request body, as the API takes it. */
function designRequest(r: VoiceRecipe) {
  return { voice_description: r.voiceDescription, text: r.text, model_id: r.modelId, guidance_scale: r.guidanceScale, loudness: r.loudness, seed: r.seed };
}

function voiceMarkdown(o: { name: string; design: DesignResult; take: number; studioFallback: boolean; sampleName: string | null }): string {
  const { design, take } = o;
  const r = design.recipe;
  const line = r.text;
  const fence = (s: string) => ["```", s, "```"];
  return [
    `# ${o.name}: the voice`,
    "",
    ...castingLines(design.fields),
    "",
    ...(o.sampleName ? [`**Hear it:** ${o.sampleName} is take ${take + 1} of 3 from Voice Design, saying:`, "", `> ${line}`, ""] : []),
    ...(o.studioFallback
      ? ["In the app this character spoke with a stand-in studio voice (the app's daily quota of new voices was used up). The sample and the prompt below are the voice designed for this face.", ""]
      : []),
    "## Make this voice in your own ElevenLabs account",
    "",
    "Voices made with ElevenLabs Voice Design can only be shared inside the account that made them, so this exact voice",
    "can't be handed over. You can design a **similar** one: Voice Design gives a different voice on every run, even with",
    "the same prompt and seed, so generate a few times and keep the take that sounds closest to the sample.",
    "Designing uses credits on your own ElevenLabs plan.",
    "",
    "### On the ElevenLabs website",
    "",
    "1. Open ElevenLabs, then Voices, then Create a voice, then Voice Design.",
    "2. Paste this prompt as the voice description:",
    "",
    ...fence(design.description),
    "",
    "3. Use this as the preview text:",
    "",
    ...fence(line),
    "",
    "4. Generate, listen, and save the take you like.",
    "",
    "### With the API",
    "",
    "With your own API key in `ELEVENLABS_API_KEY`, this asks for three takes and writes them to designs.json",
    "(each has `audio_base_64` and a `generated_voice_id`):",
    "",
    "```bash",
    `curl -s "https://api.elevenlabs.io/v1/text-to-voice/design?output_format=${r.outputFormat}" \\`,
    '  -H "xi-api-key: $ELEVENLABS_API_KEY" -H "content-type: application/json" \\',
    "  --data @- > designs.json <<'JSON'",
    JSON.stringify(designRequest(r), null, 2),
    "JSON",
    "```",
    "",
    "Then save the take you like (replace PASTE_ID with its generated_voice_id):",
    "",
    "```bash",
    'curl -s "https://api.elevenlabs.io/v1/text-to-voice" \\',
    '  -H "xi-api-key: $ELEVENLABS_API_KEY" -H "content-type: application/json" \\',
    "  --data @- <<'JSON'",
    JSON.stringify({ voice_name: o.name, voice_description: r.voiceDescription, generated_voice_id: "PASTE_ID" }, null, 2),
    "JSON",
    "```",
    "",
  ].join("\n");
}

function voiceJson(design: DesignResult, take: number, studioFallback: boolean, sampleName: string | null) {
  return {
    format: "face-to-voice/voice",
    version: 1,
    name: title(design.fields.persona || "Character"),
    casting: design.fields,
    prompt: design.description,
    designRequest: designRequest(design.recipe), // POST /v1/text-to-voice/design body (similar voice, not the same)
    outputFormat: design.recipe.outputFormat,
    sample: sampleName ? { file: sampleName, take: take + 1, of: design.previews.length } : null, // take counts from 1, as in voice.md
    studioFallback,
  };
}
