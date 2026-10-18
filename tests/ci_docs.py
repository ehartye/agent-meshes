"""Fast CI documentation invariants; independent temporary repositories per test."""
import json
from pathlib import Path
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
from check_docs import check_docs


class DocumentationChecks(unittest.TestCase):
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


if __name__ == '__main__':
    unittest.main()
