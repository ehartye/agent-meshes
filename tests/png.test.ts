/** @lane merge
 * @subject src/png.ts
 */
import { expect, it } from 'vitest';
import { deflateSync } from 'node:zlib';
import { PNG_SIGNATURE, crc32, decodePng, encodePng } from '../src/png.ts';

/** A deterministic RGBA picture with every channel varying, including partial alpha. */
function picture(width: number, height: number): Buffer {
  const rgba = Buffer.alloc(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    rgba[i * 4] = (i * 7) & 255; rgba[i * 4 + 1] = (i * 13 + 5) & 255; rgba[i * 4 + 2] = (i * 31 + 9) & 255; rgba[i * 4 + 3] = i % 3 === 0 ? 0 : (i * 5) & 255;
  }
  return rgba;
}

/** Split a PNG into its chunks, so a test can read the types, lengths and stored CRCs. */
function chunks(png: Buffer) {
  const out: { type: string; data: Buffer; crc: number }[] = [];
  for (let pos = 8; pos < png.length;) {
    const length = png.readUInt32BE(pos);
    out.push({ type: png.toString('latin1', pos + 4, pos + 8), data: png.subarray(pos + 8, pos + 8 + length), crc: png.readUInt32BE(pos + 8 + length) });
    pos += 12 + length;
  }
  return out;
}

/** Assemble a PNG chunk the same way the encoder does, so a test can build files the encoder never writes. */
function chunk(type: string, data: Buffer): Buffer {
  const body = Buffer.concat([Buffer.from(type), data]), length = Buffer.alloc(4), crc = Buffer.alloc(4);
  length.writeUInt32BE(data.length); crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

it('round-trips RGBA bytes exactly', () => {
  const rgba = picture(37, 21);
  const decoded = decodePng(encodePng(37, 21, rgba));
  expect(decoded.width).toBe(37);
  expect(decoded.height).toBe(21);
  expect(decoded.rgba.equals(rgba)).toBe(true);
});

it('writes the signature, IHDR, IDAT and IEND with correct CRCs, and equal pixels give equal bytes', () => {
  const rgba = picture(16, 9);
  const png = encodePng(16, 9, rgba);
  expect(png.subarray(0, 8).equals(PNG_SIGNATURE)).toBe(true);
  expect([...png.subarray(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
  const list = chunks(png);
  expect(list.map(c => c.type)).toEqual(['IHDR', 'IDAT', 'IEND']);
  for (const c of list) expect(c.crc).toBe(crc32(Buffer.concat([Buffer.from(c.type, 'latin1'), c.data])));
  const header = list[0]!.data;
  expect([header.readUInt32BE(0), header.readUInt32BE(4), header[8], header[9], header[10], header[11], header[12]]).toEqual([16, 9, 8, 6, 0, 0, 0]);
  expect(encodePng(16, 9, rgba).equals(png)).toBe(true);
});

it('computes the standard CRC-32', () => {
  expect(crc32(Buffer.from('123456789'))).toBe(0xcbf43926);
  expect(crc32(Buffer.alloc(0))).toBe(0);
});

it('rejects a corrupted chunk, a bad signature and truncated data', () => {
  const png = encodePng(4, 4, picture(4, 4));
  const flipped = Buffer.from(png); flipped[flipped.length - 20] ^= 0xff; // inside IDAT
  expect(() => decodePng(flipped)).toThrowError(expect.objectContaining({ code: 'PNG_INVALID', message: expect.stringMatching(/CRC/) }));
  const bad = Buffer.from(png); bad[1] = 0;
  expect(() => decodePng(bad)).toThrowError(expect.objectContaining({ code: 'PNG_INVALID' }));
  expect(() => decodePng(png.subarray(0, png.length - 5))).toThrowError(expect.objectContaining({ code: 'PNG_INVALID' }));
});

it('refuses formats it does not write', () => {
  const png = Buffer.from(encodePng(2, 2, picture(2, 2)));
  png[8 + 8 + 9] = 2; // colour type 2 (RGB), with the IHDR CRC repaired
  png.writeUInt32BE(crc32(png.subarray(12, 8 + 8 + 13)), 8 + 8 + 13);
  expect(() => decodePng(png)).toThrowError(expect.objectContaining({ code: 'PNG_UNSUPPORTED' }));
});

it('rejects pixel data of the wrong size and non-positive dimensions', () => {
  expect(() => encodePng(2, 2, Buffer.alloc(15))).toThrowError(expect.objectContaining({ code: 'PNG_SIZE_MISMATCH' }));
  expect(() => encodePng(0, 2, Buffer.alloc(0))).toThrowError(expect.objectContaining({ code: 'PNG_INVALID' }));
  expect(() => encodePng(1.5, 2, Buffer.alloc(12))).toThrowError(expect.objectContaining({ code: 'PNG_INVALID' }));
});

it('decodes rows written with the Sub, Up, Average and Paeth filters', () => {
  const width = 5, height = 4, rgba = picture(width, height), stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  const paeth = (a: number, b: number, c: number) => { const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c); return pa <= pb && pa <= pc ? a : pb <= pc ? b : c; };
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = y + 1; // Sub, Up, Average, Paeth
    for (let i = 0; i < stride; i++) {
      const a = i >= 4 ? rgba[y * stride + i - 4]! : 0, b = y ? rgba[(y - 1) * stride + i]! : 0, c = y && i >= 4 ? rgba[(y - 1) * stride + i - 4]! : 0;
      const predictor = [a, b, (a + b) >> 1, paeth(a, b, c)][y]!;
      raw[y * (stride + 1) + 1 + i] = (rgba[y * stride + i]! - predictor) & 255;
    }
  }
  const header = Buffer.alloc(13); header.writeUInt32BE(width, 0); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 6;
  const png = Buffer.concat([PNG_SIGNATURE, chunk('IHDR', header), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
  expect(decodePng(png).rgba.equals(rgba)).toBe(true);
});
