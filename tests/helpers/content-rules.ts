// The content rules shared by tests/plugin-content-hygiene.test.ts and tests/build-output-guidance.test.ts.
// scripts/check_private_terms.py implements the same rules and term-file format for a manual scan; the hygiene test
// runs both over one fixture and fails when they disagree.
//
// Plugin content stays free of language about our own machines and non-plugin projects; that belongs in the wiki.
// Generic patterns are checked here. Private project names are not listed in the repo: point
// AGENT_MESHES_PRIVATE_TERMS_FILE at a local file with one term per line to check those too. A plain term matches
// case-insensitively anywhere in a line; a term written /pattern/flags is a regular expression with exactly those flags
// (no flags means case-sensitive), for names that are also ordinary words or substrings.
// A private term is never printed: a finding names the term's number in the file, not the term.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, extname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export type Rule = [what: string, matches: (line: string) => boolean];

/** The checkout that holds this helper. */
export const CHECKOUT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
/** The directory to scan: AGENT_MESHES_TEST_ROOT (a copy of the files to check) when set, else the checkout. */
export const contentRoot = (): string => resolve(process.env.AGENT_MESHES_TEST_ROOT || CHECKOUT_ROOT);

const TEXT = new Set(['.md', '.mjs', '.js', '.ts', '.json', '.yml', '.yaml', '.py', '.html', '.sh', '.txt', '']);
// Directories and the linked-worktree pointer file are skipped by name, wherever they sit.
const SKIP_NAMES = new Set(['.git', 'node_modules', '.cache', '.playwright-mcp', 'dist', 'dist-web', 'results']);
/** Files that hold the patterns themselves, relative to the root. */
export const RULE_FILES = new Set(['tests/helpers/content-rules.ts', 'tests/plugin-content-hygiene.test.ts', 'scripts/check_private_terms.py']);

// Fixture paths use placeholder user names; a real account name is a finding.
const PLACEHOLDER_USER = /^(?:one|two|a|a b|shared|public|user|you|me|name|username|example|fixture|test|someone|runner)$/i;
const HOME_PATH = /[A-Za-z]:[\\/]+Users[\\/]+([^\\/\s"']+)|\/Users\/([a-z][\w.-]*)\/|\/home\/([a-z][\w.-]*)\//g;
export const homePathIn = (line: string): boolean => [...line.matchAll(HOME_PATH)].some(m => !PLACEHOLDER_USER.test(m[1] ?? m[2] ?? m[3]) && !(m[1] ?? m[2] ?? m[3]).startsWith('<'));
export const RULES: Rule[] = [
  ['a home-directory path', homePathIn],
  ['a GPU model name', line => /\b(?:GeForce|RTX ?\d{3,4}|Radeon(?: RX)?|Iris Xe|UHD Graphics)\b/.test(line)],
  ['a link into a repository that is not a plugin', line => /github\.com\/ehartye\/(?!agent-|hartye-)[\w.-]+|ehartye\.github\.io\/(?!agent-|hartye-)/.test(line)],
  ['a wiki vault path', line => /wiki\/(?:authored|sources|entities)\//.test(line)],
];

/** The terms in a term file: one per line, trimmed, blank lines dropped. */
export const parseTerms = (text: string): string[] => text.split(/\r?\n/).map(t => t.trim()).filter(Boolean);

/** Rules for private terms. The label carries the term's number (1-based among the non-blank lines), never the term. */
export function privateRules(termsFile: string | undefined = process.env.AGENT_MESHES_PRIVATE_TERMS_FILE): Rule[] {
  if (!termsFile) return [];
  return parseTerms(readFileSync(termsFile, 'utf8')).map((term, index): Rule => {
    const pattern = /^\/(.+)\/([a-z]*)$/.exec(term);
    if (pattern) {
      let re: RegExp;
      try { re = new RegExp(pattern[1], pattern[2].replace(/[gy]/g, '')); }
      catch { throw new Error(`private pattern #${index + 1} in the term file is not a valid regular expression`); }
      return [`private pattern #${index + 1}`, line => re.test(line)];
    }
    const lower = term.toLowerCase();
    return [`private term #${index + 1}`, line => line.toLowerCase().includes(lower)];
  });
}

/** The paths in a list file: one per line, trimmed, blank lines dropped. */
export const readPathList = (file: string): string[] => parseTerms(readFileSync(file, 'utf8'));

const posix = (path: string): string => path.split(sep).join('/');
const scannable = (root: string, file: string): boolean => {
  const parts = posix(relative(root, file)).split('/');
  return !parts.some(part => SKIP_NAMES.has(part)) && TEXT.has(extname(file)) && !RULE_FILES.has(parts.join('/'));
};
const walk = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
  if (SKIP_NAMES.has(entry.name)) return [];
  const full = join(dir, entry.name);
  return entry.isDirectory() ? walk(full) : entry.isFile() ? [full] : [];
});

/**
 * The text files to scan under root. Without a path list this is every file on disk, so a new untracked file is
 * covered as well as a tracked one. With a list (paths relative to root, or absolute), only those files and the files
 * under listed directories; a listed path that no longer exists is skipped.
 */
export function contentFiles(root: string, paths?: string[]): string[] {
  const starts = paths ? paths.map(p => resolve(root, p)).filter(p => existsSync(p)) : [root];
  const files = starts.flatMap(start => statSync(start).isDirectory() ? walk(start) : [start]);
  return [...new Set(files)].filter(file => scannable(root, file)).sort();
}

/** Scan lines against rules; each finding is "file:line: rule" and never contains the matched text. */
export function scanContent(root: string, rules: Rule[], paths?: string[]): string[] {
  const hits: string[] = [];
  for (const file of contentFiles(root, paths)) {
    readFileSync(file, 'utf8').split(/\r?\n/).forEach((line, index) => {
      for (const [what, matches] of rules) if (matches(line)) hits.push(`${posix(relative(root, file))}:${index + 1}: ${what}`);
    });
  }
  return hits;
}

/** Findings for lines of text (no files); used by the guidance test, which scans one section of one reference. */
export const scanLine = (rules: Rule[], text: string): string[] => rules.filter(([, matches]) => matches(text)).map(([what]) => what);

/** The path-list file named by AGENT_MESHES_CONTENT_PATHS_FILE, if any. */
export const pathListFromEnvironment = (): string[] | undefined => {
  const file = process.env.AGENT_MESHES_CONTENT_PATHS_FILE;
  return file ? readPathList(file) : undefined;
};
