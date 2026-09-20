import { describe, expect, it } from 'vitest';
import { Box3, Mesh, SkinnedMesh, Vector3 } from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { applyOperation, createProject, validateProject } from '../src/core/model.ts';
import { buildScene } from '../src/render/scene.ts';
import { exportGLB, verifyGLB } from '../src/export.ts';
import { shellField } from '../src/render/shell.ts';

function twoSpheres(bound = true) {
  let p = createProject('blob');
  if (bound) {
    p = applyOperation(p, { op: 'bone.add', bone: { name: 'a', position: [-0.4, 0.5, 0] } });
    p = applyOperation(p, { op: 'bone.add', bone: { name: 'b', position: [0.4, 0.5, 0] } });
  }
  p = applyOperation(p, { op: 'add', part: { name: 'left', geometry: { type: 'sphere', size: [0.6, 0.6, 0.6] }, position: [-0.4, 0.5, 0], color: '#ff0000', ...(bound ? { binding: { type: 'rigid', bone: 'a' } } : {}) } });
  p = applyOperation(p, { op: 'add', part: { name: 'right', geometry: { type: 'sphere', size: [0.6, 0.6, 0.6] }, position: [0.4, 0.5, 0], color: '#0000ff', ...(bound ? { binding: { type: 'rigid', bone: 'b' } } : {}) } });
  return applyOperation(p, { op: 'shell.set', shell: { name: 'body', parts: ['left', 'right'], blend: 0.5, resolution: 32 } });
}

