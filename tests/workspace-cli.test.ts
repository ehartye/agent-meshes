import { afterEach, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const run = promisify(execFile), directories: string[] = [];
const cli = (...args: string[]) => run(process.execPath, [resolve('scripts/agent-meshes.mjs'), ...args], { timeout: 15000, windowsHide: true });
afterEach(async () => { for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true }); });
async function setup() {
  const directory = await mkdtemp(join(tmpdir(), 'mesh-workspace-cli-')); directories.push(directory);
  const invoke = async (...args: string[]) => JSON.parse((await cli('--workspace', directory, ...args)).stdout);
  return { directory, invoke };
}
async function failure(...args: string[]) {
  try { await cli(...args); throw new Error('Expected CLI failure'); }
  catch (error) {
    expect(error).toMatchObject({ code: 1 });
    return JSON.parse((error as { stderr: string }).stderr);
  }
}

it('discovers contracts without a server and structures command-line errors', async () => {
  expect(JSON.parse((await cli('capabilities')).stdout).operations['bone.add']).toBeDefined();
  expect(await failure('--nonsense')).toMatchObject({ ok: false, error: { code: 'CLI_ARGUMENT_ERROR' } });
  expect(await failure('--workspace', 'unused', '--url', 'http://127.0.0.1:1', 'state')).toMatchObject({ ok: false, error: { code: 'CLI_ARGUMENT_ERROR' } });
});

it('persists authoring and undo/redo across separate CLI processes without HTTP', async () => {
  const { directory, invoke } = await setup();
  expect(await invoke('new', 'Agent asset')).toMatchObject({ revision: 1, project: { name: 'Agent asset' } });
  // `new` starts a clean history, so the first edit is the only undo step.
  expect(await invoke('op', '{"op":"add","part":{"name":"body"}}')).toMatchObject({ revision: 2, undo: 1 });
  expect(await invoke('state')).toMatchObject({ revision: 2, project: { parts: [expect.objectContaining({ name: 'body' })] } });
  expect(await invoke('inspect', 'part:body')).toMatchObject({ workspace: { revision: 2 }, counts: { parts: 1 }, selection: { kind: 'part' } });
  expect(await invoke('undo')).toMatchObject({ revision: 3, project: { parts: [] }, redo: 1 });
  expect(await invoke('redo')).toMatchObject({ revision: 4, project: { parts: [expect.objectContaining({ name: 'body' })] } });
  const saved = join(directory, 'portable.json'); await invoke('save', saved);
  expect(JSON.parse(await readFile(saved, 'utf8')).parts[0].name).toBe('body');
  await invoke('new', 'Other');
  expect(await invoke('open', saved)).toMatchObject({ project: { name: 'Agent asset' } });
  const glb = join(directory, 'asset.glb'); expect(await invoke('export', glb)).toMatchObject({ output: glb });
  expect(JSON.parse((await cli('verify', glb)).stdout).ok).toBe(true);
}, 60000);

it('dry-runs atomic batches, rejects stale revisions and preserves history on failed plans', async () => {
  const { directory, invoke } = await setup();
  const file = join(directory, 'batch.json');
  await writeFile(file, JSON.stringify([{ op: 'add', part: { name: 'body' } }, { op: 'add', part: { name: 'head' } }]));
  const before = await invoke('state');
  expect(await invoke('batch', file, '--dry-run')).toMatchObject({ ok: true, revision: 0, changes: { parts: { added: ['body', 'head'] } } });
  expect(await invoke('state')).toEqual(before);
  expect(await invoke('--expect-revision', '0', 'batch', file)).toMatchObject({ revision: 1, undo: 1 });
  expect(await failure('--workspace', directory, '--expect-revision', '0', 'new', 'Lost')).toMatchObject({ error: { code: 'REVISION_CONFLICT' } });
  await writeFile(file, JSON.stringify([{ op: 'add', part: { name: 'candidate' } }, { op: 'remove', name: 'missing' }]));
  expect(await failure('--workspace', directory, 'batch', file)).toMatchObject({ error: { operationIndex: 1 } });
  expect(await invoke('state')).toMatchObject({ revision: 1, undo: 1, project: { parts: [{ name: 'body' }, { name: 'head' }] } });
  expect(await invoke('undo')).toMatchObject({ project: { parts: [] } });
}, 60000);

it('returns parse and field validation details and opens recipes without a server', async () => {
  const { directory, invoke } = await setup();
  expect(await failure('--workspace', directory, 'op', '{')).toMatchObject({ error: { code: 'INVALID_JSON' } });
  expect(await failure('--workspace', directory, 'op', '{"op":"pose","name":"root","rotation":[0,0,0,2]}')).toMatchObject({ error: { operationIndex: 0, issues: [expect.objectContaining({ path: ['rotation'] })] } });
  expect(await invoke('recipe', 'biped')).toMatchObject({ project: { name: 'Copper courier' }, revision: 1 });
  expect(await invoke('undo')).toMatchObject({ project: { parts: [] } });
}, 30000);

it('new on an existing workspace starts a clean history while the revision keeps counting', async () => {
  const { directory, invoke } = await setup();
  await invoke('new', 'hull-dart');
  await invoke('op', '{"op":"add","part":{"name":"body"}}');
  const again = await invoke('new', 'hull-dart');
  // The revision is a concurrency token: a reset to 0 would let a stale --expect-revision 0 (or a server's cached
  // revision) match a workspace that has changed, so it stays monotonic.
  expect(again).toMatchObject({ revision: 3, undo: 0, redo: 0, project: { name: 'hull-dart', parts: [] } });
  expect(await failure('--workspace', directory, 'undo')).toMatchObject({ error: { message: 'Nothing to undo' } });
  expect(await failure('--workspace', directory, '--expect-revision', '0', 'op', '{"op":"add","part":{"name":"x"}}')).toMatchObject({ error: { code: 'REVISION_CONFLICT', actual: 3 } });
}, 60000);

it('--quiet prints a one-line summary instead of the whole project, and the default output is unchanged', async () => {
  const { directory, invoke } = await setup();
  const file = join(directory, 'batch.json');
  await writeFile(file, JSON.stringify([{ op: 'add', part: { name: 'body' } }, { op: 'add', part: { name: 'bell', geometry: { type: 'lathe', size: [1, 1, 1], profile: [[0.5, 0.5], [0.5, -0.5], [0, -0.5]] } } }]));
  expect(await invoke('new', 'kit', '--quiet')).toEqual({ name: 'kit', revision: 1, undo: 0, redo: 0, counts: { parts: 0, bones: 0, clips: 0, boundParts: 0, tracks: 0, keys: 0 } });
  const quiet = await invoke('--quiet', 'batch', file);
  expect(quiet).toEqual({ name: 'kit', revision: 2, undo: 1, redo: 0, counts: expect.objectContaining({ parts: 2 }), warnings: [expect.objectContaining({ code: 'LATHE_PROFILE_INWARD', part: 'bell' })] });
  expect(quiet).not.toHaveProperty('project');
  expect(await invoke('recipe', 'biped', '--quiet')).toMatchObject({ name: 'Copper courier', revision: 3, counts: { parts: expect.any(Number), clips: expect.any(Number) } });
  expect(await invoke('undo')).toHaveProperty('project.name', 'kit');
  await writeFile(file, JSON.stringify([{ op: 'add', part: { name: 'fin' } }]));
  expect(await invoke('batch', file, '--dry-run', '--quiet')).toMatchObject({ ok: true, operations: 1, changes: { parts: { added: ['fin'] } } });
}, 60000);
