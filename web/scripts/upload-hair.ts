/**
 * Hair on Vercel Blob: the strand files (0.3–1.3 MB each, 228 of them, ~220 MB) are too big to commit, so production
 * fetches them from the project's public Blob store instead of /models/hair/. Run from web/ before deploying, after
 * any change to the hair set (`uv run haircs-review apply …`, `uv run import-hair …`):
 *
 *   node scripts/upload-hair.ts            uploads what is missing, writes src/data/hairBlob.json
 *   node scripts/upload-hair.ts --dry-run  lists what it would upload
 *
 * Needs BLOB_READ_WRITE_TOKEN in .env.local (Vercel → Storage → Blob → the store connected to the project → .env.local).
 * Files are stored by content (hair/<sha256 prefix>.strands.bin), so a changed style gets a new URL and every URL can
 * be cached for a year; unchanged files are never uploaded twice (one `list` call, no per-file checks).
 * Thumbnails stay in the repo (small, and the picker shows them all at once). `pnpm fetch-hair` downloads the files
 * back for development.
 */
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";

import { list, put } from "@vercel/blob";

process.loadEnvFile(".env.local");
const token = process.env.BLOB_READ_WRITE_TOKEN;
const dry = process.argv.includes("--dry-run");
if (!token && !dry) {
  console.error("BLOB_READ_WRITE_TOKEN is not set in .env.local (Vercel → Storage → Blob → .env.local)");
  process.exit(1);
}

const { styles } = JSON.parse(readFileSync("public/models/hair/index.json", "utf8")) as { styles: { id: string; file: string }[] };

const existing = new Map<string, string>(); // pathname → url
if (token) {
  let cursor: string | undefined;
  do {
    const page = await list({ prefix: "hair/", cursor, token, limit: 1000 });
    for (const b of page.blobs) existing.set(b.pathname, b.url);
    cursor = page.hasMore ? page.cursor : undefined;
  } while (cursor);
}

const files: Record<string, string> = {}; // style id → pathname
let base = "";
let uploaded = 0;
let bytes = 0;
for (const s of styles) {
  const data = readFileSync(`public/models/${s.file}`);
  const ext = s.file.slice(s.file.indexOf(".", s.file.lastIndexOf("/")));
  const pathname = `hair/${createHash("sha256").update(data).digest("hex").slice(0, 20)}${ext}`;
  files[s.id] = pathname;
  const known = existing.get(pathname);
  if (known) {
    base ||= known.slice(0, known.length - pathname.length);
    continue;
  }
  uploaded++;
  bytes += data.length;
  if (dry) continue;
  const blob = await put(pathname, data, { access: "public", addRandomSuffix: false, allowOverwrite: true, contentType: "application/octet-stream", cacheControlMaxAge: 31536000, token });
  base ||= blob.url.slice(0, blob.url.length - pathname.length);
  console.log(`  ${s.id} → ${pathname} (${(data.length / 1e6).toFixed(2)} MB)`);
}
console.log(`${dry ? "would upload" : "uploaded"} ${uploaded} files, ${(bytes / 1e6).toFixed(1)} MB; ${styles.length - uploaded} already there`);
if (!dry) {
  writeFileSync("src/data/hairBlob.json", JSON.stringify({ note: "Written by web/scripts/upload-hair.ts: where production fetches each hair file.", base, files }, null, 1) + "\n");
  console.log("wrote src/data/hairBlob.json");
}
