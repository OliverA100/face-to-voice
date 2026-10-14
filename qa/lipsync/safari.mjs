/*
 * A tiny WebDriver client for real Safari (safaridriver), shaped like the bits of a puppeteer Page that lib.mjs uses,
 * so record()/replay work unchanged. Needs Safari → Settings → Advanced → "Show features for web developers", then
 * Developer → "Allow remote automation" (once).
 *
 * Safari can't run a script before the page's own (no evaluateOnNewDocument): inject.js is installed right after
 * each navigation, before anything has played, which is enough: the player's AudioContext is created on the first
 * click and the frame trampoline takes over the app's next requestAnimationFrame.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";

import { sleep } from "./lib.mjs";

const PORT = 4444;

async function wd(method, url, body) {
  const res = await fetch(`http://127.0.0.1:${PORT}${url}`, { method, headers: { "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
  const j = await res.json();
  if (j.value && j.value.error) throw new Error(`${j.value.error}: ${j.value.message}`);
  return j.value;
}

export async function launchSafari() {
  // a crashed earlier run can leave Safari paired with a stale session: start from a fresh driver
  spawn("pkill", ["-f", "safaridriver"]);
  await sleep(800);
  const proc = spawn("safaridriver", ["-p", String(PORT)], { stdio: "ignore" });
  await sleep(1500);
  const s = await wd("POST", "/session", { capabilities: { alwaysMatch: { browserName: "safari" } } });
  const id = s.sessionId;
  await wd("POST", `/session/${id}/window/rect`, { width: 1440, height: 1000, x: 0, y: 0 });
  return new SafariBrowser(id, proc);
}

class SafariBrowser {
  constructor(id, proc) {
    this.id = id;
    this.proc = proc;
    this.page = new SafariPage(this);
  }
  async pages() {
    return [this.page];
  }
  async newPage() {
    return this.page;
  }
  async close() {
    await wd("DELETE", `/session/${this.id}`).catch(() => {});
    this.proc.kill();
  }
}

const fnSource = (fn) => (typeof fn === "function" ? `return (${fn.toString()}).apply(null, arguments)` : `return (${fn})`);

class SafariPage {
  constructor(b) {
    this.b = b;
    this.scripts = [];
    this.mouse = { click: (x, y) => this.clickAt(x, y) };
  }
  s(path) {
    return `/session/${this.b.id}${path}`;
  }
  on() {}
  async evaluateOnNewDocument(src, ...args) {
    this.scripts.push(typeof src === "function" ? `(${src.toString()})(...${JSON.stringify(args)})` : src);
  }
  async goto(url) {
    await wd("POST", this.s("/url"), { url });
    for (const src of this.scripts) await wd("POST", this.s("/execute/sync"), { script: src, args: [] });
    // the scripts ran after the page's own: anything the app reads as it starts (a restored session in sessionStorage)
    // came too late. The first time, load the page again so it starts with them (the scripts guard against running twice)
    if (this.scripts.length && !this.primed) {
      this.primed = true;
      await wd("POST", this.s("/url"), { url });
      for (const src of this.scripts) await wd("POST", this.s("/execute/sync"), { script: src, args: [] });
    }
  }
  url() {
    return this._url || "";
  }
  async evaluate(fn, ...args) {
    // element handles from $() travel as WebDriver element references
    const a = args.map((x) => (x && x.__el ? x.__el : x));
    return wd("POST", this.s("/execute/sync"), { script: fnSource(fn), args: a });
  }
  async waitForFunction(fn, opts = {}, ...args) {
    const t0 = Date.now();
    const timeout = opts.timeout ?? 30_000;
    for (;;) {
      const v = await this.evaluate(fn, ...args).catch(() => null);
      if (v) return { asElement: () => (v && v["element-6066-11e4-a52e-4f735466cecf"] ? this.wrap(v) : null) };
      if (Date.now() - t0 > timeout) throw new Error("waitForFunction timed out");
      await sleep(typeof opts.polling === "number" ? opts.polling : 200);
    }
  }
  wrap(ref) {
    const id = ref["element-6066-11e4-a52e-4f735466cecf"];
    return {
      __el: ref,
      // a real pointer click at the element's centre (WebDriver's element click doesn't count as a gesture for audio)
      click: async () => {
        const r = await wd("POST", this.s("/execute/sync"), { script: "arguments[0].scrollIntoView({ block: \"center\" }); const b = arguments[0].getBoundingClientRect(); return [b.x + b.width / 2, b.y + b.height / 2];", args: [ref] });
        await this.clickAt(r[0], r[1]);
      },
      screenshot: async ({ path }) => {
        const b64 = await wd("GET", this.s(`/element/${id}/screenshot`));
        fs.writeFileSync(path, Buffer.from(b64, "base64"));
      },
      type: (text) => wd("POST", this.s(`/element/${id}/value`), { text }),
    };
  }
  async $(sel) {
    // like puppeteer: null when nothing matches
    const ref = await wd("POST", this.s("/element"), { using: "css selector", value: sel }).catch((e) => (/no such element/.test(e.message) ? null : Promise.reject(e)));
    return ref ? this.wrap(ref) : null;
  }
  async click(sel) {
    await (await this.$(sel)).click();
  }
  async waitForSelector(sel, { timeout = 30_000 } = {}) {
    const t0 = Date.now();
    for (;;) {
      const el = await this.$(sel);
      if (el) return el;
      if (Date.now() - t0 > timeout) throw new Error(`waitForSelector ${sel} timed out`);
      await sleep(250);
    }
  }
  async clickAt(x, y) {
    await wd("POST", this.s("/actions"), {
      actions: [{ type: "pointer", id: "mouse", parameters: { pointerType: "mouse" }, actions: [{ type: "pointerMove", x: Math.round(x), y: Math.round(y) }, { type: "pointerDown", button: 0 }, { type: "pointerUp", button: 0 }] }],
    });
  }
  async screenshot({ path }) {
    const b64 = await wd("GET", this.s("/screenshot"));
    fs.writeFileSync(path, Buffer.from(b64, "base64"));
  }
}
