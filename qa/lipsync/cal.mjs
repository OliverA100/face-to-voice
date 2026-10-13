/* Recorder self-check: records calibrate.html (?mode=raw) — the flash frames must line up with the beeps. */
import { launch, open, record, sleep } from "./lib.mjs";
const browser = process.argv[2] || "chrome";
const mode = process.argv[3] || "raw";
const br = await launch({ browser });
const page = await open(br, `http://localhost:3199/calibrate.html?mode=${mode}`);
await sleep(1000);
await record(page, `cal-${browser}-${mode}`, async () => {
  // a real pointer click (Safari only starts audio from a user gesture)
  const r = await page.evaluate(() => { const b = document.querySelector("#go").getBoundingClientRect(); return [b.x + b.width / 2, b.y + b.height / 2]; });
  await page.mouse.click(r[0], r[1]);
  await sleep(9000);
}, { tail: 200 });
await br.close();
