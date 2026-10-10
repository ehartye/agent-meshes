import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { Mesh } from 'three';
import { ModelError } from '../src/errors.ts';
import { exportGLB } from '../src/export.ts';
import { readAccessor, readGLB } from '../src/gltf-read.ts';
import { buildScene, checkSockets, instantiate, seedParams, type Template } from '../src/runtime.ts';

const template = (): Template => ({
  version: 1, name: 'param-ship',
  params: {
    width: { default: 1, min: 0.5, max: 2 },
    length: { default: 3, min: 2, max: 5 },
    sweep: { default: 0.3, min: 0.1, max: 0.8 },
    hue: { default: 200, min: 0, max: 360 },
    ribs: { default: 12, min: 6, max: 24, integer: true },
  },
  parts: [
    { name: 'hull', geometry: { type: 'lathe', size: [1, 1, 1], segments: { $param: 'ribs' }, profile: [[0, 0], [{ $expr: 'width * 0.6' }, 0.4], [{ $expr: 'width * 0.4' }, { $param: 'length' }], [0, { $expr: 'length + 0.4' }]], profileUnits: 'metres' }, color: { $hsl: [{ $param: 'hue' }, 0.4, 0.5] } },
    { name: 'wing', geometry: { type: 'prism', size: [0.2, 1, 1.4], segments: 3, mirrorX: true, outline: [[0, 0], [{ $expr: 'width * 1.4' }, { $param: 'sweep' }], [0.3, 1]], outlineUnits: 'metres', axis: 'y' }, position: [{ $expr: 'width * 0.5' }, 0, 0.2] },
    { name: 'socket_engine', geometry: { type: 'group', size: [1, 1, 1], segments: 3 }, position: [0, 0, { $expr: '-length / 30' }] },
  ],
} as unknown as Template);