describe('organic shell', () => {
  it('stores a shell in the project and validates its members', () => {
    const p = twoSpheres();
    expect(p.shells).toEqual([{ name: 'body', parts: ['left', 'right'], blend: 0.5, resolution: 32 }]);
    expect(validateProject(JSON.parse(JSON.stringify(p)))).toEqual(p);
    expect(() => applyOperation(p, { op: 'shell.set', shell: { name: 'x', parts: ['left', 'nope'], blend: 0.1, resolution: 32 } })).toThrow(/Unknown shell part: nope/);
    expect(applyOperation(p, { op: 'shell.remove', name: 'body' }).shells).toEqual([]);
    expect(() => applyOperation(p, { op: 'shell.set', shell: { name: 'left', parts: ['left'], blend: 0.1, resolution: 32 } })).toThrow(/distinct/i);
    expect(() => applyOperation(p, { op: 'remove', name: 'left' })).toThrow(/shell body/);
  });

  it('blends the members into one field with a neck between them', () => {
    const p = twoSpheres();
    const field = shellField(p, p.shells![0]);
    // Each sphere centre is deep inside; the midpoint between them is inside only because of the blend.
    expect(field([-0.4, 0.5, 0])).toBeLessThan(-0.2);
    expect(field([0, 0.5, 0])).toBeLessThan(0);
    expect(field([0, 1.2, 0])).toBeGreaterThan(0);
    const sharp = shellField(p, { ...p.shells![0], blend: 0.001 });
    expect(sharp([0, 0.5, 0])).toBeGreaterThan(0);
  });

  it('renders the shell as one skinned mesh that replaces its members', () => {
    const built = buildScene(twoSpheres());
    try {
      const meshes: Mesh[] = []; built.root.traverse(o => { if (o instanceof Mesh) meshes.push(o); });
      expect(meshes.map(m => m.name)).toEqual(['body']);
      const shell = meshes[0];
      expect(shell).toBeInstanceOf(SkinnedMesh);
      const box = new Box3().setFromBufferAttribute(shell.geometry.getAttribute('position') as never);
      expect(box.min.x).toBeLessThan(-0.6); expect(box.max.x).toBeGreaterThan(0.6);
      expect(shell.geometry.getAttribute('color')).toBeTruthy();
      expect(shell.geometry.getAttribute('skinWeight')).toBeTruthy();
      // A vertex on the far left is red and owned by bone a; on the far right, blue and owned by b.
      const pos = shell.geometry.getAttribute('position'), col = shell.geometry.getAttribute('color'), idx = shell.geometry.getAttribute('skinIndex'), w = shell.geometry.getAttribute('skinWeight');
      let left = 0, right = 0;
      for (let i = 0; i < pos.count; i++) { if (pos.getX(i) < pos.getX(left)) left = i; if (pos.getX(i) > pos.getX(right)) right = i; }
      expect(col.getX(left)).toBeGreaterThan(0.9); expect(col.getZ(left)).toBeLessThan(0.1);
      expect(col.getZ(right)).toBeGreaterThan(0.9);
      const bones = [...built.bones.keys()];
      expect(bones[idx.getX(left)]).toBe('a'); expect(w.getX(left)).toBeGreaterThan(0.95);
      expect(bones[idx.getX(right)]).toBe('b'); expect(w.getX(right)).toBeGreaterThan(0.95);
    } finally { built.dispose(); }
  });

  it('darkens vertex colors in crevices with distance-field ambient occlusion', () => {
    const built = buildScene(twoSpheres(false));
    try {
      const shell = built.root.getObjectByName('body') as Mesh;
      const pos = shell.geometry.getAttribute('position'), col = shell.geometry.getAttribute('color');
      // The neck between the spheres sits near x = 0 at mid height; the outer poles are at |x| > 0.65.
      let neck = -1, pole = -1;
      for (let i = 0; i < pos.count; i++) {
        const x = pos.getX(i), y = pos.getY(i);
        if (Math.abs(x) < 0.06 && Math.abs(y - 0.5) < 0.08 && (neck < 0 || pos.getZ(i) > pos.getZ(neck))) neck = i;
        if (x > 0.6 && (pole < 0 || x > pos.getX(pole))) pole = i;
      }
      expect(neck).toBeGreaterThanOrEqual(0); expect(pole).toBeGreaterThanOrEqual(0);
      const brightness = (i: number) => col.getX(i) + col.getY(i) + col.getZ(i);
      expect(brightness(neck)).toBeLessThan(brightness(pole) * 0.85);
      expect(brightness(pole)).toBeGreaterThan(0.9);
    } finally { built.dispose(); }
  });

  it('renders an unbound shell as a plain mesh', () => {
    const built = buildScene(twoSpheres(false));
    try {
      const meshes: Mesh[] = []; built.root.traverse(o => { if (o instanceof Mesh) meshes.push(o); });
      expect(meshes).toHaveLength(1);
      expect(meshes[0]).not.toBeInstanceOf(SkinnedMesh);
      expect(meshes[0].geometry.getAttribute('normal')).toBeTruthy();
    } finally { built.dispose(); }
  });

  it('exports a shelled rig as a valid GLB whose only mesh is the shell', async () => {
    const bytes = await exportGLB(twoSpheres());
    expect((await verifyGLB(bytes)).errors).toBe(0);
    const gltf = await new GLTFLoader().parseAsync(bytes.slice().buffer, '');
    const names: string[] = []; gltf.scene.traverse(o => { if (o instanceof Mesh) names.push(o.name); });
    expect(names).toEqual(['body']);
  });

  it('produces the same geometry as before when no cut is given', () => {
    const built = buildScene(twoSpheres());
    try {
      const g = (built.root.getObjectByName('body') as Mesh).geometry;
      expect(g.getAttribute('position').count).toBe(648);
      expect(g.index!.count).toBe(3876);
    } finally { built.dispose(); }
  });
});

