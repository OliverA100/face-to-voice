/* Checks a deployment is ready for measuring: page loads (Vercel protection bypass), BotID refuses a scripted browser
 * WITHOUT the token and lets it through WITH it, and Redis/Blob/ElevenLabs/LiveKit answer. Spends nothing. */
import { headReady, launch, open } from "./lib.mjs";
const url = process.argv[2];
const br = await launch({ browser: "chrome" });
const page = await open(br, url + (url.includes("?") ? "&" : "?") + "debug=1");
const status = await page.evaluate(() => document.title + " | " + location.host);
console.log("page:", status);
await headReady(page);
const r = await page.evaluate(async () => {
  const post = (f, path, body) => f(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).then(async (r) => [r.status, (await r.text()).slice(0, 160)]);
  const Q = window.__lsqa;
  return {
    talkWithout: await post(Q.rawFetch, "/api/talk/token", { descKey: "nope" }),
    talkWith: await post(window.fetch, "/api/talk/token", { descKey: "nope" }),
    speakWith: await post(window.fetch, "/api/voice/speak", { descKey: "nope", text: "hi" }),
  };
});
console.log(JSON.stringify(r, null, 1));
await br.close();
