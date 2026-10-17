"use client";

/**
 * A voice preview's orb on the Voice step: the loader's sphere, live, answering its own preview as it plays (the same
 * sphere and motion as the chat's, components/ui/TalkPanel.tsx). Picked in a local lab (not in the repo):
 *   - the look, "Voice sphere · bumpy": the loader's soap bubble at its finish (full colour), with bumps that stay
 *     (the finish's own `rest`: a lower polish would wash the colour out);
 *   - the motion, "F · Swell in colour" (./loader/chrome.tsx VOICE_STYLES): the bumps swell with the voice and fall
 *     back in its pauses.
 * Each voice opens at its own clock (other bumps, another rainbow), on a still of exactly that frame (the stills
 * below), so the live sphere takes over without a change; with prefers-reduced-motion (or without WebGL) the still is
 * all there is. Its loudness: the preview's file, measured once (lib/voice/previewLoudness.ts), read at the
 * <audio>'s currentTime. Never darkened (on hover or while playing): its colour stays full.
 *
 * The stills (lib/brand/voice-sphere-*.webp) are rendered by a local tool (not in the repo) with the loader's shader:
 * each voice's opening frame at VOICE_SPHERE.clocks, in VOICE_SPHERE.finish, `still` px square. Render them again when
 * VOICE_SPHERE, CHROME or the shader changes.
 */
import type { CSSProperties, ReactNode, RefObject } from "react";
import { useEffect, useRef } from "react";

import still0 from "@/lib/brand/voice-sphere-0.webp";
import still1 from "@/lib/brand/voice-sphere-1.webp";
import still2 from "@/lib/brand/voice-sphere-2.webp";
import { loudnessAt, previewLoudness } from "@/lib/voice/previewLoudness";
import { whenIdle } from "@/lib/whenIdle";

import { CHROME, SOAP_BUBBLE, VOICE_STYLES, chromeBox } from "./loader/chrome";
import type { ChromeVoice } from "./loader/chromeGl";
import { LoaderSphere } from "./loader/LoaderSphere";

export const VOICE_SPHERE = {
  size: 34, // px, the sphere's --orb size (its box adds room for the bumps and spills round the 36 px play button)
  clocks: [12, 22, 32], // the loader's clock each voice opens at (its bumps and rainbow), voices 1–3
  finish: { ...SOAP_BUBBLE, rest: 0.18 }, // "Voice sphere · bumpy": the bubble, bumps kept at full colour
  style: VOICE_STYLES.swellColour.style, // "F · Swell in colour"
  still: 144, // px, the stills' size (the box is ~42 CSS px: sharp at 3×)
};

const STILLS = [still0, still1, still2];
const which = (index: number) => ((index % 3) + 3) % 3;

/** The opening frame voice `index` draws (and its still shows): its clock, at the finish. */
export const voiceSphereFrame = (index: number) => {
  const time = VOICE_SPHERE.clocks[which(index)];
  return { time, drift: time * CHROME.speed, polish: 1, material: 1 };
};

/** Centred on the 36 px play button (size-9): the canvas is wider than it, room for the bumps, and spills evenly. */
function Centred({ children, style }: { children: ReactNode; style?: CSSProperties }) {
  return (
    <span className="relative block size-9">
      <span className="absolute top-1/2 left-1/2 block -translate-1/2" style={style}>
        {children}
      </span>
    </span>
  );
}

export function VoiceSphere({ index, url, playing, audios }: { index: number; url: string; playing: boolean; audios: RefObject<(HTMLAudioElement | null)[]> }) {
  const loudness = useRef<Float32Array | null>(null);
  // measured once the list is up and the page is idle (a decode per preview, ~10–40 ms each), not in the way of a tap
  useEffect(() => {
    let live = true;
    const go = () => void previewLoudness(url).then((l) => live && (loudness.current = l));
    const cancel = whenIdle(go, 1500, 200);
    return () => {
      live = false;
      cancel();
    };
  }, [url]);

  const read = (): ChromeVoice => {
    const el = audios.current[index], l = loudness.current;
    return { polish: 1, level: playing && l && el && !el.paused ? loudnessAt(l, el.currentTime) : 0 };
  };
  const i = which(index);
  return (
    <Centred>
      <LoaderSphere
        size={`${VOICE_SPHERE.size}px`}
        finish={VOICE_SPHERE.finish}
        start={VOICE_SPHERE.clocks[i]}
        startPolish={1}
        poster={STILLS[i].src}
        voice={{ style: VOICE_SPHERE.style, read }}
      />
    </Centred>
  );
}

/**
 * A preview row's placeholder while the voices are designed: its orb's own silhouette (the still as a mask) in the grey
 * of the other skeleton bars, pulsing, so the result appears in the shape it promised. It also fetches the stills.
 */
export function VoiceSpherePlaceholder({ index }: { index: number }) {
  const mask = `url(${STILLS[which(index)].src})`;
  const box = chromeBox(`${VOICE_SPHERE.size}px`);
  return (
    <Centred>
      <span
        aria-hidden
        className="block animate-pulse bg-surface"
        style={{ width: box, height: box, maskImage: mask, WebkitMaskImage: mask, maskSize: "cover", WebkitMaskSize: "cover" }}
      />
    </Centred>
  );
}
