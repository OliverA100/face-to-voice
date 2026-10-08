import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { MOTION } from "@/lib/motion";

// The UI durations exist twice (tokens.css for CSS, lib/motion.ts for GSAP): they must stay equal.
describe("motion scale", () => {
  const css = fs.readFileSync(path.resolve(__dirname, "../../app/tokens.css"), "utf8");
  const ms = (name: string) => Number(css.match(new RegExp(`--${name}:\\s*(\\d+)ms`))?.[1]);

  it("mirrors tokens.css", () => {
    expect(ms("dur-1") / 1000).toBe(MOTION.quick);
    expect(ms("dur-2") / 1000).toBe(MOTION.move);
    expect(ms("dur-3") / 1000).toBe(MOTION.height);
  });
});
