/** @lane merge
 * @subject src/cli.ts
 */
import { afterEach, describe, expect, it } from 'vitest';
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readdir, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { deflateRawSync } from 'node:zlib';
import { importAssets } from '../scripts/mixamo-library.mjs';
import {
  ANIMATIONS_API_VERSION, createAnimationServer, downloadsDir, knownFolderFromReg, serveAnimations, serverRecordFile,
} from '../src/animation-server.ts';
import { animatedFbx } from './helpers/animated-fbx.ts';

const run = promisify(execFile);
const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const step of cleanup.splice(0).reverse()) await step(); });
const temp = async (label: string) => { const path = await mkdtemp(join(tmpdir(), `mesh-anim-${label}-`)); cleanup.push(() => rm(path, { recursive: true, force: true })); return path; };

/** A 1 x 1 GIF89a, as a stub renderer returns. */
const TINY_GIF = Buffer.from('47494638396101000100800000000000ffffff21f90401000000002c00000000010001000002024401003b', 'hex');
const stubRender = async () => ({ gif: new Uint8Array(TINY_GIF) });
const WALK = animatedFbx({ travel: 2 }), IDLE = animatedFbx({ travel: 0, seconds: 3 }), RUN = animatedFbx({ travel: 3, seconds: 1 }), JUMP = animatedFbx({ travel: 0.4, seconds: 1.5 });

/** A zip archive of these members, deflated. */
function zip(members: Record<string, Buffer>): Buffer {
  const locals: Buffer[] = [], central: Buffer[] = []; let offset = 0;
  for (const [name, bytes] of Object.entries(members)) {
    const packed = deflateRawSync(bytes), label = Buffer.from(name, 'utf8'), local = Buffer.alloc(30), entry = Buffer.alloc(46);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(8, 8); local.writeUInt32LE(packed.length, 18); local.writeUInt32LE(bytes.length, 22); local.writeUInt16LE(label.length, 26);
    entry.writeUInt32LE(0x02014b50, 0); entry.writeUInt16LE(8, 10); entry.writeUInt32LE(packed.length, 20); entry.writeUInt32LE(bytes.length, 24); entry.writeUInt16LE(label.length, 28); entry.writeUInt32LE(offset, 42);
    locals.push(local, label, packed); central.push(entry, label); offset += 30 + label.length + packed.length;
  }
  const directory = Buffer.concat(central), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(Object.keys(members).length, 8); end.writeUInt16LE(Object.keys(members).length, 10); end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

/** A temporary library, managed home and Downloads folder, with the environment that points at them. */
async function setup() {
  const library = await temp('lib'), home = await temp('home'), downloads = await temp('dl');
  const env = { ...process.env, AGENT_MESHES_HOME: home, AGENT_MESHES_MIXAMO_DIR: library };
  return { library, home, downloads, env };
}
async function startServer(options: Partial<Parameters<typeof createAnimationServer>[0]> = {}) {
  const server = await createAnimationServer({ port: 0, render: stubRender, ...options });
  cleanup.push(() => server.close());
  return server;
}
const json = async (response: Response) => ({ status: response.status, body: await response.json() as any });
const post = (url: string, body: unknown, headers: Record<string, string> = {}) => fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });

/** Every file under a folder (skipping .git), with the SHA-256 of its bytes. */
async function snapshot(folder: string, base = folder): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const item of await readdir(folder, { withFileTypes: true })) {
    if (item.name === '.git') continue;
    const path = join(folder, item.name);
    if (item.isDirectory()) Object.assign(out, await snapshot(path, base));
    else out[path.slice(base.length + 1).replaceAll('\\', '/')] = createHash('sha256').update(await readFile(path)).digest('hex');
  }
  return out;
}

/** Collect the server-sent events of a server until closed. */
async function listen(url: string) {
  const controller = new AbortController(), events: { event: string; data: any }[] = [];
  const response = await fetch(`${url}api/events`, { signal: controller.signal });
  expect(response.headers.get('content-type')).toMatch(/^text\/event-stream/);
  const reader = response.body!.getReader(), decoder = new TextDecoder();
  void (async () => {
    let buffer = '';
    for (;;) {
      const { value, done } = await reader.read().catch(() => ({ value: undefined, done: true }));
      if (done) return;
      buffer += decoder.decode(value, { stream: true });
      for (let at = buffer.indexOf('\n\n'); at >= 0; at = buffer.indexOf('\n\n')) {
        const block = buffer.slice(0, at); buffer = buffer.slice(at + 2);
        const event = /^event: (.+)$/m.exec(block)?.[1], data = /^data: (.+)$/m.exec(block)?.[1];
        if (event && data) events.push({ event, data: JSON.parse(data) });
      }
    }
  })();
  cleanup.push(async () => controller.abort());
  return events;
}
const until = async (check: () => boolean, ms = 5000) => { const end = Date.now() + ms; while (!check()) { if (Date.now() > end) throw new Error('timed out'); await new Promise(r => setTimeout(r, 20)); } };

