/** @lane merge
 * @subject skills/mesh-build/references/native-build-identity.md
 */
import { afterEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { applyOperation, createProject } from '../src/core/model.ts';
import { buildAsset } from '../src/build.ts';
import { loadBuildConfig } from '../src/build-config.ts';
import { RULES, privateRules, scanLine } from './helpers/content-rules.ts';

// Document checks: the reference has a "Committing build output" section that names the files to ignore, the flags
// that tolerate a missing listed file and the line-ending rule, and labels every paragraph and bullet. Fixture
// checks: the [tested] claims in that section hold for the real build module. No engine is needed.
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const REFERENCE = join(ROOT, 'skills/mesh-build/references/native-build-identity.md');
const referenceLines = (): string[] => readFileSync(REFERENCE, 'utf8').split(/\r?\n/);

const FENCE = /^\s*(?:```|~~~)/;
const HEADING = /^(#{1,6})\s+(.*?)\s*$/;
const ITEM = /^\s*(?:[-*+]|\d+[.)])\s+/;
const LABEL = /^\[(?:tested|documented|general)\]/;

interface Line { text: string; fenced: boolean }
/** Mark lines inside (and including) code fences so that shell or Python comments are never read as headings. */
function classify(lines: string[]): Line[] {
  let open = false;
  return lines.map(text => {
    if (FENCE.test(text)) { open = !open; return { text, fenced: true }; }
    return { text, fenced: open };
  });
}
/** The lines from the section heading to the next heading of equal or higher level (or the end of the file). */
function section(): Line[] {
  const lines = classify(referenceLines());
  const start = lines.findIndex(line => !line.fenced && /^#{2,3} Committing build output$/.test(line.text));
  if (start < 0) return [];
  const level = HEADING.exec(lines[start].text)![1].length;
  const end = lines.findIndex((line, index) => index > start && !line.fenced && (HEADING.exec(line.text)?.[1].length ?? 99) <= level);
  return lines.slice(start, end < 0 ? undefined : end);
}
/** Paragraphs and bullets of the section body; headings and code fences are left out. */
function blocks(): string[] {
  const result: string[] = [];
  let current: string | undefined;
  const close = () => { if (current !== undefined) result.push(current); current = undefined; };
  for (const { text, fenced } of section().slice(1)) {
    if (fenced) { close(); continue; }
    if (HEADING.test(text)) { close(); continue; }
    if (!text.trim()) { close(); continue; }
    if (ITEM.test(text)) { close(); current = text.replace(ITEM, '').trim(); continue; }
    current = current === undefined ? text.trim() : `${current} ${text.trim()}`;
  }
  close();
  return result;
}

// The rules come from tests/helpers/content-rules.ts, shared with tests/plugin-content-hygiene.test.ts.

describe('the Committing build output section of the native build identity reference', () => {
  it('has a heading, a Contents entry and the names a reader searches for', () => {
    const lines = referenceLines();
    expect(lines.filter(line => /^#{2,3} Committing build output$/.test(line))).toHaveLength(1);
    const contents = lines.slice(lines.indexOf('## Contents'), lines.findIndex((line, index) => index > lines.indexOf('## Contents') && /^\S/.test(line) && !line.startsWith('- ') && !line.startsWith('## ')));
    expect(contents).toContain('  - [Committing build output](#committing-build-output)');
    const text = section().map(line => line.text).join('\n');
    for (const name of ['.agent-meshes-blender-', '--if-changed', '--force', '.gitattributes', 'Missing owned build file']) expect(text, name).toContain(name);
  });

  it('labels every paragraph and bullet as tested, documented or general', () => {
    const found = blocks();
    expect(found.length).toBeGreaterThan(0);
    expect(found.filter(block => !LABEL.test(block))).toEqual([]);
  });

  it('names no home directory, GPU model, non-plugin repository, wiki path or private term', () => {
    const body = section();
    expect(body.length).toBeGreaterThan(0);
    const rules = [...RULES, ...privateRules()];
    const hits = body.flatMap(({ text }, index) => scanLine(rules, text).map(what => `section line ${index + 1}: ${what}`));
    expect(hits).toEqual([]);
  });
});

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
/** A project build in a temporary directory, as in tests/build.test.ts: no Blender, no browser. */
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'agent-meshes-output-guidance-')); directories.push(directory);
  await writeFile(join(directory, 'source.json'), JSON.stringify(applyOperation(createProject('asset'), { op: 'add', part: { name: 'body' } })));
  const config = join(directory, 'build.json');
  await writeFile(config, JSON.stringify({ version: 1, project: 'source.json', output: 'generated' }));
  return { directory, config, output: join(directory, 'generated') };
}

describe('the claims the section labels tested', () => {
  it('a plain build refuses an owned directory whose marker lists a file that is missing', async () => {
    const { config, output } = await fixture();
    await buildAsset(config);
    await unlink(join(output, 'verification.json'));
    await expect(buildAsset(config)).rejects.toThrow(/Missing owned build file: verification\.json/);
    // The refusal leaves the rest of the directory alone and carries a stable code and a three-part hint.
    expect((await readFile(join(output, 'model.glb'))).length).toBeGreaterThan(0);
    const error = await buildAsset(config).then(() => undefined, (failure: unknown) => failure as Error & { code?: string; hint?: string });
    expect(error?.message).toMatch(/^Missing owned build file: verification\.json\. Hint: /);
    expect(error?.code).toBe('BUILD_OUTPUT_FILE_MISSING');
    expect(error?.hint).toContain('verification.json');
    expect(error?.hint).toMatch(/--if-changed and --force apply to native blender\.script builds only/);
    expect(error?.hint).toMatch(/Restore verification\.json, or delete the output directory/);
    expect(error?.message).toContain(error?.hint ?? '');
  });

  it('the refusal covers every listed file, including one a decorator such as the preview step adds', async () => {
    const { config, output } = await fixture();
    const decorate = async (_project: unknown, stage: string) => { await writeFile(join(stage, 'front.png'), 'preview'); return ['front.png']; };
    await buildAsset(config, { decorate });
    const listed: string[] = JSON.parse(await readFile(join(output, '.agent-meshes-build.json'), 'utf8')).files;
    expect(listed).toEqual(expect.arrayContaining(['model.glb', 'verification.json', 'front.png']));
    for (const name of listed) {
      const bytes = await readFile(join(output, name));
      await unlink(join(output, name));
      await expect(buildAsset(config, { decorate })).rejects.toThrow(`Missing owned build file: ${name}`);
      await writeFile(join(output, name), bytes);
    }
    await buildAsset(config, { decorate });
  });

  it('a project or operations build cannot use --if-changed or --force, so it has no tolerance for a missing file', async () => {
    const { directory, config, output } = await fixture();
    await buildAsset(config);
    await unlink(join(output, 'verification.json'));
    await writeFile(join(directory, 'ops.json'), JSON.stringify([{ op: 'add', part: { name: 'body' } }]));
    const operations = join(directory, 'operations.json');
    await writeFile(operations, JSON.stringify({ version: 1, name: 'recipe', operations: 'ops.json', output: 'recipe-output' }));
    for (const path of [config, operations]) {
      await expect(buildAsset(path, { ifChanged: true })).rejects.toThrow(/Incremental Blender flags require a native blender\.script build/);
      await expect(buildAsset(path, { force: true })).rejects.toThrow(/Incremental Blender flags require a native blender\.script build/);
    }
    await expect(buildAsset(config)).rejects.toThrow(/Missing owned build file: verification\.json/);
  });

  it('a CRLF copy of identical config text is a different input although the parsed value is equal', async () => {
    const { directory } = await fixture();
    const text = '{\n  "version": 1,\n  "project": "source.json",\n  "output": "generated"\n}\n';
    const lf = join(directory, 'lf.json'), crlf = join(directory, 'crlf.json');
    await writeFile(lf, text); await writeFile(crlf, text.replace(/\n/g, '\r\n'));
    const [first, second] = [await loadBuildConfig(lf), await loadBuildConfig(crlf)];
    expect(JSON.stringify(first.value)).toBe(JSON.stringify(second.value));
    expect(first.leafSha256).not.toBe(second.leafSha256);
    // The digest is over the raw bytes of the file as stored.
    expect(first.leafSha256).toBe(createHash('sha256').update(text).digest('hex'));
    expect(second.leafSha256).toBe(createHash('sha256').update(text.replace(/\n/g, '\r\n')).digest('hex'));
  });
});

describe('the preview guidance for a build that removes earlier previews', () => {
  const read = (path: string) => readFileSync(join(ROOT, path), 'utf8').replace(/\r\n/g, '\n').replace(/\s+/g, ' ');
  const build = read('skills/mesh-build/SKILL.md');

  it('the unowned-file refusal carries a preview-specific recovery hint', async () => {
    const { config, output } = await fixture();
    await buildAsset(config);
    await writeFile(join(output, 'front.png'), 'restored');
    const error = await buildAsset(config).then(() => undefined, (failure: unknown) => failure as Error & { code?: string; hint?: string });
    expect(error?.code).toBe('BUILD_OUTPUT_UNOWNED_FILE');
    expect(error?.hint).toMatch(/move the file out of it/);
    expect(error?.hint).toMatch(/preview \(a \.png or preview\.html\) that mesh preview wrote into the build folder, or one restored from version control, delete it/);
    expect(error?.hint).toMatch(/--out outside the build folder/);
    expect(error?.hint).toMatch(/rebuild with previews on \(omit --no-preview\)/);
    expect(error?.hint).toMatch(/--if-changed and --force apply to native blender\.script builds only/);
    expect(error?.message).toContain(error?.hint ?? '');
    await unlink(join(output, 'front.png'));
    // A directory a preview command made beside the marker gets the same hint.
    await mkdir(join(output, 'preview'));
    await writeFile(join(output, 'preview', 'front.png'), 'x');
    await expect(buildAsset(config)).rejects.toMatchObject({ code: 'BUILD_OUTPUT_UNOWNED_FILE', hint: expect.stringContaining('mesh preview wrote into the build folder') });
  });

  it('mesh-build says the warning is keyed on removal, the preview rule, the order and what silence means', () => {
    expect(build).toContain('BUILD_PREVIEWS_REMOVED');
    expect(build).toMatch(/keyed on the removal, not on the flag/);
    expect(build).toMatch(/`--no-preview`, `--no-preview-page`, or a model with fewer clips/);
    expect(build).toMatch(/ends `\.png` in any case, or exactly `preview\.html`/);
    expect(build).toMatch(/in the order the earlier `\.agent-meshes-build\.json` listed them/);
    expect(build).toMatch(/no marker, an unreadable marker or an adopted empty folder gets no warning, and no warning does not prove nothing was removed/);
    expect(build).toMatch(/Do not restore removed previews from version control/);
    expect(build).toMatch(/`--if-changed` and `--force` apply to native `blender\.script` builds only/);
  });

  it('mesh-build routes looking at an existing GLB to mesh preview and its reference before the build guidance', () => {
    const route = build.indexOf('run `mesh preview model.glb --out <folder>`');
    expect(route).toBeGreaterThan(0);
    expect(route).toBeLessThan(build.indexOf('## Find the relevant build guidance'));
    expect(build).toContain('`mesh view` takes no GLB');
    expect(build).toContain('(references/previews-and-refine.md#preview-a-built-glb-without-rebuilding)');
    expect(build).toContain('| Look at an existing GLB without rebuilding it');
  });

  it('the authoring skill, setup reference, README and CLI help point at the same behaviour', () => {
    expect(read('skills/mesh-authoring/SKILL.md')).toMatch(/`--no-preview` deletes the PNGs and `preview\.html` an earlier build left there.*BUILD_PREVIEWS_REMOVED.*no warning does not prove none were removed/);
    expect(read('skills/mesh-authoring/references/cli-setup.md')).toMatch(/--no-preview.*deletes the previews an earlier build left in the output folder.*BUILD_PREVIEWS_REMOVED/);
    const readme = read('README.md');
    expect(readme).toMatch(/`--no-preview-page`, or fewer clips\) removes the earlier ones.*BUILD_PREVIEWS_REMOVED.*keyed on the removal, not on the flag.*no warning does not prove nothing was removed.*`--if-changed` and `--force` apply to native `blender\.script` builds only/);
    expect(readme).toMatch(/Either flag removes the matching files an earlier build left in the folder, with the `BUILD_PREVIEWS_REMOVED` warning/);
    expect(read('src/cli.ts').match(/BUILD_PREVIEWS_REMOVED/g)?.length).toBe(4);
  });
});
