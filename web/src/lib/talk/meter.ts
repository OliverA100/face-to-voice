/**
 * How loud the visitor is, for the chat's sphere (components/ui/TalkPanel.tsx): the microphone's track measured in the
 * chat's own AudioContext by an AnalyserNode (connected to nothing else, so nothing is heard), read when asked. The
 * character's voice needs no meter of its own: the lip sync already measures it as it is heard (lib/lipsync/live.ts).
 *
 * The microphone's level is mapped from decibels: with auto gain on, speech sits around -35 to -15 dBFS and the room
 * under -50, so a linear scale would leave quiet talkers barely moving it.
 */
const MIC_METER = {
  floorDb: -55, // RMS at or under this reads 0 (the room)
  topDb: -18, // and at or over this 1 (talking up close)
};

export interface LevelMeter {
  readonly track: MediaStreamTrack;
  /** 0..1, now. */
  level(): number;
  dispose(): void;
}

/** A meter on `track` in `ctx`; null if Web Audio can't take it. */
export function micMeter(ctx: AudioContext, track: MediaStreamTrack): LevelMeter | null {
  try {
    const src = ctx.createMediaStreamSource(new MediaStream([track]));
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 512; // ~11 ms at 48 kHz: a syllable's rise shows within a frame
    src.connect(analyser);
    const buf = new Float32Array(analyser.fftSize);
    return {
      track,
      level() {
        analyser.getFloatTimeDomainData(buf);
        let sum = 0;
        for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
        const db = 10 * Math.log10(sum / buf.length + 1e-12);
        return Math.min(1, Math.max(0, (db - MIC_METER.floorDb) / (MIC_METER.topDb - MIC_METER.floorDb)));
      },
      dispose() {
        src.disconnect();
        analyser.disconnect();
      },
    };
  } catch {
    return null;
  }
}
