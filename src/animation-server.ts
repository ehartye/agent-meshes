/**
 * The animations page server: one per machine, on 127.0.0.1, serving the Mixamo library page (`dist-web/animations.html`)
 * and the HTTP API it uses (version 1). It imports downloads through the library's one import pipeline, one import at
 * a time with one preview browser, pushes `import-progress` server-sent events, edits sidecars, serves preview GIFs,
 * and runs Sync through `library-sync.ts`. `serveAnimations` adds the server record in the managed home
 * (`animations-server.json`), so a second start reuses a live server instead of starting another.
 */
import express from 'express';
import type { NextFunction, Request, Response } from 'express';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { mkdir, mkdtemp, open, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { createServer as createHttpServer } from 'node:http';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inflateRawSync } from 'node:zlib';
import {
  assertNotMeshesCheckout, importAssets, mixamoDir, mixamoRegistry, removeAssets, setNote, setTags, setTitle,
} from '../scripts/mixamo-library.mjs';
import type { MixamoEntry, MixamoImportResult, MixamoRender } from '../scripts/mixamo-library.mjs';
import type { PreviewSession } from './animation-preview.ts';
import { syncLibrary, syncStatus } from './library-sync.ts';

type Env = Record<string, string | undefined>;

/** The version of the HTTP API between this server and its page. A server of another version is replaced. */
export const ANIMATIONS_API_VERSION = 1;
export const ANIMATIONS_SERVICE = 'agent-meshes-animations';
export const DEFAULT_ANIMATIONS_PORT = 3390;
const UPLOAD_LIMIT = '512mb';
const POINTER = 'version https://git-lfs.github.com/spec/';
const DOWNLOADS_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\User Shell Folders';
const DOWNLOADS_GUID = '{374DE290-123F-4565-9164-39C4925E467B}';
/** The package's built web pages, served unless `webRoot` names another build. */
const DIST_WEB = fileURLToPath(new URL('../dist-web/', import.meta.url));

/** An error the API answers with this status and `{ error }`. */
class HttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}

/** The managed home: AGENT_MESHES_HOME, else ~/.agent-meshes. */
const managedHome = (env: Env) => env.AGENT_MESHES_HOME ? resolve(env.AGENT_MESHES_HOME) : join(homedir(), '.agent-meshes');
/** Where the running server is recorded: `<managed home>/animations-server.json`. */
export const serverRecordFile = (env: Env = process.env) => join(managedHome(env), 'animations-server.json');

/** The Downloads known folder from `reg query` output for the User Shell Folders key, with `%VAR%`s expanded from
 *  `env` (names matched in any case). Null when the value is absent or names a variable `env` lacks. */
export function knownFolderFromReg(output: string, env: Env): string | null {
  const match = new RegExp(`${DOWNLOADS_GUID.replace(/[{}]/g, '\\$&')}\\s+(REG_EXPAND_SZ|REG_SZ)\\s+(.*)$`, 'im').exec(output);
  const value = match?.[2]?.trim();
  if (!value) return null;
  let missing = false;
  const expanded = value.replace(/%([^%]+)%/g, (all, name: string) => {
    const key = Object.keys(env).find(candidate => candidate.toLowerCase() === name.toLowerCase());
    const found = key === undefined ? undefined : env[key];
    if (found === undefined) { missing = true; return all; }
    return found;
  });
  return missing || !expanded ? null : expanded;
}

function readKnownFolderFromRegistry(): string | null {
  try { return execFileSync('reg', ['query', DOWNLOADS_KEY, '/v', DOWNLOADS_GUID], { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000 }); }
  catch { return null; }
}

/** The Downloads folder: `downloads` when given, else on Windows the Downloads known folder (so one redirected to
 *  OneDrive is found), else `<home>/Downloads`. */
