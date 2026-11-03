import { setRecipeRegenerator, type GaitSettingsInput } from '../core/recipe-hook.ts';
import type { Clip, Project, RecipeIntent, RecipeOptions } from '../core/types.ts';
import { createCreature, creatureInfo, validateGaitParams, type CreatureKind, type CreatureOptions } from './index.ts';
import { defaultQuadrupedGaits } from './quadruped.ts';

type RecipeKindInput = CreatureKind | 'quadruped' | 'strandbeest';
const filled = (value: object | undefined) => value !== undefined && Object.keys(value).length > 0;
/** The clip names a recipe generates when its options name none; the gait settings of a stored recipe are keyed by these: the biped's walk, the quadrupeds' defaults, the insectoid's tripod or the keys of its leg phases, the arachnid's scuttle. The strandbeest takes no gait settings. */
function defaultGaits(kind: RecipeKindInput, options: CreatureOptions): readonly string[] {
  switch (kind) {
    case 'biped': return ['walk'];
    case 'insectoid': return options.legPhases ? Object.keys(options.legPhases) : [creatureInfo.insectoid.gait];
    case 'arachnid': return [creatureInfo.arachnid.gait];
    case 'strandbeest': return [];
    default: return defaultQuadrupedGaits;
  }
}

/** The recipe command's options as the project stores them: values given, empty ones left out, gait settings in their validated form, `quadruped` stored as `vulpine`. */
export function recipeIntent(kind: RecipeKindInput, options: CreatureOptions = {}): RecipeIntent {
  const stored: RecipeOptions = {};
  if (options.gaits?.length) stored.gaits = [...options.gaits];
  if (typeof options.speed === 'number' || filled(options.speed)) stored.speed = structuredClone(options.speed)!;
  if (options.shell) stored.shell = true;
  if (options.gaitParams !== undefined) {
    const params = validateGaitParams(options.gaitParams, options.gaits ?? defaultGaits(kind, options), kind);
    if (filled(params)) stored.gaitParams = params;
  }
  if (filled(options.legPhases)) stored.legPhases = structuredClone(options.legPhases)!;
  if (options.pairs !== undefined) stored.pairs = options.pairs;
  if (options.spacing !== undefined) stored.spacing = options.spacing;
  if (filled(options.patterns)) stored.patterns = structuredClone(options.patterns)!;
  return { kind: kind === 'quadruped' ? 'vulpine' : kind, options: stored };
}

/** A recipe project with its intent stored; createCreature itself returns the project without it. */
export function createRecipe(kind: RecipeKindInput, options: CreatureOptions = {}): Project {
  return { ...createCreature(kind, options), recipe: recipeIntent(kind, options) };
}

const EPSILON = 1e-6;
const same = (a: readonly number[], b: readonly number[]) => a.length === b.length && a.every((value, index) => Math.abs(value - b[index]) <= EPSILON);
const show = (values: readonly number[]) => `[${values.map(value => Number(value.toFixed(4))).join(', ')}]`;
/** What differs between the bones and parts the recipe generates and the project; extra bones and parts, and every other edit to a part, are not differences. The pose is ignored. */
function mismatches(project: Project, rebuilt: Project): string[] {
  const found: string[] = [];
  const bones = new Map(project.bones.map(bone => [bone.name, bone]));
  for (const bone of rebuilt.bones) {
    const have = bones.get(bone.name);
    if (!have) { found.push(`bone ${bone.name} is missing`); continue; }
    if ((have.parent ?? null) !== (bone.parent ?? null)) found.push(`bone ${bone.name} has parent ${have.parent ?? 'none'}, the recipe has ${bone.parent ?? 'none'}`);
    if (!same(have.position, bone.position)) found.push(`bone ${bone.name} is at ${show(have.position)}, the recipe has ${show(bone.position)}`);
    // q and -q are the same rotation.
    if (!same(have.rotation, bone.rotation) && !same(have.rotation.map(value => -value), bone.rotation)) found.push(`bone ${bone.name} rotation is ${show(have.rotation)}, the recipe has ${show(bone.rotation)}`);
  }
  const parts = new Set(project.parts.map(part => part.name));
  for (const part of rebuilt.parts) if (!parts.has(part.name)) found.push(`part ${part.name} is missing`);
  return found;
}

/** Rebuild the whole recipe in memory from the stored intent plus the new settings, check the project still matches its skeleton, and return the named clip with the merged intent. */
function regenerate(project: Project, name: string, params: GaitSettingsInput | undefined): { clip: Clip; recipe: RecipeIntent } {
  const intent = project.recipe;
  if (!intent) throw new Error('This project has no stored recipe, so clip.regenerate has nothing to rebuild the clip from; it works on a project made by the recipe command (agent-meshes recipe <kind>), not on one made by new, the web gallery or a file saved before recipes were stored');
  const make = (options: RecipeOptions) => createCreature(intent.kind, options as CreatureOptions);
  let options: RecipeOptions = intent.options, rebuilt = make(options);
  const clips = rebuilt.clips.map(clip => clip.name);
  if (!clips.includes(name)) throw new Error(`The stored ${intent.kind} recipe does not generate a clip named ${name}; it generates ${clips.join(', ')}`);
  const given = Object.fromEntries(Object.entries(params ?? {}).filter(([, value]) => value !== undefined)) as GaitSettingsInput;
  if (filled(given)) {
    options = { ...options, gaitParams: { ...options.gaitParams, [name]: { ...options.gaitParams?.[name], ...given } } };
    rebuilt = make(options);
  }
  const stale = mismatches(project, rebuilt);
  if (stale.length) {
    const shown = stale.slice(0, 5).join('; ');
    throw Object.assign(new Error(`Cannot regenerate clip ${name}: the project no longer matches its stored ${intent.kind} recipe (${stale.length} difference${stale.length === 1 ? '' : 's'}: ${shown}${stale.length > 5 ? `; and ${stale.length - 5} more` : ''}). Start a new recipe, or edit the clip by hand with the clip operations`), { code: 'RECIPE_STALE' });
  }
  return { clip: structuredClone(rebuilt.clips.find(clip => clip.name === name)!), recipe: recipeIntent(intent.kind, options as CreatureOptions) };
}

setRecipeRegenerator(regenerate);
