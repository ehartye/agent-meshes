import { expect, it } from 'vitest';
import { AnimationMixer, SkinnedMesh, Vector3 } from 'three';
import { createCreature, creatureKinds, creatureInfo } from '../src/recipes/index.ts';
import { validateProject } from '../src/core/model.ts';
import { buildScene } from '../src/render/scene.ts';

const footSuffix = (kind: string) => kind === 'arachnid' ? '_tip' : kind === 'equine' ? '_hoof' : kind === 'vulpine' ? '_paw' : '_ankle';
for (const kind of creatureKinds) {
  it(`${kind} is repeatable, editable and has the correct number of articulated legs`, () => {
    const project = createCreature(kind);
    expect(validateProject(JSON.parse(JSON.stringify(project)))).toEqual(project);
    expect(createCreature(kind)).toEqual(project);
    const hips = project.bones.filter(b => /^leg_.*_(hip|shoulder|coxa)$/.test(b.name));
    expect(hips).toHaveLength(creatureInfo[kind].legs);
    for (const hip of hips) {
      if (kind === 'arachnid' || kind === 'equine' || kind === 'vulpine') continue; // Dedicated anatomical tests inspect these longer chains.
      const prefix = hip.name.slice(0, -4);
      expect(project.bones.find(b => b.name === `${prefix}_knee`)?.parent).toBe(hip.name);
      expect(project.bones.find(b => b.name === `${prefix}_ankle`)?.parent).toBe(`${prefix}_knee`);
    }
    expect(project.parts.length).toBeGreaterThan(20);
    for (const clip of project.clips) for (const track of clip.tracks) expect(track.keys.at(-1)!.value).toEqual(track.keys[0].value);
  });

  it(`${kind} plants supporting feet, lifts swinging feet and loops without a jump`, () => {
    const project = createCreature(kind), built = buildScene(project);
    try {
      const mixer = new AnimationMixer(built.root);
      const ankles = [...built.bones.values()].filter(b => b.name.endsWith(footSuffix(kind)));
      const clearance = Math.min(...ankles.map(b => b.getWorldPosition(new Vector3()).y));
      expect(ankles).toHaveLength(creatureInfo[kind].legs);
      for (const clip of built.clips) {
        mixer.clipAction(clip).play();
        const peak = new Map(ankles.map(b => [b.name, 0]));
        for (let frame = 0; frame < 120; frame++) {
          mixer.setTime(clip.duration * frame / 120); built.root.updateMatrixWorld(true);
          let planted = 0;
          for (const bone of ankles) {
            const y = bone.getWorldPosition(new Vector3()).y;
            expect(y).toBeGreaterThanOrEqual(clearance - 0.002);
            if (y <= clearance + 0.002) planted++;
            peak.set(bone.name, Math.max(peak.get(bone.name)!, y - clearance));
          }
          expect(planted).toBeGreaterThanOrEqual(creatureInfo[kind].legs / 2);
        }
        for (const value of peak.values()) expect(value).toBeGreaterThan(0.06);
        mixer.setTime(0); built.root.updateMatrixWorld(true); const start = ankles.map(b => b.getWorldPosition(new Vector3()));
        mixer.setTime(clip.duration - 1e-6); built.root.updateMatrixWorld(true);
        ankles.forEach((bone, i) => expect(bone.getWorldPosition(new Vector3()).distanceTo(start[i])).toBeLessThan(0.0001));
        if (kind === 'biped' || kind === 'equine' || kind === 'vulpine') {
          const part = project.parts.find(p => p.binding?.type === 'linear')!;
          expect(part).toBeDefined();
          const mesh = built.objects.get(part.name) as SkinnedMesh;
          const attribute = mesh.geometry.getAttribute('position');
          const vertex = (index: number) => mesh.applyBoneTransform(index, new Vector3().fromBufferAttribute(attribute, index));
          mixer.setTime(0); built.root.updateMatrixWorld(true);
          const first = Array.from({ length: attribute.count }, (_, i) => vertex(i));
          mixer.setTime(clip.duration * 0.3); built.root.updateMatrixWorld(true);
          const changed = first.some((p, i) => Math.abs(p.distanceTo(first[0]) - vertex(i).distanceTo(vertex(0))) > 0.001);
          expect(changed, 'weighted surfaces must actually deform').toBe(true);
        }
        mixer.stopAllAction();
      }
    } finally { built.dispose(); }
  });
}

it('lists all five creature presets and rejects unknown recipe names', () => {
  expect(creatureKinds).toEqual(['biped', 'equine', 'vulpine', 'insectoid', 'arachnid']);
  expect(() => createCreature('unknown' as never)).toThrow(/creature|recipe/i);
});

it('coordinates diagonal and tripod support groups, and swings biped arms against the legs', () => {
  const groups = {
    equine: ['leg_L_front_hoof', 'leg_R_rear_hoof'],
    vulpine: ['leg_L_front_paw', 'leg_R_rear_paw'],
    insectoid: ['leg_L_1_ankle', 'leg_R_2_ankle', 'leg_L_3_ankle'],
    arachnid: ['leg_L_1_tip', 'leg_R_2_tip', 'leg_L_3_tip', 'leg_R_4_tip'],
  } as const;
  for (const kind of creatureKinds) {
    const built = buildScene(createCreature(kind));
    try {
      const clip = built.clips.find(clip => clip.name === 'trot') ?? built.clips[0];
      const mixer = new AnimationMixer(built.root); mixer.clipAction(clip).play();
      const position = (name: string) => built.bones.get(name)!.getWorldPosition(new Vector3());
      if (kind === 'biped') {
        for (const phase of [0, 0.5]) {
          mixer.setTime(phase * clip.duration); built.root.updateMatrixWorld(true);
          expect(position('elbow_L').z * position('leg_L_ankle').z).toBeLessThan(0);
          expect(position('elbow_R').z * position('leg_R_ankle').z).toBeLessThan(0);
        }
      } else {
        const ankles = [...built.bones.keys()].filter(name => name.endsWith(footSuffix(kind)));
        const clearance = position(ankles[0]).y;
        for (const phase of [0.25, 0.75]) {
          mixer.setTime(phase * clip.duration); built.root.updateMatrixWorld(true);
          const expected = phase === 0.25 ? [...groups[kind]] : ankles.filter(name => !(groups[kind] as readonly string[]).includes(name));
          const actual = ankles.filter(name => position(name).y < clearance + 0.002);
          expect(actual.sort()).toEqual(expected.sort());
        }
      }
    } finally { built.dispose(); }
  }
});
