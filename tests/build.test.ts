import { afterEach, expect, it } from 'vitest';
import { mkdtemp, readFile, writeFile, mkdir, readdir, rm, rename, symlink, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createProject, applyOperation } from '../src/core/model.ts';
import { buildAsset } from '../src/build.ts';

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'agent-meshes-build-test-')); directories.push(directory);
  const project = applyOperation(createProject('asset'), { op: 'add', part: { name: 'body' } });
  await writeFile(join(directory, 'source.json'), JSON.stringify(project));
  const config = join(directory, 'build.json');
  await writeFile(config, JSON.stringify({ version: 1, project: 'source.json', output: 'generated' }));
  return { directory, config, project, output: join(directory, 'generated') };
}

it('builds owned validated assets from an isolated project and rebuilds them', async () => {
  const { config, output, project } = await fixture();
  const result = await buildAsset(config);
  expect(result.output).toBe(await realpath(output));
  expect(result.files).toEqual(expect.arrayContaining(['project.mesh.json', 'model.glb', 'verification.json']));
  expect(JSON.parse(await readFile(join(output, 'project.mesh.json'), 'utf8'))).toEqual(project);
  expect(JSON.parse(await readFile(join(output, 'verification.json'), 'utf8')).ok).toBe(true);
  const marker = JSON.parse(await readFile(join(output, '.agent-meshes-build.json'), 'utf8'));
  expect(marker.config).toBe('../build.json');
  expect(marker.files).toEqual(result.files);
  await buildAsset(config);
});

it('builds operations into a fresh project on each run', async () => {
  const { directory, config, output } = await fixture();
  await writeFile(join(directory, 'ops.json'), JSON.stringify([{ op: 'add', part: { name: 'body' } }]));
  await writeFile(config, JSON.stringify({ version: 1, name: 'recipe', operations: 'ops.json', output: 'generated' }));
  await buildAsset(config); await buildAsset(config);
  expect(JSON.parse(await readFile(join(output, 'project.mesh.json'), 'utf8')).parts).toHaveLength(1);
});

it('preserves the last good output when rendering fails and cleans staging files', async () => {
  const { directory, config, output } = await fixture();
  await buildAsset(config);
  const before = await readFile(join(output, 'model.glb'));
  await expect(buildAsset(config, { decorate: async (_project, stage) => {
    await writeFile(join(stage, 'preview.png'), 'partial'); throw new Error('render failed');
  } })).rejects.toThrow('render failed');
  expect(await readFile(join(output, 'model.glb'))).toEqual(before);
  expect(await readdir(directory)).toEqual(expect.arrayContaining(['build.json', 'source.json', 'generated']));
  expect((await readdir(directory)).filter(name => name.includes('.stage-') || name.includes('.lock'))).toEqual([]);
});

it('refuses unowned directories and unexpected files in owned directories', async () => {
  const { config, output } = await fixture();
  await mkdir(output); await writeFile(join(output, 'personal.txt'), 'keep me');
  await expect(buildAsset(config)).rejects.toThrow(/owned|ownership/i);
  expect(await readFile(join(output, 'personal.txt'), 'utf8')).toBe('keep me');
  await rm(output, { recursive: true }); await buildAsset(config);
  await writeFile(join(output, 'personal.txt'), 'still keep me');
  await expect(buildAsset(config)).rejects.toThrow(/unexpected|unowned/i);
  expect(await readFile(join(output, 'personal.txt'), 'utf8')).toBe('still keep me');
});

it('adopts an empty output directory that the project created beforehand', async () => {
  const { directory, config, output } = await fixture();
  await mkdir(output);
  const result = await buildAsset(config);
  expect(result.files).toEqual(expect.arrayContaining(['project.mesh.json', 'model.glb']));
  expect(JSON.parse(await readFile(join(output, '.agent-meshes-build.json'), 'utf8')).generator).toBe('agent-meshes');
  expect((await readdir(directory)).filter(name => name.includes('.stage-') || name.includes('.backup-') || name.includes('.lock'))).toEqual([]);
});

it('keeps a file that appears in an adopted empty directory while the build renders', async () => {
  const { config, output } = await fixture();
  await mkdir(output);
  await expect(buildAsset(config, { decorate: async () => {
    await writeFile(join(output, 'personal.txt'), 'new file'); return [];
  } })).rejects.toThrow(/personal\.txt/);
  expect(await readFile(join(output, 'personal.txt'), 'utf8')).toBe('new file');
});

it('names the directory, what it holds and the fix when output holds other work', async () => {
  const { config, output } = await fixture();
  await mkdir(output); await writeFile(join(output, 'personal.txt'), 'keep me'); await writeFile(join(output, 'notes.md'), 'and me');
  const error = await buildAsset(config).then(() => undefined, (reason: unknown) => reason as Error & { code?: string; hint?: string });
  expect(error?.code).toBe('BUILD_OUTPUT_NOT_OWNED');
  expect(error?.message).toContain(await realpath(output));
  expect(error?.message).toMatch(/2 entries/);
  expect(error?.message).toContain('personal.txt');
  expect(error?.hint).toMatch(/"output"/);
  expect(error?.hint).toMatch(/different|move|delete/i);
  expect(await readdir(output)).toEqual(['notes.md', 'personal.txt']);
});

