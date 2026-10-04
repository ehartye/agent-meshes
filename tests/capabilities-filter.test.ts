import { describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolve } from 'node:path';
import { capabilities, capabilitiesFor, parseOperation } from '../src/agent-contract.ts';

const run = promisify(execFile);
const cli = (...args: string[]) => run(process.execPath, [resolve('scripts/agent-meshes.mjs'), ...args], { timeout: 30000, windowsHide: true });

describe('capabilities filter', () => {
  it('returns one geometry contract far smaller than the full dump', () => {
    const lathe = capabilitiesFor('lathe');
    expect(lathe.filter).toEqual({ name: 'lathe', kind: 'geometry' });
    const text = JSON.stringify(lathe);
    expect(text.length).toBeLessThan(JSON.stringify(capabilities()).length / 4);
    expect(text).toMatch(/r \* size\[0\]/);
    expect(text).toMatch(/bottom is at y = -size\[1\] \/ 2/);
    expect(text).toMatch(/radius 0 closes the cap/);
    for (const key of ['profileUnits', 'corners', 'angleRange', 'startAngle']) expect(text).toContain(key);
    expect(JSON.stringify(capabilitiesFor('prism'))).toMatch(/outlineUnits[\s\S]*bevel|bevel[\s\S]*outlineUnits/);
  });
  it('returns one operation contract and matches names case-insensitively', () => {
    const shell = capabilitiesFor('Shell.Set');
    expect(shell.filter).toEqual({ name: 'shell.set', kind: 'operation' });
    expect(Object.keys(shell)).not.toContain('operations');
  });
  it('lists the valid names for an unknown one with a stable code', () => {
    expect(() => capabilitiesFor('lathee')).toThrow(/Operations: .*add.*Geometries: box/);
    try { capabilitiesFor('lathee'); } catch (error) { expect((error as { code: string }).code).toBe('UNKNOWN_CAPABILITY'); }
  });
  it('publishes geometry guides in the full contract with valid examples', () => {
    const contract = capabilities();
    expect(Object.keys(contract.geometries)).toEqual(['box', 'sphere', 'cylinder', 'cone', 'capsule', 'group', 'lathe', 'prism']);
    for (const guide of Object.values(contract.geometries)) for (const example of guide.examples) expect(parseOperation(example)).toEqual(example);
  });
  it('is available as `capabilities <name>` on the command line', async () => {
    const lathe = JSON.parse((await cli('capabilities', 'lathe')).stdout);
    expect(lathe.filter.name).toBe('lathe');
    try { await cli('capabilities', 'nope'); throw new Error('expected failure'); }
    catch (error) { expect(JSON.parse((error as { stderr: string }).stderr).error.code).toBe('UNKNOWN_CAPABILITY'); }
  }, 60000);
});
