import { describe, expect, it } from 'vitest';
import { Euler, Quaternion, Vector3 } from 'three';
import { applyOperation, createProject } from '../src/core/model.ts';
import { parseOperation, planOperations } from '../src/agent-contract.ts';

const rotated = (q: number[], v: Vector3) => v.clone().applyQuaternion(new Quaternion(...q as [number, number, number, number]));

describe('rotationEuler', () => {
  it('converts degrees to the stored quaternion on add', () => {
    const project = applyOperation(createProject('r'), { op: 'add', part: { name: 'a', rotationEuler: [90, 0, 0] } });
    const q = project.parts[0].rotation;
    // +x rotation takes +y toward +z (right-handed).
    const v = rotated(q, new Vector3(0, 1, 0));
    expect(v.toArray().map(n => +n.toFixed(6) + 0)).toEqual([0, 0, 1]);
    expect('rotationEuler' in project.parts[0]).toBe(false);
  });
  it('uses three.js XYZ order: world z first, then y, then x', () => {
    const project = applyOperation(createProject('r'), { op: 'add', part: { name: 'a', rotationEuler: [30, 40, 50] } });
    const expected = new Quaternion().setFromEuler(new Euler(30 * Math.PI / 180, 40 * Math.PI / 180, 50 * Math.PI / 180, 'XYZ'));
    const q = project.parts[0].rotation;
    expect(Math.abs(expected.dot(new Quaternion(...q as [number, number, number, number])))).toBeCloseTo(1, 6);
  });
  it('works on update and with anchors', () => {
    let project = applyOperation(createProject('r'), { op: 'add', part: { name: 'a' } });
    project = applyOperation(project, { op: 'update', name: 'a', changes: { rotationEuler: [0, 90, 0] } });
    expect(rotated(project.parts[0].rotation, new Vector3(0, 0, 1)).toArray().map(n => +n.toFixed(6) + 0)).toEqual([1, 0, 0]);
    let rig = applyOperation(createProject('r'), { op: 'bone.add', bone: { name: 'b' } });
    rig = applyOperation(rig, { op: 'add', part: { name: 'p', anchor: 'b', rotationEuler: [0, 0, 90] } });
    expect(rotated(rig.parts[0].rotation, new Vector3(1, 0, 0)).toArray().map(n => +n.toFixed(6) + 0)).toEqual([0, 1, 0]);
  });
  it('rejects giving both rotation and rotationEuler, and non-finite angles', () => {
    expect(() => applyOperation(createProject('r'), { op: 'add', part: { name: 'a', rotation: [0, 0, 0, 1], rotationEuler: [0, 0, 0] } })).toThrow(/rotationEuler.*rotation|rotation.*rotationEuler/);
    const project = applyOperation(createProject('r'), { op: 'add', part: { name: 'a' } });
    expect(() => applyOperation(project, { op: 'update', name: 'a', changes: { rotation: [0, 0, 0, 1], rotationEuler: [0, 0, 0] } })).toThrow(/both/i);
    expect(() => parseOperation({ op: 'add', part: { name: 'a', rotationEuler: [0, 'x', 0] } })).toThrow();
  });
  it('is accepted by parseOperation and planOperations', () => {
    const op = { op: 'add', part: { name: 'a', rotationEuler: [0, 45, 0] } };
    expect(parseOperation(op)).toEqual(op);
    expect(planOperations(createProject('r'), [op]).project.parts[0].rotation[1]).toBeCloseTo(Math.sin(Math.PI / 8), 6);
  });
});
