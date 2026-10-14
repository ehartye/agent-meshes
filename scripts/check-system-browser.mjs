// CI proof: an explicit executable renders through a fresh fingerprinted runtime.
import assert from 'node:assert/strict';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve, join } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { resolveRuntime } from './managed-runtime.js';
import { browserLaunchOptions } from '../src/browser.ts';

assert.ok(browserLaunchOptions().executablePath, 'This check requires an explicitly configured browser');
const source = fileURLToPath(new URL('..', import.meta.url));
const runtime = resolveRuntime(source);
const load = name => import(pathToFileURL(join(runtime.root, 'src', name)).href);
const { createProject, applyOperation } = await load('core/model.ts');
const { captureProject } = await load('capture.ts');
const project = applyOperation(createProject('System Chromium proof'), {
  op: 'add', part: { name: 'asymmetric-block', geometry: { type: 'box', size: [1, 2, 3], segments: 12 }, color: '#e65124' },
});
const output = resolve('artifacts/system-browser');
await mkdir(output, { recursive: true });
const files = await captureProject(project, output);
assert.deepEqual(files, ['front.png', 'side.png', 'perspective.png']);
const evidence = [];
for (const file of files) {
  const bytes = await readFile(join(output, file));
  assert.equal(bytes.subarray(0, 8).toString('hex'), '89504e470d0a1a0a', 'PNG signature');
  assert.ok(bytes.length > 1000, 'Nontrivial rendered image');
  assert.ok(bytes.readUInt32BE(16) > 0 && bytes.readUInt32BE(20) > 0, 'Image dimensions');
  evidence.push({ file, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') });
}
assert.equal(new Set(evidence.map(item => item.sha256)).size, 3, 'Camera views must render differently');
const report = { ok: true, executablePath: browserLaunchOptions().executablePath, runtimeFingerprint: runtime.fingerprint, images: evidence };
await writeFile(join(output, 'verification.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report));
