/** @lane merge */
import { afterEach, describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { importAssets, setTags } from '../scripts/mixamo-library.mjs';
import { createAnimationServer } from '../src/animation-server.ts';
import { syncLibrary, syncStatus } from '../src/library-sync.ts';
import { animatedFbx } from './helpers/animated-fbx.ts';

const run = promisify(execFile);
const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const step of cleanup.splice(0).reverse()) await step(); });
const temp = async (label: string) => { const path = await mkdtemp(join(tmpdir(), `mesh-sync-${label}-`)); cleanup.push(() => rm(path, { recursive: true, force: true })); return path; };

const TINY_GIF = Buffer.from('47494638396101000100800000000000ffffff21f90401000000002c00000000010001000002024401003b', 'hex');
const stubRender = async () => ({ gif: new Uint8Array(TINY_GIF) });
const IDENTITY = ['-c', 'user.name=Library Test', '-c', 'user.email=test@example.invalid', '-c', 'commit.gpgsign=false', '-c', 'core.autocrlf=false'];
/** Run git in a folder with a test identity, outside any repository the test runs in. */
const git = async (cwd: string, ...args: string[]) => {
  const env = { ...process.env }; for (const key of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE']) delete env[key];
  return (await run('git', [...IDENTITY, ...args], { cwd, env, windowsHide: true })).stdout.trim();
};
/** A clone that sync can commit in: repository-local identity, no signing, no line-ending conversion. */
const configure = async (clone: string) => {
  for (const [key, value] of [['user.name', 'Library Test'], ['user.email', 'test@example.invalid'], ['commit.gpgsign', 'false'], ['core.autocrlf', 'false']]) await git(clone, 'config', key, value);
};

/** A bare remote with one commit on main, and a clone of it that tracks origin/main. */
async function remoteAndClone() {
  const root = await temp('repo');
  const remote = join(root, 'remote.git'), seed = join(root, 'seed'), library = join(root, 'library');
  await git(root, 'init', '-q', '--bare', '--initial-branch=main', remote);
  await git(root, 'clone', '-q', remote, seed);
  await writeFile(join(seed, 'README.md'), '# Animations\n');
  await git(seed, 'add', 'README.md');
  await git(seed, 'commit', '-q', '-m', 'Start');
  await git(seed, 'push', '-q', 'origin', 'HEAD:main');
  await git(root, 'clone', '-q', remote, library);
  await configure(library);
  return { root, remote, library };
}
async function environment(library: string) {
  const home = await temp('home'), downloads = await temp('dl');
  return { home, downloads, env: { ...process.env, AGENT_MESHES_HOME: home, AGENT_MESHES_MIXAMO_DIR: library } };
}
const post = async (url: string, body: unknown) => {
  const response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { status: response.status, body: await response.json() as any };
};

describe('syncStatus', () => {
  it('is unavailable outside a git working tree and without an upstream', async () => {
    const plain = await temp('plain');
    expect(await syncStatus(plain)).toMatchObject({ available: false, reason: expect.stringMatching(/not a git working tree/) });
    const local = await temp('local');
    await git(local, 'init', '-q', '--initial-branch=main');
    expect(await syncStatus(local)).toMatchObject({ available: false, branch: 'main', reason: expect.stringMatching(/no upstream/) });
    await expect(syncLibrary(local)).rejects.toThrow(/no upstream/);
  });

  it('reports the branch, commits ahead and behind, and the changed library paths', async () => {
    const { library } = await remoteAndClone();
    const { downloads, env } = await environment(library);
    await writeFile(join(downloads, 'Walk.fbx'), animatedFbx({ travel: 2 }));
    await importAssets([join(downloads, 'Walk.fbx')], { directory: library, env, render: stubRender });
    await writeFile(join(library, 'scratch.txt'), 'not the library');
    const status = await syncStatus(library);
    expect(status).toMatchObject({ available: true, branch: 'main', ahead: 0, behind: 0 });
    expect(status.changed.sort()).toEqual(['mixamo/clips/walk.fbx', 'mixamo/clips/walk.gif', 'mixamo/clips/walk.json']);
  });
});

describe('Sync through the server', () => {
  it('commits, pulls and pushes an import and a tag edit; a conflicting remote edit is reported and the rebase undone', async () => {
    const { root, remote, library } = await remoteAndClone();
    const { downloads, env } = await environment(library);
    await writeFile(join(downloads, 'Walk.fbx'), animatedFbx({ travel: 2 }));
    await writeFile(join(downloads, 'Idle.fbx'), animatedFbx({ travel: 0, seconds: 3 }));
    const server = await createAnimationServer({ port: 0, library, downloads, env, render: stubRender });
    cleanup.push(() => server.close());

    expect((await post(`${server.url}api/import`, { paths: [join(downloads, 'Walk.fbx'), join(downloads, 'Idle.fbx')] })).status).toBe(200);
    expect((await post(`${server.url}api/tags`, { ids: ['walk'], add: ['ronin'] })).status).toBe(200);
    const listing = await (await fetch(`${server.url}api/library`)).json() as any;
    expect(listing.sync).toEqual({ available: true });
    const status = await (await fetch(`${server.url}api/sync`)).json() as any;
    expect(status).toMatchObject({ available: true, branch: 'main', ahead: 0, behind: 0 });
    expect(status.changed).toContain('mixamo/clips/walk.json');

    const synced = await post(`${server.url}api/sync`, {});
    expect(synced.status).toBe(200);
    expect(synced.body).toMatchObject({ committed: true, pulled: true, pushed: true, message: expect.stringMatching(/2 imports/) });
    expect(synced.body.error).toBeUndefined();
    const onRemote = (await git(root, '--git-dir', remote, 'ls-tree', '-r', '--name-only', 'main')).split('\n');
    expect(onRemote).toEqual(expect.arrayContaining(['mixamo/clips/walk.fbx', 'mixamo/clips/walk.gif', 'mixamo/clips/walk.json']));
    expect(JSON.parse(await git(root, '--git-dir', remote, 'show', 'main:mixamo/clips/walk.json')).tags).toContain('ronin');
    expect(await git(library, 'status', '--porcelain')).toBe('');
    // Nothing left to send: a second sync commits and pushes nothing.
    expect((await post(`${server.url}api/sync`, {})).body).toMatchObject({ committed: false, pulled: true, pushed: false });

    // Another machine edits the same sidecar and pushes first.
    const other = join(root, 'other');
    await git(root, 'clone', '-q', remote, other);
    await configure(other);
    const otherHome = await temp('other-home');
    await setTags(['walk'], ['from-the-laptop'], [], { directory: other, env: { ...process.env, AGENT_MESHES_HOME: otherHome, AGENT_MESHES_MIXAMO_DIR: other } });
    await git(other, 'commit', '-q', '-am', 'Tag on the laptop');
    await git(other, 'push', '-q', 'origin', 'HEAD:main');

    expect((await post(`${server.url}api/tags`, { ids: ['walk'], add: ['from-the-desk'] })).status).toBe(200);
    const conflicted = await post(`${server.url}api/sync`, {});
    expect(conflicted.body).toMatchObject({ committed: true, pushed: false, conflicts: ['mixamo/clips/walk.json'] });
    expect(conflicted.body.error).toContain('mixamo/clips/walk.json');
    expect(await git(library, 'status', '--porcelain')).toBe('');
    expect(await git(library, 'rev-list', '--count', 'origin/main..HEAD')).toBe('1');
    expect(JSON.parse(await readFile(join(library, 'mixamo/clips/walk.json'), 'utf8')).tags).toContain('from-the-desk');
    expect(JSON.parse(await git(root, '--git-dir', remote, 'show', 'main:mixamo/clips/walk.json')).tags).not.toContain('from-the-desk');
  }, 60000);

  it('names removals and edits in the commit message', async () => {
    const { library } = await remoteAndClone();
    const { downloads, env } = await environment(library);
    await writeFile(join(downloads, 'Walk.fbx'), animatedFbx({ travel: 2 }));
    await writeFile(join(downloads, 'Idle.fbx'), animatedFbx({ travel: 0, seconds: 3 }));
    await importAssets([join(downloads, 'Walk.fbx'), join(downloads, 'Idle.fbx')], { directory: library, env, render: stubRender });
    expect((await syncLibrary(library)).pushed).toBe(true);
    const server = await createAnimationServer({ port: 0, library, downloads, env, render: stubRender });
    cleanup.push(() => server.close());
    await post(`${server.url}api/remove`, { ids: ['idle'] });
    await post(`${server.url}api/note`, { id: 'walk', note: 'slow' });
    const synced = await post(`${server.url}api/sync`, {});
    expect(synced.body).toMatchObject({ committed: true, pushed: true });
    expect(synced.body.message).toMatch(/1 edit/);
    expect(synced.body.message).toMatch(/1 removal/);
    expect(await git(library, 'log', '-1', '--format=%s')).toBe(synced.body.message.split('\n')[0]);
  }, 60000);
});
