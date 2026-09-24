import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { auditSkins, skinAudit } from '../src/gltf-skins.ts';
import { readGltfJson } from '../src/gltf-morphs.ts';
import { arkitFaceFixtureGLB } from './fixtures/arkit-face-glb.ts';

const head = (name: string) => new Uint8Array(readFileSync(new URL(`./fixtures/heads/${name}`, import.meta.url)));

describe('auditSkins', () => {
  it('lists each skin with its joint names and every mesh node with its skin and morph count', () => {
    const audit = auditSkins(head('bl-good.glb'));
    expect(audit.skins).toEqual([{ skin: 0, name: 'HeadRig', joints: ['head', 'eye_L', 'eye_R'], usedBy: ['Eyeball_L', 'Eyeball_R', 'Head'] }]);
    expect(audit.meshNodes).toEqual([
      { node: 3, name: 'Eyeball_L', mesh: 0, meshName: 'Eyeball_L', skin: 0, morphTargets: 0 },
      { node: 4, name: 'Eyeball_R', mesh: 1, meshName: 'Eyeball_R', skin: 0, morphTargets: 0 },
      { node: 5, name: 'Head', mesh: 2, meshName: 'Head', skin: 0, morphTargets: 21 },
    ]);
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

  it('names joints without a name by node index and tolerates a skin pointing at a missing node', () => {
    const json = readGltfJson(arkitFaceFixtureGLB());
    (json.nodes as { name?: string }[])[1].name = undefined;
    (json.skins as { joints: number[] }[])[0].joints.push(99);
    expect(skinAudit(json).skins[0].joints).toEqual(['head', 'node 1', 'eye_R', 'node 99']);
  });
});
