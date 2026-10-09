"use client";

/**
 * Page shell: a slim top bar, the 3D bust in a big rounded card, and the slider panel in a
 * second card beside it. One VoicePanel instance: on phones and tablets it sits above the
 * sliders in a scrolling column; from `lg` up it floats bottom-right over the bust (placed in
 * the scene's grid cell, so state survives a rotation). Tokens live in app/tokens.css, the pill/card
 * classes in app/globals.css.
 */
import "@/lib/export/openLink"; // FIRST: a rebuild link (/#c=…) must reach sessionStorage before anything restores from it
import { captureFace } from "@/components/scene/Capture";
import { applySkinShade, SKIN_SHADE, skinUniforms } from "@/lib/skinShader";
import { EYE_LOOK, eyeUniforms } from "@/lib/eyeShader";
import { LIGHTING, lightingRig } from "@/components/scene/Lighting";
import { FaceCanvas } from "@/components/scene/FaceCanvas";
import { LipSyncOverlay } from "@/components/ui/LipSyncOverlay";
import { PerfOverlay } from "@/components/ui/PerfOverlay";
import { SliderPanel } from "@/components/ui/SliderPanel";
import { Toolbar } from "@/components/ui/Toolbar";
import { LogoOrb } from "@/components/ui/LogoOrb";
import { VoicePanel } from "@/components/ui/VoicePanel";
import { addonRig, addonState, syncAddon } from "@/lib/addons";
import { AGE, ageUniforms, setAge } from "@/lib/age";
import { applyEmotion, configureEmotions, emotionRig, setEmotion, setSpeechActivity } from "@/lib/emotion";
import { eyeRig, setEyeColour } from "@/lib/eyes";
import { restoreFace } from "@/lib/faceSession";
import { sliders, visemes, visibleSliders } from "@/lib/data";
import { idleDebug, view } from "@/lib/debugView";
import { GLASSES_FIT, glassesFitState } from "@/lib/glassesFit";
import { hairRig, loadReviewStyles, setHairColour, setHairStyle } from "@/lib/hair";
import { speechPlayer } from "@/lib/lipsync/player";
import { lipsyncState } from "@/lib/lipsync/state";
import { currentLook } from "@/lib/look";
import { lastCaps, updateAnimCaps, visemeCap } from "@/lib/morphs/animCaps";
import { askLimiter, geometryKey, readySpan, wantSpan } from "@/lib/morphs/capsClient";
import { limiter, loadedLimits, plainStore } from "@/lib/morphs/limiter";
import { precomputeVariations, randomFace, randomFaceAsync, randomState, strikingFeatures, varyFace, variationNotches } from "@/lib/morphs/random";
import { morphs } from "@/lib/morphs/store";
import { perf } from "@/lib/perf";
import { characterSettled } from "@/lib/character";
import { quality, setTier } from "@/lib/quality";
import { pieceFade } from "@/lib/pieceFade";
import { setSkinTone, skinRig } from "@/lib/skin";

/** The source repository; the top bar links to it. */
const REPO_URL = "https://github.com/OliverA100/face-to-voice";

// Runs once when this client module loads: ranges, defaults and kinds for every slider.
morphs.configure(sliders.sliders);
configureEmotions(sliders.emotions.intensity.default);
restoreFace(); // the face shown before a reload (sessionStorage)

/**
 * `window.__faceToVoice`: a console and automation handle on the running app's live state, e.g.
 * `__faceToVoice.morphs.set("head_000", 0.5)`, `__faceToVoice.view("profile")`, `__faceToVoice.still(true)`.
 * web/scripts/stress-states.mjs (driven by the pipeline's `uv run validate --stress`) and headless QA scripts read and
 * drive the app through it. Installed in development; a production build installs it only when the page URL has a
 * `debug` query parameter (`/?debug=1`), so the shipped page exposes nothing by default.
 */
