import { describe, expect, it, vi } from 'vitest';
import { BoxGeometry, Euler, Group, Matrix4, Mesh, MeshStandardMaterial, Quaternion, Vector3 } from 'three';
import { GLTFExporter } from 'three/addons/exporters/GLTFExporter.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { ensureFileReader } from '../src/node-file-reader.ts';
import { createAssembly, solveFrame } from '../src/render/assembly.ts';
import type { AssemblySpec } from '../src/render/assembly.ts';

const transform = (position = [0, 0, 0], rotation = [0, 0, 0], scale = [1, 1, 1]) =>
  new Matrix4().compose(new Vector3(...position), new Quaternion().setFromEuler(new Euler(...rotation as [number, number, number])), new Vector3(...scale)).toArray();
const identity = () => transform();
const move = (x: number) => transform([x, 0, 0]);
function fixture(): AssemblySpec {
  return {
    pieces: [
      { id: 'base', assembled: move(0), staged: move(0), explode: [0, 0, 0], fixed: true },
      { id: 'rail', assembled: move(1), staged: move(4), explode: [0, 1, 0] },
      { id: 'seat', assembled: move(2), staged: move(5), explode: [0, 2, 0] },
    ],
    joints: [
      { id: 'rail-to-base', child: 'rail', parent: 'base', childFrame: identity(), parentFrame: move(1) },
      { id: 'seat-to-rail', child: 'seat', parent: 'rail', childFrame: identity(), parentFrame: move(1) },
      { id: 'seat-second-contact', child: 'seat', parent: 'base', childFrame: move(.5), parentFrame: move(2.5) },
    ],
  };
}
const error = (a: readonly number[], b: readonly number[]) => Math.max(...a.map((x, i) => Math.abs(x - b[i])));

