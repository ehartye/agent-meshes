/** @lane merge
 * @subject repository content
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
});
