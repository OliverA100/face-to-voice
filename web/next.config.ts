import { withBotId } from "botid/next/config";
import type { NextConfig } from "next";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

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

const nextConfig: NextConfig = {
  agentRules: false, // no AGENTS.md / CLAUDE.md written into the project by `next dev`
  env: { FTV_HEAD_BYTES: headBytes(), FTV_ASSET_V: ASSET_V },
  async rewrites() {
    // any version is served (a tab opened before a deploy still gets its files), but only this build's is immutable
    return [{ source: "/v/:version/:dir(models|textures|basis)/:path*", destination: "/:dir/:path*" }];
  },
  async headers() {
    return [
      ...(ASSET_V ? [{ source: `/v/${ASSET_V}/:path*`, headers: [{ key: "Cache-Control", value: "public, max-age=31536000, immutable" }] }] : []),
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
