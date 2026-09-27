import { describe, expect, it } from 'vitest';
import { DoubleSide, FrontSide, Mesh, MeshPhysicalMaterial, MeshStandardMaterial } from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { applyOperation, createProject, validateProject } from '../src/core/model.ts';
import { exportGLB, verifyGLB } from '../src/export.ts';
import { buildScene } from '../src/render/scene.ts';
import { readGLB } from '../src/gltf-read.ts';
import type { Project } from '../src/core/types.ts';
import { createPuppet } from '../src/render/puppet.ts';
import { prepareGlass } from '../src/render/glass.ts';
import { addOutlines } from '../src/web/room.ts';

const glass = { metalness: 0, roughness: 0.05, opacity: 0.2, ior: 1.5, doubleSided: true };

function helmet(): Project {
  let p = createProject('helmet');
  p = applyOperation(p, { op: 'add', part: { name: 'head', geometry: { type: 'sphere', size: [0.3, 0.3, 0.3] }, color: '#c08060' } });
  p = applyOperation(p, { op: 'add', part: { name: 'bubble', geometry: { type: 'sphere', size: [0.4, 0.4, 0.4] }, color: '#dff4ff', material: glass } });
  p = applyOperation(p, { op: 'add', part: { name: 'lens', geometry: { type: 'sphere', size: [0.1, 0.1, 0.1] }, position: [0.4, 0, 0], color: '#ffffff', material: { roughness: 0, transmission: 1, ior: 1.45 } } });
  return p;
}

describe('glass materials in the operation model', () => {
  it('stores opacity, transmission, ior and doubleSided, and leaves opaque finishes unchanged', () => {
    const p = helmet();
    expect(p.parts[1].material).toEqual(glass);
    expect(p.parts[2].material).toEqual({ metalness: 0, roughness: 0, transmission: 1, ior: 1.45 });
    expect(p.parts[0].material).toBeUndefined();
    expect(validateProject(JSON.parse(JSON.stringify(p)))).toEqual(p);
    const shell = applyOperation(p, { op: 'shell.set', shell: { name: 'dome', parts: ['head'], blend: 0.1, resolution: 16, material: { opacity: 0.4 } } });
    expect(shell.shells![0].material).toEqual({ metalness: 0, roughness: 0.65, opacity: 0.4 });
  });
  it('rejects out-of-range glass values', () => {
    const p = helmet();
    for (const material of [{ opacity: 1.2 }, { opacity: -0.1 }, { transmission: 2 }, { ior: 0.5 }, { ior: 3 }, { doubleSided: 'yes' }]) {
      expect(() => applyOperation(p, { op: 'update', name: 'head', changes: { material: material as never } })).toThrow();
    }
  });
});

describe('glass in the scene builder', () => {
  it('makes a translucent, double-sided material that does not write depth, and a physical one for transmission', () => {
    const built = buildScene(helmet());
    try {
      const bubble = (built.objects.get('bubble') as Mesh).material as MeshStandardMaterial;
      expect(bubble.transparent).toBe(true);
      expect(bubble.opacity).toBeCloseTo(0.2);
      expect(bubble.depthWrite).toBe(false);
      expect(bubble.side).toBe(DoubleSide);
      const lens = (built.objects.get('lens') as Mesh).material as MeshPhysicalMaterial;
      expect(lens).toBeInstanceOf(MeshPhysicalMaterial);
      expect(lens.transmission).toBe(1);
      expect(lens.ior).toBeCloseTo(1.45);
      const head = (built.objects.get('head') as Mesh).material as MeshStandardMaterial;
      expect(head.transparent).toBe(false);
      expect(head.depthWrite).toBe(true);
      expect(head.side).toBe(FrontSide);
      expect(head).not.toBeInstanceOf(MeshPhysicalMaterial);
      // Glass must not throw a solid shadow over the face it covers.
      expect(built.objects.get('bubble')!.castShadow).toBe(false);
      expect(built.objects.get('head')!.castShadow).toBe(true);
    } finally { built.dispose(); }
  });
});

