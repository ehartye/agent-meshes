import { describe, expect, it } from 'vitest';
import { AnimationClip, Bone, BoxGeometry, BufferGeometry, Float32BufferAttribute, Group, Mesh, MeshStandardMaterial, NumberKeyframeTrack, QuaternionKeyframeTrack, VectorKeyframeTrack } from 'three';
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { ensureFileReader } from '../src/node-file-reader.ts';
import { createPuppet } from '../src/render/puppet.ts';

function materials() {
  const red = new MeshStandardMaterial({ color: '#ff0000', metalness: 0.1, roughness: 0.8 });
  const blue = new MeshStandardMaterial({ color: '#0000ff', metalness: 0.9, roughness: 0.2 });
  const root = new Group(), panel = new Mesh(new BoxGeometry(), [red, blue]), neighbor = new Mesh(new BoxGeometry(), red);
  for (const group of panel.geometry.groups) group.materialIndex = group.materialIndex! % 2;
  panel.name = 'panel'; neighbor.name = 'neighbor'; root.add(panel, neighbor);
  return { puppet: createPuppet({ scene: root, animations: [] }), red, blue };
}

async function authored() {
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new Float32BufferAttribute([0, 0, 0, 1, 0, 0, 0, 1, 0], 3));
  geometry.setAttribute('normal', new Float32BufferAttribute([0, 0, 1, 0, 0, 1, 0, 0, 1], 3));
  const stretch = new Float32BufferAttribute([0, 0, 0, 2, 0, 0, 0, 0, 0], 3);
  const raise = new Float32BufferAttribute([0, 0, 0, 0, 0, 0, 0, 2, 0], 3);
  stretch.name = 'stretch'; raise.name = 'raise';
  geometry.morphAttributes.position = [stretch, raise]; geometry.morphTargetsRelative = true;
  const shape = new Mesh(geometry, new MeshStandardMaterial()); shape.name = 'shape';
  shape.morphTargetInfluences![0] = 0.2; shape.morphTargetInfluences![1] = 0.1;
  const carrier = new Group(); carrier.name = 'carrier'; carrier.position.x = 2; carrier.add(shape);
  const root = new Group(); root.add(carrier);
  const deform = new AnimationClip('deform', 2, [
    new VectorKeyframeTrack('carrier.position', [0, 1, 2], [2, 0, 0, 4, 0, 0, 2, 0, 0]),
    new VectorKeyframeTrack('carrier.scale', [0, 1, 2], [1, 1, 1, 2, 3, 1, 1, 1, 1]),
    new NumberKeyframeTrack('shape.morphTargetInfluences', [0, 1, 2], [0.2, 0.1, 0.5, 0.75, 0.2, 0.1]),
  ]);
  const idle = new AnimationClip('idle', 2, [new QuaternionKeyframeTrack('carrier.quaternion', [0, 2], [0, 0, 0, 1, 0, 0, 0, 1])]);
  ensureFileReader();
  const bytes = await new GLTFExporter().parseAsync(root, { binary: true, animations: [deform, idle] }) as ArrayBuffer;
  return createPuppet(await new GLTFLoader().parseAsync(bytes, ''));
}

