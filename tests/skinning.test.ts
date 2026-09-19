import { it, expect } from 'vitest';
import { SkinnedMesh, Vector3 } from 'three';
import { buildScene } from '../src/render/scene.ts';
import type { Project } from '../src/core/types.ts';

const identity: [number, number, number, number] = [0, 0, 0, 1];
function fixture(): Project {
  return { version: 1, name: 'rig-test', clips: [], bones: [
    { name: 'root_joint', parent: null, position: [0, 0, 0], rotation: identity, pose: identity },
    { name: 'tip_joint', parent: 'root_joint', position: [0, 1, 0], rotation: identity, pose: identity },
  ], parts: [{ name: 'limb', geometry: { type: 'box', size: [0.4, 2, 0.4], segments: 8 }, color: '#d9a34b', position: [0, 1, 0], rotation: identity, scale: [1, 1, 1], parent: null, binding: { type: 'linear', bones: ['root_joint', 'tip_joint'], axis: 'y', range: [-0.5, 0.5] } }] };
}
it('keeps bind pose intact and deforms weighted vertices when a joint rotates', () => {
  const p = fixture();
  const rest = buildScene(p); const mesh = rest.root.getObjectByName('limb') as SkinnedMesh;
  expect(mesh.isSkinnedMesh).toBe(true);
  const positions = mesh.geometry.getAttribute('position');
  const top = Array.from({ length: positions.count }, (_, i) => i).find(i => positions.getY(i) > 0.9)!;
  const vertex = new Vector3().fromBufferAttribute(positions, top);
  const neutral = mesh.applyBoneTransform(top, vertex.clone());
  expect(neutral.distanceTo(vertex)).toBeLessThan(1e-6);
  p.bones[1].pose = [0, 0, Math.sin(Math.PI / 4), Math.cos(Math.PI / 4)];
  const posed = buildScene(p); const posedMesh = posed.root.getObjectByName('limb') as SkinnedMesh;
  const bent = posedMesh.applyBoneTransform(top, vertex.clone());
  expect(bent.distanceTo(vertex)).toBeGreaterThan(0.8);
  const weights = posedMesh.geometry.getAttribute('skinWeight');
  for (let i = 0; i < weights.count; i++) expect(weights.getX(i) + weights.getY(i) + weights.getZ(i) + weights.getW(i)).toBeCloseTo(1);
  expect(posedMesh.geometry.getAttribute('position').getY(top)).toBe(positions.getY(top));
  rest.dispose(); posed.dispose();
});
it('rigid binding follows a bone without deforming the part', () => {
  const p = fixture(); p.parts[0].binding = { type: 'rigid', bone: 'tip_joint' };
  p.bones[0].pose = [Math.sin(Math.PI / 8), 0, 0, Math.cos(Math.PI / 8)];
  const built = buildScene(p); const mesh = built.root.getObjectByName('limb') as SkinnedMesh;
  expect(mesh.isSkinnedMesh).toBe(true);
  const positions = mesh.geometry.getAttribute('position');
  const a = new Vector3().fromBufferAttribute(positions, 0), b = new Vector3().fromBufferAttribute(positions, 10);
  const distance = a.distanceTo(b);
  expect(mesh.applyBoneTransform(0, a).distanceTo(mesh.applyBoneTransform(10, b))).toBeCloseTo(distance);
  built.dispose();
});
