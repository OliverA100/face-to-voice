import { describe, expect, it } from "vitest";

import { CHARACTER_FORMAT, decodeCharacter, encodeCharacter, storageEntries, type CharacterFile } from "../characterCode";

const character: CharacterFile = {
  format: CHARACTER_FORMAT,
  version: 1,
  sliders: 2,
  shape: { sem_age: 0.4123, head_000: -1.25, jaw_width: 0.0001 },
  emotion: "happy",
  intensity: 0.8,
  pose: { headYaw: 15, headPitch: -3.5, headRoll: 6, gazeYaw: 0, gazePitch: -6 },
  hair: { style: "haircs-v0-00313", colour: "natural" },
  addons: { eyebrows: "natural", eyelashes: "none", facialHair: "none", glasses: "round-wire", facialHairColour: "hair" },
  skin: "beige",
  eyes: "blue-grey",
};

describe("character link code", () => {
  it("round-trips a character, URL-safe", () => {
    const code = encodeCharacter(character);
    expect(code).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(decodeCharacter(code)).toEqual(character);
  });

  it("refuses what isn't a character link", () => {
    const encode = (v: unknown) => encodeCharacter(v as CharacterFile);
    expect(decodeCharacter("")).toBeNull();
    expect(decodeCharacter("not base64!")).toBeNull();
    expect(decodeCharacter(encode({ ...character, format: "something-else" }))).toBeNull();
    expect(decodeCharacter(encode({ ...character, version: 99 }))).toBeNull(); // made by a newer app
    expect(decodeCharacter(encode({ ...character, shape: [1, 2] }))).toBeNull();
    expect(decodeCharacter("A".repeat(20_000))).toBeNull();
  });

  it("writes the entries a reload reads", () => {
    const e = storageEntries(character);
    expect(JSON.parse(e["ftv-face"])).toEqual({ shape: character.shape, emotion: "happy", intensity: 0.8 });
    expect(JSON.parse(e["ftv-pose"])).toEqual(character.pose);
    expect(JSON.parse(e["ftv-hair"])).toEqual(character.hair);
    expect(JSON.parse(e["ftv-addons"])).toEqual(character.addons);
    expect([e["ftv-skin"], e["ftv-eyes"]]).toEqual(["beige", "blue-grey"]);
  });
});
