"use client";

/**
 * Style tab: everything that is worn or coloured rather than shaped. Colouring (skin, eyes), Hair, brows
 * & beard (head hair, brows, lashes, facial hair) and Accessories (glasses). All of it reaches the voice too.
 * The thumbnails are lazy <img>s, so they only load once this tab is shown.
 */
import { AddonControls } from "@/components/ui/AddonControls";
import { EyeControl } from "@/components/ui/EyeControl";
import { HairControl } from "@/components/ui/HairControl";
import { SkinControl } from "@/components/ui/SkinControl";

import { Block, Hint } from "./Group";

export function StyleSection() {
  return (
    <>
      <Hint>Colours, hair and glasses. The voice sees them too.</Hint>
      <Block title="Colouring">
        <SkinControl />
        <EyeControl />
      </Block>
      <Block title="Hair, brows & beard">
        <HairControl />
        <AddonControls categories={["eyebrows", "eyelashes", "facialHair"]} />
      </Block>
      <Block title="Accessories">
        <AddonControls categories={["glasses"]} />
      </Block>
    </>
  );
}
