import { describe, expect, it } from "vitest";

import config from "../../../next.config";

// Response headers: only this build's asset version is cached for a year (an old tab's /v/<old>/… gets today's files,
// which must not be pinned under the old URL), and the page can't be framed.
describe("next.config headers", () => {
  it("immutable only for this build's asset version; anti-framing and nosniff on every path", async () => {
    const rules = await config.headers!();
    const immutable = rules.filter((r) => r.headers.some((h) => h.value.includes("immutable")));
    expect(immutable.map((r) => r.source)).toEqual([`/v/${config.env!.FTV_ASSET_V}/:path*`]);
    const all = rules.find((r) => r.source === "/:path*")!.headers;
    expect(all).toEqual(expect.arrayContaining([
      { key: "Content-Security-Policy", value: "frame-ancestors 'none'" },
      { key: "X-Content-Type-Options", value: "nosniff" },
    ]));
  });
});
