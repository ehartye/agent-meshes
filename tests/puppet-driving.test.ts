import { afterEach, describe, expect, it, vi } from 'vitest';
import { Bone, BoxGeometry, Float32BufferAttribute, Group, MathUtils, Mesh, MeshStandardMaterial, Object3D, Skeleton, SkinnedMesh, SphereGeometry, Uint16BufferAttribute, Vector3 } from 'three';
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { ensureFileReader } from '../src/node-file-reader.ts';
import { createPuppet } from '../src/render/puppet.ts';
import { createStageScene } from '../src/render/stage.ts';
import { parseQuality } from '../src/render/quality.ts';
import { morphControls } from '../src/web/preview-morphs.ts';

/** A small skinned head: a face skinned to head and jaw with two morphs, eyes on turned eye bones, a lid with a blink. */
async function headGltf() {
  const root = new Group(); root.name = 'headroot';
  const rootBone = new Bone(); rootBone.name = 'root';
  const head = new Bone(); head.name = 'head'; head.position.set(0, 0.3, 0); head.rotation.set(0, 0.4, 0.1); rootBone.add(head);
  const jaw = new Bone(); jaw.name = 'jaw'; jaw.position.set(0, -0.03, 0.02); head.add(jaw);
  const eyeL = new Bone(); eyeL.name = 'eye_L'; eyeL.position.set(-0.045, 0.03, 0.1); eyeL.rotation.set(0.2, -0.3, 0.05); head.add(eyeL);
  root.add(rootBone); root.updateMatrixWorld(true);
  const geometry = new SphereGeometry(0.12, 12, 8); geometry.translate(0, 0.3, 0);
  const pos = geometry.getAttribute('position'), n = pos.count, si: number[] = [], sw: number[] = [];
  for (let i = 0; i < n; i++) { const low = pos.getY(i) < 0.29; si.push(1, 2, 0, 0); sw.push(low ? 0.4 : 1, low ? 0.6 : 0, 0, 0); }
  geometry.setAttribute('skinIndex', new Uint16BufferAttribute(si, 4)); geometry.setAttribute('skinWeight', new Float32BufferAttribute(sw, 4));
  geometry.morphAttributes.position = ['jawOpen', 'mouthSmileLeft'].map(name => {
    const a = new Float32BufferAttribute(new Float32Array(n * 3), 3); a.name = name;
    for (let i = 0; i < n; i++) if (pos.getY(i) < 0.27) a.setXYZ(i, 0, name === 'jawOpen' ? -0.1 : 0, name === 'jawOpen' ? 0 : 0.01);
    return a;
  });
  geometry.morphTargetsRelative = true;
  const face = new SkinnedMesh(geometry, new MeshStandardMaterial({ name: 'skin' })); face.name = 'face'; root.add(face);
  face.bind(new Skeleton([rootBone, head, jaw, eyeL])); face.updateMorphTargets();
  const ball = new Mesh(new SphereGeometry(0.025, 8, 6), new MeshStandardMaterial({ name: 'sclera' })); ball.name = 'eyeball_L'; eyeL.add(ball);
  const lidGeometry = new BoxGeometry(0.07, 0.06, 0.004), blink = new Float32BufferAttribute(new Float32Array(lidGeometry.getAttribute('position').count * 3), 3);
  blink.name = 'eyeBlinkLeft'; for (let i = 0; i < blink.count; i++) blink.setXYZ(i, 0, -0.06, 0);
  lidGeometry.morphAttributes.position = [blink]; lidGeometry.morphTargetsRelative = true;
  const lid = new Mesh(lidGeometry, new MeshStandardMaterial({ name: 'lid' })); lid.name = 'lid_L'; lid.position.set(-0.045, 0.09, 0.13); lid.updateMorphTargets(); head.add(lid);
  ensureFileReader();
  const bytes = await new GLTFExporter().parseAsync(root, { binary: true }) as ArrayBuffer;
  return new GLTFLoader().parseAsync(bytes, '');
}

/** Count the whole-model re-application: every apply updates the root's world matrices. */
function countApplies(root: Object3D) {
  const original = root.updateMatrixWorld.bind(root);
  const counter = { n: 0 };
  root.updateMatrixWorld = (force?: boolean) => { counter.n++; original(force); };
  return counter;
}
const forward = (bone: Object3D) => {
  bone.updateWorldMatrix(true, false);
  const origin = new Vector3().setFromMatrixPosition(bone.matrixWorld);
  return new Vector3(0, 0, 1).applyMatrix4(bone.matrixWorld).sub(origin).normalize();
};

