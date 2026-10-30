/** @lane merge
 * @subject repository content
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { afterAll, expect, it } from 'vitest';
import { CHECKOUT_ROOT, RULES, contentRoot, pathListFromEnvironment, privateRules, scanContent } from './helpers/content-rules.ts';

// The rules, the term-file format and the file walk live in tests/helpers/content-rules.ts. By default this scans the
// whole checkout, untracked files included. AGENT_MESHES_TEST_ROOT points at another directory (for example a copy of
// the files to check); AGENT_MESHES_CONTENT_PATHS_FILE lists the paths to scan, one per line, so parallel edits to
// other files do not matter. scripts/check_private_terms.py takes the same inputs.

it('plugin content names no home directory, GPU model, non-plugin repository or wiki path', () => {
  expect(scanContent(contentRoot(), [...RULES, ...privateRules()], pathListFromEnvironment())).toEqual([]);
});

// The standalone script and the helper must agree. The fixture is assembled at run time so this file holds no violation.
const directories: string[] = [];
afterAll(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

it('the helper and scripts/check_private_terms.py report the same findings on one fixture', () => {
  const python = ['python', 'python3'].find(name => spawnSync(name, ['--version']).status === 0);
  if (!python) return; // the script is a manual aid; without Python only the helper is checked
  const root = mkdtempSync(join(tmpdir(), 'agent-meshes-content-rules-')); directories.push(root);
  mkdirSync(join(root, 'docs'));
  const literal = 'zq' + 'literal' + 'word', pattern = 'zq' + 'pat' + 'tern';
  const homeDirectory = ['', 'home', 'real' + 'person', 'work'].join('/');
  writeFileSync(join(root, 'docs', 'clean.md'), 'Nothing here.\nA placeholder path: ' + ['', 'home', 'someone', 'work'].join('/') + '\n');
  writeFileSync(join(root, 'docs', 'literal.md'), `fine\nuses ${literal.toUpperCase()} here\n`);
  writeFileSync(join(root, 'docs', 'regex.md'), `${pattern}7 matches\n${pattern} alone does not\n`);
  writeFileSync(join(root, 'docs', 'home.md'), `first\nsecond\nsee ${homeDirectory}\n`);
  writeFileSync(join(root, 'docs', 'skipped.png'), literal);
  const outside = mkdtempSync(join(tmpdir(), 'agent-meshes-content-lists-')); directories.push(outside); // lists stay out of the scanned root
  const terms = join(outside, 'terms.txt');
  writeFileSync(terms, `\n${literal}\n/${pattern}\\d/\n`);
  const list = join(outside, 'list.txt');
  writeFileSync(list, 'docs/literal.md\ndocs/regex.md\ndocs/home.md\ndocs/clean.md\ndocs/gone.md\ndocs/skipped.png\n');

  for (const paths of [undefined, ['docs/literal.md', 'docs/regex.md', 'docs/home.md', 'docs/clean.md', 'docs/gone.md', 'docs/skipped.png']]) {
    const expected = scanContent(root, [...RULES, ...privateRules(terms)], paths);
    const args = ['-I', join(CHECKOUT_ROOT, 'scripts', 'check_private_terms.py'), '--root', root, '--terms-file', terms, ...(paths ? ['--paths-file', list] : [])];
    const run = spawnSync(python, args, { encoding: 'utf8', env: { ...process.env, AGENT_MESHES_TEST_ROOT: '', AGENT_MESHES_PRIVATE_TERMS_FILE: '' } });
    expect(expected).toEqual(['docs/home.md:3: a home-directory path', 'docs/literal.md:2: private term #1', 'docs/regex.md:1: private pattern #2']);
    expect(run.status).toBe(1);
    expect(run.stdout.trim().split(/\r?\n/).sort()).toEqual([...expected].sort());
    expect(run.stdout + run.stderr).not.toContain(literal);
    expect(run.stdout + run.stderr).not.toContain(pattern);
  }

  // --paths-file takes a JSON array as well as one path per line, and scans the same files either way. A file that is
  // neither fails with one line that names both formats, not a traceback or a silent zero.
  const listed = ['docs/literal.md', 'docs/regex.md', 'docs/home.md', 'docs/clean.md', 'docs/gone.md', 'docs/skipped.png'];
  const scanned = (listFile: string) => {
    const run = spawnSync(python, ['-I', join(CHECKOUT_ROOT, 'scripts', 'check_private_terms.py'), '--root', root, '--terms-file', terms, '--paths-file', listFile], { encoding: 'utf8', env: { ...process.env, AGENT_MESHES_TEST_ROOT: '', AGENT_MESHES_PRIVATE_TERMS_FILE: '' } });
    return { run, count: Number(/in (\d+) file\(s\) scanned/.exec(run.stderr)?.[1]) };
  };
  const array = join(outside, 'list.json');
  writeFileSync(array, JSON.stringify(listed));
  const fromArray = scanned(array), fromList = scanned(list);
  expect(fromList.count).toBe(4); // gone.md does not exist and skipped.png is not text
  expect(fromArray.count).toBe(fromList.count);
  expect(fromArray.run.status).toBe(1);
  expect(fromArray.run.stdout).toBe(fromList.run.stdout);

  for (const content of ['{"a":1}', '[1, 2]', '["docs/clean.md"', '[']) {
    const invalid = join(outside, 'invalid.json');
    writeFileSync(invalid, content);
    const { run } = scanned(invalid);
    expect(run.status, content).toBe(2);
    expect(run.stdout, content).toBe('');
    expect(run.stderr.trim().split(/\r?\n/), content).toHaveLength(1);
    expect(run.stderr, content).toContain('JSON array');
    expect(run.stderr, content).toContain('one path per line');
    expect(run.stderr, content).not.toContain('Traceback');
  }
});

// ---------------------------------------------------------------------------------------------------------------------
// Skill structure: references are reachable, descriptions fit the cap, and copied guidance keeps one wording.
// These read contentRoot(), so AGENT_MESHES_TEST_ROOT can point at a copy of README.md and skills/ to try a change.
// ---------------------------------------------------------------------------------------------------------------------
const DESCRIPTION_CAP = 1536; // Claude Code truncates a skill's description and when_to_use together at this length
const posix = (path: string): string => path.split(sep).join('/');
const markdownIn = (dir: string): string[] => !existsSync(dir) ? [] : readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
  const full = join(dir, entry.name);
  return entry.isDirectory() ? markdownIn(full) : entry.isFile() && entry.name.endsWith('.md') ? [full] : [];
});
const skillDirectories = (root: string): string[] => !existsSync(join(root, 'skills')) ? [] : readdirSync(join(root, 'skills'), { withFileTypes: true })
  .filter(entry => entry.isDirectory() && existsSync(join(root, 'skills', entry.name, 'SKILL.md'))).map(entry => join(root, 'skills', entry.name)).sort();
const withoutFences = (text: string): string => text.replace(/^(```|~~~)[\s\S]*?^\1/gm, ''); // a link inside a fenced example is not a link
const linkTargets = (file: string): string[] => [...withoutFences(readFileSync(file, 'utf8')).matchAll(/\[[^\]]*\]\(([^)\s]+)\)/g)].map(match => match[1]);

/**
 * Files under skills/<name>/references that no SKILL.md and no README.md links to. A link from another reference does
 * not count: a reference reached only through a second reference is invisible to a reader who stops at the skill.
 */