describe('the Downloads folder', () => {
  const REG = '\r\nHKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\User Shell Folders\r\n    {374DE290-123F-4565-9164-39C4925E467B}    REG_EXPAND_SZ    %USERPROFILE%\\Downloads\r\n\r\n';
  it('reads the Windows known folder from reg query output and expands its variables, in any case', () => {
    expect(knownFolderFromReg(REG, { USERPROFILE: 'C:\\Users\\someone' })).toBe('C:\\Users\\someone\\Downloads');
    const redirected = REG.replace('%USERPROFILE%\\Downloads', '%OneDrive%\\Downloads');
    expect(knownFolderFromReg(redirected, { ONEDRIVE: 'D:\\OneDrive - Example' })).toBe('D:\\OneDrive - Example\\Downloads');
    expect(knownFolderFromReg(REG.replace('REG_EXPAND_SZ    %USERPROFILE%\\Downloads', 'REG_SZ    E:\\Fetched'), {})).toBe('E:\\Fetched');
    expect(knownFolderFromReg('', {})).toBeNull();
    expect(knownFolderFromReg(redirected, {})).toBeNull();
  });
  it('prefers --downloads, then the known folder on Windows, then <home>/Downloads', () => {
    expect(downloadsDir({ downloads: 'some/folder', platform: 'win32', home: resolve('h'), readKnownFolder: () => REG })).toBe(resolve('some/folder'));
    expect(downloadsDir({ platform: 'win32', home: resolve('h'), env: { USERPROFILE: 'C:\\Users\\someone' }, readKnownFolder: () => REG })).toBe('C:\\Users\\someone\\Downloads');
    expect(downloadsDir({ platform: 'win32', home: resolve('h'), env: {}, readKnownFolder: () => null })).toBe(join(resolve('h'), 'Downloads'));
    expect(downloadsDir({ platform: 'linux', home: resolve('h'), readKnownFolder: () => REG })).toBe(join(resolve('h'), 'Downloads'));
  });
});

