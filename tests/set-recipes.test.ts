import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
// @ts-expect-error plain ESM recipe helper without type declarations
import { inspectGLB } from '../recipes/lib/glb.mjs';

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'mesh-set-recipes-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

/** One-triangle-pair GLB: a unit quad on y = 0 (x, z in -0.5..0.5) placed by whatever node the caller describes. */
function glb(nodes: object[], materials: object[] = [{ name: 'Stone' }], extraAttributes: Record<string, number> = {}) {
  const positions = new Float32Array([-0.5, 0, -0.5, 0.5, 0, -0.5, 0.5, 0, 0.5, -0.5, 0, 0.5]);
  const indices = new Uint16Array([0, 1, 2, 0, 2, 3]);
  const bin = Buffer.concat([Buffer.from(positions.buffer), Buffer.from(indices.buffer)]);
  const json = {
    asset: { version: '2.0' }, scene: 0, scenes: [{ nodes: nodes.map((_, i) => i).filter(i => !(nodes[i] as { child?: boolean }).child) }],
    nodes: nodes.map(n => { const { child, ...rest } = n as { child?: boolean }; void child; return rest; }),
    meshes: [{ primitives: [{ attributes: { POSITION: 0, ...extraAttributes }, indices: 1, material: 0 }] }], materials,
    accessors: [{ bufferView: 0, componentType: 5126, count: 4, type: 'VEC3', min: [-0.5, 0, -0.5], max: [0.5, 0, 0.5] }, { bufferView: 1, componentType: 5123, count: 6, type: 'SCALAR' }],
    bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: 48 }, { buffer: 0, byteOffset: 48, byteLength: 12 }], buffers: [{ byteLength: bin.length }],
  };
  let js = Buffer.from(JSON.stringify(json)); while (js.length % 4) js = Buffer.concat([js, Buffer.from(' ')]);
  const header = Buffer.alloc(12); header.writeUInt32LE(0x46546c67, 0); header.writeUInt32LE(2, 4); header.writeUInt32LE(12 + 8 + js.length + 8 + bin.length, 8);
  const chunk = (type: number, body: Buffer) => { const h = Buffer.alloc(8); h.writeUInt32LE(body.length, 0); h.writeUInt32LE(type, 4); return Buffer.concat([h, body]); };
  return Buffer.concat([header, chunk(0x4e4f534a, js), chunk(0x004e4942, bin)]);
}
const write = (name: string, bytes: Buffer) => { const path = join(dir, name); writeFileSync(path, bytes); return path; };
const stats = (...args: string[]) => spawnSync(process.execPath, [resolve('recipes/set-stats.mjs'), ...args], { encoding: 'utf8' });

describe('recipes/lib/glb.mjs', () => {
  it('applies a matrix node to every vertex, which accessor min/max cannot show', () => {
    // scale x by 2, rotate nothing, lift by 1: a 2 x 1 quad floating at y = 1
    const file = write('lifted.glb', glb([{ mesh: 0, matrix: [2, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 1, 0, 1] }]));
    const info = inspectGLB(file);
    expect(info.triangles).toBe(2);
    expect(info.min).toEqual([-1, 1, -0.5]);
    expect(info.max).toEqual([1, 1, 0.5]);
    expect(info.nodes).toMatchObject({ total: 1, matrix: 1, meshes: 1 });
  });
  it('composes TRS parents with children and reports materials and attributes', () => {
    const bytes = glb([{ children: [1], translation: [0, 2, 0] }, { mesh: 0, child: true, rotation: [0.7071068, 0, 0, 0.7071068] }], [{ name: 'A' }, {}], {});
    const info = inspectGLB(write('tree.glb', bytes));
    expect(info.min[1]).toBeCloseTo(2 - 0.5, 5); // the quad stood up on a parent lifted by 2: y spans 1.5..2.5
    expect(info.max[1]).toBeCloseTo(2.5, 5);
    expect(info.materials).toEqual([{ index: 0, name: 'A', used: true }, { index: 1, name: null, used: false }]);
  });
});

describe('recipes/set-stats.mjs', () => {
  it('passes a grounded, centred, named, in-budget model', () => {
    const file = write('ok.glb', glb([{ mesh: 0 }]));
    const run = stats('--max-tris', '2', '--max-materials', '1', '--require-named-materials', '--expect-height', '0', file);
    expect(run.status, run.stdout + run.stderr).toBe(0);
    expect(run.stdout).toContain('tris=2/2');
  });
  it('flags budget, pivot, unnamed and unused materials, and exits 1', () => {
    const file = write('bad.glb', glb([{ mesh: 0, translation: [0.25, 0.4, 0] }], [{}, { name: 'Spare' }]));
    const run = stats('--max-tris', '1', '--max-materials', '1', '--require-named-materials', file);
    expect(run.status).toBe(1);
    for (const text of ['triangles 2 > budget 1', '2 materials > 1', 'unnamed material', 'lowest point y = 0.4000', 'base centre (0.2500,0.0000)', '1 material(s) no primitive uses']) expect(run.stdout).toContain(text);
  });
  it('lets a per-file budget override the default and prints JSON', () => {
    const file = write('knight.glb', glb([{ mesh: 0 }]));
    const run = stats('--max-tris', '1', '--budget', 'knight=10', '--json', file);
    expect(run.status).toBe(0);
    expect(JSON.parse(run.stdout)[0]).toMatchObject({ budget: 10, triangles: 2, ok: true });
  });
  it('exits 2 on a usage error', () => { expect(stats().status).toBe(2); expect(stats('--budget', 'nope', 'x.glb').status).toBe(2); });
});

// The sheet needs Chromium and a managed release; CI has neither, so this runs on a machine that has run mesh-setup.
const chess = join('C:/Users/ehart/repos/vr-chess/art/pieceset');
const releases = join(process.env.AGENT_MESHES_HOME ?? join(homedir(), '.agent-meshes'), 'releases');
const release = existsSync(releases) ? readdirSync(releases).filter(n => !n.startsWith('.')).sort().reverse().map(n => join(releases, n)).find(p => existsSync(join(p, 'managed-install.json'))) : undefined;
const pieces = ['white_pawn.glb', 'white_king.glb'].map(n => join(chess, n));
(release && pieces.every(existsSync) && !process.env.CI ? it : it.skip)('set-sheet.mjs renders a labelled sheet from one shared camera', () => {
  const out = join(dir, 'sheet.png');
  const json = execFileSync(process.execPath, [resolve('recipes/set-sheet.mjs'), '--runtime-root', release!, '--out', out, '--views', 'front,q34', '--crop-bottom', '0.5', '--cell-scale', '0.5', '--json', ...pieces], { encoding: 'utf8', timeout: 120000 });
  const report = JSON.parse(json);
  expect(existsSync(out)).toBe(true);
  expect(report.models).toEqual(['white_pawn', 'white_king']);
  expect(report.cameras.front.target).toEqual(report.cameras.q34.target); // one shared target, no per-model framing
}, 150000);