export function referencesLinkedOnlyFromReferences(root: string): string[] {
  const readmes = existsSync(join(root, 'README.md')) ? [join(root, 'README.md')] : [];
  const entrances = [...skillDirectories(root).map(dir => join(dir, 'SKILL.md')), ...readmes];
  const reached = new Set<string>();
  for (const entrance of entrances) {
    for (const target of linkTargets(entrance)) {
      if (/^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/i.test(target)) continue;
      reached.add(resolve(dirname(entrance), decodeURIComponent(target.split('#')[0])));
    }
  }
  return skillDirectories(root).flatMap(dir => markdownIn(join(dir, 'references'))).filter(file => !reached.has(file)).map(file => posix(relative(root, file))).sort();
}

/** The value of a single-line frontmatter key, unquoted; undefined when the key is absent. */
export function frontmatterValue(text: string, key: string): string | undefined {
  const lines = text.split(/\r?\n/);
  expect(lines[0], 'SKILL.md must open with a --- frontmatter fence').toBe('---');
  const end = lines.indexOf('---', 1);
  expect(end, 'frontmatter must close with ---').toBeGreaterThan(1);
  const found = lines.slice(1, end).filter(line => line.startsWith(`${key}:`));
  expect(found.length, `${key} appears at most once`).toBeLessThanOrEqual(1);
  if (!found.length) return undefined;
  const raw = found[0].slice(key.length + 1).trim();
  expect(raw, `${key} must be a one-line scalar, not a folded or literal block`).not.toMatch(/^[>|]/);
  if (/^".*"$/.test(raw)) return JSON.parse(raw) as string;
  if (/^'.*'$/.test(raw)) return raw.slice(1, -1).replace(/''/g, "'");
  return raw;
}

