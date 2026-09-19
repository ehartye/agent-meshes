import { expect, it } from 'vitest';
import { AnimationMixer, Quaternion, SkinnedMesh, Vector3 } from 'three';
import { createCreature } from '../src/recipes/index.ts';
import { buildScene } from '../src/render/scene.ts';
import { solveSpiderPose, spiderGait, spiderStep, spiderTarget } from '../src/recipes/spider-motion.ts';
import { createSpiderLeg } from '../src/recipes/spider-leg.ts';

const segments = ['coxa', 'trochanter', 'femur', 'patella', 'tibia', 'metatarsus', 'tarsus'];
const prefixes = ['L', 'R'].flatMap(side => [1, 2, 3, 4].map(index => `leg_${side}_${index}`));

it('keeps moving distal spider joints on fixed local hinge axes', () => {
  const project = createCreature('arachnid');
  for (const prefix of prefixes) for (const segment of ['patella']) {
    const track = project.clips[0].tracks.find(t => t.bone === `${prefix}_${segment}`)!;
    const axes = track.keys.map(k => new Vector3(...k.value.slice(0, 3)))
      .filter(v => v.length() > 0.0001).map(v => v.normalize());
    expect(axes.length).toBeGreaterThan(20);
    for (const axis of axes) expect(axis.clone().cross(axes[0]).length(), `${prefix}_${segment} hinge axis drift`).toBeLessThan(1e-5);
  }
});

it('drives each leg mainly from the thorax while preserving its distal shape', () => {
  const project = createCreature('arachnid');
  for (const prefix of prefixes) {
    const ranges = segments.map(segment => {
      const track = project.clips[0].tracks.find(t => t.bone === `${prefix}_${segment}`)!;
      const rotations = track.keys.map(k => new Quaternion(...k.value as [number, number, number, number]));
      let range = 0;
      for (const a of rotations) for (const b of rotations) range = Math.max(range, a.angleTo(b));
      return range;
    });
    expect(ranges[0], `${prefix} must visibly sweep at the thorax`).toBeGreaterThan(0.15);
    for (let i = 1; i < ranges.length; i++) {
      expect(ranges[i], `${prefix}_${segments[i]} should remain nearly rigid`).toBeLessThan(0.11);
      expect(ranges[0], `${prefix} thorax motion must dominate ${segments[i]}`).toBeGreaterThan(1.75 * ranges[i]);
    }
    expect(ranges[6], 'tarsus should follow its parent without extra wiggling').toBeLessThan(1e-7);
    for (const i of [1, 2, 4, 5, 6]) expect(ranges[i], `${segments[i]} should keep its rest angle`).toBeLessThan(1e-7);
    const tracks = segments.slice(1).map(segment => project.clips[0].tracks.find(t => t.bone === `${prefix}_${segment}`)!);
    const distal = tracks[0].keys.map((_, i) => tracks.reduce((q, t) => q.multiply(new Quaternion(...t.keys[i].value as [number, number, number, number])), new Quaternion()));
    let shapeRange = 0;
    for (const a of distal) for (const b of distal) shapeRange = Math.max(shapeRange, a.angleTo(b));
    expect(shapeRange, `${prefix} cumulative bend must stay small relative to the coxa`).toBeLessThan(0.11);
    expect(ranges[0]).toBeGreaterThan(1.75 * shapeRange);
  }
});

it('staggers foot recovery and keeps the body quiet during a low stepping gait', () => {
  const built = buildScene(createCreature('arachnid'));
  try {
    const mixer = new AnimationMixer(built.root), clip = built.clips[0]; mixer.clipAction(clip).play();
    const peaks = prefixes.map(() => ({ y: -Infinity, frame: 0 }));
    let bodyRange = 0;
    for (let frame = 0; frame < 240; frame++) {
      mixer.setTime(clip.duration * frame / 240); built.root.updateMatrixWorld(true);
      bodyRange = Math.max(bodyRange, built.bones.get('root')!.position.y);
      prefixes.forEach((p, i) => {
        const y = built.bones.get(`${p}_tip`)!.getWorldPosition(new Vector3()).y;
        if (y > peaks[i].y) peaks[i] = { y, frame };
      });
    }
    expect(new Set(peaks.map(p => p.frame)).size, 'recovery must not collapse into two synchronous groups').toBeGreaterThanOrEqual(4);
    for (const peak of peaks) expect(peak.y - 0.033).toBeLessThan(0.095);
    expect(bodyRange).toBeLessThan(0.009);
  } finally { built.dispose(); }
});

