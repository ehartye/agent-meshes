import { describe, expect, it } from 'vitest';
import { capabilities, inspectProject, operationSchemas, parseOperation, planOperations } from '../src/agent-contract.ts';
import { applyOperation, createProject } from '../src/core/model.ts';

function fixture() {
  let project = createProject('contract');
  project = applyOperation(project, { op: 'bone.add', bone: { name: 'root' } });
  project = applyOperation(project, { op: 'add', part: { name: 'body', binding: { type: 'rigid', bone: 'root' } } });
  return applyOperation(project, { op: 'clip.set', clip: { name: 'idle', duration: 1, tracks: [{ bone: 'root', property: 'rotation', keys: [{ time: 0, value: [0, 0, 0, 1] }, { time: 1, value: [0, 0, 0, 1] }] }] } });
}

describe('agent authoring contract', () => {
  it('publishes serializable schemas and valid examples for every supported operation', () => {
    const expected = ['add', 'update', 'remove', 'bone.add', 'bone.update', 'bone.remove', 'bone.mirror', 'pose', 'pose.reset', 'bind', 'unbind', 'clip.set', 'clip.remove'];
    const contract = capabilities();
    expect(contract.version).toBe(1);
    expect(Object.keys(operationSchemas).sort()).toEqual(expected.sort());
    expect(Object.keys(contract.operations).sort()).toEqual(expected.sort());
    for (const descriptor of Object.values(contract.operations)) {
      expect(descriptor.schema.type).toBe('object');
      expect(descriptor.examples.length).toBeGreaterThan(0);
      for (const example of descriptor.examples) expect(parseOperation(example)).toEqual(example);
    }
    expect(JSON.parse(JSON.stringify(contract))).toEqual(contract);
    expect(() => parseOperation({ op: 'add', part: { name: 'thing', geometry: { type: 'box', size: [-1, 1, 1] } } })).toThrow();
    expect(() => parseOperation({ op: 'pose', name: 'root', rotation: [0, 0, 0, 2] })).toThrow();
    expect(() => parseOperation({ op: 'pose.reset', typo: true })).toThrow();
  });

  it('inspects compact summaries and exact selections without exposing mutable state', () => {
    const project = fixture(), before = structuredClone(project);
    const summary = inspectProject(project);
    expect(summary.counts).toMatchObject({ parts: 1, bones: 1, clips: 1, tracks: 1, keys: 2, boundParts: 1 });
    expect(summary.parts).toEqual([expect.objectContaining({ name: 'body', parent: null, binding: { type: 'rigid', bones: ['root'] } })]);
    expect(summary.clips).toEqual([expect.objectContaining({ name: 'idle', duration: 1, tracks: 1, keys: 2 })]);
    const selected = inspectProject(project, 'body');
    expect(selected.selection).toEqual({ kind: 'part', entity: project.parts[0] });
    (selected.selection!.entity as typeof project.parts[number]).position[0] = 100;
    expect(inspectProject(project, 'bone:root').selection).toEqual({ kind: 'bone', entity: project.bones[0] });
    expect(() => inspectProject(project, 'missing')).toThrow(/missing/i);
    expect(project).toEqual(before);
  });

  it('disambiguates clip names from parts and keeps large weight/key arrays out of summaries', () => {
    const project = fixture();
    project.clips[0].name = 'body';
    expect(() => inspectProject(project, 'body')).toThrow(/ambiguous/i);
    expect(inspectProject(project, 'clip:body').selection).toEqual({ kind: 'clip', entity: project.clips[0] });
    const summary = inspectProject(project);
    expect(summary.parts[0]).not.toHaveProperty('geometry');
    expect(summary.clips[0].keys).toBe(2);
  });

  it('plans atomic changes using real state validation and reports the changed names', () => {
    const project = fixture(), before = structuredClone(project);
    const result = planOperations(project, [
      { op: 'update', name: 'body', changes: { color: '#123456' } },
      { op: 'add', part: { name: 'hat' } },
      { op: 'clip.remove', name: 'idle' },
    ]);
    expect(result.report).toEqual({ ok: true, operations: 3, changes: {
      parts: { added: ['hat'], removed: [], updated: ['body'] },
      bones: { added: [], removed: [], updated: [] },
      clips: { added: [], removed: ['idle'], updated: [] },
    } });
    expect(result.project.parts[0].color).toBe('#123456');
    expect(project).toEqual(before);
    expect(planOperations(project, []).project).toEqual(project);
    expect(planOperations(project, []).project).not.toBe(project);
  });

  it('detects hierarchy cycles and leaves no changes from a partially valid plan', () => {
    const project = createProject('hierarchy');
    expect(() => planOperations(project, [
      { op: 'add', part: { name: 'parent', geometry: { type: 'group' } } },
      { op: 'add', part: { name: 'child', parent: 'parent' } },
      { op: 'update', name: 'parent', changes: { parent: 'child' } },
    ])).toThrow(/Operation 2:.*cycle/i);
    expect(project.parts).toEqual([]);
    expect(() => planOperations(project, null as unknown as unknown[])).toThrow(/array/i);
  });

  it('reports the failing zero-based index, original cause and schema issues without changing input', () => {
    const project = fixture(), before = structuredClone(project);
    for (const operation of [
      { op: 'update', name: 'body', changes: { geometry: { type: 'box', size: [2, 2, 2], segments: 12 } } },
      { op: 'add', part: { name: 'child', parent: 'missing' } },
      { op: 'pose', name: 'root', rotation: [0, 0, 0, 2] },
    ]) {
      let error: unknown;
      try { planOperations(project, [{ op: 'add', part: { name: 'candidate' } }, operation]); } catch (caught) { error = caught; }
      expect(error).toBeInstanceOf(Error);
      expect(error).toMatchObject({ operationIndex: 1, cause: expect.any(Error) });
      if (operation.op === 'pose') expect(error).toMatchObject({ issues: expect.arrayContaining([expect.objectContaining({ path: ['rotation'] })]) });
      expect(project).toEqual(before);
    }
  });
});
