import { afterEach, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import RAPIER from '@dimforge/rapier3d-compat';
import { createHangingMobile, validateMobileSpec } from '../src/physics/mobile.ts';

// Keep the real WASM engine; a mutable facade permits observing constructor calls.
vi.mock('@dimforge/rapier3d-compat', async () => {
  const actual = await vi.importActual<typeof import('@dimforge/rapier3d-compat')>('@dimforge/rapier3d-compat');
  return { ...actual, default: { ...actual.default } };
});

const fixture = () => JSON.parse(readFileSync(new URL('./fixtures/hanging-mobile.json', import.meta.url), 'utf8'));
const massReference = JSON.parse(readFileSync(new URL('./fixtures/hanging-mobile-mass.json', import.meta.url), 'utf8'));
const cleanup: (() => void)[] = [];
afterEach(() => { for (const close of cleanup.splice(0)) close(); vi.restoreAllMocks(); });
async function mobile(input = fixture()) { const result = await createHangingMobile(input); cleanup.push(() => result.dispose()); return result; }
const run = (m: Awaited<ReturnType<typeof createHangingMobile>>, count: number) => { for (let i = 0; i < count; i++) m.advance(1 / 120); };
const named = (m: Awaited<ReturnType<typeof createHangingMobile>>, name: string) => m.snapshot().nodes.find((n: {name: string}) => n.name === name)!;
const roll = (m: Awaited<ReturnType<typeof createHangingMobile>>, name: string) => { const q = named(m, name).rotation; return 2 * Math.atan2(q[2], q[3]); };

it('validates and detaches the sampled tree without allocating an engine world', async () => {
  const allocate = vi.spyOn(RAPIER, 'World');
  const original = fixture(), validated = validateMobileSpec(original);
  expect(validated.nodes).toHaveLength(13); expect(Object.isFrozen(validated.nodes[0].wires[0].points[0])).toBe(true);
  original.nodes[0].wires[0].points[0][0] = 999; expect(validated.nodes[0].wires[0].points[0][0]).not.toBe(999);
  const cases: ((s: ReturnType<typeof fixture>) => void)[] = [
    s => s.nodes[0].name = s.nodes[1].name,
    s => s.nodes[0].suspension.parent = 'missing',
    s => { s.nodes[0].suspension.parent = s.nodes[1].name; s.nodes[1].suspension.parent = s.nodes[0].name; },
    s => s.nodes[0].suspension.parent = null,
    s => s.nodes[0].wires[0].points[0][0] = NaN,
    s => s.nodes[0].wires[0].radius = 0,
    s => s.nodes[0].wires[0].points[1] = s.nodes[0].wires[0].points[0],
    s => s.nodes[0].leaf.thickness = 0,
    s => s.nodes[0].leaf.contour = [[0, 0], [1, 0], [.2, .2], [1, 1], [0, 1]],
    s => s.nodes[0].leaf.contour = [[0, 0], [1, 1], [0, 1], [1, 0]],
    s => s.nodes = Array(33).fill(s.nodes[0]),
    s => s.nodes[0].wires[0].points = Array(129).fill([0, 0, 0]),
    s => { for (const n of s.nodes.slice(0, 3)) n.wires = Array.from({ length: 8 }, () => ({ points: Array.from({ length: 128 }, (_, i) => [i / 128, 0, 0]), radius: .001, density: 1000 })); },
    s => s.nodes[0].leaf.scaleRange = [2, 1],
    s => s.nodes.find((n: {name: string}) => n.name === 'top').hanger.wire = 99,
  ];
  for (const change of cases) { const s = fixture(); change(s); expect(() => validateMobileSpec(s)).toThrow(); await expect(createHangingMobile(s)).rejects.toThrow(); }
  expect(allocate).not.toHaveBeenCalled();
});

it('retains the proven wire/leaf mass, center of mass and inertia without exposing mutable engine objects', async () => {
  const m = await mobile(), snapshot = m.snapshot();
  expect(snapshot.counts).toEqual({ bodies: 14, colliders: 511, joints: 13 });
  for (const node of snapshot.nodes) {
    const reference = massReference[node.name]; expect(node.mass).toBeCloseTo(reference.mass, 5);
    for (const [i, key] of ['x', 'y', 'z'].entries()) { expect(node.centerOfMass[i]).toBeCloseTo(reference.com[key], 5); expect(node.principalInertia[i]).toBeCloseTo(reference.inertia[key], 5); }
    const alignment = node.inertiaRotation.reduce((sum: number, n: number, i: number) => sum + n * reference.inertiaRotation[['x', 'y', 'z', 'w'][i]], 0);
    expect(Math.abs(alignment)).toBeCloseTo(1, 5); expect(Object.isFrozen(node.position)).toBe(true);
  }
  expect('world' in m).toBe(false); expect(snapshot.maxJointGap).toBeLessThan(1e-6);
});

it('couples growing sheet mass through its parent and ancestor, then responds to a real hanger change and gust', async () => {
  const m = await mobile(); run(m, 1800); const before = { left: roll(m, 'left'), top: roll(m, 'top'), mass: named(m, 'leaf0').leafMass };
  m.setLeafScale('leaf0', 1.65); run(m, 2400);
  expect(roll(m, 'left')).toBeGreaterThan(before.left + .04); expect(roll(m, 'top')).toBeGreaterThan(before.top + .04);
  expect(named(m, 'leaf0').leafMass / before.mass).toBeCloseTo(1.65 ** 2, 5);
  const heavy = roll(m, 'top'); m.setHanger('top', 0); const anchor = m.snapshot().joints.find((j: {name: string}) => j.name === 'top')!.childLocal;
  m.advance(1 / 120); const movedAnchor = m.snapshot().joints.find((j: {name: string}) => j.name === 'top')!.childLocal;
  expect(Math.hypot(...movedAnchor.map((v: number, i: number) => v - anchor[i]))).toBeLessThanOrEqual(.00800001);
  run(m, 2400); expect(Math.abs(roll(m, 'top') - heavy)).toBeGreaterThan(.08); expect(m.snapshot().maxJointGap).toBeLessThan(.004);
  const top = named(m, 'top'), joint = m.snapshot().joints.find((j: {name: string}) => j.name === 'top')!;
  expect(Math.hypot(...top.wires[1].points.at(-1)!.map((v, i) => v - joint.childLocal[i]))).toBeLessThan(1e-12);
  m.applyGust({ direction: [0, 0, 1], strength: .7 }); run(m, 30);
  expect(m.snapshot().nodes.some(n => Math.hypot(...n.angularVelocity) > .03)).toBe(true);
  run(m, 4800); expect(m.snapshot().nodes.every(n => Math.hypot(...n.angularVelocity) < .025)).toBe(true);
});

it('rejects invalid controls atomically and bounds elapsed work, including pause accumulation', async () => {
  const m = await mobile(), before = m.snapshot();
  const bad = [() => m.setLeafScale('missing', 1), () => m.setLeafScale('leaf0', NaN), () => m.setLeafScale('leaf0', 2), () => m.setHanger('top', -1), () => m.setHanger('left', .5), () => m.applyGust({ direction: [0, 0, 0], strength: 1 }), () => m.applyGust({ direction: [0, 0, 1], strength: NaN }), () => m.advance(-1), () => m.advance(Infinity)];
  for (const action of bad) expect(action).toThrow(); expect(m.snapshot()).toEqual(before);
  expect(m.advance(1000)).toBe(8); expect(m.advance(0)).toBe(0);
  m.advance(1 / 240); m.clearAccumulator(); expect(m.advance(1 / 240)).toBe(0); expect(m.advance(1 / 240)).toBe(1);
});

it('reconstructs deterministic solver state on reset, frees replaced worlds, and disposes idempotently', async () => {
  const free = vi.spyOn(RAPIER.World.prototype, 'free'), input = fixture(), m = await mobile(input);
  run(m, 1800); const settled = m.snapshot(); m.setLeafScale('leaf0', 1.65); m.setHanger('top', 1); m.applyGust({ direction: [1, 0, 1], strength: 1 }); run(m, 300);
  input.nodes[0].wires[0].points[0][0] = 999; m.reset(); run(m, 1800); expect(m.snapshot()).toEqual(settled);
  for (let i = 0; i < 10; i++) { m.reset(); expect(m.snapshot().counts).toEqual(settled.counts); }
  expect(free).toHaveBeenCalledTimes(11); m.dispose(); m.dispose(); expect(free).toHaveBeenCalledTimes(12);
  for (const action of [() => m.reset(), () => m.snapshot(), () => m.advance(0), () => m.clearAccumulator(), () => m.setLeafScale('leaf0', 1), () => m.setHanger('top', 0), () => m.applyGust({ direction: [0, 0, 1], strength: 1 })]) expect(action).toThrow(/disposed/);
});

it('collides thin sheet leaves instead of letting a gust push the lighter rear leaf through the heavier front leaf', async () => {
  const wire = (points: number[][], radius = .002) => ({ points, radius, density: 7850 });
  const m = await mobile({ nodes: [
    { name: 'bar', wires: [wire([[-.3, 0, 0], [.3, 0, 0]], .01)], suspension: { parent: null, parentAnchor: [0, 3, 0], anchor: [0, .5, 0] } },
    ...[-.015, .015].map((z, i) => ({ name: i ? 'front' : 'rear', wires: [wire([[0, 0, 0], [0, .5, 0]])], leaf: { contour: [[-.3, 0], [.3, 0], [.3, -.6], [-.3, -.6]], thickness: .0014, density: i ? 5400 : 2700 }, suspension: { parent: 'bar', parentAnchor: [0, 0, z], anchor: [0, .5, 0] } })),
  ] });
  m.applyGust({ direction: [0, 0, 1], strength: 2 }); let minimum = Infinity;
  for (let i = 0; i < 240; i++) { m.advance(1 / 120); minimum = Math.min(minimum, named(m, 'front').position[2] - named(m, 'rear').position[2]); }
  expect(minimum).toBeGreaterThan(0); // Counterfactual with leaf collisions disabled crosses by 9.96 mm.
});

it('frees a partially constructed replacement and preserves the current world when reset fails', async () => {
  const m = await mobile(); run(m, 120); const before = m.snapshot();
  const free = vi.spyOn(RAPIER.World.prototype, 'free');
  vi.spyOn(RAPIER.World.prototype, 'createCollider').mockImplementationOnce(() => { throw new Error('Injected allocation failure'); });
  expect(() => m.reset()).toThrow('Injected allocation failure'); expect(free).toHaveBeenCalledTimes(1); expect(m.snapshot()).toEqual(before);
  m.advance(1 / 120); expect(m.snapshot().maxJointGap).toBeLessThan(.004);
});