it('keeps stance feet planted at the documented travel speed after clip interpolation', () => {
  const built = buildScene(createCreature('arachnid'));
  try {
    const mixer = new AnimationMixer(built.root), clip = built.clips[0]; mixer.clipAction(clip).play();
    const speed = spiderGait.stride / (spiderGait.stance * clip.duration);
    const previous = new Map<string, Vector3>();
    const legs = prefixes.map((_, i) => createSpiderLeg(i < 4 ? -1 : 1, i % 4));
    for (let frame = 0; frame < 480; frame++) {
      const phase = frame / 480, time = phase * clip.duration;
      mixer.setTime(time); built.root.updateMatrixWorld(true);
      prefixes.forEach((prefix, i) => {
        const side = i < 4 ? -1 : 1, index = i % 4;
        const offset = spiderStep(phase, side, index);
        const point = built.bones.get(`${prefix}_tip`)!.getWorldPosition(new Vector3());
        const bob = built.bones.get('root')!.position.y;
        const expected = new Vector3(...spiderTarget(legs[i].bones[0].position, legs[i].contact, offset, bob)); expected.y += bob;
        expect(point.distanceTo(expected)).toBeLessThan(0.0015);
        point.z += speed * time;
        if (offset[1] === 0) {
          if (previous.has(prefix)) expect(point.distanceTo(previous.get(prefix)!)).toBeLessThan(0.0003);
          previous.set(prefix, point);
        } else previous.delete(prefix);
      });
    }
  } finally { built.dispose(); }
});

it('solves the same bounded hinge pose regardless of sample order and rejects unreachable targets', () => {
  const leg = createSpiderLeg(-1, 0);
  const rest: [number, number, number][] = [];
  const point = new Vector3();
  for (const bone of leg.bones) { point.add(new Vector3(...bone.position)); rest.push(point.toArray()); }
  const target = rest[7].map((v, i) => v + (i === 1 ? 0.06 : i === 2 ? 0.1 : 0)) as [number, number, number];
  const first = solveSpiderPose(rest, target);
  solveSpiderPose(rest, rest[7]);
  expect(solveSpiderPose(rest, target)).toEqual(first);
  for (const q of first) expect(new Quaternion(...q).length()).toBeCloseTo(1, 10);
  expect(() => solveSpiderPose(rest, [10, 10, 10])).toThrow(/constrained pose range/);
  expect(() => solveSpiderPose(rest, [NaN, 0, 0])).toThrow(/finite/);
});

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

it('preserves segment lengths, contacts and the loop seam during thorax-led motion', () => {
  const project = createCreature('arachnid'), built = buildScene(project);
  try {
    const mixer = new AnimationMixer(built.root), clip = built.clips[0]; mixer.clipAction(clip).play();
    const position = (name: string) => built.bones.get(name)!.getWorldPosition(new Vector3());
    const starts = new Map<string, Quaternion>();
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
    mixer.setTime(0); built.root.updateMatrixWorld(true); const start = prefixes.map(p => position(`${p}_tip`));
    mixer.setTime(clip.duration - 1e-6); built.root.updateMatrixWorld(true);
    prefixes.forEach((p, i) => expect(position(`${p}_tip`).distanceTo(start[i])).toBeLessThan(0.0001));
    for (const [name, rotation] of starts) expect(built.bones.get(name)!.quaternion.angleTo(rotation)).toBeLessThan(0.0001);
  } finally { built.dispose(); }
});