afterEach(() => { vi.restoreAllMocks(); });

describe('per-frame face driving', () => {
  it('defers setter work: a frame of writes costs no re-application until something reads or syncs', async () => {
    const puppet = createPuppet(await headGltf());
    const face = puppet.object('face') as SkinnedMesh;
    const applies = countApplies(puppet.root);
    const spheres = vi.spyOn(SkinnedMesh.prototype, 'computeBoundingSphere');
    for (let frame = 0; frame < 10; frame++) {
      puppet.setMorph('face', 'jawOpen', frame / 10);
      puppet.setMorph('face', 'mouthSmileLeft', 0.5);
      puppet.setMorph('lid_L', 'eyeBlinkLeft', 0.25);
      puppet.setPose('eye_L', { rotation: [0, frame, 0] });
      puppet.setPose('jaw', { rotation: [frame, 0, 0] });
    }
    expect(applies.n).toBe(0);
    // Raw three.js state is pending until the next sync; the puppet's own getters are already current.
    expect(face.morphTargetInfluences![0]).toBe(0);
    expect(puppet.getMorph('face', 'jawOpen')).toBeCloseTo(0.9, 12);
    expect(puppet.getPose('eye_L').rotation).toEqual([0, 9, 0]);
    puppet.sync();
    expect(face.morphTargetInfluences![0]).toBeCloseTo(0.9, 12);
    puppet.sync();
    expect(applies.n).toBe(1);
    expect(spheres).not.toHaveBeenCalled();
  });

  it('keeps every reader consistent with pending writes', async () => {
    const puppet = createPuppet(await headGltf());
    const restBounds = puppet.bounds(), restJaw = puppet.observe({ jaw: { node: 'jaw', point: [0, 0, 0.1] } }).jaw;
    puppet.setMorph('face', 'jawOpen', 1);
    expect(puppet.bounds().min.y).toBeLessThan(restBounds.min.y - 0.05);
    puppet.setPose('jaw', { rotation: [30, 0, 0] });
    expect(puppet.observe({ jaw: { node: 'jaw', point: [0, 0, 0.1] } }).jaw[1]).toBeLessThan(restJaw[1] - 0.01);
    puppet.setPose('eye_L', { rotation: [0, 20, 0] });
    const eye = puppet.bone('eye_L');
    expect(MathUtils.radToDeg(eye.quaternion.angleTo(puppet.createPoseSampler().root.getObjectByName('eye_L')!.quaternion))).toBeCloseTo(20, 6);
    puppet.resetMorph();
    expect(puppet.getMorph('face', 'jawOpen')).toBe(0);
    puppet.resetPose();
    expect(puppet.bounds().min.y).toBeCloseTo(restBounds.min.y, 9);
  });

  it('turns off frustum culling for skins (whose rest sphere goes stale) and refreshes their sphere in bounds()', async () => {
    const puppet = createPuppet(await headGltf());
    const face = puppet.object('face') as SkinnedMesh;
    expect(face.frustumCulled).toBe(false);
    expect(puppet.object('lid_L').frustumCulled).toBe(true);
    puppet.setPose('root', { position: [5, 0, 0] });
    const box = puppet.bounds();
    const sphere = face.boundingSphere!.clone().applyMatrix4(face.matrixWorld);
    expect(sphere.center.x).toBeGreaterThan(4.5);
    expect(sphere.containsPoint(box.getCenter(new Vector3()))).toBe(true);
  });

  it('sets many morphs and poses in one validated call', async () => {
    const puppet = createPuppet(await headGltf());
    const applies = countApplies(puppet.root);
    puppet.setMorphs({ face: { jawOpen: 0.4, mouthSmileLeft: 0.7 }, lid_L: { eyeBlinkLeft: 1 } });
    puppet.setPoses({ eye_L: { rotation: [0, 12, 0] }, jaw: { rotation: [8, 0, 0] } });
    expect(applies.n).toBe(0);
    expect(puppet.getMorph('face', 'jawOpen')).toBeCloseTo(0.4, 12);
    expect(puppet.getMorph('face', 'mouthSmileLeft')).toBeCloseTo(0.7, 12);
    expect(puppet.getMorph('lid_L', 'eyeBlinkLeft')).toBe(1);
    expect(puppet.getPose('jaw').rotation).toEqual([8, 0, 0]);
    // Invalid input anywhere changes nothing.
    expect(() => puppet.setMorphs({ face: { jawOpen: 0.9, jawOpn: 1 } })).toThrow(/Unknown morph target for face: jawOpn/);
    expect(() => puppet.setMorphs({ face: { jawOpen: Number.NaN } })).toThrow(/finite/);
    expect(() => puppet.setMorphs({ nose: { jawOpen: 1 } })).toThrow(/Unknown part: nose/);
    expect(() => puppet.setPoses({ eye_L: { rotation: [0, 50, 0] }, eye_X: { rotation: [0, 1, 0] } })).toThrow(/Unknown bone: eye_X/);
    expect(() => puppet.setPoses({ eye_L: { rotation: [0, Number.NaN, 0] } })).toThrow(/finite/);
    expect(() => puppet.setPoses({ jaw: { scale: [1, 0, 1] } })).toThrow(/positive/);
    expect(puppet.getMorph('face', 'jawOpen')).toBeCloseTo(0.4, 12);
    expect(puppet.getPose('eye_L').rotation).toEqual([0, 12, 0]);
  });

  it('keeps pose offsets composing over clip playback while deferred', async () => {
    const gltf = await headGltf();
    const puppet = createPuppet(gltf);
    const rest = puppet.bone('jaw').quaternion.clone();
    puppet.setPose('jaw', { rotation: [10, 0, 0] });
    puppet.setPose('jaw', { rotation: [20, 0, 0] });
    expect(MathUtils.radToDeg(puppet.bone('jaw').quaternion.angleTo(rest))).toBeCloseTo(20, 6);
  });
});