export function downloadsDir({ downloads, env = process.env, platform = process.platform, home = homedir(), readKnownFolder = readKnownFolderFromRegistry }: {
  downloads?: string; env?: Env; platform?: string; home?: string; readKnownFolder?: () => string | null;
} = {}): string {
  if (downloads) return resolve(downloads);
  if (platform === 'win32') {
    const output = readKnownFolder();
    const folder = output ? knownFolderFromReg(output, env) : null;
    if (folder) return folder;
  }
  return join(home, 'Downloads');
}

export interface AnimationServerOptions {
  /** Listening port on 127.0.0.1 (default 3390; 0 picks a free one). */
  port?: number;
  /** The library folder (default: AGENT_MESHES_MIXAMO_DIR, through `mixamoDir`). */
  library?: string;
  /** The Downloads folder the Import tab lists (default: `downloadsDir`). */
  downloads?: string;
  env?: Env;
  /** Preview renderer; by default one preview browser session, started on the first import. */
  render?: MixamoRender;
  /** The built web pages to serve: `animations.html` at `/` and the rest statically (default: the package's `dist-web`). */
  webRoot?: string;
  /** Reads `length` bytes at `start` of a file in Downloads (default: a positioned file read). Every read of a download goes through it. */
  readDownload?: ReadDownload;
}
export type ReadDownload = (path: string, start: number, length: number) => Promise<Uint8Array>;
export interface AnimationServer { url: string; port: number; library: string; downloads: string; close(): Promise<void> }
export interface DownloadFile { name: string; path: string; bytes: number; mtimeMs: number; kind: 'fbx' | 'zip'; inLibrary: string | null }
export type ImportProgress = MixamoImportResult & { done: number; total: number };

