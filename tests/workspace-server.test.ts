import { afterEach, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { createServer } from '../src/server.ts';
import { Workspace } from '../src/workspace.ts';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn(); });
async function setup() {
  const directory = await mkdtemp(join(tmpdir(), 'mesh-durable-server-')); cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const server = await createServer({ port: 0, workspacePath: directory }); cleanup.push(server.close);
  const post = (path: string, body: unknown, revision?: number) => fetch(`${server.url}/api/${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...(revision === undefined ? {} : { 'x-agent-meshes-revision': String(revision) }) }, body: JSON.stringify(body) });
  return { directory, server, post };
}

it('acknowledges only durable edits and shares current state with independent CLI writers', async () => {
  const { directory, server, post } = await setup();
  const response = await post('op', { op: 'add', part: { name: 'serverPart' } }, 0);
  expect(response.status).toBe(200); expect(response.headers.get('x-agent-meshes-revision')).toBe('1');
  const other = new Workspace(directory);
  expect(other.read().project.parts[0].name).toBe('serverPart');
  other.transact(e => e.apply({ op: 'add', part: { name: 'cliPart' } }), 1); other.close();
  expect((await (await fetch(`${server.url}/api/project`)).json()).parts.map((p: { name: string }) => p.name)).toEqual(['serverPart', 'cliPart']);
  const stale = await post('op', { op: 'remove', name: 'serverPart' }, 1);
  expect(stale.status).toBe(409);
  expect((await stale.json()).details.code).toBe('REVISION_CONFLICT');
  expect((await (await post('undo', {}, 2)).json()).parts.map((p: { name: string }) => p.name)).toEqual(['serverPart']);
});

it('preserves memory and persisted project on database failure and restores after restart', async () => {
  const { directory, server, post } = await setup();
  await post('op', { op: 'add', part: { name: 'kept' } });
  const db = new DatabaseSync(join(directory, 'workspace.sqlite'));
  db.exec("CREATE TRIGGER reject_write BEFORE UPDATE ON workspace BEGIN SELECT RAISE(FAIL, 'storage unavailable'); END");
  expect((await post('op', { op: 'remove', name: 'kept' })).status).toBe(400);
  expect((await (await fetch(`${server.url}/api/project`)).json()).parts[0].name).toBe('kept');
  db.exec('DROP TRIGGER reject_write'); db.close();
  await server.close();
  const restarted = await createServer({ port: 0, workspacePath: directory }); cleanup.push(restarted.close);
  expect((await (await fetch(`${restarted.url}/api/project`)).json()).parts[0].name).toBe('kept');
});

it('publishes external edits even when an HTTP read observes them before the polling tick', async () => {
  const { directory, server } = await setup();
  const controller = new AbortController();
  const response = await fetch(`${server.url}/api/events`, { signal: controller.signal });
  const reader = response.body!.getReader(); await reader.read();
  const other = new Workspace(directory);
  try {
    other.transact(e => e.apply({ op: 'add', part: { name: 'externalPart' } }));
    await fetch(`${server.url}/api/project`);
    const timer = setTimeout(() => controller.abort(), 5000);
    try { expect(new TextDecoder().decode((await reader.read()).value)).toContain('externalPart'); }
    finally { clearTimeout(timer); }
  } finally { other.close(); await reader.cancel().catch(() => {}); controller.abort(); }
}, 10000);

it('returns inspection data and its revision from one snapshot during concurrent writes', async () => {
  const { directory, server } = await setup();
  const script = `import {Workspace} from ${JSON.stringify(pathToFileURL(resolve('src/workspace.ts')).href)}; import {createProject} from ${JSON.stringify(pathToFileURL(resolve('src/core/model.ts')).href)}; const w=new Workspace(${JSON.stringify(directory)}); for(let i=1;i<=120;i++){w.transact(e=>e.replace(createProject('revision'+i)));await new Promise(r=>setTimeout(r,1));}w.close();`;
  const writer = promisify(execFile)(process.execPath, ['--input-type=module', '-e', script], { windowsHide: true });
  try {
    for (let i = 0; i < 200; i++) {
      const snapshot = await (await fetch(`${server.url}/api/inspect`)).json();
      expect(snapshot.name).toBe(snapshot.workspace.revision === 0 ? 'Untitled' : `revision${snapshot.workspace.revision}`);
    }
  } finally { await writer; }
}, 30000);