describe('aimBone', () => {
  it('points a bone +Z at a world point through turned parents and a turned rest pose, and returns the yaw and pitch', async () => {
    const puppet = createPuppet(await headGltf());
    const target: [number, number, number] = [0.6, 0.9, 1.2];
    const aim = puppet.aimBone('eye_L', target);
    const eye = puppet.bone('eye_L');
    const toTarget = new Vector3(...target).sub(eye.getWorldPosition(new Vector3())).normalize();
    expect(MathUtils.radToDeg(forward(eye).angleTo(toTarget))).toBeLessThan(1e-4);
    expect(aim.clamped).toBe(false);
    // The applied offset is the pose the getter reports.
    const pose = puppet.getPose('eye_L');
    puppet.resetPose('eye_L'); puppet.setPose('eye_L', pose);
    expect(MathUtils.radToDeg(forward(puppet.bone('eye_L')).angleTo(toTarget))).toBeLessThan(1e-4);
    // Aiming again at the same point is stable (the offset is replaced, not stacked).
    const again = puppet.aimBone('eye_L', target);
    expect(again.yaw).toBeCloseTo(aim.yaw, 9); expect(again.pitch).toBeCloseTo(aim.pitch, 9);
  });

  it('reports yaw toward the bone +X and pitch toward +Y, and clamps to limits', async () => {
    const puppet = createPuppet(await headGltf());
    const local = (x: number, y: number, z: number) => {
      // A point in the eye's un-offset frame, in world space.
      puppet.resetPose('eye_L');
      return puppet.bone('eye_L').localToWorld(new Vector3(x, y, z)).toArray() as [number, number, number];
    };
    const right = puppet.aimBone('eye_L', local(1, 0, 1));
    expect(right.yaw).toBeCloseTo(45, 6); expect(right.pitch).toBeCloseTo(0, 6);
    const up = puppet.aimBone('eye_L', local(0, 1, 1));
    expect(up.yaw).toBeCloseTo(0, 6); expect(up.pitch).toBeCloseTo(45, 6);
    const limited = puppet.aimBone('eye_L', local(-3, -1, 1), { maxYaw: 25, maxPitch: 15 });
    expect(limited).toEqual({ yaw: -25, pitch: -15, clamped: true });
    const direction = forward(puppet.bone('eye_L'));
    const expected = new Vector3(0, 0, 1).applyAxisAngle(new Vector3(1, 0, 0), MathUtils.degToRad(15)).applyAxisAngle(new Vector3(0, 1, 0), MathUtils.degToRad(-25));
    puppet.resetPose('eye_L');
    const restFrame = puppet.bone('eye_L').matrixWorld.clone();
    const origin = new Vector3().setFromMatrixPosition(restFrame);
    const expectedWorld = expected.applyMatrix4(restFrame).sub(origin).normalize();
    expect(MathUtils.radToDeg(direction.angleTo(expectedWorld))).toBeLessThan(1e-4);
    expect(() => puppet.aimBone('eye_X', [0, 0, 1])).toThrow(/Unknown bone: eye_X/);
    expect(() => puppet.aimBone('eye_L', [0, Number.NaN, 1])).toThrow(/finite/);
    expect(() => puppet.aimBone('eye_L', [0, 0, 1], { maxYaw: -1 })).toThrow(/maxYaw/);
    expect(() => puppet.aimBone('eye_L', [0, 0, 1], { maxYow: 1 } as never)).toThrow(/Unknown aimBone option "maxYow"/);
  });

  it('keeps the position and scale offsets of an aimed bone', async () => {
    const puppet = createPuppet(await headGltf());
    puppet.setPose('eye_L', { position: [0, 0.01, 0], scale: [1.2, 1.2, 1.2] });
    puppet.aimBone('eye_L', [0, 0.3, 2]);
    expect(puppet.getPose('eye_L').position).toEqual([0, 0.01, 0]);
    expect(puppet.getPose('eye_L').scale).toEqual([1.2, 1.2, 1.2]);
  });
});