describe('glass in the exported GLB', () => {
  it('writes alphaMode BLEND, doubleSided, KHR_materials_transmission and KHR_materials_ior with 0 validator errors and warnings', async () => {
    const bytes = await exportGLB(helmet());
    const report = await verifyGLB(bytes);
    expect((report.issues.messages as { severity: number }[]).filter(m => m.severity <= 1)).toEqual([]);
    expect(report.errors).toBe(0);
    expect(report.warnings).toBe(0);
    const doc = readGLB(bytes);
    const byMesh = (name: string) => doc.json.materials![doc.json.meshes![doc.json.nodes!.find(n => n.name === name)!.mesh!].primitives[0].material!] as Record<string, any>;
    const bubble = byMesh('bubble');
    expect(bubble.alphaMode).toBe('BLEND');
    expect(bubble.doubleSided).toBe(true);
    expect(bubble.pbrMetallicRoughness.baseColorFactor[3]).toBeCloseTo(0.2);
    const lens = byMesh('lens');
    expect(lens.alphaMode ?? 'OPAQUE').toBe('OPAQUE');
    expect(lens.extensions.KHR_materials_transmission.transmissionFactor).toBe(1);
    expect(lens.extensions.KHR_materials_ior.ior).toBeCloseTo(1.45);
    expect((doc.json as { extensionsUsed?: string[] }).extensionsUsed).toEqual(expect.arrayContaining(['KHR_materials_transmission', 'KHR_materials_ior']));
    const head = byMesh('head');
    expect(head.alphaMode ?? 'OPAQUE').toBe('OPAQUE');
    expect(head.doubleSided ?? false).toBe(false);
  });
  it('round-trips through the plain three.js GLTFLoader as see-through glass', async () => {
    const bytes = await exportGLB(helmet());
    const gltf = await new GLTFLoader().parseAsync(bytes.slice().buffer as ArrayBuffer, '');
    const bubble = (gltf.scene.getObjectByName('bubble') as Mesh).material as MeshStandardMaterial;
    expect(bubble.transparent).toBe(true);
    expect(bubble.depthWrite).toBe(false);
    expect(bubble.opacity).toBeCloseTo(0.2);
    expect(bubble.side).toBe(DoubleSide);
    const lens = (gltf.scene.getObjectByName('lens') as Mesh).material as MeshPhysicalMaterial;
    expect(lens.transmission).toBe(1);
  });
});

describe('glass in the viewer runtime', () => {
  async function loaded() {
    const bytes = await exportGLB(helmet());
    const gltf = await new GLTFLoader().parseAsync(bytes.slice().buffer as ArrayBuffer, '');
    gltf.scene.traverse(object => { object.castShadow = true; object.receiveShadow = true; });
    return gltf;
  }
  it('prepareGlass stops glass casting shadows and tags it, leaving opaque parts alone', async () => {
    const gltf = await loaded();
    expect(prepareGlass(gltf.scene).sort()).toEqual(['bubble', 'lens']);
    const bubble = gltf.scene.getObjectByName('bubble')!, head = gltf.scene.getObjectByName('head')!;
    expect(bubble.castShadow).toBe(false); expect(bubble.receiveShadow).toBe(true); expect(bubble.userData.glass).toBe(true);
    expect(head.castShadow).toBe(true); expect(head.userData.glass).toBeUndefined();
  });
  it('draws no ink outline hull for glass, which would show through it', async () => {
    const puppet = createPuppet(await loaded());
    const hulls = addOutlines(puppet, 0.01);
    expect(hulls.map(h => h.name).sort()).toEqual(['head_outline']);
  });
});

describe('auditGlass', () => {
  it('lists blended and transmissive materials from GLB bytes, not opaque ones', async () => {
    const { auditGlass } = await import('../src/gltf-materials.ts');
    const glassy = auditGlass(await exportGLB(helmet()));
    expect(glassy.map(g => ({ alphaMode: g.alphaMode, opacity: Number(g.opacity.toFixed(3)), transmission: g.transmission, doubleSided: g.doubleSided }))).toEqual([
      { alphaMode: 'BLEND', opacity: 0.2, transmission: 0, doubleSided: true },
      { alphaMode: 'OPAQUE', opacity: 1, transmission: 1, doubleSided: false },
    ]);
    let plain = createProject('plain');
    plain = applyOperation(plain, { op: 'add', part: { name: 'box' } });
    expect(auditGlass(await exportGLB(plain))).toEqual([]);
  });
});
