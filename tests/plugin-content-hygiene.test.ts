/** @lane merge
 * @subject repository content
 */
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, extname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

// Plugin content stays free of language about our own machines and non-plugin projects; that belongs in the wiki.
// Generic patterns are checked here. Private project names are not listed in the repo: point
// AGENT_MESHES_PRIVATE_TERMS_FILE at a local file with one term per line to check those too. A plain term matches
// case-insensitively anywhere in a line; a term written /pattern/flags is a regular expression with exactly those flags
// (no flags means case-sensitive), for names that are also ordinary words or substrings, such as /\bPip\b/.
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const TEXT = new Set(['.md', '.mjs', '.js', '.ts', '.json', '.yml', '.yaml', '.py', '.html', '.sh', '.txt', '']);
const SKIP_DIRS = new Set(['.git', 'node_modules', '.cache', '.playwright-mcp', 'dist', 'dist-web', 'results']);
const walk = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
  const full = join(dir, entry.name);
  if (entry.isDirectory()) return SKIP_DIRS.has(entry.name) ? [] : walk(full);
  return entry.isFile() && entry.name !== '.git' && TEXT.has(extname(entry.name)) ? [full] : [];
});
// Fixture paths use placeholder user names; a real account name is a finding.
const PLACEHOLDER_USER = /^(?:one|two|a|a b|shared|public|user|you|me|name|username|example|fixture|test|someone|runner)$/i;
const HOME_PATH = /[A-Za-z]:[\\/]+Users[\\/]+([^\\/\s"']+)|\/Users\/([a-z][\w.-]*)\/|\/home\/([a-z][\w.-]*)\//g;
const homePathIn = (line: string) => [...line.matchAll(HOME_PATH)].some(m => !PLACEHOLDER_USER.test(m[1] ?? m[2] ?? m[3]) && !(m[1] ?? m[2] ?? m[3]).startsWith('<'));
const RULES: [string, (line: string) => boolean][] = [
  ['a home-directory path', homePathIn],
  ['a GPU model name', line => /\b(?:GeForce|RTX ?\d{3,4}|Radeon(?: RX)?|Iris Xe|UHD Graphics)\b/.test(line)],
  ['a link into a repository that is not a plugin', line => /github\.com\/ehartye\/(?!agent-|hartye-)[\w.-]+|ehartye\.github\.io\/(?!agent-|hartye-)/.test(line)],
  ['a wiki vault path', line => /wiki\/(?:authored|sources|entities)\//.test(line)],
];

it('plugin content names no home directory, GPU model, non-plugin repository or wiki path', () => {
  const termsFile = process.env.AGENT_MESHES_PRIVATE_TERMS_FILE;
  const terms = termsFile ? readFileSync(termsFile, 'utf8').split(/\r?\n/).map(t => t.trim()).filter(Boolean) : [];
  const rules = [...RULES, ...terms.map((term): [string, (line: string) => boolean] => {
    const pattern = /^\/(.+)\/([a-z]*)$/.exec(term);
    if (pattern) { const re = new RegExp(pattern[1], pattern[2]); return [`the private pattern ${term}`, line => re.test(line)]; }
    const lower = term.toLowerCase();
    return [`the private term "${term}"`, line => line.toLowerCase().includes(lower)];
  })];
  const self = resolve(fileURLToPath(import.meta.url));
  const hits: string[] = [];
  for (const file of walk(ROOT)) {
    if (resolve(file) === self) continue; // this file holds the patterns
    readFileSync(file, 'utf8').split(/\r?\n/).forEach((line, index) => {
      for (const [what, matches] of rules) if (matches(line)) hits.push(`${relative(ROOT, file).split(sep).join('/')}:${index + 1}: ${what}`);
    });
  }
  expect(hits).toEqual([]);
});
