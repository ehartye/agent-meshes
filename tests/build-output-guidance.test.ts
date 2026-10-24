/** @lane merge
 * @subject skills/mesh-build/references/native-build-identity.md
 */
import { afterEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdtemp, readFile, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { applyOperation, createProject } from '../src/core/model.ts';
import { buildAsset } from '../src/build.ts';
import { loadBuildConfig } from '../src/build-config.ts';

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

// The same rules as tests/plugin-content-hygiene.test.ts, written so that this file does not trip them itself.
const PLACEHOLDER_USER = /^(?:one|two|a|a b|shared|public|user|you|me|name|username|example|fixture|test|someone|runner)$/i;
const HOME_PATH = /[A-Za-z]:[\\/]+Users[\\/]+([^\\/\s"']+)|\/Users\/([a-z][\w.-]*)\/|\/home\/([a-z][\w.-]*)\//g;
const homePathIn = (line: string) => [...line.matchAll(HOME_PATH)].some(m => !PLACEHOLDER_USER.test(m[1] ?? m[2] ?? m[3]) && !(m[1] ?? m[2] ?? m[3]).startsWith('<'));
const RULES: [string, (line: string) => boolean][] = [
  ['a home-directory path', homePathIn],
  ['a GPU model name', line => /\b(?:[G]eForce|RTX ?\d{3,4}|[R]adeon(?: RX)?|[I]ris Xe|[U]HD Graphics)\b/.test(line)],
  ['a link into a repository that is not a plugin', line => /github\.com\/ehartye\/(?!agent-|hartye-)[\w.-]+|ehartye\.github\.io\/(?!agent-|hartye-)/.test(line)],
  ['a wiki vault path', line => /wiki\/(?:authored|sources|entities)\//.test(line)],
];
function privateRules(): [string, (line: string) => boolean][] {
  const termsFile = process.env.AGENT_MESHES_PRIVATE_TERMS_FILE;
  const terms = termsFile ? readFileSync(termsFile, 'utf8').split(/\r?\n/).map(term => term.trim()).filter(Boolean) : [];
  return terms.map((term): [string, (line: string) => boolean] => {
    const pattern = /^\/(.+)\/([a-z]*)$/.exec(term);
    if (pattern) { const expression = new RegExp(pattern[1], pattern[2]); return [`the private pattern ${term}`, line => expression.test(line)]; }
    const lower = term.toLowerCase();
    return [`the private term "${term}"`, line => line.toLowerCase().includes(lower)];
  });
}

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
    const hits = body.flatMap(({ text }, index) => [...RULES, ...privateRules()].filter(([, matches]) => matches(text)).map(([what]) => `section line ${index + 1}: ${what}`));
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
    // The refusal leaves the rest of the directory alone, and the message carries neither a code nor a hint.
    expect((await readFile(join(output, 'model.glb'))).length).toBeGreaterThan(0);
    const error = await buildAsset(config).then(() => undefined, (failure: unknown) => failure as Error & { code?: string; hint?: string });
    expect(error?.message).toBe('Missing owned build file: verification.json');
    expect(error?.code).toBeUndefined();
    expect(error?.hint).toBeUndefined();
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