it('says which config owns an output directory that another config built', async () => {
  const { directory, config, output } = await fixture();
  await buildAsset(config);
  const other = join(directory, 'other.json');
  await writeFile(other, JSON.stringify({ version: 1, project: 'source.json', output: 'generated' }));
  const error = await buildAsset(other).then(() => undefined, (reason: unknown) => reason as Error & { code?: string; hint?: string });
  expect(error?.code).toBe('BUILD_OUTPUT_OTHER_CONFIG');
  expect(error?.message).toContain('build.json');
  expect(error?.message).toContain('other.json');
  expect(error?.hint).toMatch(/"output"/);
  expect(JSON.parse(await readFile(join(output, '.agent-meshes-build.json'), 'utf8')).config).toBe('../build.json');
});

it('tells the user to move a stray file out of an owned output directory', async () => {
  const { config, output } = await fixture();
  await buildAsset(config); await writeFile(join(output, 'personal.txt'), 'still keep me');
  const error = await buildAsset(config).then(() => undefined, (reason: unknown) => reason as Error & { code?: string; hint?: string });
  expect(error?.code).toBe('BUILD_OUTPUT_UNOWNED_FILE');
  expect(error?.message).toContain('personal.txt');
  expect(error?.message).toContain(await realpath(output));
  expect(error?.hint).toMatch(/move/i);
});

it('includes rendering artifacts only after the complete build succeeds', async () => {
  const { config, output } = await fixture();
  const result = await buildAsset(config, { decorate: async (_project, stage) => {
    await writeFile(join(stage, 'preview.png'), 'rendered'); return ['preview.png'];
  } });
  expect(result.files).toContain('preview.png');
  expect(await readFile(join(output, 'preview.png'), 'utf8')).toBe('rendered');
});

it('prevents two builds from owning the same output concurrently', async () => {
  const { config } = await fixture();
  let resume!: () => void;
  let entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { resume = resolve; });
  const first = buildAsset(config, { decorate: async () => { entered(); await gate; return []; } });
  await started;
  try { await expect(buildAsset(config)).rejects.toThrow(/locked|progress/i); }
  finally { resume(); await first; }
});

it('keeps ownership portable when a whole asset workspace moves', async () => {
  const { directory, config } = await fixture(); await buildAsset(config);
  const moved = `${directory}-moved`; directories.push(moved);
  await rename(directory, moved);
  await expect(buildAsset(join(moved, 'build.json'))).resolves.toMatchObject({ output: await realpath(join(moved, 'generated')) });
});

it('rejects source files under the output and ambiguous input configs', async () => {
  const { directory, config } = await fixture();
  await writeFile(config, JSON.stringify({ version: 1, project: 'source.json', output: '.' }));
  await expect(buildAsset(config)).rejects.toThrow(/inside|contain/i);
  await writeFile(config, JSON.stringify({ version: 1, project: 'source.json', operations: 'source.json', output: 'generated' }));
  await expect(buildAsset(config)).rejects.toThrow(/one|input|unrecognized/i);
});

it('refuses symlink outputs and symlinks added inside owned output', async () => {
  const { directory, config, output } = await fixture();
  const outside = join(directory, 'outside'); await mkdir(outside);
  await writeFile(join(outside, 'personal.txt'), 'keep');
  await symlink(outside, output, 'junction');
  await expect(buildAsset(config)).rejects.toThrow(/symlink/i);
  await rm(output); await buildAsset(config);
  await symlink(outside, join(output, 'foreign'), 'junction');
  await expect(buildAsset(config)).rejects.toThrow(/symlink/i);
  expect(await readFile(join(outside, 'personal.txt'), 'utf8')).toBe('keep');
});

it('resolves parent directory aliases so builds share ownership and locking', async () => {
  const { directory, config } = await fixture();
  const actualParent = join(directory, 'actual'); await mkdir(actualParent);
  await symlink(actualParent, join(directory, 'alias'), 'junction');
  await writeFile(config, JSON.stringify({ version: 1, project: 'source.json', output: 'alias/generated' }));
  const result = await buildAsset(config);
  expect(result.output).toBe(await realpath(join(actualParent, 'generated')));
  await writeFile(config, JSON.stringify({ version: 1, project: 'source.json', output: 'actual/generated' }));
  await expect(buildAsset(config)).resolves.toEqual(result);
});

it('preserves new unowned files created in the old output during rendering', async () => {
  const { config, output } = await fixture(); await buildAsset(config);
  const before = await readFile(join(output, 'model.glb'));
  await expect(buildAsset(config, { decorate: async () => {
    await writeFile(join(output, 'personal.txt'), 'new file'); return [];
  } })).rejects.toThrow(/unexpected|unowned/i);
  expect(await readFile(join(output, 'model.glb'))).toEqual(before);
  expect(await readFile(join(output, 'personal.txt'), 'utf8')).toBe('new file');
});