/** A red sphere with a thin green cylinder standing through its centre along y, subtracted by the shell. */
function pierced(bound = true) {
  let p = createProject('ring');
  if (bound) p = applyOperation(p, { op: 'bone.add', bone: { name: 'a', position: [0, 0.5, 0] } });
  p = applyOperation(p, { op: 'add', part: { name: 'ball', geometry: { type: 'sphere', size: [1, 1, 1] }, position: [0, 0.5, 0], color: '#ff0000', ...(bound ? { binding: { type: 'rigid', bone: 'a' } } : {}) } });
  p = applyOperation(p, { op: 'add', part: { name: 'drill', geometry: { type: 'cylinder', size: [0.3, 2, 0.3] }, position: [0, 0.5, 0], color: '#00ff00' } });
  return applyOperation(p, { op: 'shell.set', shell: { name: 'body', parts: ['ball'], cut: ['drill'], blend: 0.1, resolution: 32 } });
}

describe('shell cut', () => {
  it('stores cut parts and validates them against members', () => {
    const p = pierced();
    expect(p.shells![0].cut).toEqual(['drill']);
    expect(validateProject(JSON.parse(JSON.stringify(p)))).toEqual(p);
    expect(() => applyOperation(p, { op: 'shell.set', shell: { name: 'body', parts: ['ball'], cut: ['ball'], blend: 0.1, resolution: 32 } })).toThrow(/both a member and a cutter/i);
    expect(() => applyOperation(p, { op: 'shell.set', shell: { name: 'body', parts: ['ball'], cut: ['nope'], blend: 0.1, resolution: 32 } })).toThrow(/Unknown shell cutter: nope/);
    expect(() => applyOperation(p, { op: 'shell.set', shell: { name: 'body', parts: ['ball'], cut: ['drill', 'drill'], blend: 0.1, resolution: 32 } })).toThrow(/twice/);
    expect(() => applyOperation(p, { op: 'remove', name: 'drill' })).toThrow(/shell body/);
    expect(applyOperation(p, { op: 'shell.set', shell: { name: 'body', parts: ['ball'], blend: 0.1, resolution: 32 } }).shells![0].cut).toBeUndefined();
  });

  it('subtracts the cutter from the field so the centre is empty and the wall is inside', () => {
    const p = pierced();
    const field = shellField(p, p.shells![0]);
    expect(field([0, 0.5, 0])).toBeGreaterThan(0);
    expect(field([0, 0.9, 0])).toBeGreaterThan(0);
    expect(field([0.35, 0.5, 0])).toBeLessThan(0);
    expect(field([0, 0.5, -0.35])).toBeLessThan(0);
    const solid = shellField(p, { ...p.shells![0], cut: [] });
    expect(solid([0, 0.5, 0])).toBeLessThan(-0.4);
  });

  it('meshes the hole wall and takes colors and weights only from members', () => {
    const built = buildScene(pierced());
    try {
      const meshes: Mesh[] = []; built.root.traverse(o => { if (o instanceof Mesh) meshes.push(o); });
      expect(meshes.map(m => m.name)).toEqual(['body']);
      const g = meshes[0].geometry;
      const pos = g.getAttribute('position'), col = g.getAttribute('color'), idx = g.getAttribute('skinIndex'), w = g.getAttribute('skinWeight');
      let wall = 0;
      for (let i = 0; i < pos.count; i++) {
        const r = Math.hypot(pos.getX(i), pos.getZ(i));
        if (r < 0.25 && Math.abs(pos.getY(i) - 0.5) < 0.3) wall++;
        expect(col.getY(i)).toBeLessThan(0.05);
        expect(idx.getX(i)).toBe(0); expect(w.getX(i)).toBeCloseTo(1, 5);
      }
      expect(wall).toBeGreaterThan(20);
    } finally { built.dispose(); }
  });

  it('keeps the cutter out of the exported GLB', async () => {
    const bytes = await exportGLB(pierced(false));
    expect((await verifyGLB(bytes)).errors).toBe(0);
    const gltf = await new GLTFLoader().parseAsync(bytes.slice().buffer, '');
    const names: string[] = []; gltf.scene.traverse(o => { if (o instanceof Mesh) names.push(o.name); });
    expect(names).toEqual(['body']);
  });
});