describe('named-frame assembly', () => {
  it('stages unconnected parts, requires every support, and makes every joint coincide', () => {
    const assembly = createAssembly(fixture());
    expect(assembly.snapshot().connected).toEqual(['base']);
    expect(assembly.snapshot().transforms.seat).toEqual(move(5));
    expect(assembly.snapshot().available).toEqual(['rail']);
    expect(assembly.snap('seat')).toEqual({ ok: false, reason: 'missing-pieces', pieces: ['rail'] });
    expect(assembly.snap('rail')).toEqual({ ok: true });
    expect(assembly.snap('seat')).toEqual({ ok: true });
    expect(assembly.snapshot().transforms.seat).toEqual(move(2));
    expect(assembly.anchors().every(anchor => anchor.joined && anchor.gap < 1e-12)).toBe(true);
    expect(assembly.snap('seat')).toEqual({ ok: true });
  });

  it('removes in dependency order and restores exact staged/assembled state after explode and reset', () => {
    const assembly = createAssembly(fixture()); assembly.snap('rail'); assembly.snap('seat');
    const connected = assembly.snapshot();
    expect(assembly.remove('base')).toEqual({ ok: false, reason: 'fixed-piece', pieces: ['base'] });
    expect(assembly.remove('rail')).toEqual({ ok: false, reason: 'dependent-pieces', pieces: ['seat'] });
    assembly.setExplode(1); expect(assembly.anchors()[0].gap).toBeCloseTo(1);
    expect(assembly.snap('seat')).toEqual({ ok: false, reason: 'exploded-view', pieces: [] });
    assembly.setExplode(0); expect(assembly.snapshot()).toEqual(connected);
    expect(assembly.remove('seat')).toEqual({ ok: true });
    expect(assembly.snapshot().transforms.seat).toEqual(move(5));
    expect(assembly.remove('rail')).toEqual({ ok: true });
    assembly.snap('rail'); assembly.setExplode(.4); assembly.reset();
    expect(assembly.snapshot()).toEqual(createAssembly(fixture()).snapshot());
  });

  it('owns immutable numeric state without borrowing mutable spec arrays', () => {
    const spec = structuredClone(fixture()), original = structuredClone(spec), assembly = createAssembly(spec);
    (spec.pieces[1].assembled as number[])[12] = 200;
    (spec.joints[0].parentFrame as number[])[12] = 200;
    assembly.snap('rail'); expect(assembly.snapshot().transforms.rail[12]).toBe(1);
    const snapshot = assembly.snapshot(), anchors = assembly.anchors();
    expect(Object.isFrozen(snapshot)).toBe(true); expect(Object.isFrozen(snapshot.transforms)).toBe(true);
    expect(Object.isFrozen(snapshot.transforms.rail)).toBe(true); expect(Object.isFrozen(snapshot.missing.seat)).toBe(true);
    expect(Object.isFrozen(anchors[0].source)).toBe(true);
    expect(() => (snapshot.connected as string[]).push('fake')).toThrow();
    const second = createAssembly(original); second.snap('rail');
    expect(second.snapshot()).toEqual(snapshot);
    assembly.dispose(); assembly.dispose();
    for (const action of [() => assembly.snapshot(), () => assembly.anchors(), () => assembly.snap('rail'), () => assembly.remove('rail'), () => assembly.reset(), () => assembly.setExplode(0)]) expect(action).toThrow(/disposed/);
    expect(second.snapshot()).toEqual(snapshot);
  });

  it('rejects invalid controls and contradictory secondary contacts without partial mutation', () => {
    const assembly = createAssembly(fixture()); assembly.snap('rail'); const before = assembly.snapshot();
    for (const value of [NaN, Infinity, -1, 1.001]) expect(() => assembly.setExplode(value)).toThrow();
    for (const action of [() => assembly.snap('absent'), () => assembly.remove('absent')]) expect(action).toThrow(/Unknown piece/);
    expect(assembly.snapshot()).toEqual(before);
    // Both contacts are within the documented authored tolerance of rest, but disagree
    // with each other by more than that tolerance once the first one is solved.
    const spec = fixture();
    (spec.joints as Array<AssemblySpec['joints'][number]>).push({ id: 'competing', child: 'rail', parent: 'base', childFrame: identity(), parentFrame: move(1 - 7e-8) });
    (spec.joints[0].parentFrame as number[])[12] += 7e-8;
    const contradictory = createAssembly(spec), last = contradictory.snapshot();
    expect(() => contradictory.snap('rail')).toThrow(/Mating frames disagree/);
    expect(contradictory.snapshot()).toEqual(last);
  });

  it('rejects missing, duplicate, disconnected and cyclic graphs before creating a controller', () => {
    const cases: Array<(s: AssemblySpec) => void> = [
      s => { (s.pieces as unknown[]).push(s.pieces[0]); },
      s => { (s.joints as unknown[]).push(s.joints[0]); },
      s => { (s.joints[0] as { parent: string }).parent = 'missing'; },
      s => { (s.joints[0] as { parent: string }).parent = 'rail'; },
      s => { (s.joints as unknown[]).splice(0, 1); },
      s => { (s.joints as unknown[]).push({ id: 'cycle', child: 'rail', parent: 'seat', childFrame: identity(), parentFrame: move(-1) }); },
      s => { (s.joints as unknown[]).push({ id: 'fixed-child', child: 'base', parent: 'seat', childFrame: identity(), parentFrame: move(-2) }); },
    ];
    for (const change of cases) { const spec = fixture(); change(spec); expect(() => createAssembly(spec)).toThrow(); }
    const inconsistent = fixture(); (inconsistent.joints[2].parentFrame as number[])[12] += .02;
    expect(() => createAssembly(inconsistent)).toThrow(/coincide/);
  });

  it('bounds graph work even for dense acyclic inputs and rejects count limits', () => {
    const pieces = Array.from({ length: 30 }, (_, i) => ({ id: `p${i}`, assembled: move(i), staged: move(i + 50), explode: [0, 0, 0] as const, fixed: i === 0 }));
    const joints = pieces.flatMap((p, i) => pieces.slice(0, i).map((parent, j) => ({ id: `${i}-${j}`, child: p.id, parent: parent.id, childFrame: identity(), parentFrame: move(i - j) })));
    const assembly = createAssembly({ pieces, joints });
    for (const piece of pieces) expect(assembly.snap(piece.id).ok).toBe(true);
    expect(assembly.anchors()).toHaveLength(435);
    expect(() => createAssembly({ pieces: Array(129).fill(pieces[0]), joints: [] })).toThrow(/128/);
    expect(() => createAssembly({ pieces, joints: Array(513).fill(joints[0]) })).toThrow(/512/);
  });

  it('preserves reflected and sheared authored matrices instead of decomposing them', () => {
    const world = new Matrix4().fromArray(transform([3, -2, 1], [.3, .2, .1], [-2, .7, 3]))
      .multiply(new Matrix4().fromArray(transform([0, 0, 0], [.2, .8, .3])));
    const spec = fixture();
    for (const piece of spec.pieces) (piece as unknown as { assembled: number[] }).assembled = world.clone().multiply(new Matrix4().fromArray(piece.assembled)).toArray();
    const assembly = createAssembly(spec); assembly.snap('rail'); assembly.snap('seat');
    expect(error(assembly.snapshot().transforms.seat, spec.pieces[2].assembled)).toBeLessThan(1e-12);
    expect(new Matrix4().fromArray(assembly.snapshot().transforms.seat).determinant()).toBeLessThan(0);
    expect(assembly.anchors().every(a => a.gap < 1e-12)).toBe(true);
  });
});

