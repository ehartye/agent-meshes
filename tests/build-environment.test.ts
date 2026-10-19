/** @lane merge
 * @subject src/build-environment.ts
 */
import { expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prepareBuildEnvironment } from '../src/build-environment.ts';

const windowsNames = ['HOMEDRIVE', 'HOMEPATH', 'LOGONSERVER', 'PATH', 'SYSTEMDRIVE', 'SYSTEMROOT', 'TEMP', 'USERDOMAIN', 'USERNAME', 'USERPROFILE', 'WINDIR'];
const windowsEnv = () => Object.fromEntries(windowsNames.map(name => [name, `fixture-${name}`]));

it('copies the complete inherited environment without changing legacy names or values', () => {
  const original = { Foo: 'secret', Path: 'first', PATH: 'second', MISSING: undefined };
  const result = prepareBuildEnvironment(undefined, original, 'win32');
  expect(result.env).toEqual(original); expect(result.env).not.toBe(original);
  expect(result.contract).toEqual({ mode: 'inherited', inputs: [], platformInputs: [] });
  result.env.Foo = 'changed'; expect(original.Foo).toBe('secret');
});

it('filters POSIX variables to declarations and the documented platform baseline', () => {
  const source = { PATH: '/bin', HOME: '/home/fixture', TMPDIR: '/tmp/fixture', LANG: 'C.UTF-8', LC_ALL: '', LC_CTYPE: 'C', TZ: 'UTC', FOO: 'included', RUN_ID: 'volatile', SECRET: 'not-for-child' };
  const result = prepareBuildEnvironment(['FOO', 'MISSING'], source, 'linux');
  expect(result.env).toEqual({ PATH: '/bin', HOME: '/home/fixture', TMPDIR: '/tmp/fixture', LANG: 'C.UTF-8', LC_ALL: '', LC_CTYPE: 'C', TZ: 'UTC', FOO: 'included' });
  expect(result.contract).toEqual({ mode: 'declared', inputs: ['FOO', 'MISSING'], platformInputs: ['HOME', 'LANG', 'LC_ALL', 'LC_CTYPE', 'PATH', 'TMPDIR', 'TZ'] });
  expect(JSON.stringify(result.contract)).not.toContain('included');
  expect(Object.keys(result.env)).toEqual([...Object.keys(result.env)].sort());
});

it('allows an explicit empty list while preserving absent versus empty selected values', () => {
  const result = prepareBuildEnvironment([], { HOME: '/fixture', OMITTED: 'value' }, 'darwin');
  expect(result.env).toEqual({ HOME: '/fixture' }); expect(result.contract.inputs).toEqual([]);
  const selected = prepareBuildEnvironment(['EMPTY', 'MISSING'], { EMPTY: '' }, 'linux');
  expect(selected.env).toEqual({ EMPTY: '' }); expect(Object.hasOwn(selected.env, 'MISSING')).toBe(false);
  expect(selected.contract.inputs).toEqual(['EMPTY', 'MISSING']);
});

it('normalizes Windows names and retains every automatically inherited launch variable', () => {
  const source = { ...windowsEnv(), foo: 'included', RunId: 'excluded' };
  const result = prepareBuildEnvironment(['fOo', 'missing'], source, 'win32');
  expect(result.env).toEqual({ ...windowsEnv(), FOO: 'included' });
  expect(result.contract).toEqual({ mode: 'declared', inputs: ['FOO', 'MISSING'], platformInputs: windowsNames });
  expect(Object.keys(result.env)).toEqual([...Object.keys(result.env)].sort());
  expect(Object.keys(result.env)).not.toContain('RUNID');
});

it('deduplicates equal parent Windows aliases and rejects conflicting aliases', () => {
  const equal = { ...windowsEnv(), Path: 'same', PATH: 'same' };
  expect(prepareBuildEnvironment([], equal, 'win32').env.PATH).toBe('same');
  for (const value of ['different', undefined]) {
    expect(() => prepareBuildEnvironment([], { ...equal, Path: value }, 'win32')).toThrow(/ambiguous|conflict|alias/i);
  }
  expect(prepareBuildEnvironment(['Foo', 'FOO'], { Foo: 'one', FOO: 'two' }, 'linux').env).toEqual({ FOO: 'two', Foo: 'one' });
});

it('fails before launch when a Windows baseline value is absent or empty', () => {
  for (const name of windowsNames) {
    const source: NodeJS.ProcessEnv = windowsEnv(); delete source[name];
    expect(() => prepareBuildEnvironment([], source, 'win32')).toThrow(new RegExp(`Windows.*${name}|${name}.*Windows`));
    source[name] = '';
    expect(() => prepareBuildEnvironment([], source, 'win32')).toThrow(new RegExp(`Windows.*${name}|${name}.*Windows`));
  }
});

it('rejects invalid, excessive and duplicate declarations without exposing values', () => {
  for (const inputs of [[''], ['bad-name'], ['FOO=VALUE'], ['A\0B'], ['1FIRST'], ['FOO', 'FOO'], Array.from({ length: 257 }, (_, i) => `VAR_${i}`), null]) {
    expect(() => prepareBuildEnvironment(inputs as string[], {}, 'linux')).toThrow(/environment|input|variable|declaration/i);
  }
  expect(() => prepareBuildEnvironment(['Foo', 'FOO'], windowsEnv(), 'win32')).toThrow(/duplicate|alias/i);
});

