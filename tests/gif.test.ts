/** @lane merge */
import { chromium } from 'playwright';
import { describe, expect, it } from 'vitest';
import { browserLaunchOptions } from '../src/browser.ts';
import { decodeGif, encodeGif, quantize, type Rgb } from '../src/gif.ts';

const GREYS: Rgb[] = [[0, 0, 0], [85, 85, 85], [170, 170, 170], [255, 255, 255]];

/** A deterministic pseudo-random index stream, so a failure reproduces. */
function noise(length: number, colours: number, seed = 1): Uint8Array {
  const out = new Uint8Array(length);
  let s = seed >>> 0;
  for (let i = 0; i < length; i++) { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; out[i] = (s >>> 24) % colours; }
  return out;
}

/** Find every block that starts with `introducer` and `label` outside image data, by walking the GIF block structure. */
function blocks(gif: Uint8Array): { extensions: { label: number; data: Uint8Array[] }[]; images: number; trailer: boolean } {
  const tableSize = gif[10]! & 0x80 ? 3 * (1 << ((gif[10]! & 7) + 1)) : 0;
  let pos = 13 + tableSize, images = 0;
  const extensions: { label: number; data: Uint8Array[] }[] = [];
  const subBlocks = () => { const data: Uint8Array[] = []; while (gif[pos] !== 0) { data.push(gif.subarray(pos + 1, pos + 1 + gif[pos]!)); pos += gif[pos]! + 1; } pos++; return data; };
  while (pos < gif.length) {
    const byte = gif[pos]!;
    if (byte === 0x3b) return { extensions, images, trailer: pos === gif.length - 1 };
    if (byte === 0x21) { const label = gif[pos + 1]!; pos += 2; extensions.push({ label, data: subBlocks() }); continue; }
    if (byte === 0x2c) {
      const packed = gif[pos + 9]!;
      pos += 10 + (packed & 0x80 ? 3 * (1 << ((packed & 7) + 1)) : 0);
      pos++; // LZW minimum code size
      subBlocks(); images++; continue;
    }
    throw new Error(`unexpected byte ${byte} at ${pos}`);
  }
  return { extensions, images, trailer: false };
}

describe('encodeGif structure', () => {
  const width = 5, height = 3;
  const frames = [noise(15, 4, 1), noise(15, 4, 2), noise(15, 4, 3)];
  const gif = encodeGif(frames, { width, height, palette: GREYS, delayCs: 8, loop: 0 });

  it('writes a GIF89a header, the logical screen size and a global colour table', () => {
    expect(Buffer.from(gif.subarray(0, 6)).toString('latin1')).toBe('GIF89a');
    expect(gif[6]! | gif[7]! << 8).toBe(width);
    expect(gif[8]! | gif[9]! << 8).toBe(height);
    expect(gif[10]! & 0x80).toBe(0x80);
    expect(1 << ((gif[10]! & 7) + 1)).toBe(4);
    expect([...gif.subarray(13, 25)]).toEqual(GREYS.flat());
  });

  it('loops forever through a NETSCAPE2.0 block and gives every frame a graphic control extension with the delay', () => {
    const { extensions, images, trailer } = blocks(gif);
    const app = extensions.filter(e => e.label === 0xff);
    expect(app).toHaveLength(1);
    expect(Buffer.from(app[0]!.data[0]!).toString('latin1')).toBe('NETSCAPE2.0');
    expect([...app[0]!.data[1]!]).toEqual([1, 0, 0]);
    const controls = extensions.filter(e => e.label === 0xf9);
    expect(controls).toHaveLength(3);
    for (const control of controls) expect(control.data[0]![1]! | control.data[0]![2]! << 8).toBe(8);
    expect(images).toBe(3);
    expect(trailer).toBe(true);
  });

  it('decodes back to the same size, palette, loop count, delays and frames', () => {
    const decoded = decodeGif(gif);
    expect(decoded).toMatchObject({ width, height, loop: 0 });
    expect(decoded.palette).toEqual(GREYS);
    expect(decoded.frames.map(f => f.delayCs)).toEqual([8, 8, 8]);
    expect(decoded.frames.map(f => [...f.indices])).toEqual(frames.map(f => [...f]));
  });
});

