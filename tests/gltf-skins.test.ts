import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { auditSkins, skinAudit } from '../src/gltf-skins.ts';
import { readGltfJson } from '../src/gltf-morphs.ts';
import { arkitFaceFixtureGLB } from './fixtures/arkit-face-glb.ts';

const head = (name: string) => new Uint8Array(readFileSync(new URL(`./fixtures/heads/${name}`, import.meta.url)));

describe('auditSkins', () => {
  it('lists each skin with its joint names and every mesh node with its skin and morph count', () => {
    const audit = auditSkins(head('bl-good.glb'));
    expect(audit.skins).toEqual([{
      skin: 0, name: 'HeadRig', joints: ['head', 'eye_L', 'eye_R'], usedBy: ['Eyeball_L', 'Eyeball_R', 'Head'],
      jointParents: { head: 'HeadRig', eye_L: 'head', eye_R: 'head' }, roots: ['head'],
    }]);
    expect(audit.meshNodes).toEqual([
      { node: 3, name: 'Eyeball_L', mesh: 0, meshName: 'Eyeball_L', skin: 0, morphTargets: 0, vertices: 1104, jointAncestor: null },
      { node: 4, name: 'Eyeball_R', mesh: 1, meshName: 'Eyeball_R', skin: 0, morphTargets: 0, vertices: 1104, jointAncestor: null },
      { node: 5, name: 'Head', mesh: 2, meshName: 'Head', skin: 0, morphTargets: 21, vertices: 1152, jointAncestor: null },
    ]);
    expect(audit.vertices).toBe(3360);
  });

  it('shows a morph-bearing mesh node left out of the skin', () => {
    const audit = auditSkins(head('partialskin.glb'));
    expect(audit.meshNodes.find(n => n.name === 'Head')).toMatchObject({ skin: null, morphTargets: 21 });
    expect(audit.skins[0].usedBy).toEqual(['Eyeball_L', 'Eyeball_R']);
  });

  it('reports no skins for an unrigged head', () => {
    const audit = auditSkins(head('bl-noskin.glb'));
    expect(audit.skins).toEqual([]);
    expect(audit.meshNodes.map(n => n.skin)).toEqual([null, null, null]);
  });

  it('shows eyeball mesh nodes left out of the skin, as the author left them in Blender', () => {
    for (const file of ['C-static-eyes.glb', 'bl3-staticeyes.glb']) {
      const audit = auditSkins(head(file));
      expect(audit.meshNodes.filter(n => n.skin === null).map(n => [n.name, n.morphTargets, n.vertices, n.jointAncestor])).toEqual([['Eyeball_L', 0, 1104, null], ['Eyeball_R', 0, 1104, null]]);
      expect(audit.vertices).toBe(3360);
    }
  });

  it('names the joint above a mesh node parented to a bone', () => {
    const audit = auditSkins(head('C2-static-eyes-parented-to-eye-bones.glb'));
    expect(audit.meshNodes.map(n => [n.name, n.skin, n.jointAncestor])).toEqual([['Eyeball_L', null, 'eye_L'], ['Eyeball_R', null, 'eye_R'], ['Head', 0, null]]);
  });

  it("records each joint's parent node and the skin's root joints", () => {
    expect(auditSkins(head('E-eyes-not-under-head.glb')).skins[0]).toMatchObject({ jointParents: { head: 'HeadRig', eye_L: 'HeadRig', eye_R: 'HeadRig' }, roots: ['head', 'eye_L', 'eye_R'] });
    expect(auditSkins(head('E2-eye_L-under-eye_R.glb')).skins[0]).toMatchObject({ jointParents: { head: 'HeadRig', eye_L: 'eye_R', eye_R: 'head' }, roots: ['head'] });
    expect(auditSkins(head('bl3-flat.glb')).skins[0]).toMatchObject({ jointParents: { eye_L: 'HeadRig', eye_R: 'HeadRig', head: 'HeadRig' } });
  });

  it('counts the vertices triangles use, welded as Unreal welds repeated pole and seam vertices', () => {
    // The fixture sphere repeats each pole vertex per segment and its seam column, and leaves one vertex per pole unused:
    // 187 stored, 185 used, 146 once welded, the count UE 5.7.3 imported (tests/unreal-integration.test.ts).
    const bytes = arkitFaceFixtureGLB();
    expect(auditSkins(bytes).meshNodes[0].vertices).toBe(146);
    expect(auditSkins(arkitFaceFixtureGLB({ layout: 'primitives' })).meshNodes[0].vertices).toBe(172);
    const json = readGltfJson(bytes);
    // Without the binary chunk (a .gltf with external buffers) the count is unknown, not guessed.
    expect(skinAudit(json).meshNodes[0].vertices).toBeNull();
    expect(skinAudit(json).vertices).toBeNull();
    // Points and lines render no surface, so they are not expected to import.
    (json.meshes as { primitives: { mode?: number }[] }[])[0].primitives[0].mode = 1;
    expect(skinAudit(json).meshNodes[0].vertices).toBe(0);
  });

  it('names joints without a name by node index and tolerates a skin pointing at a missing node', () => {
    const json = readGltfJson(arkitFaceFixtureGLB());
    (json.nodes as { name?: string }[])[1].name = undefined;
    (json.skins as { joints: number[] }[])[0].joints.push(99);
    expect(skinAudit(json).skins[0].joints).toEqual(['head', 'node 1', 'eye_R', 'node 99']);
  });
});
