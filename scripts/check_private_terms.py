"""Scan plugin content for machine-specific language and private terms, the way tests/plugin-content-hygiene.test.ts does.

The rules and the term-file format are those of tests/helpers/content-rules.ts; the hygiene test runs both over one
fixture and fails when they disagree. A private term is never printed: a finding names the term's number in the term
file, not the term.

    python scripts/check_private_terms.py [--root DIR] [--paths-file LIST] [--terms-file FILE]

--paths-file names a file holding a JSON array of paths or one path per line (relative to the root, or absolute); a listed
path that does not exist is skipped. Without it every file under the
root is scanned, untracked ones included. The term file defaults to AGENT_MESHES_PRIVATE_TERMS_FILE, the root to
AGENT_MESHES_TEST_ROOT, else the checkout holding this script. Exit 0 when clean, 1 on findings, 2 on a usage error.
"""
import argparse
import json
import os
from pathlib import Path
import re
import sys

TEXT = {'.md', '.mjs', '.js', '.ts', '.json', '.yml', '.yaml', '.py', '.html', '.sh', '.txt', ''}
SKIP_NAMES = {'.git', 'node_modules', '.cache', '.playwright-mcp', 'dist', 'dist-web', 'results'}
RULE_FILES = {'tests/helpers/content-rules.ts', 'tests/plugin-content-hygiene.test.ts', 'scripts/check_private_terms.py'}

PLACEHOLDER_USER = re.compile(r'^(?:one|two|a|a b|shared|public|user|you|me|name|username|example|fixture|test|someone|runner)$', re.I)
HOME_PATH = re.compile(r'''[A-Za-z]:[\\/]+Users[\\/]+([^\\/\s"']+)|/Users/([a-z][\w.-]*)/|/home/([a-z][\w.-]*)/''')


def home_path_in(line):
    for match in HOME_PATH.finditer(line):
        name = next(group for group in match.groups() if group is not None)
        if not PLACEHOLDER_USER.search(name) and not name.startswith('<'):
            return True
    return False


RULES = [
    ('a home-directory path', home_path_in),
    ('a GPU model name', re.compile(r'\b(?:GeForce|RTX ?\d{3,4}|Radeon(?: RX)?|Iris Xe|UHD Graphics)\b').search),
    ('a link into a repository that is not a plugin', re.compile(r'github\.com/ehartye/(?!agent-|hartye-)[\w.-]+|ehartye\.github\.io/(?!agent-|hartye-)').search),
    ('a wiki vault path', re.compile(r'wiki/(?:authored|sources|entities)/').search),
]


def private_rules(terms_file):
    if not terms_file:
        return []
    text = Path(terms_file).read_text(encoding='utf-8')
    terms = [line.strip() for line in re.split(r'\r?\n', text) if line.strip()]
    rules = []
    for number, term in enumerate(terms, start=1):
        pattern = re.fullmatch(r'/(.+)/([a-z]*)', term)
        if pattern:
            flags = 0
            for flag in pattern.group(2):
                flags |= {'i': re.I, 'm': re.M, 's': re.S}.get(flag, 0)
            try:
                compiled = re.compile(pattern.group(1), flags)
            except re.error:
                raise SystemExit(f'private pattern #{number} in the term file is not a valid regular expression')
            rules.append((f'private pattern #{number}', compiled.search))
        else:
            lower = term.lower()
            rules.append((f'private term #{number}', lambda line, lower=lower: lower in line.lower()))
    return rules


def walk(directory):
    for entry in sorted(os.scandir(directory), key=lambda e: e.name):
        if entry.name in SKIP_NAMES:
            continue
        if entry.is_dir(follow_symlinks=False):
            yield from walk(entry.path)
        elif entry.is_file():
            yield Path(entry.path)


def relative(root, file):
    # A listed file outside the root is named by its ../ path, as the TypeScript helper does.
    return Path(os.path.relpath(file, root)).as_posix()


def scannable(root, file):
    parts = relative(root, file).split('/')
    return not any(part in SKIP_NAMES for part in parts) and file.suffix in TEXT and '/'.join(parts) not in RULE_FILES


def content_files(root, paths):
    starts = [root] if paths is None else [(root / p) for p in paths if (root / p).exists()]
    files = {}
    for start in starts:
        start = start.resolve()
        for file in (walk(start) if start.is_dir() else [start]):
            files[file] = None
    return sorted(file for file in files if scannable(root, file))


def scan(root, rules, paths):
    hits = []
    files = content_files(root, paths)
    for file in files:
        text = file.read_text(encoding='utf-8', errors='replace')
        for number, line in enumerate(re.split(r'\r?\n', text), start=1):
            for what, matches in rules:
                if matches(line):
                    hits.append(f'{relative(root, file)}:{number}: {what}')
    return hits, len(files)


PATHS_FILE_FORMATS = 'paths file must be a JSON array of paths or one path per line'


def read_paths_file(file):
    """Return the listed paths from a JSON array or a one-path-per-line file; raise ValueError if it is neither."""
    try:
        text = Path(file).read_text(encoding='utf-8-sig')
    except (OSError, ValueError) as error:  # UnicodeDecodeError is a ValueError.
        raise ValueError(f'{PATHS_FILE_FORMATS} (could not read {file}: {" ".join(str(error).split())})')
    stripped = text.strip()
    if stripped[:1] in ('[', '{'):
        try:
            paths = json.loads(stripped)
        except ValueError:
            paths = None
        if not isinstance(paths, list) or not all(isinstance(path, str) for path in paths):
            raise ValueError(PATHS_FILE_FORMATS)
        return paths
    return [line.strip() for line in re.split(r'\r?\n', text) if line.strip()]


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    parser.add_argument('--root', default=os.environ.get('AGENT_MESHES_TEST_ROOT') or str(Path(__file__).resolve().parent.parent))
    parser.add_argument('--paths-file')
    parser.add_argument('--terms-file', default=os.environ.get('AGENT_MESHES_PRIVATE_TERMS_FILE'))
    args = parser.parse_args(argv)
    root = Path(args.root).resolve()
    paths = None
    if args.paths_file:
        try:
            paths = read_paths_file(args.paths_file)
        except ValueError as error:
            print(error, file=sys.stderr)
            return 2
    hits, count = scan(root, RULES + private_rules(args.terms_file), paths)
    for hit in hits:
        print(hit)
    print(f'{len(hits)} finding(s) in {count} file(s) scanned', file=sys.stderr)
    return 1 if hits else 0


if __name__ == '__main__':
    sys.exit(main())
