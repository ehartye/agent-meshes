/** @lane merge
 * @subject src/recipes/regenerate.ts
 */
import { afterEach, beforeAll, expect, it, vi } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Editor, applyOperation } from '../src/core/model.ts';
import { applyOperations, OperationPlanError, parseOperation, planOperations, capabilities } from '../src/agent-contract.ts';
import { createServer } from '../src/server.ts';
import { createCreature } from '../src/recipes/index.ts';
import { createRecipe } from '../src/recipes/regenerate.ts';
import type { Operation, Project } from '../src/core/types.ts';

// Risks: a wrong clip written into a model (silent bad output), a stale recipe regenerated over a hand-edited rig, and a named error that never reaches the user.
const gaits = ['walk', 'trot'];
const lifted = { gaits, gaitParams: { walk: { lift: 0.15 } } };
const clipOf = (project: Project, name: string) => project.clips.find(clip => clip.name === name);
const apply = (project: Project, ...operations: object[]) => planOperations(project, operations).project;
const regenerate = (name: string, params?: object) => ({ op: 'clip.regenerate', name, ...(params ? { params } : {}) }) as Operation;
let equine: Project;
beforeAll(() => { equine = createRecipe('equine', { gaits }); });
const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn(); });

it('rebuilds only the named clip, exactly as a fresh recipe with the same options would, and merges settings', () => {
  const edited = apply(equine,
    { op: 'update', name: 'body', changes: { color: '#112233' } },
    { op: 'add', part: { name: 'saddle', geometry: { type: 'box', size: [0.4, 0.1, 0.4] } } },
    { op: 'clip.key.set', name: 'trot', bone: 'root', property: 'position', time: 0.1, value: [0, 0.01, 0] });
  const result = apply(edited, regenerate('walk', { lift: 0.15 }));
  const fresh = createCreature('equine', lifted);
  expect(clipOf(result, 'walk')).toEqual(clipOf(fresh, 'walk'));
  expect({ ...result, clips: [], recipe: undefined }).toEqual({ ...edited, clips: [], recipe: undefined });
  expect(clipOf(result, 'trot')).toEqual(clipOf(edited, 'trot'));
  expect(result.clips.map(clip => clip.name)).toEqual(gaits);
  expect(result.recipe!.options.gaitParams).toEqual({ walk: { lift: 0.15 } });
  expect(apply(result, regenerate('walk', { lift: 0.15 }))).toEqual(result);
  // No params after a hand edit restores the walk built with the stored options, not the table default.
  const handEdited = apply(result, { op: 'clip.key.set', name: 'walk', bone: 'root', property: 'position', time: 0.1, value: [0, 0.2, 0] });
  expect(clipOf(apply(handEdited, regenerate('walk')), 'walk')).toEqual(clipOf(fresh, 'walk'));
  const merged = apply(result, regenerate('walk', { stride: 0.5 }));
  expect(merged.recipe!.options.gaitParams).toEqual({ walk: { lift: 0.15, stride: 0.5 } });
  expect(clipOf(merged, 'walk')).toEqual(clipOf(createCreature('equine', { gaits, gaitParams: { walk: { lift: 0.15, stride: 0.5 } } }), 'walk'));
  // One undo step restores the project, recipe included.
  const editor = new Editor(edited);
  editor.replace(applyOperation(editor.project, regenerate('walk', { lift: 0.15 })));
  expect(editor.undo()).toEqual(edited);
});

it('keeps the biped cycle length tied to the effective stride and the stored speed', () => {
  const biped = createRecipe('biped', { gaits: ['walk', 'run'], speed: { walk: 0.7 } });
  const result = apply(biped, regenerate('walk', { stride: 0.4 }));
  const fresh = createCreature('biped', { gaits: ['walk', 'run'], speed: { walk: 0.7 }, gaitParams: { walk: { stride: 0.4 } } });
  expect(clipOf(result, 'walk')).toEqual(clipOf(fresh, 'walk'));
  expect(clipOf(result, 'walk')!.duration).toBeCloseTo(0.4 / (0.62 * 0.7), 3);
  expect(clipOf(result, 'run')).toEqual(clipOf(biped, 'run'));
});

it('refuses with RECIPE_STALE and changes nothing when the skeleton or a recipe part was edited', () => {
  const stale = (...operations: object[]) => {
    const project = apply(equine, ...operations), before = structuredClone(project);
    let caught: unknown;
    try { planOperations(project, [regenerate('walk')]); } catch (error) { caught = error; }
    expect(caught).toBeInstanceOf(OperationPlanError);
    expect(project).toEqual(before);
    return caught as OperationPlanError;
  };
  const moved = stale({ op: 'unbind', name: 'leg_L_front_foot' }, { op: 'bone.update', name: 'leg_L_front_hoof', changes: { position: [0, -0.1, 0.07] } });
  expect(moved.code).toBe('RECIPE_STALE'); expect(moved.message).toContain('leg_L_front_hoof');
  expect(stale({ op: 'remove', name: 'mane' }).message).toContain('part mane is missing');
  const renamed = stale({ op: 'remove', name: 'neck_crest' }, { op: 'add', part: { name: 'neck_crest_2', geometry: { type: 'box', size: [0.1, 0.1, 0.1] } } });
  expect(renamed.message).toContain('neck_crest');
  // The batch is atomic and the build path reports the same code.
  const missing = apply(equine, { op: 'remove', name: 'mane' });
  const batch = [{ op: 'add', part: { name: 'saddle', geometry: { type: 'box', size: [0.4, 0.1, 0.4] } } }, regenerate('walk')];
  expect(() => planOperations(missing, batch)).toThrow(expect.objectContaining({ code: 'RECIPE_STALE', operationIndex: 1 }));
  expect(() => applyOperations(missing, batch)).toThrow(expect.objectContaining({ code: 'RECIPE_STALE' }));
  expect(missing.parts.some(part => part.name === 'saddle')).toBe(false);
});

