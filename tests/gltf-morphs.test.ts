import { describe, expect, it } from 'vitest';
import { ARKIT_FACE_REQUIRED_MORPHS } from '../src/arkit-face.ts';
import { auditMorphNames, morphNameAudit, readGltfJson, UE_FALLBACK_MORPH_NAME, type GltfJson } from '../src/gltf-morphs.ts';
import { verifyGLB } from '../src/export.ts';
import { arkitFaceFixtureGLB } from './fixtures/arkit-face-glb.ts';

const REQUIRED = [...ARKIT_FACE_REQUIRED_MORPHS];

describe('fixture layouts', () => {
  it('builds valid GLBs for the single, multi-primitive and multi-mesh layouts', async () => {
    for (const layout of ['single', 'primitives', 'meshes'] as const) {
      const verification = await verifyGLB(arkitFaceFixtureGLB({ layout }));
      expect(verification.errors, layout).toBe(0);
    }
    const primitives = readGltfJson(arkitFaceFixtureGLB({ layout: 'primitives' }));
    expect(primitives.meshes).toHaveLength(1);
    expect(primitives.meshes![0].primitives).toHaveLength(2);
    const meshes = readGltfJson(arkitFaceFixtureGLB({ layout: 'meshes' }));
    expect(meshes.meshes!.map(m => m.extras?.targetNames)).toEqual([REQUIRED, ['jawOpen']]);
  });
});

describe('morph name audit', () => {
  it('finds nothing wrong with one mesh, or one mesh carrying face and teeth as primitives', () => {
    for (const layout of ['single', 'primitives'] as const) {
      const audit = auditMorphNames(arkitFaceFixtureGLB({ layout }));
      expect(audit.issues, layout).toEqual([]);
      expect(audit.names).toEqual(REQUIRED);
    }
    expect(auditMorphNames(arkitFaceFixtureGLB({ layout: 'primitives' })).meshes).toEqual([
      { mesh: 0, name: 'Head', targetNames: REQUIRED, primitiveTargetCounts: [21, 21] },
    ]);
  });

  it('flags a morph name repeated across glTF meshes with one clear, actionable issue', () => {
    const audit = auditMorphNames(arkitFaceFixtureGLB({ layout: 'meshes' }));
    expect(audit.issues).toHaveLength(1);
    const [issue] = audit.issues;
    expect(issue).toMatchObject({ code: 'MORPH_NAME_SHARED_ACROSS_MESHES', names: ['jawOpen'], meshes: [0, 1] });
    expect(issue.message).toContain('"jawOpen" (mesh 0 "Face", mesh 1 "Teeth")');
    expect(issue.message).toContain('GLTFAsset.cpp');
    expect(issue.message).toMatch(/discards every morph target name in the file/);
    expect(issue.message).toMatch(/one glTF mesh as separate primitives/);
  });

  it('accepts meshes whose morph names are disjoint', () => {
    const audit = auditMorphNames(arkitFaceFixtureGLB({ layout: 'meshes', morphs: REQUIRED.filter(n => n !== 'jawOpen') }));
    expect(audit.issues).toEqual([]);
    expect(audit.names).toEqual([...REQUIRED.filter(n => n !== 'jawOpen'), 'jawOpen']);
  });

  it('flags the other name layouts UE rejects: duplicates in a mesh, a count mismatch, uneven primitives, no names', () => {
    const targets = (n: number) => Array.from({ length: n }, () => ({ POSITION: 0 }));
    const json: GltfJson = {
      meshes: [
        { name: 'Dup', extras: { targetNames: ['a', 'a'] }, primitives: [{ targets: targets(2) }] },
        { name: 'Short', extras: { targetNames: ['b'] }, primitives: [{ targets: targets(2) }] },
        { name: 'Uneven', extras: { targetNames: ['c', 'd'] }, primitives: [{ targets: targets(2) }, { targets: targets(1) }] },
        { name: 'Anon', primitives: [{ targets: targets(1) }] },
        { name: 'Static', primitives: [{}] },
      ],
    };
    expect(morphNameAudit(json).issues.map(i => [i.code, i.meshes])).toEqual([
      ['MORPH_NAME_DUPLICATE_IN_MESH', [0]],
      ['MORPH_NAMES_COUNT_MISMATCH', [1]],
      ['MORPH_TARGET_COUNT_VARIES', [2]],
      ['MORPH_NAMES_MISSING', [3]],
    ]);
  });

  it('reads .gltf JSON text as well as GLB, and rejects bytes that are neither', () => {
    const glb = arkitFaceFixtureGLB();
    const text = new TextEncoder().encode(JSON.stringify(readGltfJson(glb)));
    expect(auditMorphNames(text).names).toEqual(REQUIRED);
    expect(() => readGltfJson(new TextEncoder().encode('garbage bytes'))).toThrow(expect.objectContaining({ code: 'GLTF_UNREADABLE' }));
    expect(() => readGltfJson(glb.subarray(0, 30))).toThrow(expect.objectContaining({ code: 'GLTF_UNREADABLE' }));
  });

  it('recognizes the names UE generates when it throws the glTF names away', () => {
    expect(UE_FALLBACK_MORPH_NAME.test('good_mesh_0_12_MorphTarget')).toBe(true);
    expect(UE_FALLBACK_MORPH_NAME.test('good head copy_mesh_1_0_MorphTarget')).toBe(true);
    expect(UE_FALLBACK_MORPH_NAME.test('jawOpen')).toBe(false);
  });
});