const debugHandle = typeof window !== "undefined" && (process.env.NODE_ENV !== "production" || new URLSearchParams(window.location.search).has("debug"));
if (debugHandle) {
  (window as unknown as { __faceToVoice: unknown }).__faceToVoice = {
    // face state
    morphs,
    currentLook,
    characterSettled,
    random: { randomFace, randomFaceAsync, varyFace, precomputeVariations, variationNotches, randomState, strikingFeatures, defs: visibleSliders },
    // the limiter and animation caps (getters: the real limiter once its lazy chunk has loaded)
    limits: {
      get limiter() {
        return loadedLimits()?.limiter ?? limiter;
      },
      get LIMITS() {
        return loadedLimits()?.LIMITS;
      },
      plainStore,
      caps: () => lastCaps,
      updateCaps: updateAnimCaps,
      spans: { want: wantSpan, ready: readySpan },
      ask: askLimiter,
      geometryKey,
    },
    stress: { applyEmotion, setSpeechActivity, visemeCap, visemes },
    // speech and lip sync
    speech: speechPlayer,
    lipsync: lipsyncState,
    // layers: emotion, age, skin, eyes, hair, add-ons
    emotion: { rig: emotionRig, set: setEmotion },
    age: { AGE, uniforms: ageUniforms, set: setAge },
    skin: skinRig,
    setSkinTone,
    skinShade: { SKIN_SHADE, uniforms: skinUniforms, apply: () => applySkinShade(skinRig.material) },
    eyes: eyeRig,
    setEyeColour,
    eyeLook: { EYE_LOOK, uniforms: eyeUniforms },
    hair: hairRig,
    setHairStyle,
    setHairColour,
    loadReviewStyles,
    addons: addonRig,
    addonState,
    syncAddon,
    glassesFit: { GLASSES_FIT, state: glassesFitState },
    pieceFade,
    // rendering, camera and capture
    lighting: { LIGHTING, rig: lightingRig },
    quality: { state: quality, set: setTier },
    view,
    still: (on: boolean) => void (idleDebug.still = on),
    captureFace,
    perf,
  };
}

export function FaceBuilder() {
  return (
    <div className="flex h-dvh w-dvw flex-col bg-page text-ink">
      <header className="flex h-14 shrink-0 items-center justify-between px-3 md:h-16 lg:px-5">
        <div className="flex items-center gap-3">
          <h1 className="flex items-center gap-2 whitespace-nowrap text-input font-medium tracking-[-0.01em]">
            <LogoOrb size={18} />
            Face to Voice
          </h1>
          <p className="hidden text-label text-ink-3 lg:block">Every face suggests a voice. Shape one and hear it.</p>
        </div>
        <nav className="flex items-center gap-2" aria-label="Links">
          <a href="https://elevenlabs.io" target="_blank" rel="noreferrer" className="pill-secondary hidden h-9 sm:inline-flex">
            Built with ElevenLabs
            <span aria-hidden className="-ml-1 text-ink-3">
              ↗
            </span>
            <span className="sr-only">(opens in a new tab)</span>
          </a>
          <a href={REPO_URL} target="_blank" rel="noreferrer" className="pill-primary h-8 px-3 text-label sm:h-9 sm:px-4 sm:text-body">
            GitHub
            <span className="sr-only"> (opens in a new tab)</span>
          </a>
        </nav>
      </header>

      <main className="grid min-h-0 flex-1 grid-rows-[44dvh_1fr] gap-3 px-3 pb-3 lg:grid-cols-[1fr_360px] lg:grid-rows-1 lg:px-5 lg:pb-5">
        <section className="relative min-h-0 overflow-hidden rounded-card bg-surface shadow-hairline lg:col-start-1 lg:row-start-1" aria-label="The face">
          <FaceCanvas />
          <Toolbar />
          <PerfOverlay />
          <LipSyncOverlay />
        </section>

        {/* Phones: one scrolling column (voice card, then sliders). Tablets/laptops (lg): the same column
            sits beside the head, the sliders scrolling inside it. Wide screens (xl): `contents`, so the
            voice card floats in the head's cell and the sliders take the second column on their own.
            -m-px p-px: the cards' 0.5px ring is a box-shadow, which the column's overflow would clip at its edges.
            relative (here and on the panel): absolute bits inside, like sr-only labels, stay in the scroller instead of
            stretching the page. */}
        <div className="no-scrollbar relative -m-px flex min-h-0 flex-col gap-3 overflow-y-auto p-px lg:col-start-2 lg:row-start-1 lg:overflow-hidden xl:contents">
          <div className="shrink-0 xl:pointer-events-none xl:z-10 xl:col-start-1 xl:row-start-1 xl:m-4 xl:flex xl:max-h-[calc(100%-2rem)] xl:flex-col xl:self-end xl:justify-self-end">
            <VoicePanel />
          </div>
          <aside className="card shrink-0 lg:min-h-0 lg:flex-1 lg:overflow-hidden xl:col-start-2 xl:row-start-1" aria-label="Face sliders">
            <SliderPanel />
          </aside>
        </div>
      </main>
    </div>
  );
}
