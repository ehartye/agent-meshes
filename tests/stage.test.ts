import { describe, expect, it } from 'vitest';
import { BufferGeometry, Float32BufferAttribute, Group, Mesh, MeshStandardMaterial, Vector3 } from 'three';
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { applyOperation, createProject } from '../src/core/model.ts';
import { exportGLB } from '../src/export.ts';
import { ensureFileReader } from '../src/node-file-reader.ts';
import { createStageScene, fitBoxDistance, parseModelName, parsePlacement } from '../src/render/stage.ts';

function project() {
  let p = createProject('leg');
  p = applyOperation(p, { op: 'bone.add', bone: { name: 'hip', position: [0, 1, 0] } });
  p = applyOperation(p, { op: 'bone.add', bone: { name: 'knee', parent: 'hip', position: [0, -0.5, 0] } });
  p = applyOperation(p, { op: 'add', part: { name: 'thigh', geometry: { type: 'box', size: [0.2, 0.5, 0.2] }, position: [0, 0.75, 0], color: '#3366cc', binding: { type: 'rigid', bone: 'hip' } } });
  p = applyOperation(p, { op: 'add', part: { name: 'shin', geometry: { type: 'box', size: [0.2, 0.5, 0.2] }, position: [0, 0.25, 0], color: '#3366cc', binding: { type: 'rigid', bone: 'knee' } } });
  return p;
}
let bytes: Uint8Array | null = null;
async function leg() {
  bytes ??= await exportGLB(project());
  return new GLTFLoader().parseAsync(bytes.slice().buffer, '');
}
async function face() {
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new Float32BufferAttribute([0, 0, 0, 1, 0, 0, 0, 1, 0], 3));
  geometry.setAttribute('normal', new Float32BufferAttribute([0, 0, 1, 0, 0, 1, 0, 0, 1], 3));
  const open = new Float32BufferAttribute([0, 0, 0, 0, 0, 0, 0, -2, 0], 3); open.name = 'jawOpen';
  geometry.morphAttributes.position = [open]; geometry.morphTargetsRelative = true;
  const jaw = new Mesh(geometry, new MeshStandardMaterial({ name: 'teeth' })); jaw.name = 'jaw';
  const root = new Group(); root.add(jaw);
  ensureFileReader();
  const glb = await new GLTFExporter().parseAsync(root, { binary: true }) as ArrayBuffer;
  return new GLTFLoader().parseAsync(glb, '');
}
const round = (values: readonly number[]) => values.map(v => Math.round(v * 1000) / 1000 || 0);

describe('stage inputs', () => {
  it('accepts short model names and rejects everything else with the rule', () => {
    expect(parseModelName('pip')).toBe('pip');
    expect(parseModelName('Moss_jaw-2')).toBe('Moss_jaw-2');
    for (const bad of ['', '2pip', 'a b', 'x'.repeat(65), 'pip/left', 42, null]) expect(() => parseModelName(bad)).toThrow(/Model name must/);
  });

  it('parses placements with defaults, uniform scale and clear errors', () => {
    expect(parsePlacement(undefined)).toEqual({ position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] });
    expect(parsePlacement({ position: [1, 2, 3], rotation: [0, 90, 0], scale: 2 })).toEqual({ position: [1, 2, 3], rotation: [0, 90, 0], scale: [2, 2, 2] });
    expect(parsePlacement({ scale: [1, 2, 3] }).scale).toEqual([1, 2, 3]);
    expect(() => parsePlacement({ position: [0, Number.NaN, 0] })).toThrow(/position must be three finite numbers/);
    expect(() => parsePlacement({ rotation: [0, 0] as unknown as [number, number, number] })).toThrow(/rotation must be three finite numbers/);
    expect(() => parsePlacement({ scale: 0 })).toThrow(/scale must be positive/);
    expect(() => parsePlacement({ scale: [1, -1, 1] })).toThrow(/scale must be positive/);
    expect(() => parsePlacement({ spin: 3 } as never)).toThrow(/Unknown placement field "spin"/);
    expect(() => parsePlacement('left' as never)).toThrow(/Placement must be an object/);
  });

  it('fits every box corner inside the frustum from any direction', () => {
    // A 2 m cube seen head-on through a 90° square frustum: the near face (1 m closer) must span ±1 at its depth.
    expect(fitBoxDistance([-1, -1, -1], [1, 1, 1], [0, 0, 1], 90, 1, 1)).toBeCloseTo(2, 9);
    // A wide stage in a 2:1 viewport is limited by its width: 1 + 3 / tan(hfov / 2) where tan(hfov / 2) = 2.
    expect(fitBoxDistance([-3, -1, -1], [3, 1, 1], [0, 0, 1], 90, 2, 1)).toBeCloseTo(2.5, 9);
    // Padding widens the margin by shrinking the usable half-angle tangent.
    expect(fitBoxDistance([-1, -1, -1], [1, 1, 1], [0, 0, 1], 90, 1, 2)).toBeCloseTo(3, 9);
    // From the side the depth axis is x.
    expect(fitBoxDistance([-3, -1, -1], [3, 1, 1], [1, 0, 0], 90, 1, 1)).toBeCloseTo(4, 9);
    // Direction length does not matter; a top view (nearly parallel to up) still resolves.
    expect(fitBoxDistance([-1, -1, -1], [1, 1, 1], [0, 0, 5], 90, 1, 1)).toBeCloseTo(2, 9);
    expect(Number.isFinite(fitBoxDistance([-1, -1, -1], [1, 1, 1], [0, 1, 0.0001], 90, 1, 1))).toBe(true);
    expect(() => fitBoxDistance([-1, -1, -1], [1, 1, 1], [0, 0, 1], 90, 1, 0)).toThrow(/padding must be a positive number/);
  });
});

