import type { Clip, Project, RecipeIntent } from './types.ts';

/**
 * Core cannot import the creature generators: the slim runtime package carries only three and zod, and the CLI loads
 * the generators on demand. The generator module registers itself here when it is imported; clip.regenerate calls
 * through this slot, and fails with a clear message when nothing has registered.
 */
export type GaitSettingsInput = { stride?: number; lift?: number; stance?: number; bob?: number };
/** Rebuilds the named clip from the project's stored recipe, or throws; it must not change `project`. */
export type RecipeRegenerator = (project: Project, name: string, params: GaitSettingsInput | undefined) => { clip: Clip; recipe: RecipeIntent };

let regenerator: RecipeRegenerator | undefined;
export function setRecipeRegenerator(next: RecipeRegenerator | undefined): void { regenerator = next; }
export function regenerateFromRecipe(project: Project, name: string, params: GaitSettingsInput | undefined): { clip: Clip; recipe: RecipeIntent } {
  if (!regenerator) throw new Error('clip.regenerate needs the recipe generator, which is not loaded in this process; run the operation through the agent-meshes CLI, server or build, or import the recipe regenerate module first');
  return regenerator(project, name, params);
}
