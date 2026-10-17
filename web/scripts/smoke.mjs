/**
 * The main flow, end to end, on the production build: `pnpm build && pnpm smoke` (CI runs it after the build).
 * Starts `next start` with the development mocks (no keys, nothing paid), opens the page in headless Chrome, waits for
 * the head to draw, presses Find my voice and expects three takes. Any page error or console error fails it.
 * Chrome: CHROME_PATH, else the usual install path (macOS, or google-chrome on Linux).
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";

import puppeteer from "puppeteer-core";

const PORT = 3999;
const URL = `http://localhost:${PORT}/?debug=1`; // ?debug: the page's debug handle, which reports when the head drew
const CHROME =
  process.env.CHROME_PATH ?? ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/usr/bin/google-chrome"].find((p) => existsSync(p));

const server = spawn("pnpm", ["exec", "next", "start", "-p", String(PORT)], {
  env: { ...process.env, FTV_MOCK_CLAUDE: "1", FTV_MOCK_ELEVENLABS: "1" },
  stdio: ["ignore", "inherit", "inherit"],
});
const fail = (why) => {
  console.error(`smoke: ${why}`);
  server.kill();
  process.exit(1);
};

async function up() {
  for (let i = 0; i < 60; i++) {
    if (await fetch(`http://localhost:${PORT}/`).then((r) => r.ok, () => false)) return;
    await new Promise((r) => setTimeout(r, 500));
  }
  fail("the server didn't start");
}

await up();
if (!CHROME) fail("no Chrome found (set CHROME_PATH)");
// SwiftShader: WebGL 2 without a GPU, as on a CI runner
const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ["--enable-unsafe-swiftshader", "--use-angle=swiftshader-webgl"] });
const page = await browser.newPage();
await page.setViewport({ width: 1280, height: 800 });
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
page.on("console", (m) => m.type() === "error" && errors.push(m.text()));

let step = "loading the page";
try {
  await page.goto(URL, { waitUntil: "domcontentloaded" });
  step = "waiting for the head to draw";
  await page.waitForFunction(() => window.__faceToVoice?.perf?.headVisibleMs != null, { timeout: 120_000 });
  step = "pressing Find my voice";
  await page.locator("button::-p-text(Find my voice)").setTimeout(30_000).click();
  step = "waiting for three takes";
  await page.waitForFunction(() => document.querySelectorAll('button[aria-label^="Play voice"]').length === 3, { timeout: 60_000 });
} catch (e) {
  await browser.close();
  fail(`${step}: ${e instanceof Error ? e.message : e}${errors.length ? `\n${errors.join("\n")}` : ""}`);
}
await browser.close();
server.kill();
if (errors.length) fail(`console errors:\n${errors.join("\n")}`);
console.log("smoke: the head drew and Find my voice gave three takes");