describe('stage scene', () => {
  it('holds several models, each placed and listed in order, and rejects duplicates and unknown names', async () => {
    const stage = createStageScene();
    stage.add('left', await leg(), { position: [-1, 0, 0] });
    stage.add('right', await leg(), { position: [1, 0, 0] });
    expect(stage.models).toEqual(['left', 'right']);
    expect(() => stage.add('left', { scene: new Group(), animations: [] })).toThrow(/Model "left" already exists/);
    expect(() => stage.model('middle')).toThrow(/Unknown model "middle"; use one of left, right/);
    expect(stage.model('left').name).toBe('left');
    expect(stage.root.children).toHaveLength(2);
  });

  it('gives every model an independent puppet', async () => {
    const stage = createStageScene();
    const a = stage.add('a', await leg()), b = stage.add('b', await leg());
    const kneeB = b.bone('knee').getWorldPosition(new Vector3()).toArray();
    a.setPose('knee', { rotation: [90, 0, 0] });
    a.setColor('thigh', '#ff0000');
    expect(a.getPose('knee').rotation.map(Math.round)).toEqual([90, 0, 0]);
    expect(b.getPose('knee').rotation).toEqual([0, 0, 0]);
    expect(b.getColor('thigh')).toBe('#3366cc');
    expect(b.bone('knee').getWorldPosition(new Vector3()).toArray()).toEqual(kneeB);
    expect(a.object('thigh').material).not.toBe(b.object('thigh').material);
    const faceA = stage.add('faceA', await face()), faceB = stage.add('faceB', await face());
    faceA.setMorph('jaw', 'jawOpen', 1);
    expect(faceA.getMorph('jaw', 'jawOpen')).toBe(1);
    expect(faceB.getMorph('jaw', 'jawOpen')).toBe(0);
    expect(round(faceA.bounds().min.toArray())).toEqual([0, -1, 0]);
    expect(round(faceB.bounds().min.toArray())).toEqual([0, 0, 0]);
  });

  it('reports world anchors and bounds through each model placement, and follows a moved placement', async () => {
    const stage = createStageScene();
    const turned = stage.add('turned', await leg(), { position: [2, 0, 0], rotation: [0, 90, 0] });
    stage.add('home', await leg());
    // The hip sits 1 m up; its local +x offset turns to -z under a 90° yaw.
    expect(round(turned.worldPoint('hip'))).toEqual([2, 1, 0]);
    expect(round(turned.worldPoint('hip', [0.5, 0, 0]))).toEqual([2, 1, -0.5]);
    expect(round(turned.observe({ knee: { node: 'knee' } }).knee)).toEqual([2, 0.5, 0]);
    expect(() => turned.worldPoint('nose')).toThrow(/Unknown node: nose/);
    turned.setPlacement({ position: [0, 0, 3] });
    expect(turned.getPlacement()).toEqual({ position: [0, 0, 3], rotation: [0, 90, 0], scale: [1, 1, 1] });
    expect(round(turned.worldPoint('hip'))).toEqual([0, 1, 3]);
    turned.setPlacement({ rotation: [0, 0, 0], scale: 2 });
    expect(round(turned.worldPoint('knee'))).toEqual([0, 1, 3]);
    expect(round(turned.bounds().max.toArray())).toEqual([0.2, 2, 3.2]);
    expect(() => turned.setPlacement({ scale: -1 })).toThrow(/scale must be positive/);
    expect(turned.getPlacement().scale).toEqual([2, 2, 2]);
  });

  it('measures the whole stage or a chosen subset, and releases a removed model', async () => {
    const stage = createStageScene();
    stage.add('left', await leg(), { position: [-1, 0, 0] });
    const right = stage.add('right', await leg(), { position: [1, 0, 0] });
    expect(round(stage.bounds().min.toArray())).toEqual([-1.1, 0, -0.1]);
    expect(round(stage.bounds().max.toArray())).toEqual([1.1, 1, 0.1]);
    expect(round(stage.bounds('right').min.toArray())).toEqual([0.9, 0, -0.1]);
    expect(round(stage.bounds(['left']).max.toArray())).toEqual([-0.9, 1, 0.1]);
    expect(() => stage.bounds('nobody')).toThrow(/Unknown model "nobody"/);
    const rightRoot = right.root;
    stage.remove('right');
    expect(stage.models).toEqual(['left']);
    expect(rightRoot.parent).toBeNull();
    expect(() => right.root).toThrow(/Model "right" was removed from the stage/);
    expect(() => stage.model('right')).toThrow(/Unknown model "right"; use one of left/);
    expect(() => stage.remove('right')).toThrow(/Unknown model "right"/);
    expect(round(stage.bounds().max.toArray())).toEqual([-0.9, 1, 0.1]);
  });

  it('advances every model clip on update', async () => {
    let p = project();
    p = applyOperation(p, { op: 'clip.set', clip: { name: 'kick', duration: 1, tracks: [{ bone: 'knee', property: 'rotation', keys: [{ time: 0, value: [0, 0, 0, 1] }, { time: 1, value: [0, 0, 0, 1] }] }] } });
    const glb = await exportGLB(p);
    const stage = createStageScene();
    const a = stage.add('a', await new GLTFLoader().parseAsync(glb.slice().buffer, ''));
    const b = stage.add('b', await new GLTFLoader().parseAsync(glb.slice().buffer, ''));
    a.play('kick'); stage.update(0.25);
    expect(a.time).toBeCloseTo(0.25, 6);
    expect(b.time).toBe(0);
  });
});
