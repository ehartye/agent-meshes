import { describe, expect, it } from 'vitest';
import { Color, Mesh, MeshStandardMaterial } from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { applyOperation, createProject, validateProject } from '../src/core/model.ts';
import { applyOperations } from '../src/agent-contract.ts';
import { exportGLB, verifyGLB } from '../src/export.ts';
import { buildScene } from '../src/render/scene.ts';
import { readGLB } from '../src/gltf-read.ts';
import type { Project } from '../src/core/types.ts';

const lamp = { metalness: 0, roughness: 0.4, emissive: '#ff8800', emissiveStrength: 4 };

function lantern(): Project {
  let p = createProject('lantern');
  p = applyOperation(p, { op: 'add', part: { name: 'frame', geometry: { type: 'box', size: [0.3, 0.4, 0.3] }, color: '#334455' } });
  p = applyOperation(p, { op: 'add', part: { name: 'flame', geometry: { type: 'sphere', size: [0.1, 0.1, 0.1] }, color: '#ffcc66', material: lamp } });
  p = applyOperation(p, { op: 'add', part: { name: 'dim', geometry: { type: 'sphere', size: [0.1, 0.1, 0.1] }, position: [0.3, 0, 0], color: '#ffcc66', material: { emissive: '#ff8800', emissiveStrength: 0.5 } } });
  p = applyOperation(p, { op: 'add', part: { name: 'plain', geometry: { type: 'sphere', size: [0.1, 0.1, 0.1] }, position: [-0.3, 0, 0], color: '#ffcc66', material: { emissive: '#00aaff' } } });
  return p;
}
const materialOf = (bytes: Uint8Array, node: string) => {
  const doc = readGLB(bytes);
  return doc.json.materials![doc.json.meshes![doc.json.nodes!.find(n => n.name === node)!.mesh!].primitives[0].material!] as Record<string, any>;
};
const linear = (hex: string) => new Color(hex).toArray();

describe('emissive materials in the operation model', () => {
  it('stores emissive and emissiveStrength and leaves other finishes unchanged', () => {
    const p = lantern();
    expect(p.parts[1].material).toEqual({ metalness: 0, roughness: 0.4, emissive: '#ff8800', emissiveStrength: 4 });
    expect(p.parts[3].material).toEqual({ metalness: 0, roughness: 0.65, emissive: '#00aaff' });
    expect(p.parts[0].material).toBeUndefined();
    expect(validateProject(JSON.parse(JSON.stringify(p)))).toEqual(p);
    const shell = applyOperation(p, { op: 'shell.set', shell: { name: 'dome', parts: ['frame'], blend: 0.1, resolution: 16, material: { emissive: '#ffffff' } } });
    expect(shell.shells![0].material).toEqual({ metalness: 0, roughness: 0.65, emissive: '#ffffff' });
  });

  it('rejects a malformed colour, a negative or huge strength, and a strength with no colour', () => {
    const p = lantern();
    for (const material of [{ emissive: 'orange' }, { emissive: '#fa0' }, { emissive: '#ff8800', emissiveStrength: -1 }, { emissive: '#ff8800', emissiveStrength: 1001 }, { emissiveStrength: 2 }]) {
      expect(() => applyOperation(p, { op: 'update', name: 'frame', changes: { material: material as never } }), JSON.stringify(material)).toThrow();
    }
  });

  it('replaces the whole finish on update, so omitting emissive turns the glow off', () => {
    const off = applyOperation(lantern(), { op: 'update', name: 'flame', changes: { material: { metalness: 0, roughness: 0.4 } } });
    expect(off.parts[1].material).toEqual({ metalness: 0, roughness: 0.4 });
  });

  it('is accepted by the published batch contract', () => {
    const result = applyOperations(createProject('x'), [{ op: 'add', part: { name: 'bulb', color: '#ffffff', material: lamp } }]);
    expect(result.parts[0].material).toEqual(lamp);
  });
});

