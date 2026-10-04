import { describe, expect, it } from 'vitest';
import { mkdtemp, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { planOperations, OperationPlanError } from '../src/agent-contract.ts';
import { createProject } from '../src/core/model.ts';
import { errorDetails } from '../src/errors.ts';
import { buildAsset } from '../src/build.ts';

function failure(operations: unknown[]): OperationPlanError {
  try { planOperations(createProject('e'), operations); } catch (error) { return error as OperationPlanError; }
  throw new Error('expected a failure');
}
const ok = { op: 'add', part: { name: 'fine' } };

describe('operation failures name what went wrong', () => {
  it('reports index, part, field, value and a hint for a box with too few segments', () => {
    const error = failure([ok, { op: 'add', part: { name: 'plinth', geometry: { type: 'box', segments: 1 } } }]);
    expect(error.operationIndex).toBe(1);
    expect(error.message).toMatch(/^Operation 1: add "plinth": /);
    expect(error.message).toContain('part.geometry.segments = 1');
    expect(error.message).toMatch(/box ignores segments|segments does not affect a box/i);
    expect(error.message).not.toMatch(/^\s*[\[{]|"origin"|"code":/);
    const details = errorDetails(error);
    expect(details).toMatchObject({ code: 'OPERATION_FAILED', operationIndex: 1, op: 'add', part: 'plinth', field: 'part.geometry.segments', value: 1 });
    expect(details.hint).toMatch(/box/);
    expect(details.issues?.length).toBeGreaterThan(0);
  });

  it('explains segments for round shapes instead', () => {
    const error = failure([{ op: 'add', part: { name: 'drum', geometry: { type: 'cylinder', segments: 2 } } }]);
    expect(error.message).toMatch(/facets around/i);
  });

  it('names the outline point and the unit convention', () => {
    const error = failure([{ op: 'add', part: { name: 'horse', geometry: { type: 'prism', outline: [[0, 0], [0.4, 0], [0.9, 0.2]] } } }]);
    expect(error.message).toMatch(/^Operation 0: add "horse": /);
    expect(error.message).toContain('Outline point 2 [0.9, 0.2]');
    expect(error.message).toMatch(/size-normalised -0\.5\.\.0\.5/);
    expect(error.message).toContain('outlineUnits');
    expect(errorDetails(error)).toMatchObject({ code: 'OPERATION_FAILED', part: 'horse', field: 'part.geometry.outline[2]', value: [0.9, 0.2] });
  });

  it('names the profile point and suggests profileUnits for unit overflow', () => {
    const error = failure([{ op: 'add', part: { name: 'vase', geometry: { type: 'lathe', profile: [[0, 0], [0.9, 0.1], [0, 1]] } } }]);
    expect(error.message).toContain('Profile point 1 [0.9, 0.1]');
    expect(error.message).toContain('profileUnits');
  });

  it('reports state errors and unknown keys with their operation', () => {
    expect(failure([{ op: 'remove', name: 'ghost' }]).message).toMatch(/^Operation 0: remove "ghost": Unknown part: ghost/);
    const typo = failure([{ op: 'add', part: { name: 'a', colour: '#ffffff' } }]);
    expect(typo.message).toContain('part.colour');
    expect(typo.message).toMatch(/capabilities add/);
    expect(failure([{ op: 'frobnicate' }]).message).toMatch(/Operation 0: .*op/);
  });

  it('uses the same shape for update changes', () => {
    const base = createProject('e');
    let error: OperationPlanError | undefined;
    try { planOperations(base, [ok, { op: 'update', name: 'fine', changes: { rotation: [0, 0, 0, 5] } }]); } catch (e) { error = e as OperationPlanError; }
    expect(error!.operationIndex).toBe(1);
    expect(error!.message).toMatch(/^Operation 1: update "fine": changes\.rotation = \[0,0,0,5\]/);
    expect(error!.message).toMatch(/rotationEuler/);
  });
});

describe('build reports the failing operation', () => {
  async function run(operations: unknown[]) {
    const dir = await mkdtemp(join(tmpdir(), 'op-errors-'));
    await writeFile(join(dir, 'ops.json'), JSON.stringify(operations));
    await writeFile(join(dir, 'build.json'), JSON.stringify({ version: 1, operations: 'ops.json', output: 'dist' }));
    try { await buildAsset(join(dir, 'build.json')); } catch (error) { return error as Error; }
    throw new Error('expected build to fail');
  }
  it('adds the operation index and keeps the existing error codes', async () => {
    const zodFailure = await run([ok, { op: 'add', part: { name: 'plinth', geometry: { type: 'box', segments: 1 } } }]);
    expect(zodFailure.message).toMatch(/^Operation 1: add "plinth": part\.geometry\.segments = 1/);
    expect(errorDetails(zodFailure)).toMatchObject({ code: 'VALIDATION_ERROR', operationIndex: 1, part: 'plinth' });
    const stateFailure = await run([{ op: 'remove', name: 'ghost' }]);
    expect(errorDetails(stateFailure)).toMatchObject({ code: 'AUTHORING_ERROR', operationIndex: 0, part: 'ghost' });
    const geometryFailure = await run([{ op: 'add', part: { name: 'horse', geometry: { type: 'prism', outline: [[0, 0], [0.4, 0], [0.9, 0.2]] } } }]);
    expect(geometryFailure.message).toContain('Outline point 2');
    expect(geometryFailure.message).toContain('Operation 0');
  });
  it('still builds good operations', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'op-errors-'));
    await writeFile(join(dir, 'ops.json'), JSON.stringify([{ op: 'add', part: { name: 'ok', rotationEuler: [0, 45, 0] } }]));
    await writeFile(join(dir, 'build.json'), JSON.stringify({ version: 1, operations: 'ops.json', output: 'dist' }));
    const result = await buildAsset(join(dir, 'build.json'), { decorate: async () => [] });
    expect(JSON.parse(await readFile(join(result.output, 'project.mesh.json'), 'utf8')).parts).toHaveLength(1);
  });
});
