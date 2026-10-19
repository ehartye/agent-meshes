/** @lane merge
 * @subject src/build-environment.ts
 */
import { expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
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
  expect(observed.keys).toEqual(Object.keys(result.env).sort());
});
