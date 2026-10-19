/** Supported, explicit scratch-import configuration. This is not a project/pipeline snapshot. */
export const UNREAL_COLLISION_FLAGS = {
  default: 'CTF_USE_DEFAULT',
  'simple-and-complex': 'CTF_USE_SIMPLE_AND_COMPLEX',
  'simple-as-complex': 'CTF_USE_SIMPLE_AS_COMPLEX',
  'complex-as-simple': 'CTF_USE_COMPLEX_AS_SIMPLE',
} as const;
export type UnrealCollision = keyof typeof UNREAL_COLLISION_FLAGS;
export type UnrealCollisionTraceFlag = typeof UNREAL_COLLISION_FLAGS[UnrealCollision];
export interface UnrealImportOptions {
  schema: 1;
  interchange?: {
    buildNanite?: boolean;
    useFullPrecisionUVs?: boolean;
    collision?: boolean;
    importCollisionAccordingToMeshName?: boolean;
    generateLightmapUVs?: boolean;
  };
  /** Applied to every imported StaticMesh BodySetup after Interchange completes, before measurement. */
  postImport?: { collisionTraceFlag?: UnrealCollision; doubleSidedGeometry?: boolean };
}
export interface UnrealImportConfiguration {
  requested: UnrealImportOptions;
  /** Configured pipeline property readback, not a claim that every result matches it. */
  applied: {
    interchange?: NonNullable<UnrealImportOptions['interchange']>;
    pipelines?: string[];
    postImport?: { mesh: string; settings: NonNullable<UnrealImportOptions['postImport']> }[];
  };
}
const argumentError = (message: string): never => { throw Object.assign(new Error(message), { code: 'CLI_ARGUMENT_ERROR' }); };
export function parseUnrealCollision(value: string): UnrealCollision {
  if (!Object.hasOwn(UNREAL_COLLISION_FLAGS, value)) argumentError(`Expected collision as ${Object.keys(UNREAL_COLLISION_FLAGS).join('|')}`);
  return value as UnrealCollision;
}
/** Reject typos/unsupported values before starting an engine; never silently use engine defaults. */
export function parseUnrealImportOptions(input: unknown): UnrealImportOptions {
  const fail = (message: string): never => argumentError(`Invalid Unreal import options: ${message}`);
  const object = (value: unknown, label: string): Record<string, unknown> => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return fail(`${label} must be an object`);
    return value as Record<string, unknown>;
  };
  const strict = (value: Record<string, unknown>, fields: string[], label: string) => {
    for (const key of Object.keys(value)) if (!fields.includes(key)) fail(`unsupported ${label} field "${key}"`);
  };
  const root = object(input, 'root'); strict(root, ['schema', 'interchange', 'postImport'], 'root');
  if (root.schema !== 1) fail('schema must be 1');
  let count = 0;
  for (const section of ['interchange', 'postImport']) {
    if (!Object.hasOwn(root, section)) continue;
    const values = object(root[section], section);
    strict(values, section === 'interchange' ? ['buildNanite', 'useFullPrecisionUVs', 'collision', 'importCollisionAccordingToMeshName', 'generateLightmapUVs'] : ['collisionTraceFlag', 'doubleSidedGeometry'], section);
    for (const [key, value] of Object.entries(values)) {
      count++;
      if (key === 'collisionTraceFlag') {
        if (typeof value !== 'string' || !Object.hasOwn(UNREAL_COLLISION_FLAGS, value)) fail('postImport.collisionTraceFlag must be default|simple-and-complex|simple-as-complex|complex-as-simple');
      } else if (typeof value !== 'boolean') fail(`${section}.${key} must be a boolean`);
    }
  }
  if (!count) fail('declare at least one supported setting');
  return JSON.parse(JSON.stringify(root)) as UnrealImportOptions;
}
