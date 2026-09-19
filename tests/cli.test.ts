import { afterEach, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer as createHttpServer } from 'node:http';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer } from '../src/server.ts';

const run = promisify(execFile);
const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0)) await close(); });
const cli = (...args: string[]) => run(process.execPath, [resolve('scripts/agent-meshes.mjs'), ...args], { timeout: 10000, windowsHide: true });

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
  const glb = join(directory, 'asset.glb');
  expect(JSON.parse((await invoke('export', glb)).stdout).output).toBe(glb);
  expect(JSON.parse((await invoke('verify', glb)).stdout).ok).toBe(true);
  await expect(invoke('op', '{"op":"remove","name":"missing"}')).rejects.toMatchObject({ code: 1, stderr: expect.stringContaining('Error:') });
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