describe('stage driving', () => {
  it('lets one model aim an eye at another model', async () => {
    const stage = createStageScene();
    const pip = stage.add('pip', await headGltf(), { position: [-0.4, 0, 0], rotation: [0, 30, 0] });
    const moss = stage.add('moss', await headGltf(), { position: [0.4, 0, 0], rotation: [0, -30, 0] });
    const mouth = pip.worldPoint('jaw', [0, 0, 0.1]);
    moss.aimBone('eye_L', mouth);
    const eye = moss.bone('eye_L');
    const toMouth = new Vector3(...mouth).sub(eye.getWorldPosition(new Vector3())).normalize();
    expect(MathUtils.radToDeg(forward(eye).angleTo(toMouth))).toBeLessThan(1e-4);
  });

  it('syncs every model once per frame and throws on a removed model handle', async () => {
    const stage = createStageScene();
    const a = stage.add('a', await headGltf()), b = stage.add('b', await headGltf(), { position: [1, 0, 0] });
    const applies = [countApplies(a.root), countApplies(b.root)];
    for (let i = 0; i < 20; i++) { a.setMorph('face', 'jawOpen', i / 20); b.setPose('eye_L', { rotation: [0, i, 0] }); }
    stage.update(1 / 60);
    expect(applies.map(c => c.n)).toEqual([0, 0]);
    stage.sync();
    expect(applies.map(c => c.n)).toEqual([1, 1]);
    expect((a.object('face') as SkinnedMesh).morphTargetInfluences![0]).toBeCloseTo(0.95, 12);
    stage.remove('b');
    expect(() => b.setMorph('face', 'jawOpen', 1)).toThrow(/Model "b" was removed from the stage/);
    expect(() => b.worldPoint('eye_L')).toThrow(/Model "b" was removed/);
    expect(() => b.setPlacement({ position: [0, 0, 0] })).toThrow(/Model "b" was removed/);
    expect(() => b.play()).toThrow(/Model "b" was removed/);
    expect(b.name).toBe('b');
    expect(() => stage.sync()).not.toThrow();
  });
});