describe('the animations server API', () => {
  it('lists the top level of Downloads newest first, marking files already in the library by their bytes', async () => {
    const { library, downloads, env } = await setup();
    await writeFile(join(downloads, 'Walk.fbx'), WALK);
    await writeFile(join(downloads, 'Idle.fbx'), IDLE);
    await writeFile(join(downloads, 'Pack.zip'), zip({ 'Walk Copy.fbx': WALK }));
    await writeFile(join(downloads, 'notes.txt'), 'not a download');
    await mkdir(join(downloads, 'Sub')); await writeFile(join(downloads, 'Sub', 'Run.fbx'), RUN);
    const at = Date.now() / 1000;
    await utimes(join(downloads, 'Pack.zip'), at - 300, at - 300);
    await utimes(join(downloads, 'Walk.fbx'), at - 200, at - 200);
    await utimes(join(downloads, 'Idle.fbx'), at - 100, at - 100);
    await importAssets([join(downloads, 'Walk.fbx')], { directory: library, env, render: stubRender });
    const server = await startServer({ library, downloads, env });
    const first = await json(await fetch(`${server.url}api/downloads`));
    expect(first.status).toBe(200);
    expect(first.body.directory).toBe(resolve(downloads));
    expect(first.body.files.map((file: any) => [file.name, file.kind, file.inLibrary])).toEqual([['Idle.fbx', 'fbx', null], ['Walk.fbx', 'fbx', 'walk'], ['Pack.zip', 'zip', 'walk']]);
    expect(first.body.files[0]).toMatchObject({ path: join(resolve(downloads), 'Idle.fbx'), bytes: IDLE.length });
    expect(first.body.files[0].mtimeMs).toBeGreaterThan(first.body.files[1].mtimeMs);
    const imported = await json(await post(`${server.url}api/import`, { paths: [join(downloads, 'Idle.fbx')] }));
    expect(imported.body.results).toEqual([expect.objectContaining({ status: 'imported', id: 'idle' })]);
    const second = await json(await fetch(`${server.url}api/downloads`));
    expect(second.body.files.map((file: any) => file.inLibrary)).toEqual(['idle', 'walk', 'walk']);
  });

  it('reads a download only when its size, or a zip member size, matches a library entry, and reads a zip only around its directory', async () => {
    const { library, downloads, env } = await setup();
    await writeFile(join(downloads, 'Walk.fbx'), WALK);
    await importAssets([join(downloads, 'Walk.fbx')], { directory: library, env, render: stubRender });
    const noise = (bytes: number) => Buffer.from(Array.from({ length: bytes }, () => Math.floor(Math.random() * 256)));
    await writeFile(join(downloads, 'Big.fbx'), noise(2_000_001));
    // Same size as the walk, other bytes: read and hashed, and not in the library.
    const lookalike = Buffer.from(WALK); lookalike[lookalike.length - 1] ^= 0xff;
    await writeFile(join(downloads, 'Lookalike.fbx'), lookalike);
    const huge = noise(1_500_000);
    await writeFile(join(downloads, 'Bundle.zip'), zip({ 'Huge.fbx': huge, 'Walk Copy.fbx': WALK }));
    await writeFile(join(downloads, 'Pack.zip'), zip({ 'Walk Copy.fbx': WALK }));
    const reads: { path: string; start: number; length: number }[] = [];
    const readDownload = async (path: string, start: number, length: number) => {
      reads.push({ path, start, length });
      const bytes = await readFile(path);
      return new Uint8Array(bytes.subarray(start, start + length));
    };
    const server = await startServer({ library, downloads, env, readDownload });
    const listed = await json(await fetch(`${server.url}api/downloads`));
    const inLibrary = Object.fromEntries(listed.body.files.map((file: any) => [file.name, file.inLibrary]));
    expect(inLibrary).toEqual({ 'Walk.fbx': 'walk', 'Big.fbx': null, 'Lookalike.fbx': null, 'Bundle.zip': null, 'Pack.zip': 'walk' });
    const bytesRead = (name: string) => reads.filter(item => item.path === join(resolve(downloads), name)).reduce((sum, item) => sum + item.length, 0);
    expect(bytesRead('Big.fbx')).toBe(0);
    expect(bytesRead('Lookalike.fbx')).toBe(WALK.length);
    expect(bytesRead('Walk.fbx')).toBe(WALK.length);
    // The zip's directory and its walk member are read, never the large member that matches no entry.
    expect(bytesRead('Bundle.zip')).toBeGreaterThan(0);
    expect(bytesRead('Bundle.zip')).toBeLessThan(huge.length / 2);
    // Unchanged files are not read again.
    const before = reads.length;
    await fetch(`${server.url}api/downloads`);
    expect(reads.length).toBe(before);
  });

  it('imports paths and uploads, pushing import-progress events, and lists entries with their preview URLs', async () => {
    const { library, downloads, env } = await setup();
    await writeFile(join(downloads, 'Walk.fbx'), WALK);
    await writeFile(join(downloads, 'Run.fbx'), RUN);
    await writeFile(join(downloads, 'notes.txt'), 'text');
    const server = await startServer({ library, downloads, env });
    const events = await listen(server.url);
    const imported = await json(await post(`${server.url}api/import`, { paths: [join(downloads, 'Walk.fbx'), join(downloads, 'Run.fbx'), join(downloads, 'notes.txt')] }));
    expect(imported.status).toBe(200);
    expect(imported.body.results.map((result: any) => [result.status, result.id ?? null])).toEqual([['imported', 'walk'], ['imported', 'run'], ['rejected', null]]);
    expect(imported.body.results[2].reason).toMatch(/expected an \.fbx file/);
    await until(() => events.filter(item => item.event === 'import-progress').length === 3);
    expect(events.filter(item => item.event === 'import-progress').map(item => item.data)).toEqual([
      expect.objectContaining({ source: join(resolve(downloads), 'Walk.fbx'), status: 'imported', id: 'walk', done: 1, total: 3 }),
      expect.objectContaining({ source: join(resolve(downloads), 'Run.fbx'), status: 'imported', id: 'run', done: 2, total: 3 }),
      expect.objectContaining({ status: 'rejected', reason: expect.any(String), done: 3, total: 3 }),
    ]);

    const uploaded = await json(await fetch(`${server.url}api/upload?name=${encodeURIComponent('Jump Over.fbx')}`, { method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body: new Uint8Array(JUMP) }));
    expect(uploaded.status).toBe(200);
    expect(uploaded.body.results).toEqual([expect.objectContaining({ source: 'Jump Over.fbx', status: 'imported', id: 'jump-over' })]);
    expect(JSON.parse(await readFile(join(library, 'mixamo/clips/jump-over.json'), 'utf8')).sourceName).toBe('Jump Over.fbx');
    expect((await fetch(`${server.url}api/upload`, { method: 'POST', body: new Uint8Array(JUMP) })).status).toBe(400);
    expect((await fetch(`${server.url}api/upload?name=..%2F..%2Fescape.fbx`, { method: 'POST', body: new Uint8Array(JUMP) })).status).toBe(400);
    expect((await post(`${server.url}api/import`, { paths: 'Walk.fbx' })).status).toBe(400);

    const listing = await json(await fetch(`${server.url}api/library`));
    expect(listing.body.directory).toBe(resolve(library));
    expect(listing.body.sync).toEqual({ available: false, reason: expect.stringMatching(/not a git working tree/) });
    const walk = listing.body.entries.find((entry: any) => entry.id === 'walk');
    expect(walk).toMatchObject({ kind: 'clip', title: 'Walk', previewUrl: '/previews/clips/walk.gif', tags: expect.arrayContaining(['locomotion', 'root-motion']) });
    expect(listing.body.entries.map((entry: any) => entry.id).sort()).toEqual(['jump-over', 'run', 'walk']);
    const gif = await fetch(new URL(walk.previewUrl, server.url));
    expect(gif.status).toBe(200);
    expect(gif.headers.get('content-type')).toMatch(/^image\/gif/);
    expect(Buffer.from(await gif.arrayBuffer()).subarray(0, 6).toString('latin1')).toBe('GIF89a');
  });

  it('edits tags, titles and notes, removes entries, and reports errors with 4xx', async () => {
    const { library, downloads, env } = await setup();
    await writeFile(join(downloads, 'Walk.fbx'), WALK);
    await writeFile(join(downloads, 'Idle.fbx'), IDLE);
    await importAssets([join(downloads, 'Walk.fbx'), join(downloads, 'Idle.fbx')], { directory: library, env, render: stubRender });
    const server = await startServer({ library, downloads, env });
    const sidecar = async (id: string) => JSON.parse(await readFile(join(library, `mixamo/clips/${id}.json`), 'utf8'));

    const tagged = await json(await post(`${server.url}api/tags`, { ids: ['walk', 'idle'], add: ['Ronin'], remove: ['locomotion'] }));
    expect(tagged.status).toBe(200);
    expect(tagged.body.entries.map((entry: any) => entry.id).sort()).toEqual(['idle', 'walk']);
    expect(tagged.body.entries.find((entry: any) => entry.id === 'walk')).toMatchObject({ previewUrl: '/previews/clips/walk.gif' });
    expect((await sidecar('walk')).tags).toEqual(['ronin', 'root-motion']);
    expect((await sidecar('idle')).tags).toContain('ronin');

    const titled = await json(await post(`${server.url}api/title`, { id: 'walk', title: 'Sneaky walk' }));
    expect(titled.body.entries).toEqual([expect.objectContaining({ id: 'walk', title: 'Sneaky walk' })]);
    const noted = await json(await post(`${server.url}api/note`, { id: 'walk', note: 'for the ronin' }));
    expect(noted.body.entries).toEqual([expect.objectContaining({ id: 'walk', note: 'for the ronin' })]);
    expect(await sidecar('walk')).toMatchObject({ id: 'walk', title: 'Sneaky walk', note: 'for the ronin' });

    const unknown = await json(await post(`${server.url}api/tags`, { ids: ['nope'], add: ['x'] }));
    expect(unknown.status).toBe(404);
    expect(unknown.body.error).toMatch(/Unknown Mixamo entry: nope/);
    expect((await post(`${server.url}api/tags`, { ids: 'walk', add: ['x'] })).status).toBe(400);
    expect((await post(`${server.url}api/title`, { id: 'walk', title: '  ' })).status).toBe(400);
    expect((await post(`${server.url}api/note`, { note: 'no id' })).status).toBe(400);

    const removed = await json(await post(`${server.url}api/remove`, { ids: ['idle'] }));
    expect(removed.status).toBe(200);
    expect(removed.body.removed).toEqual(['idle']);
    expect((await readdir(join(library, 'mixamo/clips'))).sort()).toEqual(['walk.fbx', 'walk.gif', 'walk.json']);
    expect((await json(await fetch(`${server.url}api/library`))).body.entries.map((entry: any) => entry.id)).toEqual(['walk']);
  });

  it('serves previews only from the layout, with 404 for a missing preview, an LFS pointer or a path that leaves it', async () => {
    const { library, downloads, env } = await setup();
    await writeFile(join(downloads, 'Walk.fbx'), WALK);
    await importAssets([join(downloads, 'Walk.fbx')], { directory: library, env, render: stubRender });
    await writeFile(join(library, 'secret.gif'), TINY_GIF);
    const server = await startServer({ library, downloads, env });
    expect((await fetch(`${server.url}previews/clips/walk.gif`)).status).toBe(200);
    expect((await fetch(`${server.url}previews/clips/run.gif`)).status).toBe(404);
    expect((await fetch(`${server.url}previews/other/walk.gif`)).status).toBe(404);
    expect((await fetch(`${server.url}previews/clips/..%2F..%2Fsecret.gif`)).status).toBe(404);
    expect((await fetch(`${server.url}previews/clips/walk.fbx`)).status).toBe(404);
    await writeFile(join(library, 'mixamo/clips/walk.gif'), 'version https://git-lfs.github.com/spec/v1\noid sha256:0000\nsize 12\n');
    expect((await fetch(`${server.url}previews/clips/walk.gif`)).status).toBe(404);
  });

  it('serves the page and assets from webRoot when given', async () => {
    const { library, downloads, env } = await setup();
    const web = await temp('web');
    await writeFile(join(web, 'animations.html'), '<!doctype html><title>temp build</title><p>from a temporary build</p>');
    await mkdir(join(web, 'assets')); await writeFile(join(web, 'assets', 'page.js'), 'console.log("temp build");');
    const server = await startServer({ library, downloads, env, webRoot: web });
    const page = await fetch(server.url);
    expect(page.headers.get('content-type')).toMatch(/^text\/html/);
    expect(await page.text()).toContain('from a temporary build');
    const script = await fetch(`${server.url}assets/page.js`);
    expect(script.status).toBe(200);
    expect(await script.text()).toContain('temp build');
    const served = await serveAnimations({ port: 0, library, downloads, env, render: stubRender, webRoot: web });
    cleanup.push(() => served.close());
    expect(await (await fetch(served.url)).text()).toContain('from a temporary build');
  });

  it('serves the page at / and rejects a foreign Origin while accepting its own', async () => {
    const { library, downloads, env } = await setup();
    const server = await startServer({ library, downloads, env });
    expect(server.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/$/);
    expect(server.port).toBe(Number(new URL(server.url).port));
    const page = await fetch(server.url);
    expect(page.status).toBe(200);
    expect(page.headers.get('content-type')).toMatch(/^text\/html/);
    const foreign = await post(`${server.url}api/tags`, { ids: [], add: [] }, { origin: 'http://evil.example' });
    expect(foreign.status).toBe(403);
    expect((await fetch(`${server.url}api/library`, { headers: { origin: 'http://evil.example' } })).status).toBe(403);
    expect((await fetch(`${server.url}api/library`, { headers: { origin: new URL(server.url).origin } })).status).toBe(200);
    const health = await json(await fetch(`${server.url}api/health`));
    expect(health.body).toMatchObject({ service: 'agent-meshes-animations', apiVersion: ANIMATIONS_API_VERSION, library: resolve(library) });
  });

  it('refuses tag edits, imports and sync for a library inside an agent-meshes checkout, writing nothing', async () => {
    const { home, downloads } = await setup();
    const checkout = await temp('checkout');
    await run('git', ['init', '-q', checkout]);
    await writeFile(join(checkout, 'package.json'), JSON.stringify({ name: 'agent-meshes' }));
    const library = join(checkout, 'animations');
    await mkdir(join(library, 'mixamo/clips'), { recursive: true });
    await writeFile(join(library, 'mixamo/clips/walk.fbx'), WALK);
    await writeFile(join(downloads, 'Idle.fbx'), IDLE);
    const env = { ...process.env, AGENT_MESHES_HOME: home, AGENT_MESHES_MIXAMO_DIR: library };
    const server = await startServer({ library, downloads, env });
    const before = await snapshot(checkout);
    const listing = await json(await fetch(`${server.url}api/library`));
    expect(listing.body.sync).toEqual({ available: false, reason: expect.stringMatching(/never kept in an agent-meshes checkout/) });
    const tags = await json(await post(`${server.url}api/tags`, { ids: ['walk'], add: ['ronin'] }));
    expect(tags.status).toBe(409);
    expect(tags.body.error).toMatch(/Mixamo files are never kept in an agent-meshes checkout/);
    const sync = await json(await post(`${server.url}api/sync`, {}));
    expect(sync.status).toBe(409);
    expect(sync.body.error).toMatch(/Mixamo files are never kept in an agent-meshes checkout/);
    const imported = await json(await post(`${server.url}api/import`, { paths: [join(downloads, 'Idle.fbx')] }));
    expect(imported.status).toBe(409);
    expect(await snapshot(checkout)).toEqual(before);
  });
});

