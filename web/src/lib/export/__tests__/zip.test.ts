import { inflateRawSync } from "node:zlib";
import { describe, expect, it } from "vitest";

import { crc32, makeZip } from "../zip";

describe("zip writer", () => {
  it("computes the standard CRC-32", () => {
    expect(crc32(new TextEncoder().encode("123456789"))).toBe(0xcbf43926);
    expect(crc32(new Uint8Array())).toBe(0);
  });

  it("stores each file after its local header and lists them all in the central directory", async () => {
    const png = new Uint8Array([137, 80, 78, 71, 1, 2, 3]);
    const blob = await makeZip([
      { name: "a/README.md", data: "héllo" },
      { name: "a/portrait.png", data: png },
    ]);
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const view = new DataView(bytes.buffer);
    const end = bytes.length - 22;
    expect(view.getUint32(end, true)).toBe(0x06054b50);
    expect(view.getUint16(end + 10, true)).toBe(2); // entries
    // the second local header: name, then the PNG bytes untouched
    let at = 0;
    for (let i = 0; i < 2; i++) {
      expect(view.getUint32(at, true)).toBe(0x04034b50);
      const size = view.getUint32(at + 18, true);
      const nameLength = view.getUint16(at + 26, true);
      const name = new TextDecoder().decode(bytes.subarray(at + 30, at + 30 + nameLength));
      const data = bytes.subarray(at + 30 + nameLength, at + 30 + nameLength + size);
      if (i === 0) expect([name, new TextDecoder().decode(data)]).toEqual(["a/README.md", "héllo"]);
      else expect([name, [...data]]).toEqual(["a/portrait.png", [...png]]);
      expect(view.getUint32(at + 14, true)).toBe(crc32(data));
      at += 30 + nameLength + size;
    }
    expect(view.getUint32(at, true)).toBe(0x02014b50); // central directory follows the files
    expect(view.getUint32(end + 16, true)).toBe(at);
  });

  it("deflates the entries marked deflate, with the CRC and size of the original", async () => {
    const model = new Uint8Array(4096).map((_, i) => i % 7); // repetitive, like a mesh's floats
    const bytes = new Uint8Array(await (await makeZip([{ name: "a/character.glb", data: model, deflate: true }])).arrayBuffer());
    const view = new DataView(bytes.buffer);
    expect(view.getUint16(8, true)).toBe(8); // method: deflate
    const packed = view.getUint32(18, true);
    expect(view.getUint32(22, true)).toBe(model.length); // uncompressed size
    expect(packed).toBeLessThan(model.length);
    expect(view.getUint32(14, true)).toBe(crc32(model));
    const nameLength = view.getUint16(26, true);
    const data = bytes.subarray(30 + nameLength, 30 + nameLength + packed);
    expect([...inflateRawSync(data)]).toEqual([...model]);
    const central = 30 + nameLength + packed;
    expect(view.getUint16(central + 10, true)).toBe(8); // the central record says deflate too
  });
});