describe('renderer quality', () => {
  it('defaults to high quality and offers a fast preset with overrides', () => {
    expect(parseQuality(undefined, 3)).toEqual({ antialias: true, pixelRatio: 2, shadows: true, shadowMapSize: 2048, environment: true });
    expect(parseQuality(undefined, 1)).toEqual({ antialias: true, pixelRatio: 1, shadows: true, shadowMapSize: 2048, environment: true });
    expect(parseQuality('high', 1.5)).toEqual({ antialias: true, pixelRatio: 1.5, shadows: true, shadowMapSize: 2048, environment: true });
    expect(parseQuality('fast', 2)).toEqual({ antialias: false, pixelRatio: 1, shadows: false, shadowMapSize: 2048, environment: false });
    expect(parseQuality({ preset: 'fast', shadows: 512 }, 2)).toEqual({ antialias: false, pixelRatio: 1, shadows: true, shadowMapSize: 512, environment: false });
    expect(parseQuality({ antialias: false, pixelRatio: 0.75, shadows: false }, 2)).toEqual({ antialias: false, pixelRatio: 0.75, shadows: false, shadowMapSize: 2048, environment: true });
    expect(parseQuality({ preset: 'fast', environment: true }, 1).environment).toBe(true);
    expect(() => parseQuality({ environment: 1 } as never, 1)).toThrow(/quality environment must be true or false/);
    expect(() => parseQuality('ultra' as never, 1)).toThrow(/quality must be "high", "fast" or an object/);
    expect(() => parseQuality({ pixelRatio: 0 }, 1)).toThrow(/pixelRatio must be a number from 0.25 to 4/);
    expect(() => parseQuality({ shadows: 1000 }, 1)).toThrow(/shadows must be true, false or a power-of-two map size from 256 to 8192/);
    expect(() => parseQuality({ aa: false } as never, 1)).toThrow(/Unknown quality option "aa"/);
  });
});

/**
 * One glTF mesh with three primitives (skin, lid, teeth) that all carry the same morph names, as a
 * Blender head exports: GLTFLoader splits it into a group named after the node with one mesh per primitive.
 */
async function multiPrimitiveGltf() {
  const root = new Group();
  const head = new Bone(); head.name = 'head'; root.add(head); root.updateMatrixWorld(true);
  const geometry = new SphereGeometry(0.1, 12, 8), n = geometry.getAttribute('position').count;
  geometry.setAttribute('skinIndex', new Uint16BufferAttribute(new Array(n * 4).fill(0), 4));
  geometry.setAttribute('skinWeight', new Float32BufferAttribute(Array.from({ length: n * 4 }, (_, i) => (i % 4 === 0 ? 1 : 0)), 4));
  geometry.morphAttributes.position = ['jawOpen', 'eyeBlinkLeft'].map((name, k) => {
    const a = new Float32BufferAttribute(new Float32Array(n * 3), 3); a.name = name;
    for (let i = 0; i < n; i++) a.setXYZ(i, 0, k === 0 ? -0.05 : 0, k === 1 ? 0.02 : 0);
    return a;
  });
  geometry.morphTargetsRelative = true;
  const third = geometry.index!.count / 3;
  geometry.clearGroups(); geometry.addGroup(0, third, 0); geometry.addGroup(third, third, 1); geometry.addGroup(2 * third, third, 2);
  const face = new SkinnedMesh(geometry, ['skin', 'lid', 'teeth'].map(name => new MeshStandardMaterial({ name })));
  face.name = 'face'; root.add(face); face.bind(new Skeleton([head])); face.updateMorphTargets();
  // An eyeball: three primitives (white, iris, pupil) and no morphs.
  const ball = new SphereGeometry(0.02, 12, 8), third2 = ball.index!.count / 3;
  ball.addGroup(0, third2, 0); ball.addGroup(third2, third2, 1); ball.addGroup(2 * third2, third2, 2);
  const eyeball = new Mesh(ball, ['eye_white', 'eye_iris', 'eye_pupil'].map(name => new MeshStandardMaterial({ name })));
  eyeball.name = 'eyeball_L'; eyeball.position.set(0.03, 0.02, 0.08); root.add(eyeball);
  ensureFileReader();
  const bytes = await new GLTFExporter().parseAsync(root, { binary: true }) as ArrayBuffer;
  return new GLTFLoader().parseAsync(bytes, '');
}

