import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { addonPiece, hairPiece, HEAD_PIECE, licenceMarkdown, overallUse, SKIN_PIECE } from "../licence";

const models = path.resolve(__dirname, "../../../../public/models");
const read = (p: string) => JSON.parse(readFileSync(path.join(models, p), "utf8"));

describe("hair licence", () => {
  it("HairCS is non-commercial, Bystedt share-alike, our grooms commercial, no hair adds nothing", () => {
    expect(hairPiece({ label: "Long bob", author: "HairCS (Lu et al. 2026), CC BY-NC 4.0", pack: "haircs" })).toMatchObject({ licence: "CC BY-NC 4.0", use: "non-commercial" });
    expect(hairPiece({ label: "Box braids", author: "Daniel Bystedt (Blender demo, CC-BY-SA 4.0)", pack: "groom" })).toMatchObject({ licence: "CC BY-SA 4.0", use: "share-alike" });
    expect(hairPiece({ label: "Neat side part", author: "Face to Voice (procedural groom)", pack: "groom" })).toMatchObject({ licence: "MIT", use: "commercial" });
    expect(hairPiece(null)).toBeNull();
  });

  it("treats a pack it doesn't know as non-commercial", () => {
    expect(hairPiece({ label: "New", author: "Someone", pack: "hair01" })).toMatchObject({ licence: "unknown", use: "non-commercial" });
  });

  it("knows the licence of every shipped hair style and add-on", () => {
    for (const s of read("hair/index.json").styles) expect(hairPiece(s)?.licence, s.id).not.toBe("unknown");
    for (const c of ["eyebrows", "eyelashes", "facialHair", "glasses"]) {
      const index = read(`addons/${c}/index.json`);
      for (const s of index.styles) expect(addonPiece(c, s, index.licence).licence, `${c}/${s.id}`).toBe("MIT");
    }
  });
});

describe("what the face allows", () => {
  const nc = hairPiece({ label: "x", author: "", pack: "haircs" })!;
  const sa = hairPiece({ label: "x", author: "Bystedt", pack: "groom" })!;

  it("is the most restrictive piece", () => {
    expect(overallUse([HEAD_PIECE, SKIN_PIECE])).toBe("commercial");
    expect(overallUse([HEAD_PIECE, sa])).toBe("share-alike");
    expect(overallUse([HEAD_PIECE, sa, nc])).toBe("non-commercial");
    expect(addonPiece("Glasses", { label: "x", author: "?" }, "CC0 1.0 — somewhere").use).toBe("non-commercial");
  });

  it("writes the verdict, every credit, and the voice terms only with a sample", () => {
    const md = licenceMarkdown({ name: "Harbour Pilot", pieces: [HEAD_PIECE, nc], appUrl: "https://example.test", date: "2026-10-06", hasSample: true });
    expect(md).toContain("**Commercial use: no.**");
    expect(md).toContain(HEAD_PIECE.credit);
    expect(md).toContain(nc.credit);
    expect(md).toContain("Don't use it to clone a voice");
    expect(licenceMarkdown({ name: "x", pieces: [HEAD_PIECE], appUrl: "", date: "", hasSample: false })).not.toContain("voice-sample");
  });
});
