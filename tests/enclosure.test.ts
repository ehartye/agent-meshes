import { describe, expect, it } from 'vitest';
import { verifyEnclosures } from '../src/enclosure.ts';
import { helmetGLB } from './helpers/enclosure-glb.ts';

describe('enclosure verifier (a glass helmet holds its head at every pose)', () => {
  it('passes a head well inside its bubble and reports the closest approach', async () => {
    const report = await verifyEnclosures(await helmetGLB());
    expect(report.ok).toBe(true);
    expect(report.failures).toEqual([]);
    expect(report.enclosures).toHaveLength(1);
    const [bubble] = report.enclosures;
    expect(bubble.enclosure).toBe('bubble');
    expect(bubble.parts).toEqual(['head']);
    expect(bubble.closest.clearance).toBeGreaterThan(0.095);
    expect(bubble.closest.clearance).toBeLessThan(0.1);
    expect(bubble.closest.part).toBe('head');
    expect(bubble.closest.pose).toBe('rest');
  });

  it('files without a declaration have nothing to check', async () => {
    const report = await verifyEnclosures(await helmetGLB({ encloses: null }));
    expect(report).toEqual({ ok: true, enclosures: [], failures: [] });
  });

  it('fails a head within the clearance of the glass', async () => {
    const report = await verifyEnclosures(await helmetGLB({ head: 0.19 }));
    expect(report.ok).toBe(false);
    expect(report.failures.join('\n')).toMatch(/bubble: head comes within [0-9.]+ mm of the glass at rest \(needs 15 mm\)/);
  });

  it('fails an ear that pokes out through the glass, naming the part', async () => {
    const report = await verifyEnclosures(await helmetGLB({ extras: [{ name: 'left-ear', radius: 0.02, at: [0.19, 0, 0] }] }));
    expect(report.ok).toBe(false);
    expect(report.enclosures[0].closest.part).toBe('left-ear');
    expect(report.enclosures[0].closest.clearance).toBeLessThan(0);
    expect(report.failures.join('\n')).toMatch(/left-ear pokes [0-9.]+ mm outside the glass at rest/);
  });

  it('samples every clip: a head that only leaves the bubble mid-clip fails at that phase', async () => {
    const report = await verifyEnclosures(await helmetGLB({ clipOffset: [0.09, 0, 0] }));
    expect(report.ok).toBe(false);
    const { closest } = report.enclosures[0];
    expect(closest.pose).toMatch(/^clip bob @ 0\.[45]\d* s$/);
    expect(report.enclosures[0].poses).toBeGreaterThan(10);
  });

  it('a clip that stays clear passes', async () => {
    const report = await verifyEnclosures(await helmetGLB({ clipOffset: [0.03, 0, 0] }));
    expect(report.ok).toBe(true);
    expect(report.enclosures[0].closest.clearance).toBeLessThan(0.075);
  });

  it('samples every morph target at full weight', async () => {
    const report = await verifyEnclosures(await helmetGLB({ swell: 1.95 }));
    expect(report.ok).toBe(false);
    expect(report.enclosures[0].closest.pose).toBe('morph swell = 1');
  });

  it('checks a maximum clearance, so a helmet cannot be far bigger than its head', async () => {
    const loose = await verifyEnclosures(await helmetGLB({ encloses: { parts: ['head'], clearance: 0.015, maxClearance: 0.04 } }));
    expect(loose.ok).toBe(false);
    expect(loose.failures.join('\n')).toMatch(/bubble: the closest part is [0-9.]+ mm from the glass \(at most 40 mm\): the enclosure is larger than what it holds/);
    const fitted = await verifyEnclosures(await helmetGLB({ head: 0.17, encloses: { parts: ['head'], clearance: 0.015, maxClearance: 0.04 } }));
    expect(fitted.ok).toBe(true);
  });

  it('fails a declaration that names a part the file lacks, or is malformed', async () => {
    const missing = await verifyEnclosures(await helmetGLB({ encloses: { parts: ['head', 'tied-hair'], clearance: 0.015 } }));
    expect(missing.ok).toBe(false);
    expect(missing.failures.join('\n')).toMatch(/bubble: encloses tied-hair, which the file lacks as a mesh/);
    const malformed = await verifyEnclosures(await helmetGLB({ encloses: { parts: [], clearance: -1 } }));
    expect(malformed.ok).toBe(false);
    expect(malformed.failures.join('\n')).toMatch(/bubble: extras\.encloses/);
  });
});

describe('verify CLI', () => {
  it('reports enclosures and fails a helmet whose ear pokes through', async () => {
    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const { mkdtemp, rm, writeFile } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join, resolve } = await import('node:path');
    const directory = await mkdtemp(join(tmpdir(), 'mesh-enclosure-'));
    try {
      const cli = (file: string) => promisify(execFile)(process.execPath, [resolve('scripts/agent-meshes.mjs'), 'verify', file], { timeout: 20000, windowsHide: true });
      const good = join(directory, 'good.glb'), bad = join(directory, 'bad.glb');
      await writeFile(good, await helmetGLB());
      await writeFile(bad, await helmetGLB({ extras: [{ name: 'left-ear', radius: 0.02, at: [0.19, 0, 0] }] }));
      const passed = JSON.parse((await cli(good)).stdout);
      expect(passed.ok).toBe(true);
      expect(passed.enclosures.enclosures[0].enclosure).toBe('bubble');
      await expect(cli(bad)).rejects.toMatchObject({ code: 1, stderr: expect.stringContaining('FAIL bubble: left-ear pokes') });
    } finally { await rm(directory, { recursive: true, force: true }); }
  }, 30000);
});
