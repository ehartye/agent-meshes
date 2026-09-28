import { describe, expect, it } from 'vitest';
import { BoxGeometry, Float32BufferAttribute, Group, Mesh, MeshStandardMaterial } from 'three';
import { addOutlines } from '../src/web/room.ts';
import type { Puppet } from '../src/render/puppet.ts';

function puppetOf(meshes: Mesh[]): Puppet {
  const root = new Group(); root.add(...meshes);
  const byName = new Map(meshes.map(mesh => [mesh.name, mesh]));
  return { parts: [...byName.keys()], object: (name: string) => byName.get(name)!, setVisible: (name: string, visible: boolean) => { byName.get(name)!.visible = visible; } } as unknown as Puppet;
}

function morphing(name: string, material: string): Mesh {
  const geometry = new BoxGeometry();
  const count = geometry.getAttribute('position').count;
  geometry.morphAttributes.position = [new Float32BufferAttribute(new Float32Array(count * 3).fill(.5), 3)];
  geometry.morphTargetsRelative = true;
  const mesh = new Mesh(geometry, new MeshStandardMaterial({ name: material }));
  mesh.name = name;
  return mesh;
}

describe('outline hulls', () => {
  it('follow their part\'s morphs, so a blink or an open jaw does not leave the ink at rest', () => {
    const skin = morphing('face_1', 'skin');
    const [hull] = addOutlines(puppetOf([skin]), .001);
    expect(hull.geometry.morphAttributes.position).toHaveLength(1);
    skin.morphTargetInfluences![0] = .7;
    expect(hull.morphTargetInfluences![0]).toBe(.7);
  });

  it('skips the mouth\'s inside (cavity, teeth, tongue), where a hull reads as ink floating in the mouth', () => {
    const parts = [morphing('face_1', 'skin'), morphing('face_5', 'mouth_cavity'), morphing('face_6', 'teeth_upper'),
      morphing('face_7', 'teeth_lower'), morphing('face_8', 'tongue')];
    const hulls = addOutlines(puppetOf(parts), .001);
    expect(hulls.map(hull => hull.name)).toEqual(['face_1_outline']);
  });
});
