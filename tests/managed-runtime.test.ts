import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { basename, join, parse } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { describeSource, inspectInstallation, installRuntime, resolveRuntime } from '../scripts/managed-runtime.js';

let sandbox: string, source: string, home: string, globalRoot: string;
const put = (path: string, text: string) => writeFileSync(path, text);
function npm(args: string[], { cwd }: { cwd: string }) {
  if (args[0] === 'ci') mkdirSync(join(cwd, 'node_modules'), { recursive: true });
  if (args[0] === 'run' && args[1] === 'build') { mkdirSync(join(cwd, 'dist-web'), { recursive: true }); put(join(cwd, 'dist-web', 'index.html'), '<!doctype html>'); }
  if (args[0] === 'root') return globalRoot;
  if (args[0] === 'prefix') return sandbox;
  if (args[0] === 'link') {
    const link = join(globalRoot, 'agent-meshes');
    if (existsSync(link)) rmSync(link, { recursive: true, force: true });
    symlinkSync(cwd, link, process.platform === 'win32' ? 'junction' : 'dir');
  }
  return '';
}
const deps = () => {};
const browser = () => {};
const options = () => ({ home, npm, checkDependencies: deps, installBrowser: browser });

beforeEach(() => {
  sandbox = mkdtempSync(join(tmpdir(), 'mesh-managed-test-'));
  source = join(sandbox, 'plugin cache'); home = join(sandbox, 'managed home');
  globalRoot = join(sandbox, 'npm', 'node_modules');
  for (const dir of [source, globalRoot, join(source, 'scripts'), join(source, 'src', 'web'), join(source, '.claude-plugin')]) mkdirSync(dir, { recursive: true });
  put(join(source, 'package.json'), JSON.stringify({ name: 'agent-meshes', version: '1.2.3', type: 'module', bin: { 'agent-meshes': 'scripts/agent-meshes.mjs' } }));
  put(join(source, 'package-lock.json'), JSON.stringify({ name: 'agent-meshes', version: '1.2.3', lockfileVersion: 3, packages: { '': { name: 'agent-meshes', version: '1.2.3' } } }));
  put(join(source, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'agent-meshes', version: '1.2.3' }));
  put(join(source, 'tsconfig.json'), '{}');
  put(join(source, 'vite.config.ts'), 'export default {};');
  put(join(source, 'scripts', 'agent-meshes.mjs'), 'console.log(JSON.stringify({ root: import.meta.url, cwd: process.cwd(), args: process.argv.slice(2) }));');
  put(join(source, 'src', 'cli.ts'), '// cli');
  put(join(source, 'src', 'web', 'index.html'), '<!doctype html>');
});
afterEach(() => rmSync(sandbox, { recursive: true, force: true }));