/** One row per skill: description and when_to_use lengths and their combined length (joined by one space). */
export function skillLengths(root: string): { skill: string; description: number; whenToUse: number; combined: number }[] {
  return skillDirectories(root).map(dir => {
    const text = readFileSync(join(dir, 'SKILL.md'), 'utf8');
    const description = frontmatterValue(text, 'description') ?? '', whenToUse = frontmatterValue(text, 'when_to_use') ?? '';
    return { skill: dir.split(sep).pop()!, description: description.length, whenToUse: whenToUse.length, combined: description.length + (whenToUse ? 1 + whenToUse.length : 0) };
  });
}

it('every skill reference is linked from a SKILL.md or the README, not only from another reference', () => {
  const root = contentRoot();
  expect(skillDirectories(root).length, 'no skills found under the content root').toBeGreaterThan(0);
  expect(referencesLinkedOnlyFromReferences(root), 'link each of these from the skill that owns it (or the README); a link from a sibling reference does not count').toEqual([]);
});

it('the reachability check names a reference that only another reference links to', () => {
  const root = mkdtempSync(join(tmpdir(), 'agent-meshes-reach-')); directories.push(root);
  mkdirSync(join(root, 'skills', 'demo', 'references'), { recursive: true });
  writeFileSync(join(root, 'skills', 'demo', 'SKILL.md'), '---\nname: demo\ndescription: d\n---\nRead [guide](references/guide.md) and [direct](references/direct.md#top).\n\n```\n[fenced](references/fenced.md)\n```\n');
  writeFileSync(join(root, 'skills', 'demo', 'references', 'guide.md'), 'See [deep](deep.md) and [fenced](fenced.md).\n');
  for (const name of ['direct', 'deep', 'fenced']) writeFileSync(join(root, 'skills', 'demo', 'references', `${name}.md`), `# ${name}\n`);
  expect(referencesLinkedOnlyFromReferences(root)).toEqual(['skills/demo/references/deep.md', 'skills/demo/references/fenced.md']);
  writeFileSync(join(root, 'README.md'), 'See [deep](skills/demo/references/deep.md) and [fenced](skills/demo/references/fenced.md).\n');
  expect(referencesLinkedOnlyFromReferences(root)).toEqual([]);
});

it('every skill description plus when_to_use fits the 1536-character cap (lengths printed)', () => {
  const rows = skillLengths(contentRoot());
  expect(rows.length).toBeGreaterThan(0);
  const pad = (value: string | number, width: number) => String(value).padStart(width);
  const name = Math.max(5, ...rows.map(row => row.skill.length));
  const table = [`${'skill'.padEnd(name)} ${pad('description', 11)} ${pad('when_to_use', 11)} ${pad('combined', 8)} ${pad('cap', 5)} ${pad('left', 5)}`,
    ...rows.map(row => `${row.skill.padEnd(name)} ${pad(row.description, 11)} ${pad(row.whenToUse, 11)} ${pad(row.combined, 8)} ${pad(DESCRIPTION_CAP, 5)} ${pad(DESCRIPTION_CAP - row.combined, 5)}`)];
  console.info(`\nskill description + when_to_use length against the ${DESCRIPTION_CAP}-character cap\n${table.join('\n')}`);
  expect(rows.filter(row => row.combined > DESCRIPTION_CAP).map(row => `${row.skill}: ${row.combined} > ${DESCRIPTION_CAP}`)).toEqual([]);
  expect(rows.filter(row => row.description === 0).map(row => row.skill), 'every skill needs a description').toEqual([]);
});