it('creates own environment properties safely rather than assigning through prototypes', () => {
  const source = Object.fromEntries([['__proto__', 'literal'], ['constructor', 'literal-constructor']]);
  const result = prepareBuildEnvironment(['__proto__', 'constructor'], source, 'linux');
  expect(Object.getPrototypeOf(result.env)).toBe(Object.prototype);
  expect(Object.hasOwn(result.env, '__proto__')).toBe(true);
  expect(result.env.__proto__).toBe('literal');
  expect(({} as Record<string, unknown>).polluted).toBeUndefined();
});

it('passes the filtered environment to a real child and retains the Windows native baseline', () => {
  const result = prepareBuildEnvironment(['MESH_INCLUDED', 'MESH_MISSING'], { ...process.env, MESH_INCLUDED: 'visible', MESH_EXCLUDED: 'not-visible' });
  const program = 'process.stdout.write(JSON.stringify({included:process.env.MESH_INCLUDED,excluded:process.env.MESH_EXCLUDED??null,missing:process.env.MESH_MISSING??null,keys:Object.keys(process.env).sort()}))';
  const child = spawnSync(process.execPath, ['-e', program], { env: result.env, encoding: 'utf8', windowsHide: true });
  expect(child.status, child.stderr || child.error?.message).toBe(0);
  const observed = JSON.parse(child.stdout);
  expect(observed.included).toBe('visible'); expect(observed.excluded).toBeNull(); expect(observed.missing).toBeNull();
  expect(observed.keys).toEqual(Object.entries(result.env).filter(([, value]) => value !== undefined).map(([name]) => name).sort());
});

it('blocks Node coverage auto-propagation to a real non-Node child unless declared', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'mesh-env-coverage-')));
  const prior = process.env.NODE_V8_COVERAGE;
  try {
    // A non-Node child cannot enable V8 coverage. Even the RED run confines its
    // inherited sentinel to this disposable folder, then restores the parent.
    process.env.NODE_V8_COVERAGE = root;
    const inspect = (env: NodeJS.ProcessEnv) => process.platform === 'win32'
      ? spawnSync(join(process.env.SYSTEMROOT!, 'System32', 'cmd.exe'), ['/d', '/c', 'set NODE_V8_COVERAGE'], { env, encoding: 'utf8', windowsHide: true })
      : spawnSync('/bin/sh', ['-c', 'printf "%s" "${NODE_V8_COVERAGE-unset}"'], { env, encoding: 'utf8' });
    const omitted = prepareBuildEnvironment([]);
    const before = Object.entries(omitted.env);
    const child = inspect(omitted.env);
    expect(child.error).toBeUndefined();
    expect(child.stdout).not.toContain(root);
    expect(Object.entries(omitted.env)).toEqual(before);
    expect(Object.hasOwn(omitted.env, 'NODE_V8_COVERAGE')).toBe(true);
    expect(omitted.env.NODE_V8_COVERAGE).toBeUndefined();
    const included = prepareBuildEnvironment(['NODE_V8_COVERAGE']);
    expect(inspect(included.env).stdout).toContain(root);
    expect(included.env.NODE_V8_COVERAGE).toBe(root);
    expect(included.contract.inputs).toEqual(['NODE_V8_COVERAGE']);
  } finally {
    if (prior === undefined) delete process.env.NODE_V8_COVERAGE; else process.env.NODE_V8_COVERAGE = prior;
    await rm(root, { recursive: true, force: true });
  }
});

it('blocks the documented z/OS automatic-copy names without claiming extra baseline inputs', () => {
  const result = prepareBuildEnvironment([], {}, 'os390' as NodeJS.Platform);
  for (const name of ['NODE_V8_COVERAGE', '_BPXK_AUTOCVT', '_CEE_RUNOPTS', '_TAG_REDIR_ERR', '_TAG_REDIR_IN', '_TAG_REDIR_OUT', 'STEPLIB', 'LIBPATH', '_EDC_SIG_DFLT', '_EDC_SUSV3']) {
    expect(Object.hasOwn(result.env, name)).toBe(true); expect(result.env[name]).toBeUndefined();
  }
  expect(result.contract.platformInputs).toEqual(['HOME', 'LANG', 'LC_ALL', 'LC_CTYPE', 'PATH', 'TMPDIR', 'TZ']);
});

it('rejects declared filtering under the Node permission model which rewrites NODE_OPTIONS', () => {
  const program = `const { prepareBuildEnvironment } = await import(${JSON.stringify(new URL('../src/build-environment.ts', import.meta.url).href)}); let error = ''; try { prepareBuildEnvironment([]); } catch (caught) { error = caught.message; } process.stdout.write(JSON.stringify({ inherited: prepareBuildEnvironment(undefined).contract.mode, error }));`;
  const child = spawnSync(process.execPath, ['--permission', '--allow-fs-read=*', '--input-type=module', '-e', program], { env: { ...process.env, NODE_V8_COVERAGE: undefined }, encoding: 'utf8', windowsHide: true });
  expect(child.status, child.stderr || child.error?.message).toBe(0);
  const observed = JSON.parse(child.stdout);
  expect(observed.inherited).toBe('inherited');
  expect(observed.error).toMatch(/declared.*permission|permission.*declared/i);
});