const PLACEHOLDER = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Animation library</title></head>
<body style="font-family: system-ui, sans-serif; margin: 2rem; color: #213844; background: #f6f8f9"><h1>Animation library</h1>
<p>The page has not been built in this runtime. Run <code>npm run build</code>, then reload. The API is at <code>/api/library</code>.</p></body></html>`;

/** The preview URL of an entry in the library layout, or null when it has no preview or sits outside the layout. */
function previewUrl(entry: MixamoEntry): string | null {
  const folder = /^mixamo\/(clips|characters)\/[^/]+$/.exec(entry.file)?.[1];
  return entry.preview && folder ? `/previews/${folder}/${encodeURIComponent(entry.preview)}` : null;
}
const withPreview = (entry: MixamoEntry) => ({ ...entry, previewUrl: previewUrl(entry) });

const strings = (value: unknown, name: string, optional = false): string[] => {
  if (value === undefined && optional) return [];
  if (!Array.isArray(value) || value.some(item => typeof item !== 'string')) throw new HttpError(400, `${name} must be an array of strings`);
  return value as string[];
};
const text = (value: unknown, name: string): string => {
  if (typeof value !== 'string') throw new HttpError(400, `${name} must be a string`);
  return value;
};

/** The HTTP status for an error from the library: the checkout rule and an unreadable sidecar are conflicts, an unknown id is not found. */
function statusOf(error: unknown): number {
  const status = (error as { status?: unknown })?.status;
  if (typeof status === 'number' && status >= 400 && status < 600) return status;
  const message = error instanceof Error ? error.message : String(error);
  if (/never kept in an agent-meshes checkout/.test(message)) return 409;
  // An unreadable sidecar (a sync conflict left in it, or another schema) is refused so nothing overwrites it.
  if (/^sidecar .* (is not valid JSON|does not have the schema \S+); fix or restore it$/.test(message)) return 409;
  if (/^Unknown Mixamo entry/.test(message)) return 404;
  if (/^a title cannot be empty/.test(message)) return 400;
  return 500;
}

async function readRange(path: string, start: number, length: number): Promise<Uint8Array> {
  const handle = await open(path, 'r');
  try {
    const bytes = Buffer.alloc(length);
    let done = 0;
    while (done < length) { const { bytesRead } = await handle.read(bytes, done, length - done, start + done); if (!bytesRead) break; done += bytesRead; }
    return bytes.subarray(0, done);
  } finally { await handle.close(); }
}

/** One FBX a download holds: its uncompressed size, and how to read its bytes. */
interface DownloadMember { size: number; read: () => Promise<Buffer>; sha?: string }

/** The FBX members of a zip from its central directory alone (the end record, then the directory), so a large archive
 *  is never read whole. A member's bytes are read only when asked for. Zip64 and damaged archives list nothing. */
async function zipMembers(path: string, bytes: number, read: ReadDownload): Promise<DownloadMember[]> {
  const tailLength = Math.min(bytes, 22 + 0xffff), tail = Buffer.from(await read(path, bytes - tailLength, tailLength));
  let end = tail.length - 22;
  while (end >= 0 && tail.readUInt32LE(end) !== 0x06054b50) end--;
  if (end < 0) return [];
  const count = tail.readUInt16LE(end + 10), size = tail.readUInt32LE(end + 12), offset = tail.readUInt32LE(end + 16);
  if (offset === 0xffffffff || offset + size > bytes) return [];
  const directory = Buffer.from(await read(path, offset, size)), members: DownloadMember[] = [];
  for (let at = 0, i = 0; i < count && at + 46 <= directory.length; i++) {
    if (directory.readUInt32LE(at) !== 0x02014b50) return [];
    const method = directory.readUInt16LE(at + 10), packed = directory.readUInt32LE(at + 20), length = directory.readUInt32LE(at + 24);
    const nameLength = directory.readUInt16LE(at + 28), extra = directory.readUInt16LE(at + 30), comment = directory.readUInt16LE(at + 32), local = directory.readUInt32LE(at + 42);
    const name = directory.subarray(at + 46, at + 46 + nameLength).toString('utf8');
    at += 46 + nameLength + extra + comment;
    if (extname(name).toLowerCase() !== '.fbx' || (method !== 0 && method !== 8)) continue;
    members.push({
      size: length,
      read: async () => {
        const header = Buffer.from(await read(path, local, 30));
        const raw = Buffer.from(await read(path, local + 30 + header.readUInt16LE(26) + header.readUInt16LE(28), packed));
        return method === 0 ? raw : inflateRawSync(raw);
      },
    });
  }
  return members;
}

/** Start the animations page server. Not recorded; `serveAnimations` adds the per-machine record and reuse. */
export async function createAnimationServer(options: AnimationServerOptions = {}): Promise<AnimationServer> {
  const env = options.env ?? process.env;
  const library = resolve(options.library ?? mixamoDir(env));
  const downloads = downloadsDir({ downloads: options.downloads, env });
  const webRoot = resolve(options.webRoot ?? DIST_WEB), readDownload = options.readDownload ?? readRange;
  const app = express();
  const server = createHttpServer(app);
  const clients = new Set<Response>();
  let port = 0;
  let queue: Promise<unknown> = Promise.resolve();
  /** Library writes (each imported file, each edit, Sync) run one at a time, in the order they arrive. Reads do not
   *  wait for them: the library writes each file whole under a temporary name, and the registry the same way. */
  const serial = <T>(task: () => Promise<T>): Promise<T> => { const run = queue.then(task); queue = run.catch(() => {}); return run; };

  let session: Promise<PreviewSession> | undefined;
  const render: MixamoRender = options.render ?? (async path => {
    if (!session) {
      session = import('./animation-preview.ts').then(module => module.createPreviewSession());
      session.catch(() => { session = undefined; });
    }
    return (await session).render(path);
  });

  const broadcast = (event: string, data: unknown) => {
    const message = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const client of clients) client.write(message);
  };

  app.disable('x-powered-by');
  // Loopback only: a request from another origin, or addressed to another host name (DNS rebinding), is refused.
  app.use((request, response, next) => {
    const hosts = [`127.0.0.1:${port}`, `localhost:${port}`];
    const origin = request.headers.origin;
    if ((origin && !hosts.some(host => origin === `http://${host}`)) || !hosts.includes(String(request.headers.host ?? ''))) {
      response.status(403).json({ error: 'Cross-origin requests are not allowed' });
      return;
    }
    next();
  });

  app.get('/api/health', (_request, response) => { response.json({ service: ANIMATIONS_SERVICE, apiVersion: ANIMATIONS_API_VERSION, library, pid: process.pid }); });

  const entries = async () => existsSync(library) ? (await mixamoRegistry(library, env)).entries : [];
  app.get('/api/library', async (_request, response) => {
    const [list, sync] = await Promise.all([entries(), syncStatus(library)]);
    response.json({ directory: library, sync: sync.available ? { available: true } : { available: false, reason: sync.reason }, entries: list.map(withPreview) });
  });

  /** The FBX members of each download (the file itself, for an FBX), cached by path, size and modification time with
   *  any hashes already taken. Of a zip, only its end record and central directory are read to list the members, so a
   *  cloud-only zip in a synced Downloads can still be fetched for that. A member, or an FBX download, is read and
   *  hashed only when its size is the size of some library entry; an FBX of any other size is never read. */
  const probes = new Map<string, { key: string; members: DownloadMember[] }>();
  const membersOf = async (file: Omit<DownloadFile, 'inLibrary'>) => {
    const key = `${file.bytes}:${file.mtimeMs}`, cached = probes.get(file.path);
    if (cached?.key === key) return cached.members;
    const members = file.kind === 'fbx'
      ? [{ size: file.bytes, read: async () => Buffer.from(await readDownload(file.path, 0, file.bytes)) }]
      : await zipMembers(file.path, file.bytes, readDownload).catch(() => []);
    probes.set(file.path, { key, members });
    return members;
  };
  /** The id of the entry with this member's bytes, or null; the member is read only when its size could match. */
  const idOf = async (member: DownloadMember, sizes: Set<number>, bySha: Map<string, string>) => {
    if (!sizes.has(member.size)) return null;
    member.sha ??= createHash('sha256').update(await member.read()).digest('hex');
    return bySha.get(member.sha) ?? null;
  };
  app.get('/api/downloads', async (_request, response) => {
    let items: import('node:fs').Dirent[];
    try { items = await readdir(downloads, { withFileTypes: true }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; items = []; }
    const files: Omit<DownloadFile, 'inLibrary'>[] = [];
    for (const item of items) {
      const kind = extname(item.name).toLowerCase().slice(1);
      if (!item.isFile() || (kind !== 'fbx' && kind !== 'zip')) continue;
      const path = join(downloads, item.name);
      try { const info = await stat(path); files.push({ name: item.name, path, bytes: info.size, mtimeMs: info.mtimeMs, kind }); }
      catch { /* removed while listing */ }
    }
    files.sort((a, b) => b.mtimeMs - a.mtimeMs || a.name.localeCompare(b.name));
    for (const path of probes.keys()) if (!files.some(file => file.path === path)) probes.delete(path);
    const known = await entries();
    const bySha = new Map(known.map(entry => [entry.sha256, entry.id])), sizes = new Set(known.map(entry => entry.bytes));
    const listed: DownloadFile[] = [];
    for (const file of files) {
      // A zip is in the library when every FBX in it is; it takes the id of its first.
      let inLibrary: string | null = null;
      try {
        const members = await membersOf(file);
        for (const member of members) {
          const id = await idOf(member, sizes, bySha);
          if (!id) { inLibrary = null; break; }
          inLibrary ??= id;
        }
      } catch { inLibrary = null; /* unreadable */ }
      listed.push({ ...file, inLibrary });
    }
    response.json({ directory: downloads, files: listed });
  });

  app.get('/api/events', (_request, response) => {
    response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
    response.write(': connected\n\n');
    clients.add(response);
    response.on('close', () => clients.delete(response));
  });

  /** Import sources one after another, sending one `import-progress` event per result. Each source is its own write
   *  task, queued when the one before it ends, so an edit or Sync sent meanwhile runs between two files. `label` turns a
   *  temporary upload path back into the name the page sent. */
  const runImport = async (sources: { path: string; label?: (source: string) => string }[], tags: string[]) => {
    assertNotMeshesCheckout(library);
    const results: MixamoImportResult[] = [], total = sources.length;
    let done = 0;
    for (const source of sources) {
      let part = (await serial(() => importAssets([source.path], { directory: library, env, tags, render }))).results;
      if (!part.length) part = [{ source: source.path, status: 'rejected', reason: 'no FBX files in this folder' }];
      part.forEach((result, index) => {
        const shown = source.label ? { ...result, source: source.label(result.source) } : result;
        if (index === part.length - 1) done++;
        results.push(shown);
        broadcast('import-progress', { ...shown, done, total } satisfies ImportProgress);
      });
    }
    return results;
  };

  const api = express.json({ limit: '1mb' });
  app.post('/api/import', api, async (request, response) => {
    const paths = strings(request.body?.paths, 'paths');
    if (!paths.length) throw new HttpError(400, 'paths must name at least one file');
    const tags = strings(request.body?.tags, 'tags', true);
    response.json({ results: await runImport(paths.map(path => ({ path: resolve(path) })), tags) });
  });

  app.post('/api/upload', express.raw({ type: () => true, limit: UPLOAD_LIMIT }), async (request, response) => {
    const name = request.query.name;
    if (typeof name !== 'string' || !name || name.length > 255 || basename(name) !== name || /[\\/:\0]/.test(name) || name === '.' || name === '..') {
      throw new HttpError(400, 'name must be a plain file name, such as Walk.fbx');
    }
    if (!Buffer.isBuffer(request.body) || !request.body.length) throw new HttpError(400, 'the upload is empty');
    assertNotMeshesCheckout(library);
    const folder = await mkdtemp(join(tmpdir(), 'agent-meshes-upload-'));
    try {
      const path = join(folder, name);
      await writeFile(path, request.body);
      const label = (source: string) => source.startsWith(folder) ? source.slice(folder.length + 1).replaceAll('\\', '/') : source;
      const tags = typeof request.query.tags === 'string' ? request.query.tags.split(',') : [];
      response.json({ results: await runImport([{ path, label }], tags) });
    } finally { await rm(folder, { recursive: true, force: true }); }
  });

  const edit = { directory: library, env };
  app.post('/api/tags', api, async (request, response) => {
    const ids = strings(request.body?.ids, 'ids'), add = strings(request.body?.add, 'add', true), remove = strings(request.body?.remove, 'remove', true);
    const { entries: changed } = await serial(() => setTags(ids, add, remove, edit));
    response.json({ entries: changed.map(withPreview) });
  });
  app.post('/api/title', api, async (request, response) => {
    const id = text(request.body?.id, 'id'), title = text(request.body?.title, 'title');
    if (!title.trim()) throw new HttpError(400, 'a title cannot be empty');
    const { entries: changed } = await serial(() => setTitle(id, title, edit));
    response.json({ entries: changed.map(withPreview) });
  });
  app.post('/api/note', api, async (request, response) => {
    const id = text(request.body?.id, 'id'), note = text(request.body?.note, 'note');
    const { entries: changed } = await serial(() => setNote(id, note, edit));
    response.json({ entries: changed.map(withPreview) });
  });
  app.post('/api/remove', api, async (request, response) => {
    const ids = strings(request.body?.ids, 'ids');
    const { removed } = await serial(() => removeAssets(ids, edit));
    response.json({ removed });
  });

  app.get('/api/sync', async (_request, response) => { response.json(await syncStatus(library)); });
  app.post('/api/sync', api, async (_request, response) => { response.json(await serial(() => syncLibrary(library))); });

  app.get('/previews/:folder/:file', async (request, response) => {
    const { folder, file } = request.params as { folder: string; file: string };
    const missing = () => { response.status(404).json({ error: 'No preview' }); };
    if (!['clips', 'characters'].includes(folder) || !/^[^\\/:\0]+\.gif$/i.test(file) || file.startsWith('.')) { missing(); return; }
    let bytes: Buffer;
    try { bytes = await readFile(join(library, 'mixamo', folder, file)); } catch { missing(); return; }
    // A clone made without LFS content holds a pointer, not the GIF; the page shows its placeholder.
    if (bytes.subarray(0, POINTER.length).toString('latin1') === POINTER) { missing(); return; }
    response.setHeader('content-type', 'image/gif');
    response.setHeader('cache-control', 'no-cache');
    response.end(bytes);
  });

  app.get('/', (_request, response) => {
    const page = join(webRoot, 'animations.html');
    // With `root`, send checks only the file name for dot segments, so an installed runtime under ~/.agent-meshes is served.
    if (existsSync(page)) response.sendFile('animations.html', { root: webRoot });
    else response.type('html').send(PLACEHOLDER);
  });
  app.use(express.static(webRoot, { index: false }));
  app.use('/api', (_request, response) => { response.status(404).json({ error: 'No such API route' }); });
  app.use((error: unknown, _request: Request, response: Response, next: NextFunction) => {
    if (response.headersSent) { next(error); return; }
    response.status(statusOf(error)).json({ error: error instanceof Error ? error.message : String(error) });
  });

  await new Promise<void>((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(options.port ?? DEFAULT_ANIMATIONS_PORT, '127.0.0.1', () => {
      server.off('error', reject);
      const address = server.address();
      if (!address || typeof address === 'string') { reject(new Error('No listening address')); return; }
      port = address.port;
      resolveListen();
    });
  });
  let closed = false;
  return {
    url: `http://127.0.0.1:${port}/`, port, library, downloads,
    close: async () => {
      if (closed) return; closed = true;
      for (const client of clients) client.end();
      await new Promise<void>((resolveClose, reject) => { server.close(error => error ? reject(error) : resolveClose()); server.closeAllConnections(); });
      await queue;
      if (session) await (await session.catch(() => null))?.close();
    },
  };
}

