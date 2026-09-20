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
  it('stores a surface pattern on parts and shells, clears it with null, and rejects bad sizes', () => {
    const dots = { type: 'dots' as const, color: '#ffffff', size: 0.1 };
    let p = applyOperation(createProject('nana'), { op: 'add', part: { name: 'body', pattern: dots } });
    expect(p.parts[0].pattern).toEqual(dots);
    p = applyOperation(p, { op: 'update', name: 'body', changes: { pattern: { ...dots, type: 'stripes', axis: 'x', offset: [0, 0.05, 0] } } });
    expect(p.parts[0].pattern).toEqual({ ...dots, type: 'stripes', axis: 'x', offset: [0, 0.05, 0] });
    p = applyOperation(p, { op: 'add', part: { name: 'head', position: [0, 1, 0] } });
    p = applyOperation(p, { op: 'shell.set', shell: { name: 'skin', parts: ['body', 'head'], blend: 0.1, resolution: 16, pattern: dots } });
    expect(p.shells![0].pattern).toEqual(dots);
    expect(validateProject(JSON.parse(JSON.stringify(p)))).toEqual(p);
    p = applyOperation(p, { op: 'update', name: 'body', changes: { pattern: null } });
    expect(p.parts[0]).not.toHaveProperty('pattern');
    expect(() => applyOperation(p, { op: 'update', name: 'body', changes: { pattern: { ...dots, size: 0 } } })).toThrow();
    expect(() => applyOperation(p, { op: 'update', name: 'body', changes: { pattern: { ...dots, type: 'hearts' as never } } })).toThrow();
    expect(() => applyOperation(p, { op: 'update', name: 'body', changes: { pattern: { ...dots, color: 'red' } } })).toThrow();
  });
});

describe('part materials', () => {
  it('stores optional metalness and roughness on add, update and shell.set, defaulting metalness to 0', () => {
    let p = applyOperation(createProject('koons'), { op: 'add', part: { name: 'balloon', material: { metalness: 1, roughness: 0.1 } } });
    expect(p.parts[0].material).toEqual({ metalness: 1, roughness: 0.1 });
    p = applyOperation(p, { op: 'add', part: { name: 'plain' } });
    expect(p.parts[1].material).toBeUndefined();
    p = applyOperation(p, { op: 'update', name: 'plain', changes: { material: { roughness: 0.3 } } });
    expect(p.parts[1].material).toEqual({ metalness: 0, roughness: 0.3 });
    p = applyOperation(p, { op: 'shell.set', shell: { name: 'skin', parts: ['balloon', 'plain'], blend: 0.1, resolution: 16, material: { metalness: 1, roughness: 0.1 } } });
    expect(p.shells![0].material).toEqual({ metalness: 1, roughness: 0.1 });
    expect(validateProject(JSON.parse(JSON.stringify(p)))).toEqual(p);
    expect(() => applyOperation(p, { op: 'update', name: 'plain', changes: { material: { metalness: 1.5 } } })).toThrow();
    expect(() => applyOperation(p, { op: 'update', name: 'plain', changes: { material: { roughness: -0.1 } } })).toThrow();
  });
});