describe('multi-primitive glTF meshes', () => {
  it('lists preview morph controls by mesh group and emotion presets from extras.arkitFace', async () => {
    const gltf = await multiPrimitiveGltf();
    gltf.scene.children[0].userData.arkitFace = { contract: 'arkit-face/1', emotions: { neutral: {}, happy: { jawOpen: 0.25, mouthSmileLeft: 0.9 }, sad: { eyeBlinkLeft: 0.25 } } };
    const puppet = createPuppet(gltf);
    const controls = morphControls(puppet);
    // One control per target, driven through the group (not its three primitives); the eyeball has none.
    expect(controls.targets).toEqual([{ target: 'jawOpen', owners: ['face'] }, { target: 'eyeBlinkLeft', owners: ['face'] }]);
    // Presets keep only the targets this model has; neutral comes first.
    expect(controls.presets).toEqual({ neutral: {}, happy: { jawOpen: 0.25 }, sad: { eyeBlinkLeft: 0.25 } });
    expect(Object.keys(controls.presets)[0]).toBe('neutral');
  });

  it('drives a morph by glTF mesh name across every primitive that has the target', async () => {
    const gltf = await multiPrimitiveGltf();
    const puppet = createPuppet(gltf);
    const primitives = (gltf.scene.getObjectByName('face')!.children as Mesh[]).filter(child => child instanceof Mesh);
    expect(primitives.length).toBe(3);
    // Only multi-primitive meshes with morph targets are morph groups: the morph-free eyeball is left out.
    expect(puppet.morphGroups).toEqual(['face']);
    expect(gltf.scene.getObjectByName('eyeball_L')!.children.length).toBe(3);
    expect(puppet.morphTargets('face')).toEqual(['jawOpen', 'eyeBlinkLeft']);
    expect(puppet.morphTargets(primitives[1].name)).toEqual(['jawOpen', 'eyeBlinkLeft']);
    const rest = puppet.bounds();
    puppet.setMorph('face', 'jawOpen', 0.5);
    expect(puppet.getMorph('face', 'jawOpen')).toBe(0.5);
    puppet.sync();
    expect(primitives.map(mesh => mesh.morphTargetInfluences![mesh.morphTargetDictionary!.jawOpen])).toEqual([0.5, 0.5, 0.5]);
    expect(puppet.bounds().min.y).toBeCloseTo(rest.min.y - 0.025, 6);
    puppet.setMorphs({ face: { jawOpen: 1, eyeBlinkLeft: 0.25 } });
    puppet.sync();
    expect(primitives.map(mesh => mesh.morphTargetInfluences![mesh.morphTargetDictionary!.eyeBlinkLeft])).toEqual([0.25, 0.25, 0.25]);
    // A single primitive can still be addressed by its own part name.
    puppet.setMorph(primitives[2].name, 'jawOpen', 0.1);
    expect(puppet.getMorph(primitives[2].name, 'jawOpen')).toBe(0.1);
    expect(puppet.getMorph(primitives[0].name, 'jawOpen')).toBe(1);
    puppet.resetMorph('face', 'jawOpen');
    expect(primitives.map(mesh => puppet.getMorph(mesh.name, 'jawOpen'))).toEqual([0, 0, 0]);
    expect(puppet.getMorph('face', 'eyeBlinkLeft')).toBe(0.25);
    puppet.resetMorph('face');
    expect(puppet.getMorph('face', 'eyeBlinkLeft')).toBe(0);
    expect(() => puppet.setMorph('face', 'jawOpn', 1)).toThrow(/Unknown morph target for face: jawOpn/);
    expect(() => puppet.setMorphs({ face: { jawOpen: 1 }, nose: { jawOpen: 1 } })).toThrow(/Unknown part: nose/);
    expect(() => puppet.morphTargets('nose')).toThrow(/Unknown part: nose/);
  });

  it('samples and stages multi-primitive morphs by mesh name', async () => {
    const puppet = createPuppet(await multiPrimitiveGltf());
    const sampler = puppet.createPoseSampler();
    sampler.sample({ clip: null, time: 0, morphs: [{ part: 'face', target: 'jawOpen', weight: 1 }] });
    const sampled: number[] = [];
    sampler.root.getObjectByName('face')!.children.forEach(child => { if (child instanceof Mesh) sampled.push(child.morphTargetInfluences![child.morphTargetDictionary!.jawOpen]); });
    expect(sampled).toEqual([1, 1, 1]);
    sampler.dispose();
    const stage = createStageScene();
    const a = stage.add('a', await multiPrimitiveGltf()), b = stage.add('b', await multiPrimitiveGltf());
    a.setMorphs({ face: { jawOpen: 0.7 } });
    expect(a.getMorph('face', 'jawOpen')).toBe(0.7);
    expect(b.getMorph('face', 'jawOpen')).toBe(0);
  });
});
