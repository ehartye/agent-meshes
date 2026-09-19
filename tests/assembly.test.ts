import { describe, expect, it } from 'vitest';
import { AnimationMixer, Matrix4, Quaternion, SkinnedMesh, Vector3 } from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { applyOperation, createProject, validateProject } from '../src/core/model.ts';
import { applyAssemblyCopy } from '../src/core/assembly.ts';
import { geometryFor } from '../src/geometry.ts';
import { buildScene, disposeScene } from '../src/render/scene.ts';
import { exportGLB, verifyGLB } from '../src/export.ts';
import type { Project, Quat } from '../src/core/types.ts';

const q = (axis: number[], angle: number) => new Quaternion().setFromAxisAngle(new Vector3(...axis), angle).toArray() as Quat;
function fixture() {
  let p = createProject('assembly');
  for (const bone of [
    { name: 'body', position: [2, 1, -1], rotation: q([0, 1, 0], .6) },
    { name: 'upper', parent: 'body', position: [.7, 0, 0], rotation: q([0, 0, 1], .2) },
    { name: 'lower', parent: 'upper', position: [0, -1, 0], rotation: q([1, 0, 0], .3) },
  ]) p = applyOperation(p, { op: 'bone.add', bone } as Parameters<typeof applyOperation>[1]);
  p = applyOperation(p, { op: 'add', part: { name: 'assemblyGroup', geometry: { type: 'group' }, position: [1, 0, 2], rotation: q([0, 0, 1], .5), scale: [2, 1, .7] } });
  p = applyOperation(p, { op: 'add', part: { name: 'limb', parent: 'assemblyGroup', geometry: { type: 'cone', segments: 7 }, rotation: q([0, 1, 0], .4), binding: { type: 'linear', bones: ['upper', 'lower'], axis: 'x', range: [-.4, .3] } } });
  p = applyOperation(p, { op: 'add', part: { name: 'accessory', parent: 'limb', position: [0, 1, 0] } });
  p = applyOperation(p, { op: 'clip.set', clip: { name: 'move', duration: 1, tracks: [
    { bone: 'upper', property: 'rotation', keys: [{ time: 0, value: [0, 0, 0, 1] }, { time: 1, value: q([0, 0, 1], .8) }] },
    { bone: 'upper', property: 'position', keys: [{ time: 0, value: [0, 0, 0] }, { time: 1, value: [.2, .1, -.3] }] },
    { bone: 'lower', property: 'rotation', keys: [{ time: 0, value: [0, 0, 0, 1] }, { time: 1, value: q([1, 0, 0], -.5) }] },
  ] } });
  return p;
}
function copy(p: Project, options: object = {}) {
  const next = structuredClone(p);
  applyAssemblyCopy(next, { op: 'assembly.copy', root: 'upper', prefix: 'right.', ...options });
  return validateProject(next);
}
function skinVertices(scene: ReturnType<typeof buildScene>, name: string) {
  const mesh = scene.objects.get(name) as SkinnedMesh;
  return Array.from({ length: mesh.geometry.getAttribute('position').count }, (_, i) => mesh.getVertexPosition(i, new Vector3()).applyMatrix4(mesh.matrixWorld));
}

