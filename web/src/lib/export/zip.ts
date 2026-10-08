/**
 * A minimal .zip writer: files are stored, not compressed. The export is a PNG and an MP3 (already compressed) plus a
 * few small text files, so deflate would save almost nothing, and this keeps the export free of dependencies.
 * Format: PKWARE APPNOTE 6.3 (local headers, central directory, end record); names are UTF-8 (flag bit 11).
 */

export interface ZipEntry {
  name: string; // path inside the zip, "/" separated
  data: Uint8Array | string; // strings are written as UTF-8
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(data: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < data.length; i++) c = CRC_TABLE[(c ^ data[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** MS-DOS time and date fields for `d` (local time, 2-second steps). */
function dosTime(d: Date): [number, number] {
  return [(d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1), ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate()];
}

export function makeZip(entries: ZipEntry[], when = new Date()): Blob {
  const utf8 = new TextEncoder();
  const [time, date] = dosTime(when);
  const parts: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;

  for (const entry of entries) {
    const name = utf8.encode(entry.name);
    const data = typeof entry.data === "string" ? utf8.encode(entry.data) : entry.data;
    const crc = crc32(data);
    // Fields shared by the local header (from "version needed") and the central record (from its offset 6).
    const common = (v: DataView, at: number) => {
      v.setUint16(at, 20, true); // version needed: 2.0
      v.setUint16(at + 2, 0x0800, true); // flags: UTF-8 names
      v.setUint16(at + 4, 0, true); // method: stored
      v.setUint16(at + 6, time, true);
      v.setUint16(at + 8, date, true);
      v.setUint32(at + 10, crc, true);
      v.setUint32(at + 14, data.length, true); // compressed size
      v.setUint32(at + 18, data.length, true); // uncompressed size
      v.setUint16(at + 22, name.length, true);
      v.setUint16(at + 24, 0, true); // extra field length
    };

    const local = new Uint8Array(30 + name.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    common(lv, 4);
    local.set(name, 30);
    parts.push(local, data);

    const record = new Uint8Array(46 + name.length);
    const cv = new DataView(record.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true); // version made by
    common(cv, 6);
    // comment length, disk number, internal and external attributes: 0
    cv.setUint32(42, offset, true);
    record.set(name, 46);
    central.push(record);

    offset += local.length + data.length;
  }

  const size = central.reduce((n, c) => n + c.length, 0);
  const end = new Uint8Array(22);
  const ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, entries.length, true); // entries on this disk
  ev.setUint16(10, entries.length, true); // entries in total
  ev.setUint32(12, size, true);
  ev.setUint32(16, offset, true);
  return new Blob([...parts, ...central, end] as BlobPart[], { type: "application/zip" });
}