it('rejects invalid artifact paths and unlisted decoration output before replacing an asset', async () => {
  const { config, output } = await fixture(); await buildAsset(config);
  const before = await readFile(join(output, 'model.glb'));
  await expect(buildAsset(config, { decorate: async () => ['../outside.txt'] })).rejects.toThrow(/unsafe/i);
  await expect(buildAsset(config, { decorate: async (_project, stage) => {
    await writeFile(join(stage, 'unlisted.txt'), 'unexpected'); return [];
  } })).rejects.toThrow(/unexpected|unowned/i);
  expect(await readFile(join(output, 'model.glb'))).toEqual(before);
});

// BUILD_PREVIEWS_REMOVED: a warning keyed on earlier previews the swap actually removes, not on a flag.
const writing = (...names: string[]) => async (_project: unknown, stage: string): Promise<string[]> => {
  for (const name of names) await writeFile(join(stage, name), name);
  return names;
};
const removedWarning = (result: Awaited<ReturnType<typeof buildAsset>>) => result.warnings?.find(warning => warning.code === 'BUILD_PREVIEWS_REMOVED');

it('warns, after the swap, naming every earlier preview a rebuild no longer writes, in marker order', async () => {
  const { config, output } = await fixture();
  await buildAsset(config, { decorate: writing('front.png', 'side.png', 'preview.html') });
  const result = await buildAsset(config, { decorate: writing('front.png') });
  const warning = removedWarning(result);
  expect(warning?.message).toMatch(/^Removed 2 preview files of the earlier build from /);
  expect(warning?.message).toContain(': side.png, preview.html.');
  expect(warning?.message).not.toContain('front.png');
  expect(result.files).toContain('front.png');
  expect(await readdir(output)).not.toContain('side.png');
  const singular = await buildAsset(config);
  expect(removedWarning(singular)?.message).toMatch(/^Removed 1 preview file of the earlier build .*: front\.png\./);
});

it('does not warn when nothing earlier is removed, with or without previews', async () => {
  const { config } = await fixture();
  expect(removedWarning(await buildAsset(config))).toBeUndefined();
  expect(removedWarning(await buildAsset(config))).toBeUndefined();
  await buildAsset(config, { decorate: writing('front.png') });
  expect(removedWarning(await buildAsset(config, { decorate: writing('front.png') }))).toBeUndefined();
  expect(removedWarning(await buildAsset(config, { decorate: writing('front.png', 'side.png') }))).toBeUndefined();
});

it('counts a .png in any case and exactly preview.html as previews, and nothing else', async () => {
  const { config } = await fixture();
  await buildAsset(config, { decorate: writing('Front.PNG', 'preview.html', 'preview.htm', 'notes.txt', 'png.json') });
  const message = removedWarning(await buildAsset(config))?.message ?? '';
  expect(message).toContain('Removed 2 preview files');
  expect(message).toContain(': Front.PNG, preview.html.');
  expect(message).not.toMatch(/preview\.htm[^l]|notes\.txt|png\.json/);
  await buildAsset(config, { decorate: writing('preview.htm', 'notes.txt') });
  expect(removedWarning(await buildAsset(config))).toBeUndefined();
});

it('says nothing when the folder was adopted empty, and refuses a missing or unreadable marker before swapping', async () => {
  const { config, output } = await fixture();
  await mkdir(output);
  expect(removedWarning(await buildAsset(config, { decorate: writing('front.png') }))).toBeUndefined();
  // An unreadable or missing marker is refused before anything is swapped, so no removal and no warning happen.
  await writeFile(join(output, '.agent-meshes-build.json'), '{not json');
  await expect(buildAsset(config)).rejects.toMatchObject({ code: 'BUILD_OUTPUT_NOT_OWNED' });
  await rm(join(output, '.agent-meshes-build.json'));
  await expect(buildAsset(config)).rejects.toMatchObject({ code: 'BUILD_OUTPUT_NOT_OWNED' });
  expect(await readdir(output)).toContain('front.png');
});

it('does not warn when the marker lists a preview that is missing from the folder', async () => {
  const { config, output } = await fixture();
  await buildAsset(config, { decorate: writing('front.png') });
  await rm(join(output, 'front.png'));
  // A plain build refuses a missing listed file, so the warning cannot claim to have removed it.
  await expect(buildAsset(config)).rejects.toMatchObject({ code: 'BUILD_OUTPUT_FILE_MISSING' });
});

it('does not warn when the build fails before the swap, because nothing was removed', async () => {
  const { config, output } = await fixture();
  await buildAsset(config, { decorate: writing('front.png') });
  await expect(buildAsset(config, { decorate: async () => { throw new Error('render failed'); } })).rejects.toThrow('render failed');
  expect(await readdir(output)).toContain('front.png');
});
