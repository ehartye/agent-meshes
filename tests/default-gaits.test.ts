/** @lane merge
 * @subject src/recipes/regenerate.ts
 */
import { expect, it } from 'vitest';
import { planOperations } from '../src/agent-contract.ts';
import { createCreature, type GaitParams } from '../src/recipes/index.ts';
import { createRecipe, recipeIntent } from '../src/recipes/regenerate.ts';
import type { Operation, Project } from '../src/core/types.ts';

// Risks: a stored gait setting or a clip.regenerate that is checked against the wrong clip names (a valid setting refused, or a wrong name accepted
// and later ignored), because the default clip names follow the kind and the stored leg phases. The list itself is not exported, so these tests reach
// it the way users do: through the stored recipe and through clip.regenerate with params.
const clip = (project: Project, name: string) => project.clips.find(c => c.name === name)!;
const regenerate = (project: Project, name: string, params: object) => planOperations(project, [{ op: 'clip.regenerate', name, params } as Operation]).project;
const legPhases = { ripple: [0, 1 / 6, 2 / 6, 3 / 6, 4 / 6, 5 / 6], tripod: [0, 0.5, 0, 0.5, 0, 0.5] };
// 0.35 differs from both default strides (insectoid 0.30, arachnid 0.25), so a rebuilt clip differs from the stored one.
const settings = (name: string) => ({ [name]: { stride: 0.35 } }) as unknown as GaitParams;

it('lists scuttle, and only scuttle, as the arachnid default clip', () => {
  expect(() => recipeIntent('arachnid', { gaitParams: settings('tripod') })).toThrow(/names the clip tripod.*\(scuttle\)/);
  expect(recipeIntent('arachnid', { gaitParams: settings('scuttle') }).options.gaitParams).toEqual({ scuttle: { stride: 0.35 } });
});

it('lists tripod for the insectoid, or the keys of its stored leg phases when it has them', () => {
  expect(() => recipeIntent('insectoid', { gaitParams: settings('walk') })).toThrow(/names the clip walk.*\(tripod\)/);
  expect(recipeIntent('insectoid', { gaitParams: settings('tripod') }).options.gaitParams).toEqual({ tripod: { stride: 0.35 } });
  expect(() => recipeIntent('insectoid', { legPhases, gaitParams: settings('together') })).toThrow(/names the clip together.*\(ripple, tripod\)/);
  expect(recipeIntent('insectoid', { legPhases, gaitParams: settings('ripple') }).options.gaitParams).toEqual({ ripple: { stride: 0.35 } });
});

it('clip.regenerate with params rebuilds only the default clip of an insectoid and an arachnid that stored no leg phases', () => {
  for (const [kind, name] of [['insectoid', 'tripod'], ['arachnid', 'scuttle']] as const) {
    const project = createRecipe(kind);
    const result = regenerate(project, name, { stride: 0.35 });
    expect(clip(result, name)).toEqual(clip(createCreature(kind, { gaitParams: settings(name) }), name));
    expect(clip(result, name)).not.toEqual(clip(project, name));
    expect(result.recipe!.options.gaitParams).toEqual({ [name]: { stride: 0.35 } });
    expect({ ...result, clips: [], recipe: undefined }).toEqual({ ...project, clips: [], recipe: undefined });
  }
});

it('clip.regenerate with params follows the stored leg phases of an insectoid and leaves its other clip alone', () => {
  const project = createRecipe('insectoid', { legPhases });
  const result = regenerate(project, 'ripple', { stride: 0.35 });
  expect(clip(result, 'ripple')).toEqual(clip(createCreature('insectoid', { legPhases, gaitParams: settings('ripple') }), 'ripple'));
  expect(clip(result, 'tripod')).toEqual(clip(project, 'tripod'));
  expect(result.recipe!.options.gaitParams).toEqual({ ripple: { stride: 0.35 } });
});
