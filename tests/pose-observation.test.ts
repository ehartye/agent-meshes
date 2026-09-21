import { describe, expect, it, vi } from 'vitest';
import { AnimationClip, Bone, BufferGeometry, Float32BufferAttribute, Group, Mesh, MeshStandardMaterial, NumberKeyframeTrack, Skeleton, SkinnedMesh, Uint16BufferAttribute, Vector3, VectorKeyframeTrack } from 'three';
import { createPuppet } from '../src/render/puppet.ts';
import { GLTFExporter } from 'three/addons/exporters/GLTFExporter.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { ensureFileReader } from '../src/node-file-reader.ts';

function fixture(uuid = false) {
  const root = new Group(); root.name = 'rig';
  const carrier = new Group(); carrier.name = 'carrier'; carrier.position.set(2, 0, 0); carrier.rotation.z = Math.PI / 2; carrier.scale.set(2, 3, 1); root.add(carrier);
  const bone = new Bone(); bone.name = 'hoof'; bone.position.y = 1; carrier.add(bone);
  const geometry = new BufferGeometry(); geometry.setAttribute('position', new Float32BufferAttribute([0, 0, 0, 1, 0, 0, 0, 1, 0], 3));
  const stretch = new Float32BufferAttribute([0, 0, 0, 1, 0, 0, 0, 0, 0], 3); stretch.name = 'stretch'; geometry.morphAttributes.position = [stretch]; geometry.morphTargetsRelative = true;
  const shape = new Mesh(geometry, new MeshStandardMaterial({ color: 'red' })); shape.name = 'shape'; root.add(shape);
  const clips = [new AnimationClip('step', 2, [
    new VectorKeyframeTrack(`${uuid ? bone.uuid : 'hoof'}.position`, [0, 1, 2], [0, 2, 0, 0, 4, 0, 0, 2, 0]),
    new VectorKeyframeTrack('carrier.position', [0, 1, 2], [2, 0, 0, 4, 0, 0, 2, 0, 0]),
    new NumberKeyframeTrack('shape.morphTargetInfluences', [0, 1, 2], [0, 1, 0]),
  ])];
  return { root, carrier, bone, shape, clips, puppet: createPuppet({ scene: root, animations: clips }) };
}

