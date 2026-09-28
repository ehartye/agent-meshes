import { describe, expect, it } from 'vitest';
import { checkGarments, garmentSummary } from '../src/garment-check.ts';
import { main } from '../src/cli.ts';
import { dressedGLB } from './helpers/garment-glb.ts';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('garment penetration check', () => {
  it('reports a leg punching through a belt only at the phases where it does', async () => {
    const report = await checkGarments(await dressedGLB(), { samples: 8 });
    expect(report.ok).toBe(false);
    expect(report.clips).toEqual(['jog']);
    const hits = report.intrusions.filter(hit => hit.part === 'layer-belt' && hit.into === 'layer-bottom');
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.every(hit => hit.kind === 'garment-garment' && hit.clip === 'jog')).toBe(true);
    // No rest-pose overlap is reported: the belt's embedded back face was inside the leg from the start.
    expect(report.intrusions.some(hit => hit.phase === 0)).toBe(false);
    const peak = hits.find(hit => hit.phase === 0.5)!;
    expect(peak.depth).toBeGreaterThan(0.01);
    expect(peak.vertices).toBeGreaterThan(0);
    expect(report.pairs.find(pair => pair.part === 'layer-belt' && pair.into === 'layer-bottom')?.phases).toContain(0.5);
  });

  it('passes when the garments stay clear, even when they overlap at rest', async () => {
    const report = await checkGarments(await dressedGLB({ flex: 4 }), { samples: 8 });
    expect(report.intrusions).toEqual([]);
    expect(report.ok).toBe(true);
    expect(report.parts.garments).toEqual(expect.arrayContaining(['layer-belt', 'layer-bottom']));
  });

  it('finds a garment folding through itself', async () => {
    const report = await checkGarments(await dressedGLB({ fold: true, belt: [1.5, 1.55] }), { samples: 8 });
    const self = report.intrusions.filter(hit => hit.kind === 'self');
    expect(self.map(hit => hit.part)).toContain('layer-apron');
    expect(self.every(hit => hit.part === hit.into)).toBe(true);
  });

  it('never reports folds in small pieces that only ride the bones', async () => {
    const report = await checkGarments(await dressedGLB({ beads: true, flex: 4 }), { samples: 8 });
    expect(report.intrusions.filter(hit => hit.part === 'boot-eyelets')).toEqual([]);
  });

  it('never treats an open surface as a container and can ignore parts', async () => {
    const report = await checkGarments(await dressedGLB({ sheet: true }), { samples: 4, ignore: /belt/ });
    expect(report.parts.open).toContain('hair-card');
    expect(report.parts.bodies).toContain('hair-card');
    expect(report.parts.garments).not.toContain('layer-belt');
    expect(report.intrusions.some(hit => hit.into === 'hair-card' || hit.part === 'layer-belt')).toBe(false);
  });

  it('fails two garments that already show through each other at rest', async () => {
    // A trouser leg wider than the boot shaft round it: its corners poke out through the shaft
    // wall while the shaft wall sinks under the leg's faces, the jagged crossing seen at a boot top.
    const report = await checkGarments(await dressedGLB({ flex: 4, shaft: 0.12 }), { samples: 4 });
    expect(report.ok).toBe(false);
    const hit = report.intrusions.find(hit => hit.kind === 'rest-crossing')!;
    expect(hit).toMatchObject({ part: 'layer-bottom', into: 'left-boot-shaft', clip: 'rest', phase: 0 });
    expect(hit.depth).toBeGreaterThan(0.01);
    expect(hit.vertices).toBeGreaterThan(0);
    expect(garmentSummary(report).join(' ')).toMatch(/layer-bottom and left-boot-shaft show through each other at rest/);
  });

  it('lets small trims interleave at rest: a crossing must bury a patch on both garments', async () => {
    const report = await checkGarments(await dressedGLB({ flex: 4, shaft: 0.12 }), { samples: 4, crossingVertices: 10000 });
    expect(report.intrusions.filter(hit => hit.kind === 'rest-crossing')).toEqual([]);
  });

  it('passes a leg tucked cleanly into a boot shaft, and a slab seated on the cloth under it', async () => {
    // The leg's end is buried in the shaft and the belt's back face in the leg: layered, not crossed.
    const report = await checkGarments(await dressedGLB({ flex: 4, shaft: 0.16 }), { samples: 4 });
    expect(report.intrusions).toEqual([]);
  });

  it('rejects unknown clips and bad options', async () => {
    const bytes = await dressedGLB();
    await expect(checkGarments(bytes, { clips: ['walk'] })).rejects.toThrow(/walk/);
    await expect(checkGarments(bytes, { samples: 0 })).rejects.toThrow(/samples/);
    await expect(checkGarments(bytes, { tolerance: -1 })).rejects.toThrow(/tolerance/);
    await expect(checkGarments(bytes, { crossingVertices: 0 })).rejects.toThrow(/crossingVertices/);
    await expect(checkGarments(bytes, { crossingDepth: Number.NaN })).rejects.toThrow(/crossingDepth/);
  });

  it('runs from the CLI and fails the exit code on intrusions', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'garments-'));
    const file = join(dir, 'figure.glb'); await writeFile(file, await dressedGLB());
    const out: string[] = [], err: string[] = [];
    const write = process.stdout.write, writeErr = process.stderr.write;
    process.stdout.write = ((chunk: string) => { out.push(String(chunk)); return true; }) as typeof process.stdout.write;
    process.stderr.write = ((chunk: string) => { err.push(String(chunk)); return true; }) as typeof process.stderr.write;
    try { await main(['node', 'cli', 'check-garments', file, '--samples', '8', '--json']); }
    finally { process.stdout.write = write; process.stderr.write = writeErr; }
    const report = JSON.parse(out.join(''));
    expect(report.format).toBe('agent-meshes/garment-check/1');
    expect(report.ok).toBe(false);
    expect(err.join('')).toMatch(/layer-belt into layer-bottom/);
    expect(process.exitCode).toBe(1);
    process.exitCode = 0;
  });
});
