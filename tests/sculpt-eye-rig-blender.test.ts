import { expect, it } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { authorGLB } from '../src/author.ts';
import { findBlender } from '../src/refine.ts';
import { verifyFaceContract } from '../src/face-contract.ts';
import { readGLB, readAccessor } from '../src/gltf-read.ts';

(findBlender() ? it : it.skip)('exports explicit partial gaze limits and preserves unrelated author extras', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mesh-partial-gaze-'));
  try {
    const output = join(dir, 'partial.glb');
    await authorGLB(resolve('tests/blender_partial_gaze_fixture.py'), output);
    const { json } = readGLB(await readFile(output));
    const declaration = json.nodes!.find(node => (node.extras as Record<string, unknown> | undefined)?.eyeGaze)?.extras;
    expect(declaration).toMatchObject({ artist: { name: 'unchanged' }, eyeGaze: {
      contract: 'eye-gaze/1', forward: '+Z', gaze: { yawMax: 14, pitchMax: 9 },
    } });
    expect(declaration).not.toHaveProperty('arkitFace');
  } finally { await rm(dir, { recursive: true, force: true }); }
}, 120_000);

(findBlender() ? it : it.skip)('rigs embedded sculpt eyes and decorations while preserving the body and its animation', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mesh-sculpt-eyes-'));
  try {
    const output = join(dir, 'eyes.glb');
    await authorGLB(resolve('tests/blender_sculpt_eye_rig_fixture.py'), output);
    const bytes = await readFile(output), doc = readGLB(bytes);
    const report = await verifyFaceContract(bytes);
    for (const id of ['validator', 'skeleton', 'skinning', 'eyes', 'head-binding']) expect(report.checks.find(c => c.id === id), id).toMatchObject({ ok: true });
    expect(report.ok).toBe(false); // This fixture deliberately has no complete expression set or mouth.
    const animations = (doc.json as typeof doc.json & { animations: {
      channels: { target: { node: number; path: string }; sampler: number }[];
      samplers: { output: number }[];
    }[] }).animations;
    expect(animations.length).toBeGreaterThan(0);
    const head = doc.json.nodes!.findIndex(n => n.name === 'head');
    const rotations = animations.flatMap(a => a.channels.filter(c => c.target.node === head && c.target.path === 'rotation').map(c => readAccessor(doc, a.samplers[c.sampler].output).data));
    expect(rotations.some(values => values.some((v, i) => i % 4 !== 3 && Math.abs(v) > 0.05))).toBe(true);
    expect(report.measurements.eyes.L!.center[0]).toBeCloseTo(.05, 5);
    expect(report.measurements.eyes.R!.center[0]).toBeCloseTo(-.05, 5);
    const eyes = doc.json.materials!.filter(m => m.name?.includes('override-red-eye-'));
    expect(eyes).toHaveLength(2);
    for (const eye of eyes) expect(eye.pbrMetallicRoughness?.baseColorFactor).toEqual([1, 0, 0, 1]);
  } finally { await rm(dir, { recursive: true, force: true }); }
}, 120_000);
