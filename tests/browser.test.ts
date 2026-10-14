import { afterEach, expect, test } from 'vitest';
import { chmodSync, mkdtempSync, rmSync, writeFileSync, mkdirSync, copyFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { browserLaunchOptions } from '../src/browser.ts';
import { installBrowser, checkDependencies } from '../scripts/managed-runtime.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const env = (path: string) => ({ AGENT_MESHES_CHROMIUM_EXECUTABLE_PATH: path });
test('default leaves browser choice to Playwright', () => {
  expect(browserLaunchOptions({})).toEqual({});
});
test('rejects empty, relative, missing and directory selections', () => {
  for (const path of ['', 'chromium', join(tmpdir(), 'missing-agent-meshes-browser'), tmpdir()]) {
    expect(() => browserLaunchOptions(env(path))).toThrow(/AGENT_MESHES_CHROMIUM_EXECUTABLE_PATH/);
  }
});
test('requires executable permission and passes the exact absolute path', () => {
  const root = mkdtempSync(join(tmpdir(), 'mesh-browser-')); roots.push(root);
  const file = join(root, 'browser with spaces'); writeFileSync(file, 'test'); chmodSync(file, 0o600);
  if (process.platform !== 'win32') expect(() => browserLaunchOptions(env(file))).toThrow(/executable file/);
  chmodSync(file, 0o700);
  expect(browserLaunchOptions(env(file))).toEqual({ executablePath: file });
});
test('explicit executable skips install; invalid explicit path fails closed', () => {
  const previous = process.env.AGENT_MESHES_CHROMIUM_EXECUTABLE_PATH;
  try {
    process.env.AGENT_MESHES_CHROMIUM_EXECUTABLE_PATH = process.execPath;
    expect(() => installBrowser('/nonexistent-runtime')).not.toThrow();
    process.env.AGENT_MESHES_CHROMIUM_EXECUTABLE_PATH = 'relative';
    expect(() => installBrowser('/nonexistent-runtime')).toThrow(/absolute executable path/);
  } finally {
    if (previous === undefined) delete process.env.AGENT_MESHES_CHROMIUM_EXECUTABLE_PATH;
    else process.env.AGENT_MESHES_CHROMIUM_EXECUTABLE_PATH = previous;
  }
});

test.each(['ok', 'launch-fails', 'webgl-fails'])('configured-browser dependency check: %s', mode => {
  const root = mkdtempSync(join(tmpdir(), 'mesh-browser-deps-')); roots.push(root);
  const put = (path: string, value: string) => { mkdirSync(join(path, '..'), { recursive: true }); writeFileSync(path, value); };
  put(join(root, 'package.json'), JSON.stringify({ type: 'module' }));
  put(join(root, 'dist-web', 'index.html'), '<!doctype html>');
  mkdirSync(join(root, 'src')); copyFileSync(join(process.cwd(), 'src', 'browser.ts'), join(root, 'src', 'browser.ts'));
  for (const name of ['three', 'zod', 'commander', 'express', 'vite', 'gltf-validator', 'playwright']) {
    put(join(root, 'node_modules', name, 'package.json'), JSON.stringify({ type: 'module', exports: './index.js' }));
    put(join(root, 'node_modules', name, 'index.js'), 'export {};');
  }
  const marker = join(root, 'closed.json');
  put(join(root, 'node_modules', 'playwright', 'index.js'), `
    import { writeFileSync } from 'node:fs';
    export const chromium = { async launch(options) {
      if (options.executablePath !== process.execPath) throw new Error('Wrong executable selection');
      if (${JSON.stringify(mode)} === 'launch-fails') throw new Error('Deliberate launch failure');
      return { async newPage() { return { async evaluate() { return ${JSON.stringify(mode)} !== 'webgl-fails'; } }; },
        async close() { writeFileSync(${JSON.stringify(marker)}, JSON.stringify(options)); } };
    } };
  `);
  const previous = process.env.AGENT_MESHES_CHROMIUM_EXECUTABLE_PATH;
  process.env.AGENT_MESHES_CHROMIUM_EXECUTABLE_PATH = process.execPath;
  try {
    if (mode === 'ok') expect(() => checkDependencies(root)).not.toThrow();
    else expect(() => checkDependencies(root)).toThrow(mode === 'launch-fails' ? /Deliberate launch failure/ : /no WebGL2 support/);
    expect(existsSync(marker)).toBe(mode !== 'launch-fails');
    if (mode !== 'launch-fails') expect(JSON.parse(readFileSync(marker, 'utf8')).executablePath).toBe(process.execPath);
  } finally {
    if (previous === undefined) delete process.env.AGENT_MESHES_CHROMIUM_EXECUTABLE_PATH;
    else process.env.AGENT_MESHES_CHROMIUM_EXECUTABLE_PATH = previous;
  }
});
