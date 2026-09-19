import { describe, it, expect } from 'vitest';
import { createProject, applyOperation, validateProject, Editor } from '../src/core/model.ts';

describe('named model authoring', () => {
  it('creates, edits and restores named parts without mutating prior state', () => {
    const initial = createProject('robot');
    const added = applyOperation(initial, { op: 'add', part: { name: 'head', geometry: { type: 'box', size: [1, 2, 3] } } });
    expect(initial.parts).toHaveLength(0);
    expect(added.parts[0].position).toEqual([0, 0, 0]);
    const moved = applyOperation(added, { op: 'update', name: 'head', changes: { position: [0, 2, 0] } });
    expect(moved.parts[0].position).toEqual([0, 2, 0]);
    expect(added.parts[0].position).toEqual([0, 0, 0]);
    expect(validateProject(JSON.parse(JSON.stringify(moved)))).toEqual(moved);
  });
  it('rejects invalid edits atomically and preserves undo/redo', () => {
    const editor = new Editor(createProject('robot'));
    editor.apply({ op: 'add', part: { name: 'head' } });
    expect(() => editor.apply({ op: 'add', part: { name: 'head' } })).toThrow(/duplicate/i);
    expect(() => editor.apply({ op: 'update', name: 'head', changes: { position: [NaN, 0, 0] } })).toThrow();
    expect(editor.project.parts).toHaveLength(1);
    editor.undo(); expect(editor.project.parts).toHaveLength(0);
    editor.redo(); expect(editor.project.parts).toHaveLength(1);
    editor.undo(); editor.apply({ op: 'add', part: { name: 'body' } });
    expect(() => editor.redo()).toThrow(/redo/i);
  });
  it('checks hierarchy cycles, dangling references and geometry bounds', () => {
    let p = createProject('robot');
    p = applyOperation(p, { op: 'add', part: { name: 'body', geometry: { type: 'group' } } });
    p = applyOperation(p, { op: 'add', part: { name: 'head', parent: 'body' } });
    expect(() => applyOperation(p, { op: 'update', name: 'body', changes: { parent: 'head' } })).toThrow(/cycle/i);
    expect(() => applyOperation(p, { op: 'remove', name: 'body' })).toThrow(/child/i);
    expect(() => applyOperation(p, { op: 'add', part: { name: 'bad', parent: 'missing' } })).toThrow(/parent/i);
    expect(() => applyOperation(p, { op: 'add', part: { name: 'bad', geometry: { type: 'sphere', size: [-1, 1, 1] } } })).toThrow();
    expect(() => validateProject({ ...p, version: 42 })).toThrow();
  });
});
