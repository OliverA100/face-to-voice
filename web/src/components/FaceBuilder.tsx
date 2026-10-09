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
import { SiteHeader } from "@/components/ui/SiteHeader";
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
    // Below lg the page itself scrolls (not a box inside it), so iOS Safari shrinks its bars and the cards pass under the
    // toolbar; the header and the head stick. --head-top / --tabs-top: where the head and the slider tabs stick.
    // viewport-fit=cover (app/layout.tsx) lets the page reach under the notch and the bars, so the edges keep clear of the safe areas.
    <div className="flex min-h-dvh w-full flex-col bg-page pr-[env(safe-area-inset-right)] pl-[env(safe-area-inset-left)] text-ink [--head-top:calc(env(safe-area-inset-top)_+_3.5rem)] [--tabs-top:calc(var(--head-top)_+_44svh_+_0.75rem)] md:[--head-top:calc(env(safe-area-inset-top)_+_4rem)] lg:h-dvh">
      <SiteHeader home />

      <main className="grid flex-1 px-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] lg:min-h-0 lg:grid-cols-[1fr_360px] lg:grid-rows-1 lg:gap-3 lg:px-5 lg:pb-5">
        {/* Below lg: the head sticks under the header on a page-coloured band (the cards slide behind it). svh, not dvh: the
            head keeps its size while Safari's bars shrink and grow. From lg the band is `contents` and the head is the grid's cell. */}
        <div className="sticky top-(--head-top) z-20 -mx-3 h-[calc(44svh_+_0.75rem)] bg-page px-3 pb-3 lg:contents">
          <section className="relative min-h-0 overflow-hidden rounded-card bg-surface shadow-hairline max-lg:h-full lg:col-start-1 lg:row-start-1" aria-label="The face">
            <FaceCanvas />
            <Toolbar />
            <PerfOverlay />
            <LipSyncOverlay />
          </section>
        </div>

        {/* Phones and tablets: one column (voice card, then sliders) that scrolls with the page. Laptops (lg): the same column
            sits beside the head, the sliders scrolling inside it. Wide screens (xl): `contents`, so the
            voice card floats in the head's cell and the sliders take the second column on their own.
            -m-px p-px: the cards' 0.5px ring is a box-shadow, which the column's overflow would clip at its edges.
            relative (here and on the panel): absolute bits inside, like sr-only labels, stay in the scroller instead of
            stretching the page. */}
        <div className="relative -m-px flex flex-col gap-3 p-px lg:col-start-2 lg:min-h-0 lg:row-start-1 lg:overflow-hidden xl:contents">
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