describe('rigged assembly copies', () => {
  it('copies bound meshes, necessary ancestors, accessories and relevant clips', () => {
    const p = fixture(), next = copy(p, { offset: [1, 2, 3] });
    expect(next.bones).toHaveLength(5);
    expect(next.parts.map(part => part.name)).toContain('right.accessory');
    expect(next.parts.find(part => part.name === 'right.limb')?.parent).toBe('right.assemblyGroup');
    expect(next.bones.find(bone => bone.name === 'right.lower')?.position).toEqual(p.bones[2].position);
    expect(next.clips[0].tracks).toHaveLength(6);
    expect(next.clips[0].tracks[4].keys).toEqual(p.clips[0].tracks[1].keys);
    expect(p.parts).toHaveLength(3);
    expect(copy(p, { clips: false }).clips).toEqual(p.clips);
  });
  it('translates a copy in its bone parent frame without duplicating unrelated ancestor geometry', () => {
    const p = fixture(); p.parts[0].geometry.type = 'sphere';
    const next = copy(p, { offset: [1, 2, 3] });
    expect(next.parts.find(part => part.name === 'right.assemblyGroup')?.geometry.type).toBe('group');
    expect(next.parts.find(part => part.name === 'right.limb')?.geometry).toEqual(p.parts[1].geometry);
    const shift = new Vector3(1, 2, 3).applyQuaternion(new Quaternion(...p.bones[0].rotation));
    const built = buildScene(next), mixer = new AnimationMixer(built.root);
    try {
      mixer.clipAction(built.clips[0]).play();
      for (const time of [.17, .71]) {
        mixer.setTime(time); built.root.updateMatrixWorld(true); built.skeleton.update();
        const original = skinVertices(built, 'limb'), copied = skinVertices(built, 'right.limb');
        original.forEach((vertex, i) => expect(copied[i].distanceTo(vertex.add(shift))).toBeLessThan(2e-6));
      }
    } finally { mixer.stopAllAction(); built.dispose(); }
  });
  it.each(['x', 'y', 'z'] as const)('reflects every deformed vertex in the rotated parent rest frame (%s)', mirror => {
    const p = fixture();
    p.bones[1].pose = q([1, 0, 0], .25);
    p.bones[2].pose = q([0, 0, 1], -.4);
    const next = copy(p, { mirror, offset: [.3, .2, -.1] });
    const scene = buildScene(next);
    const parent = new Matrix4().compose(new Vector3(...p.bones[0].position), new Quaternion(...p.bones[0].rotation), new Vector3(1, 1, 1));
    const scale = new Vector3(1, 1, 1); scale[mirror] = -1;
    const transform = parent.clone().multiply(new Matrix4().makeTranslation(.3, .2, -.1)).multiply(new Matrix4().makeScale(...scale.toArray())).multiply(parent.clone().invert());
    const check = () => {
      scene.root.updateMatrixWorld(true); scene.skeleton.update();
      const original = skinVertices(scene, 'limb'), reflected = skinVertices(scene, 'right.limb');
      for (let i = 0; i < original.length; i++) expect(reflected[i].distanceTo(original[i].applyMatrix4(transform))).toBeLessThan(2e-6);
    };
    try {
      check();
      const mixer = new AnimationMixer(scene.root); mixer.clipAction(scene.clips[0]).play();
      for (const time of [.13, .47, .89]) { mixer.setTime(time); check(); }
      mixer.stopAllAction();
    } finally { scene.dispose(); }
  });
  it('preserves explicit asymmetric vertex weights and returns original geometry after two mirrors', () => {
    const p = fixture(), mesh = p.parts[1], geometry = geometryFor(mesh);
    mesh.binding = { type: 'weights', bones: ['upper', 'lower'], weights: Array.from({ length: geometry.getAttribute('position').count }, (_, i) => [i % 3 / 2, 1 - i % 3 / 2]) };
    geometry.dispose();
    const once = copy(p, { mirror: 'z' });
    expect(once.parts.find(part => part.name === 'right.limb')?.binding).toEqual({ ...mesh.binding, bones: ['right.upper', 'right.lower'] });
    const twice = structuredClone(once);
    applyAssemblyCopy(twice, { op: 'assembly.copy', root: 'right.upper', prefix: 'back.', mirror: 'z' });
    const built = buildScene(validateProject(twice));
    try {
      const source = skinVertices(built, 'limb'), restored = skinVertices(built, 'back.right.limb');
      source.forEach((vertex, i) => expect(vertex.distanceTo(restored[i])).toBeLessThan(2e-6));
    } finally { built.dispose(); }
  });
  it('reflects asymmetric explicit weights through posed and animated external parents and exports the same geometry', async () => {
    const p = fixture(), mesh = p.parts[1], geometry = geometryFor(mesh);
    mesh.binding = { type: 'weights', bones: ['upper', 'lower'], weights: Array.from({ length: geometry.getAttribute('position').count }, (_, i) => [i % 7 / 6, 1 - i % 7 / 6]) };
    geometry.dispose();
    p.bones[0].pose = q([1, 0, 0], .4);
    p.clips[0].tracks.push({ bone: 'body', property: 'rotation', keys: [{ time: 0, value: [0, 0, 0, 1] }, { time: 1, value: q([0, 0, 1], .7) }] });
    const next = copy(p, { mirror: 'y', offset: [.3, 0, .1] });
    const reopened = validateProject(JSON.parse(JSON.stringify(next)));
    const built = buildScene(reopened);
    try {
      const checkReflection = () => {
        built.root.updateMatrixWorld(true); built.skeleton.update();
        const parent = built.bones.get('body')!.matrixWorld;
        const transform = parent.clone().multiply(new Matrix4().makeTranslation(.3, 0, .1)).multiply(new Matrix4().makeScale(1, -1, 1)).multiply(parent.clone().invert());
        const original = skinVertices(built, 'limb'), reflected = skinVertices(built, 'right.limb');
        original.forEach((vertex, i) => expect(reflected[i].distanceTo(vertex.applyMatrix4(transform))).toBeLessThan(3e-6));
      };
      checkReflection();
      const bytes = await exportGLB(reopened), report = await verifyGLB(bytes);
      expect(report.errors).toBe(0); expect(report.warnings).toBe(0);
      const loaded = await new GLTFLoader().parseAsync(bytes.slice().buffer as ArrayBuffer, '');
      const originalMixer = new AnimationMixer(built.root), exportedMixer = new AnimationMixer(loaded.scene);
      try {
        originalMixer.clipAction(built.clips[0]).play(); exportedMixer.clipAction(loaded.animations[0]).play();
        for (const time of [.01, .23, .58, .94]) {
          originalMixer.setTime(time); exportedMixer.setTime(time);
          checkReflection(); loaded.scene.updateMatrixWorld(true);
          for (const name of ['limb', 'right.limb']) {
            const expected = skinVertices(built, name);
            let actual: SkinnedMesh | undefined;
            loaded.scene.traverse(object => { if (object.userData.part === name && object instanceof SkinnedMesh) actual = object; });
            expect(actual).toBeDefined();
            for (let i = 0; i < expected.length; i++) expect(actual!.getVertexPosition(i, new Vector3()).applyMatrix4(actual!.matrixWorld).distanceTo(expected[i])).toBeLessThan(3e-6);
          }
        }
      } finally { originalMixer.stopAllAction(); exportedMixer.stopAllAction(); disposeScene(loaded.scene); }
    } finally { built.dispose(); }
  });
  it('keeps geometry topology, normals and winding consistent without renumbering vertices', () => {
    const p = fixture(), next = copy(p, { mirror: 'x' });
    const original = geometryFor(p.parts[1]), reflected = geometryFor(next.parts.find(part => part.name === 'right.limb')!);
    try {
      const a = original.getAttribute('position'), b = reflected.getAttribute('position');
      expect(b.count).toBe(a.count);
      for (let i = 0; i < a.count; i++) {
        expect(b.getX(i)).toBeCloseTo(-a.getX(i), 10); expect(b.getY(i)).toBe(a.getY(i)); expect(b.getZ(i)).toBe(a.getZ(i));
      }
      const an = original.getAttribute('normal'), bn = reflected.getAttribute('normal');
      for (let i = 0; i < an.count; i++) expect(new Vector3(bn.getX(i), bn.getY(i), bn.getZ(i)).distanceTo(new Vector3(-an.getX(i), an.getY(i), an.getZ(i)))).toBeLessThan(1e-7);
      for (let i = 0; i < original.index!.count; i += 3) {
        expect(reflected.index!.getX(i)).toBe(original.index!.getX(i));
        expect(reflected.index!.getX(i + 1)).toBe(original.index!.getX(i + 2));
        expect(reflected.index!.getX(i + 2)).toBe(original.index!.getX(i + 1));
      }
    } finally { original.dispose(); reflected.dispose(); }
  });
  it('rejects ambiguous bindings, external bound ancestors and all namespace collisions', () => {
    const p = fixture();
    const mixed = structuredClone(p); mixed.parts[1].binding = { type: 'linear', bones: ['body', 'upper'], axis: 'y', range: [0, 1] };
    expect(() => copy(mixed)).toThrow(/limb.*outside|limb.*mixed/i);
    const external = structuredClone(p); external.parts[0].geometry.type = 'box'; external.parts[0].binding = { type: 'rigid', bone: 'body' };
    expect(() => copy(external)).toThrow(/assemblyGroup.*outside|assemblyGroup.*ancestor/i);
    expect(() => copy(copy(p))).toThrow(/collision|duplicate/i);
    const collision = applyOperation(p, { op: 'add', part: { name: 'right.upper' } });
    expect(() => copy(collision)).toThrow(/collision|duplicate/i);
  });
});
