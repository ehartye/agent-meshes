import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
// @ts-expect-error plain .mjs script with no declaration file
import { assertSlim, diff, generate, packageJson, packageOf, runtimeClosure } from '../scripts/build-runtime-package.mjs';

it('the generated runtime package depends on three (peer) and zod only, and ships the entry plus its closure', () => {
  const closure = runtimeClosure();
  expect(() => assertSlim(closure)).not.toThrow();
  const pkg = packageJson();
  expect(Object.keys(pkg.dependencies)).toEqual(['zod']);
  expect(Object.keys(pkg.peerDependencies)).toEqual(['three']);
  const generated = generate() as Map<string, unknown>;
  expect([...generated.keys()]).toEqual(expect.arrayContaining(['package.json', 'LICENSE', 'README.md', 'src/runtime.ts', ...closure.files]));
  // Nothing outside src/ except the package files: no scripts, no tests, no workbench.
  expect([...generated.keys()].filter(path => !path.startsWith('src/') && !['package.json', 'LICENSE', 'README.md'].includes(path))).toEqual([]);
});

it('a stray dependency in the runtime closure is refused, and a stale copy is reported', () => {
  expect(() => assertSlim({ files: [], runtime: ['three/examples/jsm/loaders/GLTFLoader.js', 'zod', 'express'], typeOnly: [] })).toThrow(/express/);
  expect(packageOf('@dimforge/rapier3d-compat/x')).toBe('@dimforge/rapier3d-compat');
  const dir = mkdtempSync(join(tmpdir(), 'am-runtime-test-'));
  try {
    expect(diff(dir)).toContain('missing src/runtime.ts');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
