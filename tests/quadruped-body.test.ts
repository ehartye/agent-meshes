import { expect, it } from 'vitest';
import { Quaternion, SkinnedMesh, Vector3 } from 'three';
import type { Project } from '../src/core/types.ts';
import { validateProject } from '../src/core/model.ts';
import { buildScene } from '../src/render/scene.ts';
import { addQuadrupedBody } from '../src/recipes/quadruped-body.ts';

for (const species of ['equine', 'vulpine'] as const) {
  it(`${species} body remains connected to its animated head and tail rig`, () => {
    const project: Project = { version: 1, name: species, parts: [], clips: [], shells: [], bones: [
      { name: 'root', parent: null, position: [0, 0, 0], rotation: [0, 0, 0, 1], pose: [0, 0, 0, 1] },
    ] };
    addQuadrupedBody(project, species);
    expect(project.parts.length).toBeGreaterThan(10);
    expect(validateProject(project)).toEqual(project);
    expect(project.bones.map(b => b.name).sort()).toEqual(['head', 'root', 'tail']);
    for (const part of project.parts) {
      expect(part.binding?.type).toBe('rigid');
      if (part.binding?.type === 'rigid') expect(['root', 'head', 'tail']).toContain(part.binding.bone);
    }
    const built = buildScene(project);
    try {
      const vertex = (name: string) => {
        const mesh = built.objects.get(name) as SkinnedMesh;
        return mesh.applyBoneTransform(0, new Vector3().fromBufferAttribute(mesh.geometry.getAttribute('position'), 0)).applyMatrix4(mesh.matrixWorld);
      };
      const before = new Map(project.parts.map(part => [part.name, vertex(part.name)]));
      for (const joint of ['head', 'tail']) built.bones.get(joint)!.quaternion.copy(new Quaternion().setFromAxisAngle(new Vector3(1, 0, 0), 0.2));
      built.root.updateMatrixWorld(true);
      for (const part of project.parts) {
        const moved = vertex(part.name).distanceTo(before.get(part.name)!);
        if (part.binding?.type === 'rigid' && part.binding.bone === 'root') expect(moved).toBeLessThan(1e-8);
      }
      expect(vertex('nose').distanceTo(before.get('nose')!)).toBeGreaterThan(0.03);
      expect(vertex('tail_tip').distanceTo(before.get('tail_tip')!)).toBeGreaterThan(0.03);
    } finally { built.dispose(); }
  });
}
