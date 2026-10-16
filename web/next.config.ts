import { withBotId } from "botid/next/config";
import type { NextConfig } from "next";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";

/** head.glb's size, so the loader can show real download progress (lib/headLoad.ts). 0 = unknown. */
function headBytes(): string {
  try {
    return String(statSync(join(process.cwd(), "public/models/head.glb")).size);
  } catch {
    return "0";
  }
}

/**
 * One version for everything under public/models, public/textures and public/basis: a hash of their names and contents
 * (files of 8 MB or more, and the hair strand files production serves from Vercel Blob, by size only). The app asks for
 * /v/<version>/models/… (lib/data.ts, lib/textures.ts): the same files, cached for a year without revalidating, and a
 * deploy that changes any of them changes every URL. "" when the folders are missing.
 */
function assetVersion(): string {
  const hash = createHash("sha1");
  const walk = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else {
        const st = statSync(p);
        hash.update(p).update(String(st.size));
        if (st.size < 8_000_000 && !e.name.endsWith(".strands.bin")) hash.update(readFileSync(p));
      }
    }
  };
  try {
    for (const d of ["models", "textures", "basis"]) walk(join(process.cwd(), "public", d));
  } catch {
    return "";
  }
  return hash.digest("hex").slice(0, 10);
}
const ASSET_V = assetVersion();

/**
 * The loader sphere's worker (src/components/ui/loader/chromeWorker.ts + chromeGl.ts) as one plain JS file. The
 * bundler's own worker is a chain of three files fetched one after another (a bootstrap, its runtime, then the code:
 * ~2 s on a slow 4G phone before the sphere can move); this one file is preloaded from the page's head (loader/chrome.tsx
 * Chrome `boot`), so it is cached by the time the sphere starts.
 * Not a general bundler: chromeGl.ts imports nothing and chromeWorker.ts imports only chromeGl.ts, so the two are
 * transpiled (types and comments dropped) and joined, chromeGl's code in its own scope.
 */
export function chromeWorkerSource(): string {
  const dir = join(process.cwd(), "src/components/ui/loader");
  const js = (file: string) =>
    ts.transpileModule(readFileSync(join(dir, file), "utf8"), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, removeComments: true } }).outputText;
  const gl = js("chromeGl.ts").replace(/^export /gm, "");
  const worker = js("chromeWorker.ts").replace(/^import \{[^}]*\} from "\.\/chromeGl";\n/m, "").replace(/^export \{\};\n?/m, "");
  const source = `const { createChromeGl, createChromeFlow } = (() => {\n${gl}\nreturn { createChromeGl, createChromeFlow };\n})();\n${worker}`;
  // a new import or export in either file needs a look here (a real bundler, or join it the same way)
  if (/^\s*(import|export)\b/m.test(source)) throw new Error("chromeWorkerSource: chromeGl.ts / chromeWorker.ts import or export more than this joins");
  return source;
}

/** Production builds write it to public/chrome/worker.<content hash>.js (git-ignored) and the app gets its URL
 *  (process.env.FTV_CHROME_WORKER); dev keeps the bundler's worker, which rebuilds on every edit. "" = the bundler's
 *  (also when the sources aren't there: `next start` from another folder, after the build has baked the URL in). */
function chromeWorker(): string {
  if (process.env.NODE_ENV !== "production" || !existsSync(join(process.cwd(), "src/components/ui/loader/chromeWorker.ts"))) return "";
  const source = chromeWorkerSource();
  const name = `worker.${createHash("sha1").update(source).digest("hex").slice(0, 10)}.js`;
  const dir = join(process.cwd(), "public/chrome");
  if (!existsSync(join(dir, name))) {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, name), source);
  }
  return `/chrome/${name}`;
}
const CHROME_WORKER = chromeWorker();

const nextConfig: NextConfig = {
  agentRules: false, // no AGENTS.md / CLAUDE.md written into the project by `next dev`
  env: { FTV_HEAD_BYTES: headBytes(), FTV_ASSET_V: ASSET_V, FTV_CHROME_WORKER: CHROME_WORKER },
  async rewrites() {
    // any version is served (a tab opened before a deploy still gets its files), but only this build's is immutable
    return [{ source: "/v/:version/:dir(models|textures|basis)/:path*", destination: "/:dir/:path*" }];
  },
  async headers() {
    return [
      ...(ASSET_V ? [{ source: `/v/${ASSET_V}/:path*`, headers: [{ key: "Cache-Control", value: "public, max-age=31536000, immutable" }] }] : []),
      // the sphere's worker: its name changes with its content (and the page's preload only helps if it is reused as is)
      { source: "/chrome/:path*", headers: [{ key: "Cache-Control", value: "public, max-age=31536000, immutable" }] },
      // the page spends credits on a click: never inside someone else's frame
      {
        source: "/:path*",
        headers: [
          { key: "Content-Security-Policy", value: "frame-ancestors 'none'" },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
        ],
      },
    ];
  },
};

// BotID (Vercel's bot check) only works on Vercel deployments: its challenge script is served from Vercel's edge, so
// enabling it locally breaks fetch() to the protected routes. src/instrumentation-client.ts has the matching client gate.
export default process.env.VERCEL ? withBotId(nextConfig) : nextConfig;