/** Whether two resolved library paths name one folder: case-insensitively on Windows, whose file names ignore case. */
export const sameLibrary = (a: string | undefined, b: string, platform = process.platform) =>
  typeof a === 'string' && (platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b);

interface ServerRecord { pid: number; port: number; url: string; apiVersion: number; library: string }
export interface ServedAnimations { url: string; port: number; pid: number; reused: boolean; close(): Promise<void> }

const sleep = (ms: number) => new Promise(done => setTimeout(done, ms));
function alive(pid: unknown): boolean {
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === 'EPERM'; }
}
async function readRecord(file: string): Promise<ServerRecord | null> {
  try { const record = JSON.parse(await readFile(file, 'utf8')); return record && typeof record === 'object' ? record : null; }
  catch { return null; }
}
async function health(url: string): Promise<{ service?: string; apiVersion?: number; library?: string; pid?: number } | null> {
  try {
    const response = await fetch(new URL('api/health', url), { signal: AbortSignal.timeout(3000) });
    const body = await response.json() as { service?: string; apiVersion?: number; library?: string; pid?: number };
    return response.ok && body?.service === ANIMATIONS_SERVICE ? body : null;
  } catch { return null; }
}

/** An exclusive lock file, so two agents starting the server at once start one: the second waits, then reuses it.
 *  A lock whose holder has exited, or older than a minute, is stale and taken over. */
