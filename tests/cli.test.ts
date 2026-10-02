import { afterEach, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer as createHttpServer } from 'node:http';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from '../src/server.ts';

const run = promisify(execFile);
const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0)) await close(); });
const cli = (...args: string[]) => run(process.execPath, [resolve('scripts/agent-meshes.mjs'), ...args], { timeout: 10000, windowsHide: true });

it('makes construction guidance readable through help and capabilities outside the package directory', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mesh-guidance-'));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const invoke = (...args: string[]) => run(process.execPath, [resolve('scripts/agent-meshes.mjs'), ...args], {
    cwd: directory, timeout: 10000, windowsHide: true,
  });
  const contract = JSON.parse((await invoke('capabilities')).stdout);
  expect(contract.guidance).toBeDefined();
  const reference = contract.guidance.references.find((item: { topic: string }) => item.topic === 'character-construction');
  expect(reference).toBeDefined();
  const path = fileURLToPath(new URL(reference.path, contract.guidance.baseUrl));
  expect(path).toBe(resolve('scripts/blender_lib/references/character-construction.md'));
  expect((await invoke('--help')).stdout).toContain(path);
  expect((await invoke('capabilities', '--help')).stdout).toContain(path);
  const guide = await readFile(path, 'utf8');
  expect(guide).toMatch(/^# Character construction/m);
  // Follow the procedure's API links: an installed guide must not refer to omitted skills.
  for (const target of [...guide.matchAll(/\]\(([^)]+)\)/g)].map(match => match[1])) {
    const url = new URL(target, new URL(reference.path, contract.guidance.baseUrl));
    expect(url.protocol).toBe('file:');
    expect(fileURLToPath(url)).toBe(resolve('scripts/blender_lib/README.md'));
    const api = await readFile(url, 'utf8');
    const anchors = [...api.matchAll(/^## (.+)$/gm)].map(match => match[1].toLowerCase().replace(/[^\w\s-]/g, '').replace(/\s/g, '-'));
    expect(anchors).toContain(url.hash.slice(1));
  }
});

it('reports the installed package version from another project directory', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mesh-version-'));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  await writeFile(join(directory, 'package.json'), '{"version":"99.0.0"}');
  const { version } = JSON.parse(await readFile('package.json', 'utf8'));
  const { stdout } = await run(process.execPath, [resolve('scripts/agent-meshes.mjs'), '--version'], {
    cwd: directory, timeout: 10000, windowsHide: true,
  });
  expect(stdout.trim()).toBe(version);
});

it('edits and saves a project through the executable CLI', async () => {
  const server = await createServer({ port: 0 });
  cleanup.push(server.close);
  const directory = await mkdtemp(join(tmpdir(), 'mesh-cli-'));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const project = join(directory, 'saved.json');
  const batch = join(directory, 'batch.json');
  const invoke = (...args: string[]) => cli('--url', server.url, ...args);
  expect(JSON.parse((await invoke('new', 'Biped')).stdout).name).toBe('Biped');
  expect(JSON.parse((await invoke('op', '{"op":"add","part":{"name":"torso"}}')).stdout).parts).toHaveLength(1);
  await writeFile(batch, '[{"op":"add","part":{"name":"leg"}}]');
  expect(JSON.parse((await invoke('batch', batch)).stdout).parts).toHaveLength(2);
  expect(JSON.parse((await invoke('undo')).stdout).parts).toHaveLength(1);
  expect(JSON.parse((await invoke('redo')).stdout).parts).toHaveLength(2);
  await invoke('save', project);
  await invoke('new', 'Empty');
  expect(JSON.parse((await invoke('open', project)).stdout).name).toBe('Biped');
  expect(JSON.parse((await invoke('state')).stdout).parts).toHaveLength(2);
  expect(JSON.parse((await invoke('recipe', 'equine', '--gaits', 'walk,gallop')).stdout).clips.map((c: { name: string }) => c.name)).toEqual(['walk', 'gallop']);
  await invoke('open', project);
  const glb = join(directory, 'asset.glb');
  expect(JSON.parse((await invoke('export', glb)).stdout).output).toBe(glb);
  expect(JSON.parse((await invoke('verify', glb)).stdout).ok).toBe(true);
  await expect(invoke('op', '{"op":"remove","name":"missing"}')).rejects.toMatchObject({ code: 1, stderr: expect.stringContaining('"ok":false') });
}, 30000); // Ten fresh Node processes can exceed five seconds on hosted Windows runners.

it('refuses to edit a server that is not agent-meshes', async () => {
  let writes = 0;
  const server = createHttpServer((request, response) => {
    if (request.method === 'POST') writes++;
    response.setHeader('content-type', 'application/json');
    response.end('{"service":"different-service"}');
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  cleanup.push(() => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing address');
  await expect(cli('--url', `http://127.0.0.1:${address.port}`, 'new', 'Bad')).rejects.toMatchObject({
    code: 1, stderr: expect.stringContaining('Endpoint is not an agent-meshes server'),
  });
  expect(writes).toBe(0);
});

it('loads an editable creature recipe atomically and rejects unknown recipes', async () => {
  const server = await createServer({ port: 0 }); cleanup.push(server.close);
  const invoke = (...args: string[]) => cli('--url', server.url, ...args);
  const project = JSON.parse((await invoke('recipe', 'insectoid')).stdout);
  expect(project.name).toBe('Jade scarab');
  expect(project.bones.filter((bone: { name: string }) => bone.name.endsWith('_ankle'))).toHaveLength(6);
  expect(project.clips[0].name).toBe('tripod');
  await expect(invoke('recipe', 'unknown')).rejects.toMatchObject({ code: 1 });
  expect(JSON.parse((await invoke('state')).stdout).name).toBe('Jade scarab');
  expect(JSON.parse((await invoke('undo')).stdout).parts).toHaveLength(0);
}, 30000);

it('inspects and dry-runs a server workspace and preserves structured revision errors', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mesh-cli-server-workspace-'));
  const server = await createServer({ port: 0, workspacePath: directory });
  cleanup.push(server.close, () => rm(directory, { recursive: true, force: true }));
  const invoke = (...args: string[]) => cli('--url', server.url, ...args);
  const file = join(directory, 'batch.json');
  await writeFile(file, '[{"op":"add","part":{"name":"body"}}]');
  expect(JSON.parse((await invoke('batch', file, '--dry-run')).stdout)).toMatchObject({ ok: true, revision: 0, changes: { parts: { added: ['body'] } } });
  expect(JSON.parse((await invoke('inspect')).stdout)).toMatchObject({ counts: { parts: 0 }, workspace: { revision: 0, undo: 0 } });
  await invoke('--expect-revision', '0', 'batch', file);
  expect(JSON.parse((await invoke('inspect', 'body')).stdout)).toMatchObject({ selection: { kind: 'part' }, workspace: { revision: 1 } });
  let failure: { stderr: string } | undefined;
  try { await invoke('--expect-revision', '0', 'new', 'Stale'); } catch (error) { failure = error as { stderr: string }; }
  expect(JSON.parse(failure!.stderr)).toMatchObject({ ok: false, error: { code: 'REVISION_CONFLICT', expected: 0, actual: 1 } });
}, 30000);
