import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// SpeechPlayer against a fake Web Audio clock: when a line counts as playing, done or failed.
class FakeBuffer {
  data: Float32Array;
  constructor(public numberOfChannels: number, public length: number, public sampleRate: number) {
    if (length <= 0) throw new DOMException("The number of frames provided (0) is less than or equal to the minimum bound (0).", "NotSupportedError");
    this.data = new Float32Array(length);
  }
  get duration() {
    return this.length / this.sampleRate;
  }
  getChannelData() {
    return this.data;
  }
}
interface FakeSource {
  buffer: FakeBuffer | null;
  when: number;
  started: boolean;
  stopped: boolean;
  ended: boolean;
  onended: (() => void) | null;
}
const sources: FakeSource[] = [];
// A source's `ended` is an event: it fires after the call that caused it (stop(), or the clock passing its end).
const end = (s: FakeSource) => {
  if (s.ended || !s.started) return;
  s.ended = true;
  setTimeout(() => s.onended?.(), 0);
};
class FakeContext {
  state = "running";
  currentTime = 0;
  sampleRate = 48000;
  outputLatency = 0.01;
  destination = {};
  resume = () => {
    this.state = "running";
    return Promise.resolve();
  };
  suspend = () => {
    this.state = "suspended";
    return Promise.resolve();
  };
  private handlers = new Set<() => void>();
  addEventListener = (_: string, fn: () => void) => void this.handlers.add(fn);
  removeEventListener = (_: string, fn: () => void) => void this.handlers.delete(fn);
  /** The context starts running later (Safari resuming): its statechange then. */
  runLater = (ms: number) => {
    this.resume = () => {
      setTimeout(() => {
        this.state = "running";
        for (const fn of [...this.handlers]) fn();
      }, ms);
      return Promise.resolve();
    };
  };
  closed = false;
  close = () => {
    this.closed = true;
    return Promise.resolve();
  };
  createBuffer = (c: number, n: number, r: number) => new FakeBuffer(c, n, r);
  createBufferSource() {
    const s: FakeSource = { buffer: null, when: 0, started: false, stopped: false, ended: false, onended: null };
    sources.push(s);
    return Object.assign(s, {
      connect() {},
      start(when: number) {
        s.when = when;
        s.started = true;
      },
      stop() {
        s.stopped = true;
        end(s);
      },
    });
  }
}
let ctx: FakeContext;
class FakeAudioContext {
  constructor() {
    ctx = new FakeContext();
    return ctx;
  }
}

/** Move the audio clock to t: every source that has played by then ends. */
const clock = (t: number) => {
  ctx.currentTime = t;
  for (const s of sources) if (s.when + s.buffer!.duration <= t) end(s);
};

const pcm = (seconds: number) => Buffer.alloc(Math.round(seconds * 24000) * 2, 1).toString("base64");
const chunk = (seconds: number) => JSON.stringify({ audio_base64: pcm(seconds), alignment: null, normalized_alignment: null });
const stream = (...seconds: number[]) => new Response(seconds.map(chunk).join("\n") + "\n");
const rawChunk = (bytes: Uint8Array) => JSON.stringify({ audio_base64: Buffer.from(bytes).toString("base64") });
/** n samples that all differ, as little-endian 16-bit PCM. */
const ramp = (n: number) => {
  const b = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) b.writeInt16LE(((i * 37) % 60000) - 30000, i * 2);
  return b;
};
/** Every sample scheduled so far, in order. */
const played = () => sources.flatMap((s) => [...s.buffer!.data]);

