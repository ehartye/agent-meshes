import { afterAll, beforeAll, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer } from '../src/server.ts';

// `view --project <file>` renders a saved project with no workbench. A capture starts Chromium, so these tests
// carry the long timeout of tests/capture-views.test.ts; tests/cli.test.ts keeps its 10 s timeout for the
// cases that need no browser.
const TIMEOUT = 180_000;
const run = promisify(execFile);
const cli = (...args: string[]) => run(process.execPath, [resolve('scripts/agent-meshes.mjs'), ...args], { timeout: 120_000, windowsHide: true, maxBuffer: 64 * 1024 * 1024 });
type Failure = { code?: number; stdout: string; stderr: string };
const fail = async (...args: string[]): Promise<{ failure: Failure; error: { code: string; message: string } }> => {
  let failure: Failure | undefined;
  try { await cli(...args); } catch (caught) { failure = caught as Failure; }
  if (!failure) throw new Error(`Expected "${args.join(' ')}" to fail`);
  return { failure, error: JSON.parse(failure.stderr).error };
};
/** Width and height from the IHDR chunk of a PNG. */
const dimensions = async (path: string) => { const bytes = await readFile(path); return `${bytes.readUInt32BE(16)}x${bytes.readUInt32BE(20)}`; };
const sizes = async (directory: string) => Object.fromEntries(await Promise.all((await readdir(directory)).sort().map(async name => [name, await dimensions(join(directory, name))])));

let root: string;
let biped: string;
let resultDirectory: string;
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'view-project-'));
  biped = join(root, 'biped.mesh.json');
  const workspace = join(root, 'authoring-workspace');
  await cli('--workspace', workspace, 'recipe', 'biped', '--quiet');
  await cli('--workspace', workspace, 'save', biped, '--quiet');
  resultDirectory = join(root, 'views');
}, TIMEOUT);
/** One capture of the project, shared by the tests that compare against it. No workbench is running and no --workspace or --url is given: --project alone must be enough. */
let rendered: Promise<{ output: string; files: string[] }> | undefined;
const render = () => rendered ??= cli('view', resultDirectory, '--project', biped).then(({ stdout }) => JSON.parse(stdout));
afterAll(async () => { await rm(root, { recursive: true, force: true }); });

it('renders the stills and the contact sheet of a saved project with no workbench', async () => {
  const result = await render();
  expect(result.output).toBe(resolve(resultDirectory));
  // The stills the old route writes (front, side, perspective) and one contact sheet per clip.
  expect(result.files).toEqual(['front.png', 'side.png', 'perspective.png', 'walk-contact.png']);
  expect((await readdir(resultDirectory)).sort()).toEqual([...result.files].sort());
  expect(await dimensions(join(resultDirectory, 'walk-contact.png'))).toBe('1280x720');
  for (const view of ['front', 'side', 'perspective']) expect(await dimensions(join(resultDirectory, `${view}.png`))).not.toBe('1280x720');
}, TIMEOUT);

it('renders the requested views and the default output shape for --views', async () => {
  const directory = join(root, 'top-views');
  const { files } = JSON.parse((await cli('view', directory, '--views', 'top, front', '--project', biped)).stdout);
  expect(files).toEqual(['top.png', 'front.png', 'walk-contact.png']);
}, TIMEOUT);

it('is not affected by --workspace or --url given alone, and contacts no server', async () => {
  const result = await render();
  const workspace = join(root, 'unused-workspace');
  const withWorkspace = JSON.parse((await cli('--workspace', workspace, 'view', join(root, 'with-workspace'), '--project', biped)).stdout);
  expect(withWorkspace.files).toEqual(result.files);
  expect(existsSync(workspace)).toBe(false);
  // Port 9 (discard) has no listener: a route that contacted the workbench would fail with WORKBENCH_UNREACHABLE.
  const withUrl = JSON.parse((await cli('--url', 'http://127.0.0.1:9', 'view', join(root, 'with-url'), '--project', biped)).stdout);
  expect(withUrl.files).toEqual(result.files);
  expect(await sizes(join(root, 'with-workspace'))).toEqual(await sizes(resultDirectory));
  expect(await sizes(join(root, 'with-url'))).toEqual(await sizes(resultDirectory));
}, TIMEOUT);

