import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createConnection } from 'node:net';
import { EventEmitter } from 'node:events';
import viteConfig from '../vite.config.ts';
import { createServer } from '../src/server.ts';

const servers: Awaited<ReturnType<typeof createServer>>[] = [];
const directories: string[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => server.close()));
  await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true })));
});
async function setup() {
  const server = await createServer({ port: 0 });
  servers.push(server);
  const request = async (path: string, body?: unknown) => {
    const response = await fetch(`${server.url}/api/${path}`, body === undefined ? {} : {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() };
  };
  return { ...server, request };
}
describe('loopback authoring server', () => {
  it('shuts down promptly with an unfinished client request', async () => {
    const service = await createServer({ port: 0 });
    const received = new Promise<void>(resolve => service.server.once('request', () => resolve()));
    const socket = createConnection({ host: '127.0.0.1', port: Number(new URL(service.url).port) });
    await new Promise<void>(resolve => socket.once('connect', resolve));
    socket.write('POST /api/new HTTP/1.1\r\nHost: localhost\r\nContent-Type: application/json\r\nContent-Length: 100\r\n\r\n{');
    await received;
    const closing = service.close();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await expect(Promise.race([closing.then(() => 'closed'), new Promise(resolve => {
        timer = setTimeout(() => resolve('timeout'), 200);
      })])).resolves.toBe('closed');
    } finally {
      clearTimeout(timer);
      socket.destroy();
      await closing;
    }
  });
  it('identifies itself and edits with undo and redo', async () => {
    const { request } = await setup();
    expect((await request('health')).body).toEqual({ service: 'agent-meshes', version: '0.1.0' });
    expect((await request('project')).body.name).toBe('Untitled');
    expect((await request('new', { name: 'Spider' })).body.name).toBe('Spider');
    expect((await request('op', { op: 'add', part: { name: 'thorax' } })).body.parts).toHaveLength(1);
    expect((await request('undo', {})).body.parts).toHaveLength(0);
    expect((await request('redo', {})).body.parts).toHaveLength(1);
  });
  it('rejects an invalid batch without changing the project or undo history', async () => {
    const { request } = await setup();
    await request('op', { op: 'add', part: { name: 'body' } });
    const result = await request('batch', { operations: [
      { op: 'add', part: { name: 'leg' } }, { op: 'add', part: { name: 'body' } },
    ] });
    expect(result.status).toBe(400);
    expect((await request('project')).body.parts.map((part: { name: string }) => part.name)).toEqual(['body']);
    expect((await request('undo', {})).body.parts).toHaveLength(0);
  });
  it('makes a valid batch one undo step and accepts a validated project transaction', async () => {
    const { request } = await setup();
    await request('batch', { operations: [
      { op: 'add', part: { name: 'body' } }, { op: 'add', part: { name: 'leg' } },
    ] });
    expect((await request('undo', {})).body.parts).toHaveLength(0);
    expect((await request('project', { version: 1, name: 'Imported', parts: [] })).body.name).toBe('Imported');
    expect((await request('undo', {})).body.name).toBe('Untitled');
    expect((await request('project', { version: 99 })).status).toBe(400);
  });
  it('saves, reopens, and rejects invalid documents without replacing the project', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'agent-meshes-test-'));
    directories.push(directory);
    const path = join(directory, 'project.json');
    const { request } = await setup();
    await request('new', { name: 'Beetle' });
    expect((await request('save', { path })).status).toBe(200);
    expect(JSON.parse(await readFile(path, 'utf8')).name).toBe('Beetle');
    await request('new', { name: 'Other' });
    expect((await request('open', { path })).body.name).toBe('Beetle');
    await writeFile(path, '{"version":99}');
    expect((await request('open', { path })).status).toBe(400);
    expect((await request('project')).body.name).toBe('Beetle');
  });
  it('serializes concurrent writes and starts from the saved project', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'agent-meshes-test-'));
    directories.push(directory);
    const path = join(directory, 'project.json');
    const { request } = await setup();
    await request('new', { name: 'Persistent' });
    const saves = await Promise.all(Array.from({ length: 8 }, () => request('save', { path })));
    expect(saves.every(result => result.status === 200)).toBe(true);
    const reopened = await createServer({ port: 0, projectPath: path });
    servers.push(reopened);
    expect((await (await fetch(`${reopened.url}/api/project`)).json()).name).toBe('Persistent');
    await writeFile(path, '{}');
    await expect(createServer({ port: 0, projectPath: path })).rejects.toThrow();
  });
  it('streams the initial project and subsequent changes', async () => {
    const { url, request } = await setup();
    const controller = new AbortController();
    const response = await fetch(`${url}/api/events`, { signal: controller.signal });
    const reader = response.body!.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toContain('Untitled');
    await request('new', { name: 'Walker' });
    expect(new TextDecoder().decode((await reader.read()).value)).toContain('Walker');
    controller.abort();
  });
  it('blocks cross-origin writes and malformed requests', async () => {
    const { url, request } = await setup();
    const response = await fetch(`${url}/api/new`, { method: 'POST',
      headers: { origin: 'https://unrelated.example', 'content-type': 'application/json' }, body: '{"name":"Bad"}' });
    expect(response.status).toBe(403);
    expect((await request('new', { name: 42 })).status).toBe(400);
    expect((await request('save', { path: '' })).status).toBe(400);
  });
});

it('rewrites only same-origin loopback browser requests through the Vite proxy', () => {
  const proxy = new EventEmitter();
  const config = viteConfig as { server: { proxy: Record<string, { configure?: (proxy: EventEmitter) => void }> } };
  config.server.proxy['/api'].configure?.(proxy);
  for (const [host, origin, expected] of [
    ['127.0.0.1:5173', 'http://127.0.0.1:5173', 'http://127.0.0.1:3388'],
    ['localhost:5173', 'http://localhost:5173', 'http://127.0.0.1:3388'],
    ['127.0.0.1:5173', 'https://unrelated.example', undefined],
    ['unrelated.example', 'http://unrelated.example', undefined],
  ]) {
    const headers = new Map<string, string>();
    proxy.emit('proxyReq', { setHeader: (key: string, value: string) => headers.set(key, value) }, { headers: { host, origin } });
    expect(headers.get('origin')).toBe(expected);
  }
});
