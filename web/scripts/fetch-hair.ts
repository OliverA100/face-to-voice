/**
 * Hair files for development: the strand files (~1 MB each, ~230 of them, ~215 MB) are too big to commit, so they live
 * on the project's public Vercel Blob store (scripts/upload-hair.ts uploads them and lists them in src/data/hairBlob.json).
 * This downloads them into public/models/, where development serves them from. Run from web/:
 *
 *   pnpm fetch-hair               downloads every file that is missing or differs from the store (the Blob paths are
 *                                 content-addressed: hair/<sha256 prefix>.strands.bin, see upload-hair.ts)
 *   pnpm fetch-hair --base <url>  from another copy of the store (the same paths, under <url>)
 */
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname } from "node:path";

/** Downloads at a time. */
const PARALLEL = 6;

const blob = JSON.parse(readFileSync("src/data/hairBlob.json", "utf8")) as { base: string; files: Record<string, string> };
const index = JSON.parse(readFileSync("public/models/hair/index.json", "utf8")) as { styles: { id: string; file: string; bytes: number }[] };

const entries = Object.entries(blob.files);
if (!entries.length) {
  console.error("src/data/hairBlob.json lists no hair files: the hair hasn't been uploaded yet (the deploy runs scripts/upload-hair.ts).");
  process.exit(1);
}
const flag = process.argv.indexOf("--base");
const base = flag >= 0 ? process.argv[flag + 1] : blob.base;
if (!base || base.startsWith("--")) {
  console.error(flag >= 0 ? "--base needs a URL" : "src/data/hairBlob.json has no base URL: run scripts/upload-hair.ts again");
  process.exit(1);
}

const sizeOf = (path: string) => {
  try {
    return statSync(path).size;
  } catch {
    return -1;
  }
};

/** The sha256 prefix upload-hair.ts names each file by ("hair/<hash>.strands.bin"), or "" if the path has none. */
const hashOf = (path: string) => /^([0-9a-f]{20})\./.exec(basename(path))?.[1] ?? "";
const sha = (data: Buffer) => createHash("sha256").update(data).digest("hex");
/** The local file is the store's: the size index.json lists and the content the Blob path names. */
const current = (dest: string, bytes: number, hash: string) => sizeOf(dest) === bytes && sha(readFileSync(dest)).startsWith(hash);

const byId = new Map(index.styles.map((s) => [s.id, s]));
const jobs: { id: string; url: string; dest: string; bytes: number; hash: string }[] = [];
const failed: string[] = [];
let present = 0;
for (const [id, path] of entries) {
  const style = byId.get(id);
  if (!style) {
    failed.push(`${id}: not in public/models/hair/index.json`);
    continue;
  }
  const hash = hashOf(path);
  if (!hash) {
    failed.push(`${id}: ${path} in src/data/hairBlob.json is not a content-addressed path (hair/<sha256 prefix>.strands.bin)`);
    continue;
  }
  const dest = `public/models/${style.file}`;
  if (current(dest, style.bytes, hash)) present++;
  else jobs.push({ id, url: (base.endsWith("/") ? base : base + "/") + path, dest, bytes: style.bytes, hash });
}

let next = 0;
let done = 0;
let fetched = 0;
let bytes = 0;
const progress = () => {
  if (process.stdout.isTTY) process.stdout.write(`\rfetching hair: ${done}/${jobs.length} files, ${(bytes / 1e6).toFixed(1)} MB`);
};

async function fetchOne(job: (typeof jobs)[number]): Promise<void> {
  const res = await fetch(job.url);
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  const data = Buffer.from(await res.arrayBuffer());
  // index.json and the store must agree, or every run would fetch the file again
  if (data.length !== job.bytes) throw new Error(`${data.length} bytes, index.json lists ${job.bytes}`);
  const got = sha(data);
  if (!got.startsWith(job.hash)) throw new Error(`content does not match its path (sha256 ${got.slice(0, 20)}…)`);
  mkdirSync(dirname(job.dest), { recursive: true });
  // temp file + rename: an interrupted run never leaves a partial file under the real name
  const tmp = `${job.dest}.${process.pid}.tmp`;
  try {
    writeFileSync(tmp, data);
    renameSync(tmp, job.dest);
  } catch (err) {
    rmSync(tmp, { force: true });
    throw err;
  }
  fetched++;
  bytes += data.length;
}

progress();
await Promise.all(
  Array.from({ length: PARALLEL }, async () => {
    while (next < jobs.length) {
      const job = jobs[next++];
      try {
        await fetchOne(job);
      } catch (err) {
        failed.push(`${job.id} (${job.url}): ${err instanceof Error ? err.message : String(err)}`);
      }
      done++;
      progress();
    }
  }),
);
if (process.stdout.isTTY) process.stdout.write("\n");

console.log(`fetched ${fetched} files, ${(bytes / 1e6).toFixed(1)} MB; ${present} already there`);
if (failed.length) {
  console.error(`${failed.length} failed:\n  ${failed.join("\n  ")}`);
  process.exit(1);
}