describe('emissive materials in the scene builder', () => {
  it('sets the emissive colour and intensity, and leaves other parts dark', () => {
    const built = buildScene(lantern());
    try {
      const flame = (built.objects.get('flame') as Mesh).material as MeshStandardMaterial;
      expect(flame.emissive.getHexString()).toBe('ff8800');
      expect(flame.emissiveIntensity).toBe(4);
      expect(((built.objects.get('plain') as Mesh).material as MeshStandardMaterial).emissiveIntensity).toBe(1);
      expect(((built.objects.get('frame') as Mesh).material as MeshStandardMaterial).emissive.getHex()).toBe(0);
    } finally { built.dispose(); }
  });
});

describe('emissive materials in the exported GLB', () => {
  it('writes emissiveFactor, and KHR_materials_emissive_strength only when the strength is not 1, with 0 validator errors and warnings', async () => {
    const bytes = await exportGLB(lantern());
    const report = await verifyGLB(bytes);
    expect((report.issues.messages as { severity: number }[]).filter(m => m.severity <= 1)).toEqual([]);
    expect(report.errors).toBe(0);
    expect(report.warnings).toBe(0);
    const flame = materialOf(bytes, 'flame');
    flame.emissiveFactor.forEach((n: number, i: number) => expect(n).toBeCloseTo(linear('#ff8800')[i], 5));
    expect(flame.extensions.KHR_materials_emissive_strength.emissiveStrength).toBe(4);
    const plain = materialOf(bytes, 'plain');
    plain.emissiveFactor.forEach((n: number, i: number) => expect(n).toBeCloseTo(linear('#00aaff')[i], 5));
    expect(plain.extensions?.KHR_materials_emissive_strength).toBeUndefined();
    expect(materialOf(bytes, 'dim').extensions.KHR_materials_emissive_strength.emissiveStrength).toBe(0.5);
    expect(materialOf(bytes, 'frame').emissiveFactor).toBeUndefined();
    expect((readGLB(bytes).json as { extensionsUsed?: string[] }).extensionsUsed).toContain('KHR_materials_emissive_strength');
  });

  it('keeps parts that differ only in emissive on separate materials, and shares identical ones', async () => {
    let p = lantern();
    p = applyOperation(p, { op: 'add', part: { name: 'flame2', geometry: { type: 'sphere', size: [0.1, 0.1, 0.1] }, position: [0, 0.3, 0], color: '#ffcc66', material: lamp } });
    const doc = readGLB(await exportGLB(p));
    const used = (name: string) => doc.json.meshes![doc.json.nodes!.find(n => n.name === name)!.mesh!].primitives[0].material;
    expect(used('flame2')).toBe(used('flame'));
    expect(new Set([used('flame'), used('dim'), used('plain'), used('frame')]).size).toBe(4);
  });

  it('survives merging by material', async () => {
    const bytes = await exportGLB(lantern(), { merge: 'byMaterial' });
    const strengths = (readGLB(bytes).json.materials as Record<string, any>[]).map(m => m.extensions?.KHR_materials_emissive_strength?.emissiveStrength ?? null);
    expect(strengths.filter(s => s === 4)).toHaveLength(1);
    expect(strengths.filter(s => s === 0.5)).toHaveLength(1);
  });

  it('loads back with the colour and intensity, as the preview page does', async () => {
    const bytes = await exportGLB(lantern());
    const gltf = await new GLTFLoader().parseAsync(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer, '');
    const materials = new Map<string, MeshStandardMaterial>();
    gltf.scene.traverse(o => { if (o instanceof Mesh) materials.set(o.name, o.material as MeshStandardMaterial); });
    expect(materials.get('flame')!.emissive.getHexString()).toBe('ff8800');
    expect(materials.get('flame')!.emissiveIntensity).toBe(4);
    expect(materials.get('dim')!.emissiveIntensity).toBeCloseTo(0.5);
  });
});
