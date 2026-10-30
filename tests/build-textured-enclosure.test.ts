import { afterEach, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { buildAsset } from '../src/build.ts';
import { blenderIt } from './helpers/blender.ts';

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))); });

/** Build the textured head fixture, optionally declaring an enclosure on a bubble round it. */
async function build(encloses: unknown, textured = true) {
  const directory = await mkdtemp(join(tmpdir(), 'mesh-textured-enclosure-')); directories.push(directory);
  const source = await readFile(resolve('tests/fixtures/textured/textured_head.py'), 'utf8');
  const script = source.replace('TEXTURED = True', `TEXTURED = ${textured ? 'True' : 'False'}`).replace('ENCLOSES = None', `ENCLOSES = ${encloses === undefined ? 'None' : `json.loads(${JSON.stringify(JSON.stringify(encloses))})`}`);
  await writeFile(join(directory, 'textured_head.py'), script);
  const config = join(directory, 'build.json');
  await writeFile(config, JSON.stringify({ version: 1, name: 'textured_head', blender: { script: 'textured_head.py' }, output: 'generated' }));
  return { directory, config, output: join(directory, 'generated') };
}

// Real Blender only: CI skips this, like the glass and refine stages.
const maybe = blenderIt;

maybe('a Blender-authored textured GLB with no enclosure declaration completes the managed build', async () => {
  const { config, output } = await build(undefined);
  const result = await buildAsset(config);
  expect(result.output).toBe(output);
  const glb = await readFile(join(output, 'model.glb'));
  const json = JSON.parse(Buffer.from(glb.subarray(20, 20 + glb.readUInt32LE(12))).toString('utf8'));
  expect(json.images.length).toBeGreaterThan(0);
  const verification = JSON.parse(await readFile(join(output, 'verification.json'), 'utf8'));
  expect(verification.issues.numErrors).toBe(0);
  expect(verification.enclosures).toBeUndefined();
}, 240000);

// The bubble stands about 0.06 m off the head, so a 0.2 m clearance cannot hold.
const tooTight = { parts: ['head'], clearance: 0.2 };
maybe('an untextured GLB with a bad declared enclosure fails the build', async () => {
  const { config } = await build(tooTight, false);
  await expect(buildAsset(config)).rejects.toThrow(/Enclosure check failed[\s\S]*bubble/);
}, 240000);

maybe('a textured GLB with a bad declared enclosure fails the build as an enclosure failure', async () => {
  const { config } = await build(tooTight);
  await expect(buildAsset(config)).rejects.toThrow(/Enclosure check failed[\s\S]*bubble/);
}, 240000);

maybe('a textured GLB whose declared enclosure holds completes with the enclosure reported', async () => {
  const { config, output } = await build({ parts: ['head'], clearance: 0.015, maxClearance: 0.08 });
  await buildAsset(config);
  const verification = JSON.parse(await readFile(join(output, 'verification.json'), 'utf8'));
  expect(verification.enclosures.ok).toBe(true);
  expect(verification.enclosures.enclosures[0]).toMatchObject({ enclosure: 'bubble', parts: ['head'], ok: true });
}, 240000);