describe('the server record', () => {
  it('reuses one live server for the same library, even when two starts race, and removes the record on close', async () => {
    const { library, downloads, env } = await setup();
    const [a, b] = await Promise.all([
      serveAnimations({ port: 0, library, downloads, env, render: stubRender }),
      serveAnimations({ port: 0, library, downloads, env, render: stubRender }),
    ]);
    cleanup.push(() => a.close(), () => b.close());
    expect(a.url).toBe(b.url);
    expect([a.reused, b.reused].sort()).toEqual([false, true]);
    const record = JSON.parse(await readFile(serverRecordFile(env), 'utf8'));
    expect(record).toEqual({ pid: process.pid, port: a.port, url: a.url, apiVersion: ANIMATIONS_API_VERSION, library: resolve(library) });
    const other = await temp('other-lib');
    await expect(serveAnimations({ port: 0, library: other, downloads, env, render: stubRender })).rejects.toThrow(/already running.*library/s);
    const owner = a.reused ? b : a;
    await owner.close();
    await expect(readFile(serverRecordFile(env), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  /** A stand-in for an animations server of API version 0, whose health reports `reportedPid` (its own pid by default). */
  async function oldServer(library: string, reportedPid?: number) {
    const pid = reportedPid === undefined ? 'process.pid' : String(reportedPid);
    const old = spawn(process.execPath, ['-e', `require('node:http').createServer((q, s) => { s.setHeader('content-type', 'application/json'); s.end(JSON.stringify({ service: 'agent-meshes-animations', apiVersion: 0, library: ${JSON.stringify(resolve(library))}, pid: ${pid} })); }).listen(0, '127.0.0.1', function () { console.log(this.address().port); });`], { stdio: ['ignore', 'pipe', 'inherit'], windowsHide: true });
    const exited = new Promise(resolveExit => old.once('exit', resolveExit));
    cleanup.push(async () => { if (old.exitCode === null) { old.kill(); await exited; } });
    const port = Number(await new Promise<string>(resolveLine => old.stdout!.once('data', chunk => resolveLine(String(chunk).trim()))));
    return { old, exited, port };
  }

  it('stops a live server of another API version and starts a fresh one', async () => {
    const { library, downloads, env, home } = await setup();
    const { old, exited, port } = await oldServer(library);
    await writeFile(join(home, 'animations-server.json'), JSON.stringify({ pid: old.pid, port, url: `http://127.0.0.1:${port}/`, apiVersion: 0, library: resolve(library) }));
    const fresh = await serveAnimations({ port: 0, library, downloads, env, render: stubRender });
    cleanup.push(() => fresh.close());
    expect(fresh.reused).toBe(false);
    expect(fresh.url).not.toBe(`http://127.0.0.1:${port}/`);
    await exited;
    expect(JSON.parse(await readFile(serverRecordFile(env), 'utf8'))).toMatchObject({ pid: process.pid, url: fresh.url, apiVersion: ANIMATIONS_API_VERSION });
  });

  it('never stops the recorded pid when the server answering at the recorded URL reports another pid', async () => {
    const { library, downloads, env, home } = await setup();
    // The recorded pid is alive, but the server at the URL is a different process: the record is stale.
    const bystander = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', windowsHide: true });
    const gone = new Promise(resolveExit => bystander.once('exit', resolveExit));
    cleanup.push(async () => { if (bystander.exitCode === null) { bystander.kill(); await gone; } });
    const { old, port } = await oldServer(library, 1);
    await writeFile(join(home, 'animations-server.json'), JSON.stringify({ pid: bystander.pid, port, url: `http://127.0.0.1:${port}/`, apiVersion: 0, library: resolve(library) }));
    const fresh = await serveAnimations({ port: 0, library, downloads, env, render: stubRender });
    cleanup.push(() => fresh.close());
    expect(fresh.reused).toBe(false);
    await new Promise(r => setTimeout(r, 300));
    expect(bystander.exitCode).toBeNull();
    expect(old.exitCode).toBeNull();
    expect(JSON.parse(await readFile(serverRecordFile(env), 'utf8'))).toMatchObject({ pid: process.pid, url: fresh.url, apiVersion: ANIMATIONS_API_VERSION });
  });
});

describe('agent-meshes animations', () => {
  const cli = resolve('scripts/agent-meshes.mjs');
  const firstLine = (child: ChildProcess) => new Promise<string>((resolveLine, reject) => {
    let out = '', err = '';
    child.stdout!.on('data', chunk => { out += chunk; if (out.includes('\n')) resolveLine(out.slice(0, out.indexOf('\n'))); });
    child.stderr!.on('data', chunk => { err += chunk; });
    child.once('exit', code => reject(new Error(`serve exited with ${code}: ${err}`)));
  });

  it('serve prints the URL line, serves the library and its previews, and a second serve reuses the server', async () => {
    const { library, downloads, env, home } = await setup();
    await writeFile(join(downloads, 'Walk.fbx'), WALK);
    await importAssets([join(downloads, 'Walk.fbx')], { directory: library, env, render: stubRender });
    const server = spawn(process.execPath, [cli, 'animations', 'serve', '--port', '0', '--library', library, '--downloads', downloads], { env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    cleanup.push(async () => { if (server.exitCode === null) { const gone = new Promise(r => server.once('exit', r)); server.kill(); await gone; } });
    const line = JSON.parse(await firstLine(server));
    expect(line).toEqual({ service: 'animations', url: expect.stringMatching(/^http:\/\/127\.0\.0\.1:\d+\/$/) });
    const listing = await json(await fetch(`${line.url}api/library`));
    expect(listing.body.entries).toEqual([expect.objectContaining({ id: 'walk', previewUrl: '/previews/clips/walk.gif' })]);
    const gif = await fetch(new URL(listing.body.entries[0].previewUrl, line.url));
    expect(gif.headers.get('content-type')).toMatch(/^image\/gif/);
    expect((await fetch(`${line.url}api/library`, { headers: { origin: 'http://evil.example' } })).status).toBe(403);
    const record = JSON.parse(await readFile(join(home, 'animations-server.json'), 'utf8'));
    expect(record).toMatchObject({ pid: server.pid, url: line.url, apiVersion: 1, library: resolve(library) });

    const again = await run(process.execPath, [cli, 'animations', 'serve', '--port', '0', '--library', library, '--downloads', downloads], { env, timeout: 20000, windowsHide: true });
    expect(JSON.parse(again.stdout.trim())).toEqual(line);
    expect(JSON.parse(await readFile(join(home, 'animations-server.json'), 'utf8'))).toEqual(record);
    expect(server.exitCode).toBeNull();
  }, 60000);

  it('import prints the results of the pipeline as JSON', async () => {
    const { library, downloads, env } = await setup();
    await writeFile(join(downloads, 'Walk.fbx'), WALK);
    await writeFile(join(downloads, 'notes.txt'), 'text');
    // An imported clip renders its preview in Chromium; a rejected file and a duplicate never start it.
    await importAssets([join(downloads, 'Walk.fbx')], { directory: library, env, render: stubRender });
    const { stdout } = await run(process.execPath, [cli, 'animations', 'import', join(downloads, 'Walk.fbx'), join(downloads, 'notes.txt'), '--tags', 'ronin', '--library', library], { env, timeout: 20000, windowsHide: true });
    const { results } = JSON.parse(stdout);
    expect(results.map((result: any) => [result.status, result.id ?? null])).toEqual([['duplicate', 'walk'], ['rejected', null]]);
  }, 30000);
});
