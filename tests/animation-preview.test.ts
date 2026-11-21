/** @lane merge */
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPreviewSession, PREVIEW_PALETTE, renderClipPreview } from '../src/animation-preview.ts';
import { decodeGif } from '../src/gif.ts';
import { animatedFbx } from './helpers/animated-fbx.ts';

const hex = (rgb: readonly number[]) => `#${rgb.map(v => v.toString(16).padStart(2, '0')).join('')}`;

let dir = '', walk = '', idle = '';
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'agent-meshes-preview-'));
  walk = join(dir, 'Walk.fbx'); idle = join(dir, 'Idle.fbx');
  await writeFile(walk, animatedFbx({ seconds: 2, travel: 1 }));
  await writeFile(idle, animatedFbx({ seconds: 1, travel: 0 }));
});
afterAll(async () => { if (dir) await rm(dir, { recursive: true, force: true }); });

/** The horizontal centre of the pixels darker than the ground line: the figure. */
function figureCentreX(indices: Uint8Array, size: number, darkest: number): number | null {
  let sum = 0, count = 0;
  for (let i = 0; i < indices.length; i++) if (indices[i]! <= darkest) { sum += i % size; count++; }
  return count ? sum / count : null;
}

describe('the preview palette', () => {
  it('has 16 colours running from --ink to --stage and includes --line', () => {
    expect(PREVIEW_PALETTE).toHaveLength(16);
    const colours = PREVIEW_PALETTE.map(hex);
    expect(colours[0]).toBe('#213844');
    expect(colours).toContain('#dce7eb');
    expect(colours).toContain('#d6e0e4');
  });
});

describe('renderClipPreview', { timeout: 180_000 }, () => {
  it('renders the synthetic 2 s walk as a 192 by 192 GIF89a that loops forever, at 12 fps, under 400 KB', async () => {
    const { gif } = await renderClipPreview(walk);
    expect(Buffer.from(gif.subarray(0, 6)).toString('latin1')).toBe('GIF89a');
    expect(gif.length).toBeLessThanOrEqual(400 * 1024);
    const decoded = decodeGif(gif);
    expect(decoded).toMatchObject({ width: 192, height: 192, loop: 0 });
    expect(decoded.frames).toHaveLength(24);
    expect(new Set(decoded.frames.map(f => f.delayCs))).toEqual(new Set([8]));
    expect(decoded.palette.slice(0, 16).map(hex)).toEqual(PREVIEW_PALETTE.map(hex));

    // The background is the stage colour, and the figure is drawn in darker tints of ink.
    const stage = PREVIEW_PALETTE.map(hex).indexOf('#dce7eb'), line = PREVIEW_PALETTE.map(hex).indexOf('#d6e0e4');
    const counts = new Array(16).fill(0);
    for (const value of decoded.frames[0]!.indices) counts[value]++;
    expect(counts.indexOf(Math.max(...counts))).toBe(stage);
    const darkest = Math.min(stage, line) - 2;
    const figure = decoded.frames[0]!.indices.filter(value => value <= darkest).length;
    expect(figure).toBeGreaterThan(192 * 192 * 0.01);

    // The figure moves: frames differ, and with the camera following the hips it stays near the same place in the frame.
    const distinct = new Set(decoded.frames.map(f => Buffer.from(f.indices).toString('base64')));
    expect(distinct.size).toBeGreaterThan(decoded.frames.length / 2);
    const first = figureCentreX(decoded.frames[0]!.indices, 192, darkest)!, last = figureCentreX(decoded.frames.at(-1)!.indices, 192, darkest)!;
    expect(Math.abs(first - last)).toBeLessThan(192 * 0.15);
  });

  it('shares one browser across renders in a session, lowers the frame rate to fit maxFrames and refuses a file that is not an FBX', async () => {
    const session = await createPreviewSession();
    try {
      const a = decodeGif((await session.render(idle, { size: 96 })).gif);
      expect(a).toMatchObject({ width: 96, height: 96 });
      expect(a.frames).toHaveLength(12);
      const b = decodeGif((await renderClipPreview(walk, { size: 64, maxFrames: 10, session })).gif);
      expect(session.browser.isConnected()).toBe(true);
      expect(b).toMatchObject({ width: 64, height: 64 });
      expect(b.frames).toHaveLength(10);
      expect(new Set(b.frames.map(f => f.delayCs))).toEqual(new Set([20]));
      const text = join(dir, 'not.fbx');
      await writeFile(text, 'hello, not an fbx');
      await expect(session.render(text)).rejects.toThrow(/FBX/);
      // The session survives a failed render.
      expect(decodeGif((await session.render(idle, { size: 32, maxFrames: 2 })).gif).frames).toHaveLength(2);
    } finally { await session.close(); }
    expect(session.browser.isConnected()).toBe(false);
  });

  it('draws a "with skin" download, with a skinned mesh, a rest take and bare bone names, from its longest take', async () => {
    const skinned = join(dir, 'Skinned.fbx'), bare = join(dir, 'Bare.fbx');
    await writeFile(skinned, animatedFbx({ seconds: 1.5, mesh: true, restTake: true, prefix: '' }));
    await writeFile(bare, animatedFbx({ seconds: 1.5, prefix: '' }));
    const session = await createPreviewSession();
    try {
      const { gif } = await session.render(skinned, { size: 64 });
      const decoded = decodeGif(gif);
      expect(decoded.frames).toHaveLength(18);
      expect(new Set(decoded.frames.map(f => Buffer.from(f.indices).toString('base64'))).size).toBeGreaterThan(9);
      // Only the mannequin is drawn: the skinned mesh changes nothing.
      expect(Buffer.from(gif).equals(Buffer.from((await session.render(bare, { size: 64 })).gif))).toBe(true);
    } finally { await session.close(); }
  });
});
