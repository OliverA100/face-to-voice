/**
 * A voice preview's loudness, for its orb on the Voice step (components/ui/VoiceSphere.tsx): the preview's file (a
 * public Blob MP3, or a data: URL in development) fetched and decoded once, off the audio that plays it (an
 * OfflineAudioContext: no output, no user gesture needed), as 10 ms blocks of RMS ÷ the file's peak, the same scale
 * as the lip sync's loudness. The orb reads the block at its <audio>'s currentTime.
 * Cached per URL; null when the file can't be fetched or decoded (the orb then rests while it plays).
 */
const cache = new Map<string, Promise<Float32Array | null>>();

export function previewLoudness(url: string): Promise<Float32Array | null> {
  let loudness = cache.get(url);
  if (!loudness) cache.set(url, (loudness = measure(url)));
  return loudness;
}

/** The loudness at `seconds` into the preview (0 past its end). */
export const loudnessAt = (loudness: Float32Array, seconds: number): number => loudness[Math.floor(seconds * 100)] ?? 0;

async function measure(url: string): Promise<Float32Array | null> {
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    const Offline = window.OfflineAudioContext ?? (window as unknown as { webkitOfflineAudioContext?: typeof OfflineAudioContext }).webkitOfflineAudioContext;
    if (!Offline) return null;
    const audio = await new Offline(1, 1, 44100).decodeAudioData(await res.arrayBuffer());
    const samples = audio.getChannelData(0), block = Math.max(1, Math.round(audio.sampleRate / 100));
    const loudness = new Float32Array(Math.ceil(samples.length / block));
    let peak = 1e-6;
    for (let k = 0; k < loudness.length; k++) {
      let sum = 0;
      const end = Math.min(samples.length, (k + 1) * block);
      for (let i = k * block; i < end; i++) sum += samples[i] * samples[i];
      loudness[k] = Math.sqrt(sum / block);
      if (loudness[k] > peak) peak = loudness[k];
    }
    for (let k = 0; k < loudness.length; k++) loudness[k] /= peak;
    return loudness;
  } catch {
    return null;
  }
}
