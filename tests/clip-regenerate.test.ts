/** @lane merge
 * @subject src/recipes/regenerate.ts
 */
import { afterEach, beforeAll, expect, it, vi } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Editor, applyOperation } from '../src/core/model.ts';
import { applyOperations, OperationPlanError, parseOperation, planOperations, capabilities } from '../src/agent-contract.ts';
import { workspaceCommand } from '../src/workspace-command.ts';
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
const cleanup: (() => Promise<unknown> | unknown)[] = [];
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn(); });
const scratch = async () => { const directory = await mkdtemp(join(tmpdir(), 'mesh-regenerate-')); cleanup.push(() => rm(directory, { recursive: true, force: true })); return directory; };
// Child processes load the CLI, server and build fresh, so they show which paths register the recipe generator on their own.
const node = promisify(execFile);
const cli = async (directory: string, ...args: string[]) => JSON.parse((await node(process.execPath, [resolve('scripts/agent-meshes.mjs'), '--workspace', directory, ...args], { timeout: 30000, windowsHide: true })).stdout);
const failure = async (run: Promise<unknown>) => { try { await run; } catch (error) { return error as { code: number; stdout: string; stderr: string }; } throw new Error('Expected the process to fail'); };

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
  // The dry run and the build path report the same code.
  const missing = apply(equine, { op: 'remove', name: 'mane' });
  const batch = [{ op: 'add', part: { name: 'saddle', geometry: { type: 'box', size: [0.4, 0.1, 0.4] } } }, regenerate('walk')];
  expect(() => planOperations(missing, batch)).toThrow(expect.objectContaining({ code: 'RECIPE_STALE', operationIndex: 1 }));
  expect(() => applyOperations(missing, batch)).toThrow(expect.objectContaining({ code: 'RECIPE_STALE' }));
});

