"""Dependency-light CI checks for changed documentation and release metadata."""
import argparse
import json
from pathlib import Path, PurePosixPath
import re
import sys
from urllib.parse import unquote, urlsplit

import yaml
from markdown_it import MarkdownIt


def markdown_targets(tokens):
    for token in tokens:
        attribute = 'href' if token.type == 'link_open' else 'src' if token.type == 'image' else None
        if attribute:
            yield token.attrGet(attribute)
        if token.children:
            yield from markdown_targets(token.children)


def check_docs(root, paths):
    root = Path(root).resolve()
    errors = []
    try:
        package = json.loads((root / 'package.json').read_text(encoding='utf-8'))
        lock = json.loads((root / 'package-lock.json').read_text(encoding='utf-8'))
        plugin = json.loads((root / '.claude-plugin/plugin.json').read_text(encoding='utf-8'))
        market = json.loads((root / '.claude-plugin/marketplace.json').read_text(encoding='utf-8'))
        versions = [package['version'], lock['version'], lock['packages']['']['version'], plugin['version']]
        entries = [p for p in market['plugins'] if p['name'] == package['name']]
        if len(entries) != 1:
            errors.append('Release metadata: expected one matching marketplace entry')
        versions += [p['version'] for p in entries]
        if not versions or any(v != versions[0] for v in versions):
            errors.append('Release metadata version mismatch')
    except (OSError, ValueError, KeyError, TypeError) as error:
        errors.append(f'Release metadata: {error}')

    for relative in paths:
        if not isinstance(relative, str) or '\\' in relative or PurePosixPath(relative).is_absolute() or '..' in PurePosixPath(relative).parts:
            errors.append(f'Unsafe changed path: {relative!r}')
            continue
        file = root / relative
        if not file.exists():  # Deleted paths still participate in CI selection.
            continue
        try:
            if file.suffix == '.json':
                json.loads(file.read_text(encoding='utf-8'))
            if file.suffix != '.md':
                continue
            text = file.read_text(encoding='utf-8')
            if file.name == 'SKILL.md':
                match = re.match(r'^---\r?\n(.*?)\r?\n---(?:\r?\n|$)', text, re.S)
                metadata = yaml.safe_load(match.group(1)) if match else None
                if not isinstance(metadata, dict) or not isinstance(metadata.get('description'), str) or not metadata['description'].strip():
                    errors.append(f'{relative}: missing skill description/frontmatter')
                if not isinstance(metadata, dict) or metadata.get('name') != file.parent.name:
                    errors.append(f'{relative}: skill name must match its directory')
            for target in markdown_targets(MarkdownIt('commonmark').parse(text)):
                parsed = urlsplit(target)
                if parsed.scheme or not parsed.path or parsed.path.startswith('/'):
                    continue  # External/host-absolute URLs and anchors are not network checked.
                destination = (file.parent / unquote(parsed.path)).resolve()
                if not destination.exists():
                    errors.append(f'{relative}: missing local link {target}')
        except (OSError, ValueError, yaml.YAMLError) as error:
            errors.append(f'{relative}: {error}')
    return errors


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root', default='.')
    parser.add_argument('--paths-file', required=True)
    args = parser.parse_args()
    paths = json.loads(Path(args.paths_file).read_text(encoding='utf-8'))
    if not isinstance(paths, list):
        raise ValueError('Changed paths must be a JSON list')
    errors = check_docs(args.root, paths)
    for error in errors:
        print(error, file=sys.stderr)
    print(f'Documentation/metadata checks: {len(paths)} changed paths, {len(errors)} errors.')
    return bool(errors)


if __name__ == '__main__':
    sys.exit(main())