describe('managed CLI installation', () => {
  test('copies the runtime outside the plugin, builds and validates before linking, and resolves the exact release', () => {
    const order: string[] = [];
    const runtime = installRuntime(source, { ...options(), npm: (args: string[], opts: { cwd: string }) => { order.push(args.slice(0, 2).join(' ')); return npm(args, opts); }, checkDependencies: () => order.push('deps'), installBrowser: () => order.push('browser') });
    expect(runtime.root.startsWith(join(home, 'releases'))).toBe(true);
    expect(order.indexOf('ci --omit=dev')).toBeLessThan(order.indexOf('run build'));
    expect(order.indexOf('run build')).toBeLessThan(order.indexOf('browser'));
    expect(order.indexOf('browser')).toBeLessThan(order.indexOf('deps'));
    expect(order.indexOf('deps')).toBeLessThan(order.indexOf('link --omit=dev'));
    expect(resolveRuntime(source, { home }).root).toBe(runtime.root);
    expect(existsSync(join(source, 'node_modules'))).toBe(false);
    expect(existsSync(join(source, 'dist-web'))).toBe(false);
    expect(inspectInstallation(source, options()).linked).toBe(true);
  });

  test('rerun reuses a complete runtime and repairs an outdated link', () => {
    const first = installRuntime(source, options());
    const calls: string[] = [];
    const second = installRuntime(source, { ...options(), npm: (args: string[], opts: { cwd: string }) => { calls.push(args[0]); return npm(args, opts); } });
    expect(first.root).toBe(second.root);
    expect(calls).not.toContain('ci');
    expect(calls).toContain('link');
  });

  test('npm normalizing a Windows bin shebang does not make the runtime stale', () => {
    put(join(source, 'scripts', 'agent-meshes.mjs'), '#!/usr/bin/env node\r\nconsole.log("ready");\r\n');
    const runtime = installRuntime(source, { ...options(), npm: (args: string[], opts: { cwd: string }) => {
      if (args[0] === 'link') {
        const bin = join(opts.cwd, 'scripts', 'agent-meshes.mjs');
        put(bin, readFileSync(bin, 'utf8').replace(/^#!([^\r\n]*)\r\n/, '#!$1\n'));
      }
      return npm(args, opts);
    } });
    expect(resolveRuntime(source, { home }).root).toBe(runtime.root);
  });

  test('the skill launcher selects the managed copy and fails closed after a source update', () => {
    for (const file of ['managed-runtime.js', 'run-managed.js']) copyFileSync(join(process.cwd(), 'scripts', file), join(source, 'scripts', file));
    installRuntime(source, options());
    const launch = () => execFileSync(process.execPath, [join(source, 'scripts', 'run-managed.js'), 'batch', 'ops with spaces.json'], {
      cwd: sandbox, encoding: 'utf8', env: { ...process.env, AGENT_MESHES_HOME: home }, stdio: 'pipe',
    });
    const output = JSON.parse(launch());
    expect(output.root).toContain('/releases/');
    expect(output.cwd).toBe(sandbox);
    expect(output.args).toEqual(['batch', 'ops with spaces.json']);
    put(join(source, 'src', 'cli.ts'), '// plugin updated');
    expect(launch).toThrow(/mesh-setup/);
  });

  test('rejects missing installs and same-version runtime changes instead of falling back to PATH', () => {
    expect(() => resolveRuntime(source, { home })).toThrow(/setup/i);
    const old = installRuntime(source, options());
    put(join(source, 'src', 'cli.ts'), '// different build of same version');
    expect(() => resolveRuntime(source, { home })).toThrow(/setup/i);
    const next = installRuntime(source, options());
    expect(next.root).not.toBe(old.root);
    expect(existsSync(old.cli)).toBe(true);
  });

  test('version sync rejects inconsistent plugin and package metadata', () => {
    put(join(source, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'agent-meshes', version: '9.0.0' }));
    expect(() => describeSource(source)).toThrow(/version/i);
  });

  test('a failed install never links or promotes an incomplete runtime', () => {
    const calls: string[] = [];
    expect(() => installRuntime(source, { ...options(), npm: (args: string[]) => { calls.push(args[0]); throw new Error('install failed'); } })).toThrow(/install failed/);
    expect(calls).not.toContain('link');
    expect(() => resolveRuntime(source, { home })).toThrow(/setup/i);
    expect(existsSync(join(home, 'setup.lock'))).toBe(false);
  });

  test('a failed workbench build never promotes the runtime', () => {
    expect(() => installRuntime(source, { ...options(), npm: (args: string[], opts: { cwd: string }) => { if (args[0] === 'run') throw new Error('vite failed'); return npm(args, opts); } })).toThrow(/vite failed/);
    expect(() => resolveRuntime(source, { home })).toThrow(/setup/i);
  });

  test('rejects install paths inside the plugin and concurrent setup', () => {
    expect(() => installRuntime(source, { ...options(), home: join(source, 'runtime') })).toThrow(/outside/i);
    mkdirSync(home); put(join(home, 'setup.lock'), 'another setup');
    expect(() => installRuntime(source, options())).toThrow(/setup.*running|lock/i);
    expect(readFileSync(join(home, 'setup.lock'), 'utf8')).toBe('another setup');
  });

  test('a missing managed home directly under a filesystem root retains its full basename', () => {
    const rootHome = join(parse(sandbox).root, `agent-meshes-missing-${basename(sandbox)}`);
    expect(() => resolveRuntime(source, { home: rootHome })).toThrow(/Managed CLI.*missing/);
  });

  test('detects an edited installed runtime and a stale npm link', () => {
    const runtime = installRuntime(source, options());
    rmSync(join(globalRoot, 'agent-meshes'), { recursive: true });
    symlinkSync(source, join(globalRoot, 'agent-meshes'), process.platform === 'win32' ? 'junction' : 'dir');
    expect(inspectInstallation(source, options()).linked).toBe(false);
    put(runtime.cli, '// changed');
    expect(() => resolveRuntime(source, { home })).toThrow(/modified|mismatch/i);
  });

  test('the resolved CLI executes the installed copy, preserving arguments and the project working directory', () => {
    const runtime = installRuntime(source, options());
    const output = JSON.parse(execFileSync(process.execPath, [runtime.cli, 'batch', 'file with spaces.json'], { cwd: sandbox, encoding: 'utf8' }));
    expect(output.root).toContain('/releases/');
    expect(output.cwd).toBe(sandbox);
    expect(output.args).toEqual(['batch', 'file with spaces.json']);
  });

  test('inspection reports a missing browser and workbench without claiming the install is ready', () => {
    installRuntime(source, options());
    const report = inspectInstallation(source, { ...options(), checkDependencies: () => { throw new Error('dist-web/index.html is missing'); } });
    expect(report.ok).toBe(false);
    expect(report.errors.join(' ')).toMatch(/dist-web/);
  });
});

test('the plugin manifest, package and lockfile agree on name and version', () => {
  const { name, version } = describeSource(process.cwd());
  expect(name).toBe('agent-meshes');
  expect(JSON.parse(readFileSync('.claude-plugin/plugin.json', 'utf8')).version).toBe(version);
  expect(JSON.parse(readFileSync('.claude-plugin/marketplace.json', 'utf8')).plugins[0].version).toBe(version);
});