it('writes the same file names and PNG dimensions as a view of the same project in a running workbench', async () => {
  const result = await render();
  const server = await createServer({ port: 0, projectPath: biped });
  try {
    const directory = join(root, 'workbench-views');
    const workbench = JSON.parse((await cli('--url', server.url, 'view', directory)).stdout);
    expect(workbench.files).toEqual(result.files);
    expect(await sizes(directory)).toEqual(await sizes(resultDirectory));
  } finally { await server.close(); }
}, TIMEOUT);

/** A failed load names its cause and writes nothing: the output directory is not created. */
const failsWithoutWriting = async (project: string, expected: { code: string | string[]; message?: string }) => {
  const output = join(root, `refused-${Math.random().toString(36).slice(2)}`);
  const { failure, error } = await fail('view', output, '--project', project);
  expect(failure.code).toBe(1);
  expect(failure.stdout).toBe('');
  expect(Array.isArray(expected.code) ? expected.code : [expected.code]).toContain(error.code);
  if (expected.message) expect(error.message).toContain(expected.message);
  expect(existsSync(output)).toBe(false);
  return error;
};

it('refuses a missing project file by name', async () => {
  const error = await failsWithoutWriting(join(root, 'absent.mesh.json'), { code: 'ENOENT', message: 'absent.mesh.json' });
  expect(error.code).not.toBe('CLI_ARGUMENT_ERROR');
}, TIMEOUT);

it('refuses a file that is not JSON with INVALID_JSON', async () => {
  const file = join(root, 'not-json.mesh.json');
  await writeFile(file, 'this is not json {');
  await failsWithoutWriting(file, { code: 'INVALID_JSON' });
}, TIMEOUT);

it('refuses JSON that fails the project schema', async () => {
  const file = join(root, 'schema.mesh.json');
  await writeFile(file, JSON.stringify({ version: 1, name: 'broken', parts: 'not a list' }));
  await failsWithoutWriting(file, { code: ['VALIDATION_ERROR', 'AUTHORING_ERROR'] });
}, TIMEOUT);

it('refuses a valid project with no mesh geometry with AUTHORING_ERROR before writing anything', async () => {
  const workspace = join(root, 'empty-workspace');
  const file = join(root, 'empty.mesh.json');
  await cli('--workspace', workspace, 'new', 'Empty', '--quiet');
  await cli('--workspace', workspace, 'save', file, '--quiet');
  await failsWithoutWriting(file, { code: 'AUTHORING_ERROR', message: 'Add mesh geometry' });
}, TIMEOUT);

it('still reports a bad project file when --workspace or --url is given alone', async () => {
  const file = join(root, 'also-not-json.mesh.json');
  await writeFile(file, '{');
  expect((await fail('--workspace', join(root, 'unused-workspace-2'), 'view', join(root, 'refused-a'), '--project', file)).error.code).toBe('INVALID_JSON');
  expect((await fail('--url', 'http://127.0.0.1:9', 'view', join(root, 'refused-b'), '--project', file)).error.code).toBe('INVALID_JSON');
  expect(existsSync(join(root, 'refused-a'))).toBe(false);
  expect(existsSync(join(root, 'refused-b'))).toBe(false);
  expect(existsSync(join(root, 'unused-workspace-2'))).toBe(false);
}, TIMEOUT);

it('says in view --help that --project takes a project file and needs no workbench', async () => {
  const { stdout } = await cli('view', '--help');
  expect(stdout).toContain('--project <file>');
  expect(stdout).toMatch(/no\s+workbench/i);
}, TIMEOUT);
