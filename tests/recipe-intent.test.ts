/** @lane merge
 * @subject src/recipes/regenerate.ts
 */
import { afterEach, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { createProject, projectSchema, validateProject } from '../src/core/model.ts';
import { loadProject, saveProject } from '../src/storage.ts';
import { capabilities, inspectProject, planOperations } from '../src/agent-contract.ts';
import { createCreature } from '../src/recipes/index.ts';
import { createRecipe, recipeIntent } from '../src/recipes/regenerate.ts';

// Risk: a corrupt or unreadable project. The stored recipe is part of the shared project contract.
const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
// A file saved by `recipe biped` and `save` on 0.40.0 (the release before recipes were stored), trimmed to a part, two bones and a short walk clip. It is a literal so the new code does not make its own old file.
const oldFile = '{"version":1,"name":"Copper courier","parts":[{"name":"pelvis","geometry":{"type":"sphere","size":[0.65,0.33,0.4],"segments":10},"color":"#294958","position":[0,1.08,0],"rotation":[0,0,0,1],"scale":[1,1,1],"parent":null,"binding":{"type":"rigid","bone":"root"}}],"bones":[{"name":"root","parent":null,"position":[0,0,0],"rotation":[0,0,0,1],"pose":[0,0,0,1]},{"name":"chest","parent":"root","position":[0,1.4,0],"rotation":[0,0,0,1],"pose":[0,0,0,1]}],"clips":[{"name":"walk","duration":1.2,"tracks":[{"bone":"root","property":"position","keys":[{"time":0,"value":[0,0,0]},{"time":0.3,"value":[0,0.048,0]},{"time":0.6,"value":[0,0,0]},{"time":1.2,"value":[0,0,0]}]}]}],"shells":[]}';
const scratch = async () => { const directory = await mkdtemp(join(tmpdir(), 'mesh-recipe-intent-')); directories.push(directory); return directory; };

it('stores the options given, leaves empty ones out and stores quadruped as vulpine', () => {
  expect(recipeIntent('equine', { gaits: ['walk', 'trot'], gaitParams: { walk: { lift: 0.15 }, trot: {} } }))
    .toEqual({ kind: 'equine', options: { gaits: ['walk', 'trot'], gaitParams: { walk: { lift: 0.15 } } } });
  expect(recipeIntent('quadruped').kind).toBe('vulpine');
  expect(recipeIntent('biped', { gaits: [], gaitParams: {}, shell: false, legPhases: {}, patterns: {} })).toEqual({ kind: 'biped', options: {} });
  expect(recipeIntent('biped', { speed: { walk: 0.99 } }).options).toEqual({ speed: { walk: 0.99 } });
  expect(recipeIntent('strandbeest', { pairs: 4, spacing: 0.5 }).options).toEqual({ pairs: 4, spacing: 0.5 });
});

it('adds the intent to a recipe project and nothing else, and only the recipe helper does', () => {
  const options = { gaits: ['walk', 'trot'], gaitParams: { walk: { lift: 0.15 } } };
  const { recipe, ...rest } = createRecipe('equine', options);
  expect(recipe).toEqual(recipeIntent('equine', options));
  expect(rest).toEqual(createCreature('equine', options));
  expect(Object.hasOwn(createCreature('biped'), 'recipe')).toBe(false);
  expect(Object.hasOwn(createProject('demo'), 'recipe')).toBe(false);
});

it('round trips through validation, save and open, and an older project without a recipe still loads', async () => {
  const project = createRecipe('biped', { gaits: ['walk', 'run'], gaitParams: { run: { stride: 0.7 } } });
  expect(validateProject(structuredClone(project))).toEqual(project);
  const directory = await scratch(), file = join(directory, 'recipe.mesh.json'), older = join(directory, 'older.mesh.json');
  await saveProject(file, project);
  expect(await loadProject(file)).toEqual(project);
  await writeFile(older, oldFile);
  const loaded = await loadProject(older);
  expect(loaded).toEqual(JSON.parse(oldFile));
  expect(loaded.version).toBe(1);
  expect(loaded.clips.map(clip => clip.name)).toEqual(['walk']);
  expect(Object.hasOwn(loaded, 'recipe')).toBe(false);
  // Nothing was stored with it, so regenerating refuses and changes nothing.
  expect(() => planOperations(loaded, [{ op: 'clip.regenerate', name: 'walk' }])).toThrow(/no stored recipe/);
  expect(loaded).toEqual(JSON.parse(oldFile));
});

it('keeps the project schema strict: unknown recipe fields and kinds are refused, and recipe is optional in the published schema', () => {
  const base = createCreature('biped');
  expect(() => validateProject({ ...base, recipe: { kind: 'biped', options: {}, extra: 1 } })).toThrow();
  expect(() => validateProject({ ...base, recipe: { kind: 'dragon', options: {} } })).toThrow();
  expect(() => validateProject({ ...base, recipe: { kind: 'biped', options: { gaitParams: { walk: { cadence: 1 } } } } })).toThrow();
  expect(() => validateProject({ ...base, recipe: null })).toThrow();
  const schema = z.toJSONSchema(projectSchema) as { properties: Record<string, unknown>; required?: string[] };
  expect(schema.properties).toHaveProperty('recipe');
  expect(schema.required ?? []).not.toContain('recipe');
  expect((capabilities().projectSchema as { properties: object }).properties).toHaveProperty('recipe');
});

it('inspect reports the recipe kind only when the project has one', () => {
  expect(inspectProject(createRecipe('vulpine'))).toHaveProperty('recipe', { kind: 'vulpine' });
  expect(inspectProject(createCreature('vulpine'))).not.toHaveProperty('recipe');
});
