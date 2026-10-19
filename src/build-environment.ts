export interface BuildEnvironmentContract {
  mode: 'inherited' | 'declared';
  inputs: string[];
  platformInputs: string[];
}

/** libuv may inherit these from the real Windows parent even with an explicit env. */
const windowsInputs = ['HOMEDRIVE', 'HOMEPATH', 'LOGONSERVER', 'PATH', 'SYSTEMDRIVE', 'SYSTEMROOT', 'TEMP', 'USERDOMAIN', 'USERNAME', 'USERPROFILE', 'WINDIR'];
const posixInputs = ['HOME', 'LANG', 'LC_ALL', 'LC_CTYPE', 'PATH', 'TMPDIR', 'TZ'];
/** Node 24 child_process copies these unless options.env has an own property. */
const zosAutomaticInputs = ['_BPXK_AUTOCVT', '_CEE_RUNOPTS', '_TAG_REDIR_ERR', '_TAG_REDIR_IN', '_TAG_REDIR_OUT', 'STEPLIB', 'LIBPATH', '_EDC_SIG_DFLT', '_EDC_SUSV3'];
const variableName = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Resolve once before native cache preparation and use the returned environment
 * for every native author path, including plain/forced/fallback generation.
 * Hash its values privately; the public contract contains names only.
 */
export function prepareBuildEnvironment(inputs?: string[], env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): { env: NodeJS.ProcessEnv; contract: BuildEnvironmentContract } {
  if (inputs === undefined) return { env: { ...env }, contract: { mode: 'inherited', inputs: [], platformInputs: [] } };
  // Node's permission mode rewrites NODE_OPTIONS independently of own-property
  // suppression. Do not promise an exact declared child environment in that mode.
  if (process.permission) throw new Error('Declared environment filtering is unsupported under the Node permission model');
  if (!Array.isArray(inputs) || inputs.length > 256) throw new Error('Declared environment inputs must be an array of at most 256 variable names');
  const canonical = (name: string) => platform === 'win32' ? name.toUpperCase() : name;
  const declarations = new Set<string>();
  for (const name of inputs) {
    if (typeof name !== 'string' || !variableName.test(name)) throw new Error('Invalid declared environment variable name');
    const key = canonical(name);
    if (declarations.has(key)) throw new Error(`Duplicate declared environment variable or alias: ${key}`);
    declarations.add(key);
  }
  const platformInputs = [...(platform === 'win32' ? windowsInputs : posixInputs)];
  const wanted = new Set([...platformInputs, ...declarations]);
  const automatic = new Set(['NODE_V8_COVERAGE', ...(String(platform) === 'os390' ? zosAutomaticInputs : [])]);
  const values = new Map<string, string | undefined>();
  for (const [name, value] of Object.entries(env)) {
    const key = canonical(name);
    if (!wanted.has(key)) continue;
    if (value !== undefined && typeof value !== 'string') throw new Error(`Invalid environment value for variable: ${key}`);
    if (values.has(key) && values.get(key) !== value) throw new Error(`Conflicting parent environment aliases for variable: ${key}`);
    values.set(key, value);
  }
  if (platform === 'win32') {
    // Missing values cannot be left for libuv to refill outside this snapshot.
    // Empty placeholders are also unsafe for native Windows launch (SystemRoot
    // in particular); reject this unsupported snapshot rather than inventing it.
    for (const name of platformInputs) if (!values.get(name)) throw new Error(`Missing or empty required Windows environment variable: ${name}`);
  }
  return {
    // Own undefined is a negative sentinel: Node must not refill this variable,
    // while its envPairs serializer emits no value to the actual child. Keep it
    // on the live launch object even though JSON/private value hashes omit it.
    env: Object.fromEntries([...new Set([...wanted, ...automatic])].sort().filter(name => values.get(name) !== undefined || automatic.has(name)).map(name => [name, values.get(name)])),
    contract: { mode: 'declared', inputs: [...declarations].sort(), platformInputs },
  };
}