describe('authored GLB controls', () => {
  it('preserves and isolates every material slot, with all-slot setters and first-slot getters', () => {
    const { puppet, red, blue } = materials();
    const slots = puppet.object('panel').material as MeshStandardMaterial[];
    expect(Array.isArray(slots)).toBe(true); expect(slots).toHaveLength(2);
    expect(slots[0]).not.toBe(red); expect(slots[1]).not.toBe(blue);
    expect(puppet.getColor('panel')).toBe('#ff0000'); expect(puppet.getColor('panel', 1)).toBe('#0000ff');
    puppet.setColor('panel', '#00ff00', 1);
    expect(puppet.getColor('panel')).toBe('#ff0000'); expect(puppet.getColor('panel', 1)).toBe('#00ff00');
    puppet.setMaterial('panel', { roughness: 0.4 }, 1);
    expect(puppet.getMaterial('panel')).toEqual({ metalness: 0.1, roughness: 0.8 });
    expect(puppet.getMaterial('panel', 1)).toEqual({ metalness: 0.9, roughness: 0.4 });
    puppet.setColor('panel', '#ffffff'); puppet.setMaterial('panel', { metalness: 0.5 });
    for (const slot of [0, 1]) { expect(puppet.getColor('panel', slot)).toBe('#ffffff'); expect(puppet.getMaterial('panel', slot).metalness).toBe(0.5); }
    expect(puppet.getColor('neighbor')).toBe('#ff0000'); expect(red.color.getHexString()).toBe('ff0000'); expect(blue.roughness).toBe(0.2);
  });

  it('rejects invalid slots and unsupported multi-material patterns before mutation', () => {
    const { puppet } = materials(), mesh = puppet.object('panel');
    for (const slot of [-1, 2, 0.5, NaN]) {
      expect(() => puppet.setColor('panel', '#ffffff', slot)).toThrow(/material slot/i);
      expect(() => puppet.getMaterial('panel', slot)).toThrow(/material slot/i);
    }
    expect(() => puppet.setMaterial('panel', { metalness: 0.5, roughness: Infinity })).toThrow(/0 to 1/);
    expect(puppet.getMaterial('panel').metalness).toBe(0.1);
    expect(() => puppet.setPattern('panel', { type: 'dots', color: '#ffffff', size: 0.2 })).toThrow(/multi-material/i);
    expect(mesh.geometry.getAttribute('color_1')).toBeUndefined(); expect(mesh.geometry.getAttribute('color')).toBeUndefined();
    expect(puppet.getPattern('panel')).toBeNull(); expect(puppet.getColor('panel', 1)).toBe('#0000ff');
  });

  it('samples imported node scale and morph tracks and measures the current deformed surface', async () => {
    const puppet = await authored(); puppet.seek(0.5);
    expect(puppet.object('shape').parent!.scale.toArray()).toEqual([1.5, 2, 1]);
    expect(puppet.object('shape').morphTargetInfluences![0]).toBeCloseTo(0.35);
    expect(puppet.object('shape').morphTargetInfluences![1]).toBeCloseTo(0.425);
    puppet.seek(1);
    expect(puppet.object('shape').parent!.scale.toArray()).toEqual([2, 3, 1]);
    expect(puppet.object('shape').morphTargetInfluences).toEqual([0.5, 0.75]);
    expect(puppet.bounds().max.x).toBeCloseTo(8); expect(puppet.bounds().max.y).toBeCloseTo(7.5);
    puppet.play('idle');
    expect(puppet.object('shape').parent!.position.toArray()).toEqual([2, 0, 0]);
    expect(puppet.object('shape').parent!.scale.toArray()).toEqual([1, 1, 1]);
    expect(puppet.bounds().max.x).toBeCloseTo(3.4); expect(puppet.bounds().max.y).toBeCloseTo(1.2);
  });

  it('applies named morph overrides after clips and resets them to the current animation or authored rest', async () => {
    const puppet = await authored(); puppet.seek(1);
    puppet.setMorph('shape', 'stretch', 0.8); puppet.setMorph('shape', 'raise', 0.25);
    expect(puppet.getMorph('shape', 'stretch')).toBe(0.8); expect(puppet.bounds().max.x).toBeCloseTo(9.2);
    puppet.play(); puppet.update(0.1); expect(puppet.getMorph('shape', 'stretch')).toBe(0.8);
    puppet.seek(1); puppet.resetMorph('shape', 'stretch');
    expect(puppet.getMorph('shape', 'stretch')).toBe(0.5); expect(puppet.getMorph('shape', 'raise')).toBe(0.25);
    puppet.play('idle'); expect(puppet.getMorph('shape', 'raise')).toBe(0.25);
    puppet.resetMorph('shape'); expect(puppet.getMorph('shape', 'raise')).toBeCloseTo(0.1);
    // glTF weights can extrapolate: only non-finite values are rejected.
    puppet.setMorph('shape', 'stretch', 1.5); expect(puppet.bounds().max.x).toBeCloseTo(6);
    for (const weight of [NaN, Infinity, -Infinity]) expect(() => puppet.setMorph('shape', 'stretch', weight)).toThrow(/finite/i);
    expect(puppet.getMorph('shape', 'stretch')).toBe(1.5);
    expect(() => puppet.setMorph('shape', 'missing', 1)).toThrow(/Unknown morph/);
    expect(() => puppet.getMorph('missing', 'stretch')).toThrow(/Unknown part/);
    puppet.resetMorph(); expect(puppet.getMorph('shape', 'stretch')).toBeCloseTo(0.2);
  });

  it('composes scale animation with bone pose offsets without accumulating', () => {
    const root = new Group(), bone = new Bone(); bone.name = 'bone'; root.add(bone);
    const puppet = createPuppet({ scene: root, animations: [new AnimationClip('grow', 2, [new VectorKeyframeTrack('bone.scale', [0, 1, 2], [1, 1, 1, 2, 3, 1, 1, 1, 1])])] });
    puppet.seek(1); puppet.setPose('bone', { scale: [2, 1, 1] });
    expect(bone.scale.toArray()).toEqual([4, 3, 1]); puppet.seek(1); expect(bone.scale.toArray()).toEqual([4, 3, 1]);
    puppet.resetPose(); expect(bone.scale.toArray()).toEqual([2, 3, 1]);
  });

  it('binds named morph track elements and measures absolute targets while respecting hidden parents', () => {
    const geometry = new BufferGeometry();
    geometry.setAttribute('position', new Float32BufferAttribute([1, 0, 0], 3));
    const target = new Float32BufferAttribute([5, 0, 0], 3); target.name = 'reach';
    geometry.morphAttributes.position = [target];
    const mesh = new Mesh(geometry, new MeshStandardMaterial()); mesh.name = 'point';
    const root = new Group(), parent = new Group(); parent.add(mesh); root.add(parent);
    const puppet = createPuppet({ scene: root, animations: [new AnimationClip('reach', 2, [new NumberKeyframeTrack('point.morphTargetInfluences[reach]', [0, 1, 2], [0, 0.5, 0])])] });
    puppet.seek(1); expect(puppet.getMorph('point', 'reach')).toBe(0.5); expect(puppet.bounds().max.x).toBe(3);
    puppet.setMorph('point', 'reach', -0.5); expect(puppet.bounds().max.x).toBe(-1);
    puppet.resetMorph(); expect(puppet.bounds().max.x).toBe(3);
    parent.visible = false; expect(puppet.bounds().isEmpty()).toBe(true);
  });
});