describe('palette padding', () => {
  const sizeOf = (palette: Rgb[]) => { const gif = encodeGif([new Uint8Array(4)], { width: 2, height: 2, palette, delayCs: 10, loop: 0 }); return { entries: 1 << ((gif[10]! & 7) + 1), gif }; };

  it('pads the colour table to the next power of two, at least 2, with black', () => {
    expect(sizeOf([[255, 0, 0]]).entries).toBe(2);
    const three = sizeOf([[255, 0, 0], [0, 255, 0], [0, 0, 255]]);
    expect(three.entries).toBe(4);
    expect([...three.gif.subarray(13, 25)]).toEqual([255, 0, 0, 0, 255, 0, 0, 0, 255, 0, 0, 0]);
    expect(sizeOf(GREYS.concat(GREYS, GREYS, GREYS)).entries).toBe(16);
    expect(sizeOf(Array.from({ length: 17 }, (_, i) => [i, i, i] as Rgb)).entries).toBe(32);
    expect(sizeOf(Array.from({ length: 256 }, (_, i) => [i, i, i] as Rgb)).entries).toBe(256);
  });

  it('refuses more than 256 colours, an index outside the palette and a frame of the wrong length', () => {
    expect(() => sizeOf(Array.from({ length: 257 }, () => [0, 0, 0] as Rgb))).toThrow(/256/);
    expect(() => encodeGif([new Uint8Array([0, 1, 2, 3])], { width: 2, height: 2, palette: [[0, 0, 0], [9, 9, 9]], delayCs: 10, loop: 0 })).toThrow(/index/);
    expect(() => encodeGif([new Uint8Array(3)], { width: 2, height: 2, palette: GREYS, delayCs: 10, loop: 0 })).toThrow(/4/);
    expect(() => encodeGif([], { width: 2, height: 2, palette: GREYS, delayCs: 10, loop: 0 })).toThrow(/frame/);
  });
});

describe('LZW round trip', () => {
  it('survives the 4095-code reset on noisy 256-colour frames and the 2-bit minimum code size', () => {
    const palette = Array.from({ length: 256 }, (_, i) => [i, 255 - i, (i * 7) & 255] as Rgb);
    const big = [noise(192 * 192, 256, 7), noise(192 * 192, 256, 8)];
    const decoded = decodeGif(encodeGif(big, { width: 192, height: 192, palette, delayCs: 4, loop: 0 }));
    expect(decoded.frames).toHaveLength(2);
    decoded.frames.forEach((frame, i) => expect(Buffer.from(frame.indices).equals(Buffer.from(big[i]!))).toBe(true));
    const binary = [noise(999, 2, 3), noise(999, 2, 4)];
    const back = decodeGif(encodeGif(binary, { width: 37, height: 27, palette: [[0, 0, 0], [255, 255, 255]], delayCs: 4, loop: 0 }));
    back.frames.forEach((frame, i) => expect(Buffer.from(frame.indices).equals(Buffer.from(binary[i]!))).toBe(true));
  });

  it('keeps identical and partly changed frames as separate frames', () => {
    const a = new Uint8Array(64).fill(1), b = a.slice(); b[27] = 3; b[45] = 2;
    const decoded = decodeGif(encodeGif([a, a, b, b, a], { width: 8, height: 8, palette: GREYS, delayCs: 10, loop: 0 }));
    expect(decoded.frames.map(f => [...f.indices])).toEqual([a, a, b, b, a].map(f => [...f]));
  });

  it('marks unchanged pixels of later frames transparent in a reserved slot, and still decodes to the same frames', () => {
    const a = noise(32 * 32, 4, 5), b = a.slice(); for (let i = 300; i < 340; i++) b[i] = (b[i]! + 1) % 4; b[1000] = (b[1000]! + 2) % 4;
    const plain = encodeGif([a, b, a], { width: 32, height: 32, palette: GREYS, delayCs: 10, loop: 0 });
    const gif = encodeGif([a, b, a], { width: 32, height: 32, palette: GREYS, delayCs: 10, loop: 0, reserveTransparent: true });
    expect(1 << ((gif[10]! & 7) + 1)).toBe(8);
    const controls = blocks(gif).extensions.filter(e => e.label === 0xf9).map(e => [e.data[0]![0]! & 1, e.data[0]![3]]);
    expect(controls).toEqual([[0, 0], [1, 4], [1, 4]]);
    expect(gif.length).toBeLessThan(plain.length);
    expect(decodeGif(gif).frames.map(f => [...f.indices])).toEqual([a, b, a].map(f => [...f]));
  });

  it('compresses a flat frame to a small fraction of its pixel count', () => {
    const gif = encodeGif([new Uint8Array(192 * 192).fill(2)], { width: 192, height: 192, palette: GREYS, delayCs: 10, loop: 0 });
    expect(gif.length).toBeLessThan(2000);
  });
});

