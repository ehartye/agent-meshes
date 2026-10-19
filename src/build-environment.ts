export interface BuildEnvironmentContract {
  mode: 'inherited' | 'declared';
  inputs: string[];
  platformInputs: string[];
}

/** libuv may inherit these from the real Windows parent even with an explicit env. */
const windowsInputs = ['HOMEDRIVE', 'HOMEPATH', 'LOGONSERVER', 'PATH', 'SYSTEMDRIVE', 'SYSTEMROOT', 'TEMP', 'USERDOMAIN', 'USERNAME', 'USERPROFILE', 'WINDIR'];
const posixInputs = ['HOME', 'LANG', 'LC_ALL', 'LC_CTYPE', 'PATH', 'TMPDIR', 'TZ'];
const variableName = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Resolve once before native cache preparation and use the returned environment
 * for every native author path, including plain/forced/fallback generation.
 * Hash its values privately; the public contract contains names only.
 */
export function prepareBuildEnvironment(inputs?: string[], env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): { env: NodeJS.ProcessEnv; contract: BuildEnvironmentContract } {
  if (inputs === undefined) return { env: { ...env }, contract: { mode: 'inherited', inputs: [], platformInputs: [] } };
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
    env: Object.fromEntries([...wanted].sort().filter(name => values.get(name) !== undefined).map(name => [name, values.get(name)])),
    contract: { mode: 'declared', inputs: [...declarations].sort(), platformInputs },
  };
}