describe('full affine frame solving', () => {
  it('aligns complete local frames under independently transformed parents', () => {
    const source = transform([.2, .3, -.4], [.1, .4, .2], [2, 1, .7]);
    const target = transform([4, -1, 2], [.5, -.2, .9], [-2, 3, 1]);
    const parent = new Matrix4().fromArray(transform([2, 8, 1], [.1, .6, .2], [2, 1, 3]))
      .multiply(new Matrix4().fromArray(transform([0, 0, 0], [.4, .2, .1]))).toArray();
    const local = solveFrame(source, target, parent);
    const actual = new Matrix4().fromArray(parent).multiply(new Matrix4().fromArray(local)).multiply(new Matrix4().fromArray(source));
    expect(error(actual.elements, target)).toBeLessThan(1e-12);
    expect(Object.isFrozen(local)).toBe(true);
  });

  it('rejects sparse, nonfinite, perspective, singular, ill-conditioned and excessive matrices', () => {
    const invalid = [Array(16), identity().slice(1), transform([Infinity, 0, 0]), transform([0, 0, 0], [0, 0, 0], [0, 1, 1]), transform([0, 0, 0], [0, 0, 0], [1e-12, 1, 1]), transform([1e12, 0, 0])];
    const perspective = identity(); perspective[3] = .1; invalid.push(perspective);
    for (const value of invalid) {
      expect(() => solveFrame(value, identity())).toThrow();
      expect(() => solveFrame(identity(), value)).toThrow();
      expect(() => solveFrame(identity(), identity(), value)).toThrow();
    }
    const small = transform([0, 0, 0], [0, 0, 0], [1e-6, 1e-6, 1e-6]);
    expect(error(solveFrame(small, small), identity())).toBeLessThan(1e-12);
    expect(() => solveFrame(transform([0, 0, 0], [0, 0, 0], [1e-8, 1e-8, 1e-8]), transform([0, 0, 0], [0, 0, 0], [1e4, 1e4, 1e4]))).toThrow(/numerical|range/i);
  });

  it('rejects sparse explode vectors before reading or changing state', () => {
    const spec = fixture(); (spec.pieces[1] as unknown as { explode: number[] }).explode = [0, , 0] as number[];
    expect(() => createAssembly(spec)).toThrow(/finite/);
  });

  it('rejects inversion overflow even when the determinant is finite and nonzero', () => {
    const underflow = transform([0, 0, 0], [0, 0, 0], [1, 1e-160, 1e-160]);
    expect(new Matrix4().fromArray(underflow).determinant()).not.toBe(0);
    expect(() => createAssembly({ pieces: [{ id: 'base', assembled: underflow, staged: underflow, explode: [0, 0, 0], fixed: true }], joints: [] })).toThrow(/numerical/);
  });

  it('uses safe named records for names also present on Object.prototype', () => {
    const assembly = createAssembly({ pieces: [{ id: '__proto__', assembled: identity(), staged: identity(), explode: [0, 0, 0], fixed: true }], joints: [] });
    expect(assembly.snapshot().transforms.__proto__).toEqual(identity());
    expect(Object.getPrototypeOf(assembly.snapshot().transforms)).toBeNull();
  });
});

it('retains named mating anchors through actual GLB export/load, including parent-induced shear', async () => {
  ensureFileReader();
  const root = new Group(), carrier = new Group(); root.scale.set(-2, .7, 3); root.rotation.y = .3; carrier.rotation.set(.2, .5, .1); root.add(carrier);
  for (const [id, x] of [['base', 0], ['rail', 1]] as const) {
    const node = new Group(); node.name = id; node.position.x = x; carrier.add(node);
    const mesh = new Mesh(new BoxGeometry(.2, .2, .2), new MeshStandardMaterial()); node.add(mesh);
    const anchor = new Group(); anchor.name = `${id}-joint`; anchor.position.x = id === 'base' ? 1 : 0; node.add(anchor);
  }
  root.updateMatrixWorld(true);
  const bytes = await new GLTFExporter().parseAsync(root, { binary: true }) as ArrayBuffer;
  const loaded = await new GLTFLoader().parseAsync(bytes, ''); loaded.scene.updateMatrixWorld(true);
  const base = loaded.scene.getObjectByName('base')!, rail = loaded.scene.getObjectByName('rail')!;
  const originalRail = rail.matrixWorld.toArray(), mesh = rail.children.find(node => node instanceof Mesh) as Mesh;
  const geometryDispose = vi.spyOn(mesh.geometry, 'dispose'), materialDispose = vi.spyOn(mesh.material as MeshStandardMaterial, 'dispose');
  const assembled = createAssembly({
    pieces: [base, rail].map((node, i) => ({ id: node.name, assembled: node.matrixWorld.toArray(), staged: move(i + 4), explode: [0, i, 0], fixed: i === 0 })),
    joints: [{ id: 'loaded-joint', child: 'rail', parent: 'base', childFrame: loaded.scene.getObjectByName('rail-joint')!.matrix.toArray(), parentFrame: loaded.scene.getObjectByName('base-joint')!.matrix.toArray() }],
  });
  assembled.snap('rail'); expect(error(assembled.snapshot().transforms.rail, rail.matrixWorld.elements)).toBeLessThan(1e-7);
  expect(assembled.anchors()[0].gap).toBeLessThan(1e-7);
  assembled.dispose(); expect(rail.matrixWorld.toArray()).toEqual(originalRail);
  expect(geometryDispose).not.toHaveBeenCalled(); expect(materialDispose).not.toHaveBeenCalled();
});
