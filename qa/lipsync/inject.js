/*
 * In-page recorder for lip-sync measurement. Runs inside facetovoice.com (or any build of the app) and records, on the
 * page's own AudioContext clock:
 *   - audio: every node connected to ctx.destination is also connected to a tap (AudioWorklet), so we get exactly the
 *     samples the page sends to the speakers, stamped with the frame they were processed at (ctx time);
 *   - video: a requestAnimationFrame trampoline runs every rAF callback (the app's render included) and then grabs the
 *     canvas in the same task, stamped with ctx.currentTime and performance.now(). Mouth crop + small whole-head view;
 *   - clocks: outputLatency, baseLatency, getOutputTimestamp per frame (what the speakers are really behind by);
 *   - app internals, only when the page has ?debug (window.__faceToVoice): the mouth's own clock and activations;
 *   - network: every /api/voice/speak response (NDJSON) with the arrival time of each chunk.
 * Nothing here changes what the page does, except the extra audio tap (a silent branch) and the frame grabs.
 * The driver pulls the data with __lsqa.drain(), so no network access from the page is needed (works in Safari too).
 * Safe to inject twice; safe to inject after load (contexts are then found at their first connect()).
 */
(() => {
  if (window.__lsqa) return;
  const Q = (window.__lsqa = {
    version: 1,
    recording: false,
    crop: null, // {x, y, w, h} in CSS px relative to the canvas; null = auto (centre of the face, see defaultCrop)
    fullWidth: 360, // whole-canvas thumbnail width
    // look for the lips again this often (s) and move the crop when they have moved by over 15% of its height: the head
    // pitches for seconds at a time (cursor follow, nods in a chat) and the lips would leave a fixed crop
    recropEvery: 0.5,
    frames: [], // per rendered frame while recording
    audio: [], // {ctx, sr, f (frame index of first sample), b64 (Int16 mono)}
    images: [], // {i, kind, b64}
    speak: [], // {url, body, t0, chunks:[{t, n}], text}
    marks: [], // {name, perf, ctx}
    errors: [],
  });
  const nowCtx = () => (ctxs[0] ? ctxs[0].currentTime : NaN);

  // ---------------- audio tap ----------------
  const ctxs = [];
  const ctxId = new WeakMap();
  const taps = new Map();
  const origConnect = AudioNode.prototype.connect;
  const origDisconnect = AudioNode.prototype.disconnect;
  const WORKLET = `
    class LsqaTap extends AudioWorkletProcessor {
      constructor() { super(); this.buf = new Float32Array(4096); this.n = 0; this.start = -1; }
      process(inputs) {
        const ch = inputs[0];
        const len = 128;
        if (this.start < 0) this.start = currentFrame;
        for (let i = 0; i < len; i++) {
          let v = 0;
          if (ch && ch.length) { for (let c = 0; c < ch.length; c++) v += ch[c][i] || 0; v /= ch.length; }
          this.buf[this.n++] = v;
        }
        if (this.n >= this.buf.length) { this.port.postMessage([this.start, this.buf]); this.buf = new Float32Array(4096); this.n = 0; this.start = -1; }
        return true;
      }
    }
    registerProcessor("lsqa-tap", LsqaTap);`;

  function remember(ctx) {
    if (ctxId.has(ctx)) return;
    ctxId.set(ctx, ctxs.length);
    ctxs.push(ctx);
  }
  function tapFor(ctx) {
    remember(ctx);
    let t = taps.get(ctx);
    if (t) return t;
    const bus = ctx.createGain();
    t = { bus, ready: false };
    taps.set(ctx, t);
    const url = URL.createObjectURL(new Blob([WORKLET], { type: "text/javascript" }));
    ctx.audioWorklet
      .addModule(url)
      .then(() => {
        const node = new AudioWorkletNode(ctx, "lsqa-tap", { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1] });
        const mute = ctx.createGain();
        mute.gain.value = 0;
        origConnect.call(bus, node);
        origConnect.call(node, mute);
        origConnect.call(mute, ctx.destination);
        node.port.onmessage = (e) => {
          if (!Q.recording) return;
          const [f, buf] = e.data;
          const i16 = new Int16Array(buf.length);
          for (let i = 0; i < buf.length; i++) i16[i] = Math.max(-32768, Math.min(32767, Math.round(buf[i] * 32767)));
          Q.audio.push({ ctx: ctxId.get(ctx), sr: ctx.sampleRate, f, b64: b64(i16.buffer) });
        };
        t.ready = true;
      })
      .catch((e) => Q.errors.push("tap: " + e));
    return t;
  }
  AudioNode.prototype.connect = function (dest, ...rest) {
    const r = origConnect.call(this, dest, ...rest);
    if (typeof AudioDestinationNode !== "undefined" && dest instanceof AudioDestinationNode) {
      try {
        origConnect.call(this, tapFor(dest.context).bus, rest[0] || 0);
      } catch (e) {
        Q.errors.push("connect: " + e);
      }
    }
    return r;
  };
  AudioNode.prototype.disconnect = function (...args) {
    const r = origDisconnect.apply(this, args);
    const dest = args[0];
    if (typeof AudioDestinationNode !== "undefined" && dest instanceof AudioDestinationNode) {
      const t = taps.get(dest.context);
      try {
        if (t) origDisconnect.call(this, t.bus);
      } catch {}
    }
    return r;
  };
  if (window.AudioContext) {
    const AC = window.AudioContext;
    window.AudioContext = class extends AC {
      constructor(...a) {
        super(...a);
        tapFor(this);
      }
    };
  }

  // ---------------- speak responses ----------------
  const origFetch = window.fetch.bind(window);
  window.fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input.url;
    // the measurement token (temporary BotID bypass on the live site, see web/src/lib/server/guards.ts qaBypass)
    if (window.__lsqaToken && /\/api\//.test(url)) {
      const headers = new Headers((init && init.headers) || (typeof input !== "string" && input.headers) || {});
      headers.set("x-ftv-qa", window.__lsqaToken);
      init = { ...(init || {}), headers };
    }
    const res = await origFetch(input, init);
    if (/\/api\/voice\/speak/.test(url)) {
      const rec = { url, body: init && typeof init.body === "string" ? init.body : null, status: res.status, t0: performance.now(), ctx0: nowCtx(), chunks: [], text: "" };
      Q.speak.push(rec);
      try {
        const reader = res.clone().body.getReader();
        const dec = new TextDecoder();
        (async () => {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            rec.chunks.push({ t: performance.now(), ctx: nowCtx(), n: value.length });
            rec.text += dec.decode(value, { stream: true });
          }
          rec.done = performance.now();
        })();
      } catch (e) {
        Q.errors.push("speak clone: " + e);
      }
    }
    return res;
  };

  // ---------------- frames ----------------
  const nativeRAF = window.requestAnimationFrame.bind(window);
  let queue = new Map();
  let nextId = 1;
  let scheduled = false;
  window.requestAnimationFrame = (cb) => {
    const id = nextId++;
    queue.set(id, cb);
    if (!scheduled) {
      scheduled = true;
      nativeRAF(tick);
    }
    return id;
  };
  window.cancelAnimationFrame = (id) => {
    queue.delete(id);
  };
  function tick(ts) {
    scheduled = false;
    const q = queue;
    queue = new Map();
    const before = performance.now();
    for (const cb of q.values()) {
      try {
        cb(ts);
      } catch (e) {
        setTimeout(() => {
          throw e;
        });
      }
    }
    if (Q.recording) {
      try {
        afterFrame(ts, before);
      } catch (e) {
        Q.errors.push("frame: " + e);
      }
    }
    // keep ticking while recording even if the app has no frame queued (so frame timing gaps are visible)
    if (Q.recording && !scheduled) {
      scheduled = true;
      nativeRAF(tick);
    }
  }

  let worker = null;
  let frameNo = 0;
  let lastCrop = 0;
  function encoder() {
    if (worker) return worker;
    const src = `
      self.onmessage = async (e) => {
        const { i, kind, bmp, q } = e.data;
        const c = new OffscreenCanvas(bmp.width, bmp.height);
        c.getContext("2d").drawImage(bmp, 0, 0);
        bmp.close();
        const blob = await c.convertToBlob({ type: "image/jpeg", quality: q });
        const r = new FileReaderSync().readAsDataURL(blob);
        self.postMessage({ i, kind, b64: r.slice(r.indexOf(",") + 1) });
      };`;
    worker = new Worker(URL.createObjectURL(new Blob([src], { type: "text/javascript" })));
    worker.onmessage = (e) => Q.images.push(e.data);
    return worker;
  }
  function canvasEl() {
    let best = null;
    for (const c of document.querySelectorAll("canvas")) if (!best || c.width * c.height > best.width * best.height) best = c;
    return best;
  }
  function defaultCrop(rect) {
    // the head sits in the canvas centre; the mouth is ~58% down. Generous box: idle motion stays inside.
    const w = Math.round(rect.width * 0.3);
    const h = Math.round(w * 0.66);
    return { x: Math.round(rect.width * 0.5 - w / 2), y: Math.round(rect.height * 0.585 - h / 2), w, h };
  }
  /** Finds the lips in the rendered frame (red-ish pixels in the lower middle of the head) and centres the crop on
   * them. Runs in the frame's own task, right after the render, so the WebGL drawing buffer is still readable. */
  function findCrop(c, rect) {
    const W = 200;
    const H = Math.round((W * c.height) / c.width);
    const cv = document.createElement("canvas");
    cv.width = W;
    cv.height = H;
    const g = cv.getContext("2d", { willReadFrequently: true });
    g.drawImage(c, 0, 0, W, H);
    const d = g.getImageData(0, 0, W, H).data;
    let n = 0, sx = 0, sy = 0;
    const xs = [], ys = [];
    for (let y = Math.round(H * 0.35); y < Math.round(H * 0.85); y++)
      for (let x = Math.round(W * 0.25); x < Math.round(W * 0.75); x++) {
        const k = (y * W + x) * 4;
        if (d[k] > 90 && d[k + 1] < 0.65 * d[k] && d[k] - d[k + 1] > 45) {
          n++; sx += x; sy += y; xs.push(x); ys.push(y);
        }
      }
    if (n < 10) return null;
    xs.sort((a, b) => a - b); ys.sort((a, b) => a - b);
    // robust centre and width: median, 5th–95th percentile spread
    const cx = xs[n >> 1], cy = ys[n >> 1];
    const lipW = xs[Math.floor(n * 0.95)] - xs[Math.floor(n * 0.05)];
    const k = rect.width / W;
    const w = Math.round(Math.max(lipW * 1.7, 40) * k);
    const h = Math.round(w * 0.62);
    return { x: Math.round(cx * k - w / 2), y: Math.round(cy * k - h * 0.5), w, h, lipsW: Math.round(lipW * k) };
  }
  function afterFrame(ts, before) {
    const c = canvasEl();
    if (c && Q.recrop) {
      const r = c.getBoundingClientRect();
      const k = findCrop(c, r);
      if (k) Q.crop = k;
      Q.recrop = false;
      lastCrop = performance.now();
      Q.mark("crop " + JSON.stringify(Q.crop));
    } else if (c && Q.crop && Q.recropEvery > 0 && performance.now() - lastCrop > Q.recropEvery * 1000) {
      lastCrop = performance.now();
      const k = findCrop(c, c.getBoundingClientRect());
      const o = Q.crop;
      if (k && Math.abs(k.y + k.h / 2 - (o.y + o.h / 2)) > 0.15 * o.h) {
        Q.crop = { ...o, x: k.x + Math.round((k.w - o.w) / 2), y: k.y + Math.round((k.h - o.h) / 2) }; // same size, moved
        Q.mark("crop " + JSON.stringify(Q.crop));
      }
    }
    const i = frameNo++;
    const row = { i, ts, perf: performance.now(), cb: performance.now() - before, ctx: [] };
    for (const ctx of ctxs) {
      const o = { t: ctx.currentTime, state: ctx.state, out: ctx.outputLatency, base: ctx.baseLatency };
      try {
        const ot = ctx.getOutputTimestamp();
        o.otc = ot.contextTime;
        o.otp = ot.performanceTime;
      } catch {}
      row.ctx.push(o);
    }
    const F = window.__faceToVoice;
    if (F) {
      const L = F.lipsync;
      row.app = { clip: L.clipTime, lead: L.leadMs, act: { ...L.activations }, energy: L.energy, active: L.active };
      const S = F.speech;
      if (S) row.app.sync = S.syncDelayMs, row.app.state = S.state, row.app.under = S.metrics && S.metrics.underruns;
      const live = F.liveSpeech;
      if (live && live.playing) row.app.live = true;
    }
    if (c) {
      const rect = c.getBoundingClientRect();
      const sx = c.width / rect.width;
      const k = Q.crop || defaultCrop(rect);
      row.crop = k;
      row.canvas = [c.width, c.height, rect.width, rect.height];
      const enc = encoder();
      createImageBitmap(c, Math.round(k.x * sx), Math.round(k.y * sx), Math.round(k.w * sx), Math.round(k.h * sx)).then(
        (bmp) => enc.postMessage({ i, kind: "mouth", bmp, q: 0.92 }, [bmp]),
        (e) => Q.errors.push("bmp: " + e),
      );
      if (Q.fullWidth > 0)
        createImageBitmap(c, { resizeWidth: Q.fullWidth, resizeHeight: Math.round((Q.fullWidth * c.height) / c.width), resizeQuality: "medium" }).then(
          (bmp) => enc.postMessage({ i, kind: "full", bmp, q: 0.85 }, [bmp]),
          (e) => Q.errors.push("bmp full: " + e),
        );
    }
    Q.frames.push(row);
  }

  // ---------------- control ----------------
  function b64(buf) {
    const u8 = new Uint8Array(buf);
    let s = "";
    for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
    return btoa(s);
  }
  Q.recrop = true;
  Q.start = () => {
    Q.recording = true;
    Q.mark("start");
    if (!scheduled) {
      scheduled = true;
      nativeRAF(tick);
    }
  };
  Q.stop = () => {
    Q.mark("stop");
    Q.recording = false;
  };
  Q.mark = (name) => Q.marks.push({ name, perf: performance.now(), ctx: ctxs.map((c) => c.currentTime) });
  Q.contexts = () => ctxs.map((c, i) => ({ i, sr: c.sampleRate, state: c.state, t: c.currentTime, out: c.outputLatency, base: c.baseLatency, tapped: !!taps.get(c)?.ready }));
  Q.rawFetch = origFetch; // without the measurement token (checks)
  Q.tap = (ctx) => tapFor(ctx); // driver can pre-tap a known context (e.g. __faceToVoice.speech.ctx) when injected late
  /** Hands over everything gathered so far (and forgets it): the driver writes it to disk. */
  Q.drain = (maxImages = 400) => {
    const out = { frames: Q.frames, audio: Q.audio, images: Q.images.splice(0, maxImages), marks: Q.marks, errors: Q.errors, pending: 0 };
    Q.frames = [];
    Q.audio = [];
    Q.marks = [];
    Q.errors = [];
    out.pending = Q.images.length;
    return out;
  };
  Q.speakLog = () => Q.speak.map((s) => ({ ...s }));
})();