it('applies a batch atomically: a failing clip.regenerate changes neither the planner input nor the stored workspace', async () => {
  const saddle = { op: 'add', part: { name: 'saddle', geometry: { type: 'box', size: [0.4, 0.1, 0.4] } } };
  const lift = regenerate('walk', { lift: 0.15 });
  // Every project below is a copy, so a planner that wrongly edits its input cannot disturb the shared fixture.
  const healthy = () => structuredClone(equine), stalled = () => apply(healthy(), { op: 'remove', name: 'mane' });
  expect(clipOf(apply(healthy(), lift), 'walk')).not.toEqual(clipOf(equine, 'walk'));
  // The planner works on its own copy: the object the caller passes in is the same afterwards, whichever step refused.
  const project = healthy(), original = structuredClone(project);
  expect(() => planOperations(project, [lift, regenerate('gallop')])).toThrow(expect.objectContaining({ operationIndex: 1 }));
  expect(project).toEqual(original);
  const stale = stalled(), staleOriginal = structuredClone(stale);
  expect(() => planOperations(stale, [saddle, regenerate('walk')])).toThrow(expect.objectContaining({ code: 'RECIPE_STALE', operationIndex: 1 }));
  expect(stale).toEqual(staleOriginal);
  // The real batch command: the stored project and its revision are as they were when the batch refused.
  const stored = (where: string) => workspaceCommand(where, 'project') as Promise<{ project: Project; revision: number }>;
  const directory = await scratch();
  // Stale: the part added before the failing step is not stored.
  await workspaceCommand(directory, 'project', stalled());
  const staleState = await stored(directory);
  await expect(workspaceCommand(directory, 'batch', { operations: [saddle, regenerate('walk')] })).rejects.toMatchObject({ code: 'RECIPE_STALE', operationIndex: 1 });
  const afterStale = await stored(directory);
  expect(afterStale).toEqual(staleState);
  expect(afterStale.project.parts.some(part => part.name === 'saddle')).toBe(false);
  // Healthy: a regenerate that works on its own takes no effect when a later step of the batch fails.
  await workspaceCommand(directory, 'project', healthy());
  const state = await stored(directory);
  await expect(workspaceCommand(directory, 'batch', { operations: [lift, regenerate('gallop')] })).rejects.toMatchObject({ operationIndex: 1 });
  const after = await stored(directory);
  expect(after).toEqual(state);
  expect(after.revision).toBe(state.revision);
  expect(clipOf(after.project, 'walk')).toEqual(clipOf(equine, 'walk'));
  expect(after.project.recipe).toEqual(equine.recipe);
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
  const strandbeest = createRecipe('strandbeest');
  refuses(strandbeest, regenerate(strandbeest.clips[0].name, { stride: 0.4 }), /--gait-params.*strandbeest/);
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
  expect(Object.keys(schema.properties.params.properties)).toEqual(['stride', 'lift', 'stance', 'bob', 'duration']);
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

it('regenerates through the HTTP server, which loads the recipe generator itself and reports RECIPE_STALE', async () => {
  const directory = await scratch();
  await cli(directory, 'recipe', 'equine', '--gaits', 'walk,trot');
  // A separate process starts the server and never imports the regenerate module; its only route to the generator is the one a real server has.
  const script = `import {createServer} from ${JSON.stringify(pathToFileURL(resolve('src/server.ts')).href)};
const server = await createServer({port: 0, workspacePath: ${JSON.stringify(directory)}});
const post = async body => { const response = await fetch(server.url + '/api/op', {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify(body)}); return {status: response.status, body: await response.json()}; };
const out = {regenerated: await post(${JSON.stringify(regenerate('walk', { lift: 0.15 }))}), unknown: await post(${JSON.stringify(regenerate('gallop'))})};
await post({op: 'remove', name: 'mane'});
out.stale = await post(${JSON.stringify(regenerate('walk'))});
await server.close(); console.log(JSON.stringify(out)); process.exit(0);`;
  const out = JSON.parse((await node(process.execPath, ['--input-type=module', '-e', script], { timeout: 60000, windowsHide: true })).stdout);
  expect(out.regenerated.status).toBe(200);
  expect(clipOf(out.regenerated.body, 'walk')).toEqual(clipOf(createCreature('equine', lifted), 'walk'));
  expect(out.regenerated.body.recipe.options.gaitParams).toEqual({ walk: { lift: 0.15 } });
  expect(out.unknown.status).toBe(400);
  expect(out.unknown.body.error).toMatch(/walk, trot/);
  expect(out.stale.status).toBe(400);
  expect(out.stale.body.details.code).toBe('RECIPE_STALE');
}, 90000);

it('loads the recipe generator when a build applies operations, which cannot hold a stored recipe', async () => {
  const directory = await scratch();
  await writeFile(join(directory, 'ops.json'), JSON.stringify([regenerate('walk')]));
  await writeFile(join(directory, 'build.json'), JSON.stringify({ version: 1, name: 'recipe', operations: 'ops.json', output: 'generated' }));
  const failed = await failure(node(process.execPath, [resolve('scripts/agent-meshes.mjs'), 'build', join(directory, 'build.json'), '--no-preview'], { timeout: 60000, windowsHide: true }));
  expect(failed.code).toBe(1);
  const message = JSON.parse(failed.stdout || failed.stderr).error.message as string;
  expect(message).toMatch(/no stored recipe/);
  expect(message).not.toMatch(/not loaded/);
}, 90000);

it('works across CLI processes and reports RECIPE_STALE with the revision unchanged', async () => {
  const directory = await scratch(), run = (...args: string[]) => cli(directory, ...args);
  await run('recipe', 'equine', '--gaits', 'walk,trot');
  await run('op', JSON.stringify(regenerate('walk', { lift: 0.15 })), '--quiet');
  const state = await run('state');
  expect(state.project.recipe).toEqual({ kind: 'equine', options: { gaits, gaitParams: { walk: { lift: 0.15 } } } });
  await run('op', JSON.stringify({ op: 'remove', name: 'mane' }), '--quiet');
  const before = (await run('state')).revision;
  const failed = await failure(run('op', JSON.stringify(regenerate('walk'))));
  expect(failed.code).toBe(1);
  expect(JSON.parse(failed.stderr).error).toMatchObject({ code: 'RECIPE_STALE' });
  expect((await run('state')).revision).toBe(before);
}, 90000);
