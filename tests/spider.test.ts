import { expect, it } from 'vitest';
import { AnimationMixer, Quaternion, SkinnedMesh, Vector3 } from 'three';
import { createCreature } from '../src/recipes/index.ts';
import { buildScene } from '../src/render/scene.ts';

const segments = ['coxa', 'trochanter', 'femur', 'patella', 'tibia', 'metatarsus', 'tarsus'];
const prefixes = ['L', 'R'].flatMap(side => [1, 2, 3, 4].map(index => `leg_${side}_${index}`));

it('gives all eight spider legs seven anatomical bones and independently bound visible sections', () => {
  const project = createCreature('arachnid');
  for (const prefix of prefixes) {
    let parent = 'root';
    for (const segment of segments) {
      const name = `${prefix}_${segment}`;
      const bone = project.bones.find(b => b.name === name);
      expect(bone, `${name} must exist`).toBeDefined();
      expect(bone!.parent).toBe(parent);
      const shell = project.parts.find(p => p.name === `${name}_shell`);
      expect(shell?.binding).toEqual({ type: 'rigid', bone: name });
      expect(shell!.geometry.size[1]).toBeGreaterThan(0.05);
      expect(project.clips[0].tracks.some(t => t.bone === name && t.property === 'rotation')).toBe(true);
      parent = name;
    }
    expect(project.bones.find(b => b.name === `${prefix}_tip`)?.parent).toBe(parent);
  }
  expect(project.bones.filter(b => b.name.startsWith('leg_'))).toHaveLength(64);
});

it('articulates proximal and distal joints while preserving lengths, contacts and the loop seam', () => {
  const project = createCreature('arachnid'), built = buildScene(project);
  try {
    const mixer = new AnimationMixer(built.root), clip = built.clips[0]; mixer.clipAction(clip).play();
    const position = (name: string) => built.bones.get(name)!.getWorldPosition(new Vector3());
    const starts = new Map<string, Quaternion>(), motion = new Map<string, number>();
    const previous = new Map<string, Quaternion>();
    const lengths = new Map(project.bones.filter(b => b.name.startsWith('leg_') && !b.name.endsWith('_coxa')).map(b => [b.name, new Vector3(...b.position).length()]));
    const skins: SkinnedMesh[] = []; built.root.traverse(object => { if (object instanceof SkinnedMesh && object.name.startsWith('leg_')) skins.push(object); });
    const clearance = position('leg_L_1_tip').y;
    let minimumY = Infinity;
    for (let frame = 0; frame < 240; frame++) {
      mixer.setTime(clip.duration * frame / 240); built.root.updateMatrixWorld(true);
      let planted = 0;
      for (const prefix of prefixes) {
        if (position(`${prefix}_tip`).y < clearance + 0.002) planted++;
        for (const segment of segments) {
          const name = `${prefix}_${segment}`, q = built.bones.get(name)!.quaternion;
          if (frame === 0) starts.set(name, q.clone());
          if (previous.has(name)) expect(q.angleTo(previous.get(name)!), `${name} must not snap between samples`).toBeLessThan(0.2);
          previous.set(name, q.clone());
          motion.set(name, Math.max(motion.get(name) ?? 0, q.angleTo(starts.get(name)!)));
        }
      }
      expect(planted).toBeGreaterThanOrEqual(4);
      for (const [name, length] of lengths) {
        const bone = built.bones.get(name)!;
        expect(position(name).distanceTo(bone.parent!.getWorldPosition(new Vector3()))).toBeCloseTo(length, 6);
      }
      for (const mesh of skins) {
        const positions = mesh.geometry.getAttribute('position');
        for (let i = 0; i < positions.count; i++) {
          const point = mesh.applyBoneTransform(i, new Vector3().fromBufferAttribute(positions, i)).applyMatrix4(mesh.matrixWorld);
          minimumY = Math.min(minimumY, point.y);
        }
      }
    }
    expect(minimumY, 'no leg section may pass through the ground').toBeGreaterThan(-0.002);
    for (const prefix of prefixes) for (const segment of segments) {
      expect(motion.get(`${prefix}_${segment}`), `${prefix}_${segment} must articulate`).toBeGreaterThan(0.025);
    }
    mixer.setTime(0); built.root.updateMatrixWorld(true); const start = prefixes.map(p => position(`${p}_tip`));
    mixer.setTime(clip.duration - 1e-6); built.root.updateMatrixWorld(true);
    prefixes.forEach((p, i) => expect(position(`${p}_tip`).distanceTo(start[i])).toBeLessThan(0.0001));
    for (const [name, rotation] of starts) expect(built.bones.get(name)!.quaternion.angleTo(rotation)).toBeLessThan(0.0001);
  } finally { built.dispose(); }
});