// The build output guidance is copied into several places. Each copy that names a code keeps the shared facts below in
// the same words, so a reworded copy fails here instead of drifting. The facts are the guidance's meaning, written once.
const FACT = {
  keyedOnRemoval: /keyed on the removal, not on the flag/,
  previewFiles: /ends `\.png` in any case, or exactly `preview\.html`|ends `\.png` in any case and `preview\.html`/,
  silenceProvesNothing: /no warning does not prove (?:nothing|none) (?:was|were) removed/,
  nativeOnly: /`--if-changed` and `--force` apply to native `blender\.script` builds only/,
  restoredIsUnowned: /restor[^.]*version control[^.]*BUILD_OUTPUT_UNOWNED_FILE/,
  deleteAndRebuild: /[Dd]elete (?:them|it|that file) and rebuild with previews/,
  namesRemovedFiles: /\bnam(?:es|ing) them\b|\blists? the removed files\b|\blisting them\b/,
};
interface Copy { file: string; code: string; facts: (keyof typeof FACT)[] }
const COPIES: Copy[] = [
  { file: 'skills/mesh-build/SKILL.md', code: 'BUILD_PREVIEWS_REMOVED', facts: ['keyedOnRemoval', 'previewFiles', 'silenceProvesNothing', 'nativeOnly', 'namesRemovedFiles'] },
  { file: 'skills/mesh-build/SKILL.md', code: 'BUILD_OUTPUT_UNOWNED_FILE', facts: ['restoredIsUnowned', 'deleteAndRebuild', 'nativeOnly'] },
  { file: 'README.md', code: 'BUILD_PREVIEWS_REMOVED', facts: ['keyedOnRemoval', 'previewFiles', 'silenceProvesNothing', 'nativeOnly', 'namesRemovedFiles'] },
  { file: 'README.md', code: 'BUILD_OUTPUT_UNOWNED_FILE', facts: ['restoredIsUnowned', 'deleteAndRebuild', 'nativeOnly'] },
  { file: 'skills/mesh-authoring/SKILL.md', code: 'BUILD_PREVIEWS_REMOVED', facts: ['silenceProvesNothing', 'namesRemovedFiles'] },
  { file: 'skills/mesh-authoring/references/cli-setup.md', code: 'BUILD_PREVIEWS_REMOVED', facts: ['namesRemovedFiles'] },
  { file: 'skills/mesh-build/references/native-build-identity.md', code: 'BUILD_OUTPUT_UNOWNED_FILE', facts: [] },
  { file: 'skills/mesh-build/references/previews-and-refine.md', code: 'BUILD_OUTPUT_UNOWNED_FILE', facts: [] },
];
const flat = (text: string): string => text.replace(/\s+/g, ' ');

it('every skill or README that names BUILD_PREVIEWS_REMOVED or BUILD_OUTPUT_UNOWNED_FILE is a listed copy', () => {
  const root = contentRoot();
  const files = [...markdownIn(join(root, 'skills')), ...(existsSync(join(root, 'README.md')) ? [join(root, 'README.md')] : [])];
  const found = files.flatMap(file => ['BUILD_PREVIEWS_REMOVED', 'BUILD_OUTPUT_UNOWNED_FILE'].filter(code => readFileSync(file, 'utf8').includes(code)).map(code => `${posix(relative(root, file))} ${code}`)).sort();
  expect(found, 'a new copy of either code needs an entry in COPIES with the facts it repeats').toEqual(COPIES.map(copy => `${copy.file} ${copy.code}`).sort());
});

it('each copy of the build output guidance keeps the shared wording of the codes it names', () => {
  const root = contentRoot();
  const missing = COPIES.flatMap(copy => {
    const text = flat(readFileSync(join(root, copy.file), 'utf8'));
    return copy.facts.filter(fact => !FACT[fact].test(text)).map(fact => `${copy.file} (${copy.code}) lost the wording for ${fact}: ${FACT[fact].source}`);
  });
  expect(missing).toEqual([]);
});