describe('pose observations', () => {
  it('reads named local points in world or another node frame, updates ancestors, and returns immutable numbers', () => {
    const { root, bone, puppet } = fixture();
    const outside = new Group(); outside.position.set(10, 4, 0); outside.add(root); outside.rotation.y = .3;
    const anchors = { tip: { node: 'hoof', point: [0, -.25, 0] as [number, number, number] } };
    const result = puppet.observe(anchors);
    const expected = bone.localToWorld(new Vector3(0, -.25, 0)).toArray();
    expect(result.tip).toEqual(expected); expect(Object.isFrozen(result)).toBe(true); expect(Object.isFrozen(result.tip)).toBe(true);
    const relative = puppet.observe(anchors, 'carrier'); expect(relative.tip[0]).toBeCloseTo(0); expect(relative.tip[1]).toBeCloseTo(1.75);
    expect(() => puppet.observe({ bad: { node: 'absent' } })).toThrow(/Unknown node/);
    const duplicate = new Group(); duplicate.name = 'hoof'; root.add(duplicate);
    expect(() => puppet.observe(anchors)).toThrow(/Ambiguous node/);
  });

  it.each([false, true])('samples authored rest, clips, offsets and morphs without touching live state (UUID tracks=%s)', uuid => {
    const { root, bone, shape, puppet } = fixture(uuid);
    puppet.play('step'); puppet.seek(.7); puppet.setPose('hoof', { position: [1, 0, 0] }); puppet.setMorph('shape', 'stretch', .25);
    puppet.setColor('shape', '#00ff00'); root.updateMatrixWorld(true);
    const before = { time: puppet.time, playing: puppet.playing, bone: bone.matrixWorld.toArray(), morph: [...shape.morphTargetInfluences!], color: puppet.getColor('shape') };
    const sampler = puppet.createPoseSampler();
    sampler.sample({ clip: null, time: 0 });
    expect(sampler.observe({ tip: { node: 'hoof' } }, 'carrier').tip[1]).toBeCloseTo(1);
    for (const t of [1, .25, 1, -1, 3]) {
      sampler.sample({ clip: 'step', time: t, poses: { hoof: { position: [0, .5, 0] } }, morphs: [{ part: 'shape', target: 'stretch', weight: .6 }] });
      const expected = t === .25 ? 3 : 4.5;
      expect(sampler.observe({ tip: { node: 'hoof' } }, 'carrier').tip[1]).toBeCloseTo(expected);
      expect((sampler.root.getObjectByName('shape') as Mesh).morphTargetInfluences![0]).toBe(.6);
    }
    sampler.sample({ clip: null, time: 0 });
    expect(sampler.observe({ tip: { node: 'hoof' } }, 'carrier').tip[1]).toBeCloseTo(1);
    expect((sampler.root.getObjectByName('shape') as Mesh).morphTargetInfluences![0]).toBe(0);
    expect({ time: puppet.time, playing: puppet.playing, bone: bone.matrixWorld.toArray(), morph: [...shape.morphTargetInfluences!], color: puppet.getColor('shape') }).toEqual(before);
    const geometryDispose = vi.spyOn(shape.geometry, 'dispose'), materialDispose = vi.spyOn(shape.material as MeshStandardMaterial, 'dispose');
    sampler.dispose(); sampler.dispose(); expect(geometryDispose).not.toHaveBeenCalled(); expect(materialDispose).not.toHaveBeenCalled();
    expect(() => sampler.sample({ clip: null, time: 0 })).toThrow(/disposed/);
  });

  it('validates complete samples before changing the last good sample', () => {
    const { puppet } = fixture(), sampler = puppet.createPoseSampler();
    sampler.sample({ clip: 'step', time: 1 });
    const before = sampler.observe({ tip: { node: 'hoof' } });
    for (const input of [
      { clip: 'missing', time: 0 }, { clip: 'step', time: NaN },
      { clip: null, time: 0, poses: { hoof: { position: [1, Infinity, 0] } } },
      ...['position', 'rotation', 'scale'].map(key => ({ clip: null, time: 0, poses: { hoof: { [key]: [0, , 0] } } })),
      { clip: null, time: 0, morphs: [{ part: 'shape', target: 'missing', weight: .5 }] },
    ]) { expect(() => sampler.sample(input as never)).toThrow(); expect(sampler.observe({ tip: { node: 'hoof' } })).toEqual(before); }
    expect(() => sampler.observe({ bad: { node: 'hoof', point: [0, , 0] as never } })).toThrow(/three finite/);
    sampler.dispose();
  });

  it('keeps skinned skeletons independent and can dispose sampled GPU skin textures', () => {
    const root = new Group(), bone = new Bone(); bone.name = 'joint'; root.add(bone);
    const geometry = new BufferGeometry(); geometry.setAttribute('position', new Float32BufferAttribute([0, 1, 0], 3)); geometry.setAttribute('skinIndex', new Uint16BufferAttribute([0, 0, 0, 0], 4)); geometry.setAttribute('skinWeight', new Float32BufferAttribute([1, 0, 0, 0], 4));
    const skin = new SkinnedMesh(geometry, new MeshStandardMaterial()); skin.name = 'skin'; root.add(skin); root.updateMatrixWorld(true); skin.bind(new Skeleton([bone]));
    const puppet = createPuppet({ scene: root, animations: [] }), sampler = puppet.createPoseSampler();
    sampler.sample({ clip: null, time: 0, poses: { joint: { position: [0, 2, 0] } } });
    const sampled = sampler.root.getObjectByName('skin') as SkinnedMesh;
    expect(sampled.skeleton).not.toBe(skin.skeleton); expect(sampled.skeleton.bones[0]).not.toBe(bone);
    expect(sampled.getVertexPosition(0, new Vector3()).y).toBeCloseTo(3); expect(skin.getVertexPosition(0, new Vector3()).y).toBeCloseTo(1);
    sampled.skeleton.computeBoneTexture(); const dispose = vi.spyOn(sampled.skeleton.boneTexture!, 'dispose'); sampler.dispose(); expect(dispose).toHaveBeenCalledOnce();
  });

  it('owns even unnamed mesh materials, without disposing shared geometry or textures', () => {
    const root = new Group(), mesh = new Mesh(new BufferGeometry(), new MeshStandardMaterial()); root.add(mesh);
    const puppet = createPuppet({ scene: root, animations: [] }), sampler = puppet.createPoseSampler();
    const live = vi.spyOn(mesh.material, 'dispose'), owned = vi.spyOn((sampler.root.children[0] as Mesh).material as MeshStandardMaterial, 'dispose');
    const attached = new Mesh(new BufferGeometry(), new MeshStandardMaterial()), borrowed = vi.spyOn(attached.material, 'dispose'); sampler.root.add(attached);
    sampler.dispose(); expect(owned).toHaveBeenCalledOnce(); expect(live).not.toHaveBeenCalled();
    expect(borrowed).not.toHaveBeenCalled();
  });

  it('preserves observations and morph sampling through GLB export/load', async () => {
    const { puppet, root, clips } = fixture();
    const source = puppet.createPoseSampler(); source.sample({ clip: null, time: 0 });
    ensureFileReader();
    const buffer = await new GLTFExporter().parseAsync(source.root, { binary: true, animations: clips }) as ArrayBuffer;
    const loaded = createPuppet(await new GLTFLoader().parseAsync(buffer, '')), sampler = loaded.createPoseSampler();
    for (const time of [0, .25, .75, 1.5]) {
      source.sample({ clip: 'step', time }); sampler.sample({ clip: 'step', time });
      const a = source.observe({ hoof: { node: 'hoof', point: [.1, .2, .3] } }), b = sampler.observe({ hoof: { node: 'hoof', point: [.1, .2, .3] } });
      a.hoof.forEach((value, i) => expect(b.hoof[i]).toBeCloseTo(value, 5));
      expect((sampler.root.getObjectByName('shape') as Mesh).morphTargetInfluences![0]).toBeCloseTo((source.root.getObjectByName('shape') as Mesh).morphTargetInfluences![0]);
    }
    expect(root).not.toBe(sampler.root); source.dispose(); sampler.dispose();
  });
});
