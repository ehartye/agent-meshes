"""Fast CI documentation invariants; independent temporary repositories per test."""
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
from check_docs import PATHS_FILE_FORMATS, check_docs

SCRIPT = Path(__file__).resolve().parents[1] / 'scripts' / 'check_docs.py'


class TempRepoCase(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='mesh-ci-docs-')
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.put('package.json', json.dumps({'name': 'agent-meshes', 'version': '1.2.3'}))
        self.put('package-lock.json', json.dumps({'version': '1.2.3', 'packages': {'': {'version': '1.2.3'}}}))
        self.put('.claude-plugin/plugin.json', json.dumps({'name': 'agent-meshes', 'version': '1.2.3'}))
        self.put('.claude-plugin/marketplace.json', json.dumps({'plugins': [{'name': 'agent-meshes', 'version': '1.2.3'}]}))

    def put(self, name, text):
        file = self.root / name
        file.parent.mkdir(parents=True, exist_ok=True)
        file.write_text(text, encoding='utf-8')


class DocumentationChecks(TempRepoCase):
    def test_checks_changed_links_but_ignores_code_and_external_urls(self):
        self.put('README.md', '[guide](docs/with%20spaces.md)\n[external](https://example.com)\n```js\nconst f = [value](example);\n```\n')
        self.put('docs/with spaces.md', 'A guide.\n')
        self.assertEqual(check_docs(self.root, ['README.md', 'docs/deleted.md']), [])
        self.put('README.md', '[broken](docs/missing.md)\n')
        self.assertIn('missing.md', '\n'.join(check_docs(self.root, ['README.md'])))

    def test_rejects_invalid_skill_yaml_and_mismatched_name(self):
        file = 'skills/sample/SKILL.md'
        self.put(file, '---\nname: sample\ndescription: unquoted: colon\n---\n')
        self.assertTrue(check_docs(self.root, [file]))
        self.put(file, '---\nname: wrong\ndescription: A skill.\n---\n')
        self.assertIn('name', '\n'.join(check_docs(self.root, [file])))
        self.put(file, '---\nname: sample\ndescription: A skill.\n---\n')
        self.assertEqual(check_docs(self.root, [file]), [])

    def test_commonmark_links_images_and_reference_destinations(self):
        self.put('docs/guide(1).md', 'A guide.\n')
        self.put('README.md', '[angle](<docs/guide(1).md>)\n[bare](docs/guide(1).md)\n![image](docs/guide(1).md)\n[reference][guide]\n\n[guide]: docs/guide(1).md\n')
        self.assertEqual(check_docs(self.root, ['README.md']), [])
        self.put('README.md', '[broken][guide]\n\n[guide]: docs/missing.md\n')
        self.assertIn('missing.md', '\n'.join(check_docs(self.root, ['README.md'])))

    def test_version_drift_fails_even_when_only_prose_changed(self):
        self.put('README.md', 'Read me.\n')
        self.put('.claude-plugin/plugin.json', json.dumps({'version': '9.9.9'}))
        self.assertIn('version', '\n'.join(check_docs(self.root, ['README.md'])))

    def test_missing_marketplace_entry_fails(self):
        self.put('.claude-plugin/marketplace.json', json.dumps({'plugins': []}))
        self.assertIn('marketplace', '\n'.join(check_docs(self.root, [])))

    def test_changed_json_is_parsed_and_unsafe_paths_are_rejected(self):
        self.put('docs/receipt.json', '{broken')
        self.assertTrue(check_docs(self.root, ['docs/receipt.json']))
        self.assertTrue(check_docs(self.root, ['../outside.md']))


class PathsFileCli(TempRepoCase):
    """Run the CLI against the temporary repository so the --paths-file formats are covered end to end."""

    def run_cli(self, text):
        listing = self.root / 'changed.txt'
        listing.write_text(text, encoding='utf-8', newline='')
        return subprocess.run(
            [sys.executable, str(SCRIPT), '--root', str(self.root), '--paths-file', str(listing)],
            capture_output=True, text=True, check=False,
        )

    def test_accepts_a_json_array(self):
        self.put('README.md', 'Read me.\n')
        result = self.run_cli(json.dumps(['README.md']))
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn('1 changed paths, 0 errors', result.stdout)

    def test_accepts_one_path_per_line(self):
        self.put('README.md', 'Read me.\n')
        self.put('docs/a.md', 'A.\n')
        result = self.run_cli('README.md\r\n\r\ndocs/a.md\n')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn('2 changed paths, 0 errors', result.stdout)

    def test_plain_list_still_runs_the_checks(self):
        self.put('README.md', '[broken](missing.md)\n')
        result = self.run_cli('README.md\n')
        self.assertEqual(result.returncode, 1)
        self.assertIn('missing.md', result.stderr)

    def test_malformed_file_exits_non_zero_with_one_line_and_no_traceback(self):
        for text in ('[broken', '{"paths": ["README.md"]}', '[1, 2]'):
            with self.subTest(text=text):
                result = self.run_cli(text)
                self.assertNotEqual(result.returncode, 0)
                self.assertNotIn('Traceback', result.stderr)
                self.assertEqual(result.stderr.strip(), PATHS_FILE_FORMATS)
                self.assertEqual(len(result.stderr.strip().splitlines()), 1)
        self.assertIn('JSON array', PATHS_FILE_FORMATS)
        self.assertIn('one path per line', PATHS_FILE_FORMATS)


if __name__ == '__main__':
    unittest.main()