async function lock(path: string, timeoutMs = 30000): Promise<() => Promise<void>> {
  const start = Date.now();
  for (;;) {
    try {
      const handle = await open(path, 'wx');
      try { await handle.writeFile(JSON.stringify({ pid: process.pid, at: new Date().toISOString() })); } finally { await handle.close(); }
      return () => rm(path, { force: true });
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    try {
      const [content, info] = await Promise.all([readFile(path, 'utf8'), stat(path)]);
      let holder: unknown = null;
      try { holder = JSON.parse(content).pid; } catch { /* still being written */ }
      if ((holder !== null && !alive(holder)) || Date.now() - info.mtimeMs > 60000) { await rm(path, { force: true }); continue; }
    } catch { continue; /* released meanwhile */ }
    if (Date.now() - start > timeoutMs) throw new Error(`Another animations serve is starting (lock ${path}); if none is, delete the lock and retry`);
    await sleep(50);
  }
}

async function stop(pid: number) {
  if (pid === process.pid) return;
  try { process.kill(pid); } catch { return; }
  for (const end = Date.now() + 10000; alive(pid);) {
    if (Date.now() > end) throw new Error(`The animations server of another API version (pid ${pid}) did not stop`);
    await sleep(50);
  }
}

/** Start the one animations server of this machine, or reuse it. A live server with the same API version and library
 *  is reused (nothing new starts); one with another API version is stopped and replaced; one serving another library
 *  is left running and this call fails. The record is written atomically and removed when the server closes. */
export async function serveAnimations(options: AnimationServerOptions = {}): Promise<ServedAnimations> {
  const env = options.env ?? process.env;
  const library = resolve(options.library ?? mixamoDir(env));
  const file = serverRecordFile(env);
  await mkdir(dirname(file), { recursive: true });
  const release = await lock(`${file}.lock`);
  try {
    const record = await readRecord(file);
    if (record && alive(record.pid)) {
      const identity = await health(record.url);
      if (identity?.apiVersion === ANIMATIONS_API_VERSION && sameLibrary(identity.library, library)) {
        return { url: record.url, port: record.port, pid: record.pid, reused: true, close: async () => {} };
      }
      if (identity?.apiVersion === ANIMATIONS_API_VERSION) {
        throw new Error(`An animations server is already running at ${record.url} (pid ${record.pid}) for another library, ${identity.library}. Stop it first, or serve that library.`);
      }
      // Another API version: stop it, but only when the process that answered is the recorded one. Otherwise the pid
      // now belongs to another program (or nothing answers) and the record is stale.
      if (identity && identity.pid === record.pid) await stop(record.pid);
      else await rm(file, { force: true });
    }
    let server: AnimationServer;
    try { server = await createAnimationServer({ ...options, library }); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw error;
      const port = options.port ?? DEFAULT_ANIMATIONS_PORT, other = await health(`http://127.0.0.1:${port}/`);
      throw new Error(other
        ? `Port ${port} is held by an animations server for ${sameLibrary(other.library, library) ? 'this library' : `another library, ${other.library}`} that has no record here; stop it, or pass --port`
        : `Port ${port} is in use by another program; pass --port <n> (0 picks a free port)`, { cause: error });
    }
    const mine: ServerRecord = { pid: process.pid, port: server.port, url: server.url, apiVersion: ANIMATIONS_API_VERSION, library };
    const staging = `${file}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(staging, `${JSON.stringify(mine, null, 2)}\n`);
    await rename(staging, file);
    const ours = async () => { const current = await readRecord(file); return current?.pid === mine.pid && current.port === mine.port; };
    // A process that exits without closing the server still drops its record.
    const onExit = () => {
      try { const current = JSON.parse(readFileSync(file, 'utf8')); if (current?.pid === mine.pid && current.port === mine.port) rmSync(file, { force: true }); } catch { /* best effort */ }
    };
    process.once('exit', onExit);
    return {
      url: server.url, port: server.port, pid: process.pid, reused: false,
      close: async () => {
        process.off('exit', onExit);
        await server.close();
        if (await ours()) await rm(file, { force: true });
      },
    };
  } finally { await release(); }
}
