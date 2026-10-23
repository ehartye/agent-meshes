import { describe, expect, it } from 'vitest';
import { Quaternion, SkinnedMesh, Vector3 } from 'three';
import { createCreature } from '../src/recipes/index.ts';
import { buildScene } from '../src/render/scene.ts';
import type { Quat } from '../src/core/types.ts';

/** The convention the mesh-rigging skill states: the biped faces +Z and a pose is a right-handed rotation. */
const aboutX = (degrees: number): Quat => [Math.sin(degrees * Math.PI / 360), 0, 0, Math.cos(degrees * Math.PI / 360)];

function posed(pose: Record<string, Quat> = {}) {
  const project = createCreature('biped');
  for (const bone of project.bones) if (pose[bone.name]) bone.pose = pose[bone.name];
  const built = buildScene(project);
  built.root.updateMatrixWorld(true);
  return {
    project,
    bone: (name: string) => built.bones.get(name)!.getWorldPosition(new Vector3()),
    /** Where a bound part's vertices are on average, after the pose. */
    centre: (name: string) => {
      const mesh = built.objects.get(name) as SkinnedMesh, attribute = mesh.geometry.getAttribute('position'), sum = new Vector3();
      for (let i = 0; i < attribute.count; i++) sum.add(mesh.applyBoneTransform(i, new Vector3().fromBufferAttribute(attribute, i)));
      return sum.divideScalar(attribute.count);
    },
  };
}

describe('biped rotation convention', () => {
  it('faces +Z with up +Y, and _L parts sit on the -X side', () => {
    const { project } = posed();
    const part = (name: string) => project.parts.find(p => p.name === name)!.position;
    expect(part('chest_plate')[2]).toBeGreaterThan(part('backpack')[2]);
    expect(part('face_visor')[2]).toBeGreaterThan(0);
    expect(part('helmet')[1]).toBeGreaterThan(part('pelvis')[1]);
    const bone = (name: string) => project.bones.find(b => b.name === name)!.position;
    expect(bone('leg_L_hip')[0]).toBeLessThan(0);
    expect(bone('leg_R_hip')[0]).toBeGreaterThan(0);
  });

  it('turns a +X rotation of a hanging limb backwards, so a forward swing is a negative X rotation', () => {
    const rest = posed();
    for (const [limb, end] of [['arm_R', 'elbow_R'], ['arm_L', 'elbow_L'], ['leg_R_hip', 'leg_R_knee'], ['leg_L_hip', 'leg_L_knee']] as const) {
      const back = posed({ [limb]: aboutX(30) }).bone(end), forward = posed({ [limb]: aboutX(-30) }).bone(end);
      expect(back.z, `${limb} +30° about X`).toBeLessThan(rest.bone(end).z - 0.1);
      expect(forward.z, `${limb} -30° about X`).toBeGreaterThan(rest.bone(end).z + 0.1);
    }
  });

  it('bends a knee with a positive X rotation, swinging the foot back', () => {
    const rest = posed().bone('leg_R_ankle');
    expect(posed({ leg_R_knee: aboutX(30) }).bone('leg_R_ankle').z).toBeLessThan(rest.z - 0.1);
    expect(posed({ leg_R_knee: aboutX(-30) }).bone('leg_R_ankle').z).toBeGreaterThan(rest.z + 0.1);
  });

  it('leans the body forward with a positive X rotation of the chest', () => {
    const rest = posed().centre('jacket');
    expect(posed({ chest: aboutX(20) }).centre('jacket').z).toBeGreaterThan(rest.z + 0.05);
    expect(posed({ chest: aboutX(-20) }).centre('jacket').z).toBeLessThan(rest.z - 0.05);
  });

  it('tips +Y toward +Z for a +X rotation, as the skill states', () => {
    const base = createCreature('biped'), chest = base.bones.find(b => b.name === 'chest')!;
    chest.pose = aboutX(90);
    const built = buildScene(base); built.root.updateMatrixWorld(true);
    const up = new Vector3(0, 1, 0).applyQuaternion(built.bones.get('chest')!.getWorldQuaternion(new Quaternion()));
    expect(up.z).toBeGreaterThan(0.99);
    expect(Math.abs(up.y)).toBeLessThan(0.01);
  });
});
