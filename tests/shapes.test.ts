import { describe, expect, it } from 'vitest';
import { Box3, Vector3 } from 'three';
import { applyOperation, createProject, validateProject } from '../src/core/model.ts';
import { geometryFor } from '../src/geometry.ts';
import { exportGLB, verifyGLB } from '../src/export.ts';
import { parseOperation } from '../src/agent-contract.ts';

const box = (part: Parameters<typeof geometryFor>[0]) => new Box3().setFromBufferAttribute(geometryFor(part).getAttribute('position') as never).getSize(new Vector3()).toArray().map(v => +v.toFixed(4));

describe('lathe and prism shapes', () => {
  it('revolves a unit profile and scales it to size', () => {
    // A vase: narrow foot, wide belly, narrow neck. Profile is [radius, height] in unit space (radius 0..0.5, height -0.5..0.5).
    const project = applyOperation(createProject('vase'), { op: 'add', part: { name: 'vase', geometry: { type: 'lathe', size: [0.4, 1.2, 0.4], segments: 24, profile: [[0.15, -0.5], [0.5, -0.1], [0.3, 0.3], [0.2, 0.5]] } } });
    const part = project.parts[0];
    expect(part.geometry.profile).toHaveLength(4);
    expect(box(part)).toEqual([0.4, 1.2, 0.4]);
    expect(geometryFor(part).getAttribute('position').count).toBeGreaterThan(24 * 4);
  });

  it('extrudes a unit outline along z and scales it to size', () => {
    // A flat star-ish cut-out, 0.05 thick. Outline is [x, y] in unit space (-0.5..0.5), extruded from z -0.5 to 0.5.
    const outline: [number, number][] = [[0, 0.5], [0.15, 0.1], [0.5, 0.1], [0.2, -0.15], [0.3, -0.5], [0, -0.25], [-0.3, -0.5], [-0.2, -0.15], [-0.5, 0.1], [-0.15, 0.1]];
    const project = applyOperation(createProject('star'), { op: 'add', part: { name: 'star', geometry: { type: 'prism', size: [1, 1, 0.05], outline } } });
    expect(box(project.parts[0])).toEqual([1, 1, 0.05]);
    const positions = geometryFor(project.parts[0]).getAttribute('position');
    const zs = new Set<number>(); for (let i = 0; i < positions.count; i++) zs.add(+positions.getZ(i).toFixed(4));
    expect([...zs].sort()).toEqual([-0.025, 0.025]);
  });

  it('rejects a lathe without a profile, a box with one, and degenerate profiles', () => {
    expect(() => applyOperation(createProject('x'), { op: 'add', part: { name: 'a', geometry: { type: 'lathe' } } })).toThrow(/profile/i);
    expect(() => applyOperation(createProject('x'), { op: 'add', part: { name: 'a', geometry: { type: 'box', profile: [[0, 0], [1, 1], [0, 1]] } } })).toThrow(/profile/i);
    expect(() => applyOperation(createProject('x'), { op: 'add', part: { name: 'a', geometry: { type: 'prism' } } })).toThrow(/outline/i);
    expect(() => applyOperation(createProject('x'), { op: 'add', part: { name: 'a', geometry: { type: 'lathe', profile: [[0.1, -0.5], [0.2, 0.5]] } } })).toThrow(/at least 3/i);
    expect(() => applyOperation(createProject('x'), { op: 'add', part: { name: 'a', geometry: { type: 'lathe', profile: [[-0.1, -0.5], [0.2, 0], [0.2, 0.5]] } } })).toThrow(/radius/i);
  });

  it('exports both shapes as valid GLB and publishes them in the contract', async () => {
    let project = applyOperation(createProject('shapes'), { op: 'add', part: { name: 'bird', geometry: { type: 'lathe', size: [0.3, 1.5, 0.3], profile: [[0.02, -0.5], [0.18, -0.1], [0.5, 0.15], [0.3, 0.42], [0.05, 0.5]] } } });
    project = applyOperation(project, { op: 'add', part: { name: 'cutout', geometry: { type: 'prism', size: [0.6, 0.9, 0.04], outline: [[-0.5, -0.5], [0.5, -0.5], [0.5, 0.5], [-0.5, 0.5]] }, position: [1, 0.5, 0] } });
    const report = await verifyGLB(await exportGLB(project));
    expect(report.errors).toBe(0);
    expect(parseOperation({ op: 'add', part: { name: 'p', geometry: { type: 'prism', outline: [[-0.5, -0.5], [0.5, -0.5], [0, 0.5]] } } })).toBeTruthy();
    expect(validateProject(JSON.parse(JSON.stringify(project)))).toEqual(project);
  });
});

describe('anchoring a part to a bone', () => {
  function rig() {
    let p = createProject('rig');
    p = applyOperation(p, { op: 'bone.add', bone: { name: 'arm', position: [0, 2, 0], rotation: [0, 0.7071068, 0, 0.7071068] } });
    return applyOperation(p, { op: 'bone.add', bone: { name: 'hand', parent: 'arm', position: [1, 0, 0] } });
  }
  it('places the part in the bone rest frame and stores world coordinates', () => {
    const project = applyOperation(rig(), { op: 'add', part: { name: 'ring', anchor: 'hand', position: [0, -0.5, 0], geometry: { type: 'box', size: [0.1, 0.1, 0.1] }, binding: { type: 'rigid', bone: 'hand' } } });
    const ring = project.parts[0];
    // arm is rotated 90 degrees about y, so the hand sits at world (0, 2, -1); half a metre below it is (0, 1.5, -1).
    expect(ring.position.map(v => +v.toFixed(6) + 0)).toEqual([0, 1.5, -1]);
    expect(ring.rotation.map(v => +v.toFixed(6))).toEqual([0, 0.707107, 0, 0.707107]);
    expect('anchor' in ring).toBe(false);
    expect(validateProject(JSON.parse(JSON.stringify(project)))).toEqual(project);
  });
  it('composes the part rotation after the bone rotation and rejects unknown anchors', () => {
    const project = applyOperation(rig(), { op: 'add', part: { name: 'blade', anchor: 'arm', rotation: [0, 0.7071068, 0, 0.7071068] } });
    expect(project.parts[0].rotation.map(v => +v.toFixed(6))).toEqual([0, 1, 0, 0]);
    expect(() => applyOperation(rig(), { op: 'add', part: { name: 'x', anchor: 'tail' } })).toThrow(/Unknown anchor bone: tail/);
  });
});