describe('instantiate', () => {
  it('uses defaults and substitutes inside lathe profiles, prism outlines, positions, segments and colour', () => {
    const p = instantiate(template());
    const hull = p.parts.find(x => x.name === 'hull')!, wing = p.parts.find(x => x.name === 'wing')!;
    expect(hull.geometry.profile![1][0]).toBeCloseTo(0.6);
    expect(hull.geometry.profile![3][1]).toBeCloseTo(3.4);
    expect(hull.geometry.segments).toBe(12);
    expect(hull.color).toMatch(/^#[0-9a-f]{6}$/);
    expect(wing.geometry.outline![1]).toEqual([1.4, 0.3]);
    expect(wing.position[0]).toBeCloseTo(0.5);
    expect(wing.geometry.mirrorX).toBe(true);
    expect('params' in p).toBe(false);
  });
  it('two parameter sets give different geometry', () => {
    const a = instantiate(template(), { width: 0.6 }), b = instantiate(template(), { width: 1.8 });
    expect(a.parts[0].geometry.profile).not.toEqual(b.parts[0].geometry.profile);
  });
  it('rejects out-of-range, unknown and non-finite values with helpful ModelErrors', () => {
    expect(() => instantiate(template(), { width: 5 })).toThrow(/Parameter "width" is 5, outside its range 0.5\.\.2/);
    expect(() => instantiate(template(), { nope: 1 })).toThrow(/Unknown parameter "nope".*Declared parameters: width/);
    expect(() => instantiate(template(), { width: NaN })).toThrow(ModelError);
    expect(() => instantiate(template(), { ribs: 7.5 })).toThrow(/integer/);
  });
  it('reports the field path of a bad reference or expression', () => {
    const t = template();
    (t.parts as any)[0].geometry.profile[1][0] = { $expr: 'width * depth' };
    expect(() => instantiate(t)).toThrow(/Unknown parameter "depth"/);
    try { instantiate(t); } catch (e) { expect((e as ModelError).path).toContain('parts[0].geometry.profile[1][0]'); }
  });
  it('evaluates a restricted grammar and refuses code', () => {
    const t = (expr: string) => { const x = template(); (x.parts as any)[2].position = [{ $expr: expr }, 0, 0]; return instantiate(x).parts[2].position[0]; };
    expect(t('2 + 3 * 4 - 6 / 2')).toBe(11);
    expect(t('-(width + 1) ^ 2')).toBe(-4);
    expect(t('clamp(width * 10, 0, 3) + max(1, 2) + mix(0, 10, 0.5)')).toBe(3 + 2 + 5);
    for (const bad of ['process.exit(1)', 'constructor', 'width.toString()', '(() => 1)()', '"a"', 'globalThis', '1 +', 'eval("1")', 'Function("return 1")()', '1 / 0', '__proto__', 'toString(1)']) {
      expect(() => t(bad), bad).toThrow(ModelError);
    }
    const source = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '../src/params.ts'), 'utf8');
    const code = source.split('\n').filter(l => !/^\s*(\*|\/\/|\/\*)/.test(l)).join('\n');
    expect(code).not.toMatch(/\beval\s*\(|new Function|\bFunction\s*\(/);
  });
});

describe('seedParams', () => {
  it('is deterministic, in range, and pinned to known values', () => {
    const a = seedParams(template(), 42), b = seedParams(template(), 42);
    expect(a).toEqual(b);
    for (const [k, v] of Object.entries(a)) { const s = template().params[k]; expect(v).toBeGreaterThanOrEqual(s.min); expect(v).toBeLessThanOrEqual(s.max); }
    expect(Number.isInteger(a.ribs)).toBe(true);
    expect(instantiate(template(), a).name).toBe('param-ship');
    // Golden value: a change here means ships generated from saved seeds changed.
    expect(seedParams({ version: 1, name: 'g', params: { x: { default: 0, min: 0, max: 1 } } } as Template, 1).x).toMatchInlineSnapshot(`0.44588707643561065`);
  });
  it('different seeds give different params and different geometry; adding a param leaves others unchanged', () => {
    const a = seedParams(template(), 1), b = seedParams(template(), 2);
    expect(a).not.toEqual(b);
    expect(instantiate(template(), a).parts[0].geometry.profile).not.toEqual(instantiate(template(), b).parts[0].geometry.profile);
    const more = template(); more.params.extra = { default: 0, min: 0, max: 1 };
    expect(seedParams(more, 1).width).toBe(a.width);
  });
  it('rejects non-integer seeds', () => { expect(() => seedParams(template(), 1.5)).toThrow(ModelError); });
});

describe('checkSockets', () => {
  const contract = { sockets: { engine: { name: 'socket_engine', position: [0, 0, -0.1] as [number, number, number] } }, envelopes: { hull: { min: [-3, -1, -3] as [number, number, number], max: [3, 5, 3] as [number, number, number], parts: ['hull'] } } };
  it('passes a fitting hull', () => { expect(checkSockets(instantiate(template()), contract)).toEqual([]); });
  it('reports offset, missing, non-empty sockets and envelope overruns', () => {
    const p = instantiate(template(), { length: 5 });
    const v = checkSockets(p, { sockets: { engine: contract.sockets.engine, cannon: { name: 'socket_cannon', position: [0, 0, 1] }, wing: { name: 'wing', position: [0, 0, 0] } }, envelopes: { hull: { min: [-3, -1, -3], max: [3, 4, 3], parts: ['hull'] }, none: { min: [0, 0, 0], max: [1, 1, 1], parts: ['socket_engine'] } } });
    expect(v.map(x => x.kind).sort()).toEqual(['envelope-empty', 'envelope-exceeded', 'missing-socket', 'socket-not-empty', 'socket-offset']);
    expect(v.find(x => x.kind === 'socket-offset')).toMatchObject({ socket: 'engine', tolerance: 0.001 });
  });
});

it('GLB export and buildScene agree on per-part vertex counts for an instantiated template', async () => {
  const project = instantiate(template(), seedParams(template(), 7));
  const scene = buildScene(project);
  try {
    const doc = readGLB(await exportGLB(project));
    for (const name of ['hull', 'wing']) {
      const node = doc.json.nodes!.find(n => n.name === name)!;
      expect(readAccessor(doc, doc.json.meshes![node.mesh!].primitives[0].attributes.POSITION).count, name).toBe((scene.objects.get(name) as Mesh).geometry.getAttribute('position').count);
    }
  } finally { scene.dispose(); }
});