beforeEach(() => {
  vi.useFakeTimers();
  vi.resetModules();
  vi.stubGlobal("AudioContext", FakeAudioContext);
  sources.length = 0;
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("SpeechPlayer", () => {
  it("a line spoken over the last one plays to its own end, not the last one's", async () => {
    const { speechPlayer } = await import("../player");
    await speechPlayer.speak(async () => stream(1, 1, 1)); // A: 3 s
    clock(1);
    vi.advanceTimersByTime(1000);
    await speechPlayer.speak(async () => stream(2, 2)); // B: 4 s, from 1 s to ~5 s (stopping A fires A's `ended`)
    clock(3.5);
    vi.advanceTimersByTime(2500); // past A's end (~3.1 s)
    expect(speechPlayer.state).toBe("playing");
    clock(5.5);
    vi.advanceTimersByTime(2000);
    expect(speechPlayer.state).toBe("done");
  });

  it("a stream that breaks part-way stops the audio already queued and reports the error", async () => {
    const { speechPlayer } = await import("../player");
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new TextEncoder().encode(`${chunk(1)}\n${chunk(1)}\n`));
        setTimeout(() => c.error(new TypeError("network error")), 10);
      },
    });
    const done = speechPlayer.speak(async () => new Response(body)).catch((e: Error) => e.message);
    await vi.advanceTimersByTimeAsync(20);
    expect(await done).toBe("network error");
    expect(speechPlayer.state).toBe("error");
    expect(sources.length).toBeGreaterThan(0);
    expect(sources.every((s) => s.stopped)).toBe(true);
  });

  it("a 200 without any audio (an empty body, a proxy's page) is an error, not a silent line", async () => {
    const { speechPlayer } = await import("../player");
    await expect(speechPlayer.speak(async () => new Response("<html>challenge</html>"))).rejects.toThrow("couldn't be spoken");
    expect(speechPlayer.state).toBe("error");
  });

  it("a chunk that ends half way through a sample carries its last byte to the next: every sample arrives intact", async () => {
    const { speechPlayer } = await import("../player");
    const full = ramp(12000); // 0.5 s
    await speechPlayer.speak(async () => new Response([rawChunk(full.subarray(0, 1001)), rawChunk(full.subarray(1001, 4000)), rawChunk(full.subarray(4000))].join("\n") + "\n"));
    const expected = [...new Int16Array(full.buffer, full.byteOffset, 12000)].map((v) => v / 32768);
    expect(played()).toEqual(expected);
  });

  it("a 1-byte chunk neither throws (no empty buffer) nor loses its byte", async () => {
    const { speechPlayer } = await import("../player");
    const full = ramp(12000);
    const parts = [full.subarray(0, 6000), full.subarray(6000, 6001), full.subarray(6001)];
    await speechPlayer.speak(async () => new Response(parts.map(rawChunk).join("\n") + "\n"));
    expect(speechPlayer.state).toBe("playing");
    expect(played()).toEqual([...new Int16Array(full.buffer, full.byteOffset, 12000)].map((v) => v / 32768));
  });

  it("times the line by its {aligned} line over the stamps, and by the stamps with ?lipsyncOff=forcedAlignment", async () => {
    const { speechPlayer } = await import("../player");
    const { LIPSYNC_PARTS } = await import("../tuning");
    const al = (start: number) => ({ characters: ["m", "a"], character_start_times_seconds: [start, start + 0.1], character_end_times_seconds: [start + 0.1, start + 0.3] });
    const body = () => new Response([JSON.stringify({ aligned: al(0.7) }), JSON.stringify({ audio_base64: pcm(1), alignment: al(0.2), normalized_alignment: null })].join("\n") + "\n");
    await speechPlayer.speak(async () => body());
    expect(speechPlayer.aligned).toBe(true);
    const aligned = speechPlayer.cues.find((c) => c.viseme === "PP")!.start;
    LIPSYNC_PARTS.forcedAlignment = false;
    await speechPlayer.speak(async () => body());
    LIPSYNC_PARTS.forcedAlignment = true;
    expect(speechPlayer.aligned).toBe(false);
    expect(aligned - speechPlayer.cues.find((c) => c.viseme === "PP")!.start).toBeCloseTo(0.5, 3); // the "m" where aligned, not stamped
    // {"aligned": null}: aligned, nothing came back: the stamps
    await speechPlayer.speak(async () => new Response([JSON.stringify({ aligned: null }), JSON.stringify({ audio_base64: pcm(1), alignment: al(0), normalized_alignment: null })].join("\n") + "\n"));
    expect(speechPlayer.aligned).toBe(false);
    expect(speechPlayer.cues.length).toBeGreaterThan(0);
  });

  it("rests its context between lines (a running idle one stuck Safari's output), and wakes it in the next tap", async () => {
    const { speechPlayer } = await import("../player");
    await speechPlayer.speak(async () => stream(1));
    expect(ctx.state).toBe("running");
    clock(1.1);
    await vi.advanceTimersByTimeAsync(200);
    expect(speechPlayer.state).toBe("done");
    expect(ctx.state).toBe("suspended");
    speechPlayer.unlock(); // the next Speak's tap
    expect(ctx.state).toBe("running");
    await speechPlayer.speak(async () => stream(1));
    speechPlayer.stop(); // stopped mid-line: rests too
    expect(ctx.state).toBe("suspended");
  });

  it("waits for a resting context to run before it schedules a line's first audio (Safari played it ~1 s late)", async () => {
    const { speechPlayer } = await import("../player");
    await speechPlayer.speak(async () => stream(1));
    clock(1.1);
    await vi.advanceTimersByTimeAsync(200);
    expect(ctx.state).toBe("suspended");
    ctx.runLater(100);
    const before = sources.length;
    const done = speechPlayer.speak(async () => stream(1)); // a cached line: all of it at once
    await vi.advanceTimersByTimeAsync(50);
    expect(speechPlayer.state).toBe("loading");
    expect(sources.length).toBe(before); // nothing scheduled into the resting context
    await vi.advanceTimersByTimeAsync(60);
    await done;
    expect(speechPlayer.state).toBe("playing");
    expect(sources.length).toBe(before + 1);
    expect(sources.at(-1)!.when).toBeCloseTo(ctx.currentTime + 0.03, 5);
  });

  it("ends on the last audio's own `ended`: a clock that stands still (iOS resuming, a call) keeps the mouth going", async () => {
    const { speechPlayer } = await import("../player");
    await speechPlayer.speak(async () => stream(1, 1)); // 2 s from 0.03 s; the context clock does not move
    vi.advanceTimersByTime(10_000);
    expect(speechPlayer.state).toBe("playing");
    clock(2.04); // the audio really plays out (it ends at 2.03 s)
    vi.advanceTimersByTime(100);
    expect(speechPlayer.state).toBe("playing"); // output latency (0.01) + 0.1 s still to go
    vi.advanceTimersByTime(20);
    expect(speechPlayer.state).toBe("done");
  });

  it("ends right away (after the latency) when the last audio already played before the stream closed", async () => {
    const { speechPlayer } = await import("../player");
    let close!: () => void;
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new TextEncoder().encode(`${chunk(1)}\n`));
        close = () => c.close();
      },
    });
    const done = speechPlayer.speak(async () => new Response(body));
    await vi.advanceTimersByTimeAsync(0);
    clock(2);
    await vi.advanceTimersByTimeAsync(0); // the audio has ended, the stream is still open
    expect(speechPlayer.state).toBe("playing");
    close();
    await done;
    await vi.advanceTimersByTimeAsync(120);
    expect(speechPlayer.state).toBe("done");
  });

  it("?syncMs= applies to this page view only (clamped), never written to localStorage; the Sync slider is", async () => {
    const store = new Map<string, string>([["ftv-sync-ms", "120"]]);
    const localStorage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) };
    vi.stubGlobal("window", { location: { search: "?syncMs=2000" }, localStorage });
    let { speechPlayer } = await import("../player");
    expect(speechPlayer.syncDelayMs).toBe(500);
    expect(store.get("ftv-sync-ms")).toBe("120");
    vi.resetModules();
    vi.stubGlobal("window", { location: { search: "?syncMs=-9000" }, localStorage });
    ({ speechPlayer } = await import("../player"));
    expect(speechPlayer.syncDelayMs).toBe(-300);
    expect(store.get("ftv-sync-ms")).toBe("120");
    vi.resetModules();
    vi.stubGlobal("window", { location: { search: "" }, localStorage });
    ({ speechPlayer } = await import("../player"));
    expect(speechPlayer.syncDelayMs).toBe(120); // the stored value, untouched by the links before
    speechPlayer.syncDelayMs = 80; // the slider
    expect(store.get("ftv-sync-ms")).toBe("80");
  });

  it("release() before a chat: on an iPhone the line stops and its context closes (made again by the next Speak)", async () => {
    vi.stubGlobal("navigator", { userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) AppleWebKit/605.1.15", maxTouchPoints: 5 });
    const { speechPlayer } = await import("../player");
    await speechPlayer.speak(async () => stream(2));
    const first = ctx;
    speechPlayer.release(); // the chat's tap, while the line still plays
    expect(speechPlayer.state).toBe("idle");
    expect(first.closed).toBe(true);
    speechPlayer.unlock(); // the next Speak
    expect(ctx).not.toBe(first);
  });

  it("release() on a computer only stops the line: its context is kept", async () => {
    const { speechPlayer } = await import("../player");
    await speechPlayer.speak(async () => stream(2));
    const first = ctx;
    speechPlayer.release();
    expect(speechPlayer.state).toBe("idle");
    expect(first.closed).toBe(false);
  });

  it("unlock() asks iOS for a playback audio session, so the silent switch does not mute speech", async () => {
    const audioSession = { type: "auto" };
    vi.stubGlobal("navigator", { audioSession, maxTouchPoints: 5 });
    const { speechPlayer } = await import("../player");
    speechPlayer.unlock();
    expect(audioSession.type).toBe("playback");
  });

  it("leaves the audio session alone on a computer (Safari on a Mac muted Web Audio after a while in the background)", async () => {
    const audioSession = { type: "auto" };
    vi.stubGlobal("navigator", { audioSession, maxTouchPoints: 0 });
    const { speechPlayer } = await import("../player");
    await speechPlayer.speak(async () => stream(1));
    expect(audioSession.type).toBe("auto");
    speechPlayer.stop();
    expect(audioSession.type).toBe("auto");
  });

  it("hands the audio session back when the line ends, is stopped or fails, so other apps' audio can resume", async () => {
    const audioSession = { type: "auto" };
    vi.stubGlobal("navigator", { audioSession, maxTouchPoints: 5 });
    const { speechPlayer } = await import("../player");
    await speechPlayer.speak(async () => stream(1));
    expect(audioSession.type).toBe("playback"); // while the line plays
    clock(1.1);
    await vi.advanceTimersByTimeAsync(200);
    expect(speechPlayer.state).toBe("done");
    expect(audioSession.type).toBe("auto");
    await speechPlayer.speak(async () => stream(1));
    expect(audioSession.type).toBe("playback");
    speechPlayer.stop();
    expect(audioSession.type).toBe("auto");
    await expect(speechPlayer.speak(async () => new Response("<html></html>"))).rejects.toThrow();
    expect(audioSession.type).toBe("auto");
  });

  it("unlock() still works where the audio session refuses the type", async () => {
    vi.stubGlobal("navigator", {
      maxTouchPoints: 5,
      audioSession: {
        set type(_: string) {
          throw new Error("not allowed");
        },
      },
    });
    const { speechPlayer } = await import("../player");
    expect(() => speechPlayer.unlock()).not.toThrow();
    expect(ctx).toBeInstanceOf(FakeContext);
  });

  it("reports when the whole line has arrived (streamDone), and forgets it on stop()", async () => {
    const { speechPlayer } = await import("../player");
    expect(speechPlayer.streamDone).toBe(false);
    await speechPlayer.speak(async () => stream(1));
    expect(speechPlayer.streamDone).toBe(true);
    speechPlayer.stop();
    expect(speechPlayer.streamDone).toBe(false);
  });

  it("an iPhone tab back from a long time in the background starts its audio over on the next Speak (it could play silently)", async () => {
    let visibility = "visible";
    let onVisibility = (): void => {};
    const session = { type: "auto" };
    vi.stubGlobal("navigator", { userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Mobile/15E148 Safari/604.1", maxTouchPoints: 5, audioSession: session });
    vi.stubGlobal("document", {
      get visibilityState() {
        return visibility;
      },
      addEventListener: (_: string, fn: () => void) => {
        onVisibility = fn;
      },
    });
    vi.stubGlobal("window", { location: { search: "" } });
    const { speechPlayer } = await import("../player");
    await speechPlayer.speak(async () => stream(0.5));
    const first = ctx;
    await speechPlayer.speak(async () => stream(0.5));
    expect(ctx).toBe(first); // a second line: same audio
    visibility = "hidden";
    onVisibility();
    vi.advanceTimersByTime(3 * 60_000);
    visibility = "visible";
    onVisibility();
    await speechPlayer.speak(async () => stream(0.5));
    expect(first.closed).toBe(true);
    expect(ctx).not.toBe(first); // a new AudioContext, made in the tap
    expect(session.type).toBe("playback");
  });
});