describe('quantize', () => {
  it('maps each RGBA pixel to the index of the nearest palette colour, ignoring alpha', () => {
    const rgba = new Uint8Array([0, 0, 0, 255, 250, 250, 250, 255, 90, 80, 85, 0, 160, 175, 170, 255]);
    expect([...quantize(rgba, GREYS)]).toEqual([0, 3, 1, 2]);
  });
});

describe('a browser decodes the GIF', () => {
  it('Chromium reads its size and the first frame\'s colours', async () => {
    const palette: Rgb[] = [[33, 56, 68], [220, 231, 235]];
    const frame = new Uint8Array(16 * 16).map((_, i) => (i % 16 < 8 ? 0 : 1));
    const gif = encodeGif([frame, frame.map(v => 1 - v)], { width: 16, height: 16, palette, delayCs: 10, loop: 0 });
    const browser = await chromium.launch({ headless: true, ...browserLaunchOptions() });
    try {
      const page = await browser.newPage();
      const result = await page.evaluate(async src => {
        const img = new Image(); img.src = src; await img.decode();
        const canvas = document.createElement('canvas'); canvas.width = img.naturalWidth; canvas.height = img.naturalHeight;
        const context = canvas.getContext('2d')!; context.drawImage(img, 0, 0);
        return { width: img.naturalWidth, height: img.naturalHeight, left: [...context.getImageData(2, 2, 1, 1).data], right: [...context.getImageData(12, 2, 1, 1).data] };
      }, `data:image/gif;base64,${Buffer.from(gif).toString('base64')}`);
      expect(result).toEqual({ width: 16, height: 16, left: [33, 56, 68, 255], right: [220, 231, 235, 255] });
    } finally { await browser.close(); }
  });

  it('Chromium composites a later frame whose unchanged pixels are transparent to the same picture as decodeGif', async () => {
    const palette: Rgb[] = [[33, 56, 68], [120, 140, 150], [220, 231, 235]];
    const first = new Uint8Array(24 * 24).map((_, i) => (i % 24 < 12 ? 0 : 2)), second = first.slice();
    for (let y = 10; y < 14; y++) for (let x = 3; x < 9; x++) second[y * 24 + x] = 1;
    second[20 * 24 + 20] = 0;
    const gif = encodeGif([first, second], { width: 24, height: 24, palette, delayCs: 10, loop: 0, reserveTransparent: true });
    const expected = [...decodeGif(gif).frames[1]!.indices].map(i => [...palette[i]!, 255]).flat();
    const browser = await chromium.launch({ headless: true, ...browserLaunchOptions() });
    try {
      const page = await browser.newPage();
      // ImageDecoder needs a secure context: serve an empty page from an https origin that never reaches the network.
      await page.route('https://gif.invalid/**', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>gif</title>' }));
      await page.goto('https://gif.invalid/');
      const pixels = await page.evaluate(async base64 => {
        const data = Uint8Array.from(atob(base64), c => c.charCodeAt(0));
        const decoder = new (window as unknown as { ImageDecoder: new (init: { data: Uint8Array; type: string }) => { decode(o: { frameIndex: number }): Promise<{ image: CanvasImageSource & { close(): void } }> } }).ImageDecoder({ data, type: 'image/gif' });
        const { image } = await decoder.decode({ frameIndex: 1 });
        const canvas = document.createElement('canvas'); canvas.width = 24; canvas.height = 24;
        const context = canvas.getContext('2d')!; context.drawImage(image, 0, 0); image.close();
        return [...context.getImageData(0, 0, 24, 24).data];
      }, Buffer.from(gif).toString('base64'));
      expect(pixels).toEqual(expected);
    } finally { await browser.close(); }
  });
});