it('does not call additions, appearance edits or poses stale', () => {
  for (const edit of [
    [{ op: 'bone.add', bone: { name: 'bridle', parent: 'head' } }],
    [{ op: 'add', part: { name: 'saddle', geometry: { type: 'box', size: [0.4, 0.1, 0.4] } } }],
    [{ op: 'update', name: 'mane', changes: { color: '#ffffff' } }],
    [{ op: 'pose', name: 'head', rotation: [0, 0.1, 0, 0.995] }],
  ]) expect(clipOf(apply(equine, ...edit, regenerate('walk')), 'walk')).toEqual(clipOf(equine, 'walk'));
});

it('refuses the other bad requests with the reason named and the project unchanged', () => {
  const refuses = (project: Project, operation: Operation, text: RegExp) => {
    const before = structuredClone(project);
    expect(() => planOperations(project, [operation])).toThrow(text);
    expect(project).toEqual(before);
  };
  refuses(equine, regenerate('gallop'), /walk, trot/);
  refuses(createCreature('equine'), regenerate('walk'), /no stored recipe/);
  refuses(equine, regenerate('walk', { stride: 5 }), /gait-params walk\.stride=5.*Unreachable leg target/);
  refuses(equine, regenerate('walk', { stance: 1 }), /gait-params walk\.stance/);
  const insectoid = createRecipe('insectoid');
  refuses(insectoid, regenerate(insectoid.clips[0].name, { stride: 0.4 }), /--gait-params.*insectoid/);
  const name = insectoid.clips[0].name;
  const hand = apply(insectoid, { op: 'clip.key.set', name, bone: 'root', property: 'position', time: 0.1, value: [0, 0.2, 0] });
  expect(clipOf(apply(hand, regenerate(name)), name)).toEqual(clipOf(insectoid, name));
  const renamed = apply(equine, { op: 'clip.rename', name: 'walk', to: 'walk_old' });
  const appended = apply(renamed, regenerate('walk'));
  expect(appended.clips.map(clip => clip.name)).toEqual(['walk_old', 'trot', 'walk']);
  expect(clipOf(appended, 'walk')).toEqual(clipOf(equine, 'walk'));
});

it('publishes the contract: name required, params optional with the four settings, examples that parse', () => {
  const descriptor = capabilities().operations['clip.regenerate'];
  const schema = descriptor.schema as unknown as { required: string[]; properties: { params: { properties: object } } };
  expect(schema.required).toEqual(['op', 'name']);
  expect(Object.keys(schema.properties.params.properties)).toEqual(['stride', 'lift', 'stance', 'bob']);
  expect(descriptor.description).toMatch(/RECIPE_STALE/);
  for (const example of descriptor.examples) expect(parseOperation(example)).toEqual(example);
  expect(() => parseOperation({ op: 'clip.regenerate', name: 'walk', params: { cadence: 1 } })).toThrow();
});

it('fails with a clear message, and changes nothing, in a process that never loaded the recipe generator', async () => {
  vi.resetModules();
  const core = await import('../src/core/model.ts');
  const before = structuredClone(equine);
  expect(() => core.applyOperation(equine, regenerate('walk'))).toThrow(/recipe generator, which is not loaded/);
  expect(equine).toEqual(before);
  vi.resetModules();
});

it('reports a missing stored recipe the same way when a build applies operations', () => {
  expect(() => applyOperations(createCreature('biped'), [regenerate('walk')])).toThrow(/no stored recipe/);
});

it('regenerates through the HTTP server', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mesh-regenerate-server-')); cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const server = await createServer({ port: 0, workspacePath: directory }); cleanup.push(server.close);
  const post = (path: string, body: unknown) => fetch(`${server.url}/api/${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  expect((await post('project', createRecipe('equine', { gaits }))).status).toBe(200);
  const response = await post('op', regenerate('walk', { lift: 0.15 }));
  expect(response.status).toBe(200);
  const project = await response.json() as Project;
  expect(clipOf(project, 'walk')).toEqual(clipOf(createCreature('equine', lifted), 'walk'));
  expect(project.recipe!.options.gaitParams).toEqual({ walk: { lift: 0.15 } });
  const refused = await post('op', regenerate('gallop'));
  expect(refused.status).toBeGreaterThanOrEqual(400);
}, 30000);

it('works across CLI processes and reports RECIPE_STALE with the revision unchanged', async () => {
  const run = promisify(execFile), directory = await mkdtemp(join(tmpdir(), 'mesh-regenerate-cli-')); cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const cli = async (...args: string[]) => JSON.parse((await run(process.execPath, [resolve('scripts/agent-meshes.mjs'), '--workspace', directory, ...args], { timeout: 30000, windowsHide: true })).stdout);
  await cli('recipe', 'equine', '--gaits', 'walk,trot');
  await cli('op', JSON.stringify(regenerate('walk', { lift: 0.15 })), '--quiet');
  const state = await cli('state');
  expect(state.project.recipe).toEqual({ kind: 'equine', options: { gaits, gaitParams: { walk: { lift: 0.15 } } } });
  await cli('op', JSON.stringify({ op: 'remove', name: 'mane' }), '--quiet');
  const before = (await cli('state')).revision;
  try { await cli('op', JSON.stringify(regenerate('walk'))); throw new Error('Expected CLI failure'); }
  catch (error) {
    expect(error).toMatchObject({ code: 1 });
    expect(JSON.parse((error as { stderr: string }).stderr).error).toMatchObject({ code: 'RECIPE_STALE' });
  }
  expect((await cli('state')).revision).toBe(before);
}, 90000);
