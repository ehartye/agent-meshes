"""The reference heads under recipes/heads are complete, self-contained build inputs.

Pure Python: it reads the sources and never imports them, so it needs no Blender. Building the heads and checking the
arkit-face/1 contract is tests/face-rig-blender.test.ts.
"""
import ast
import json
from pathlib import Path
import sys
import unittest

sys.dont_write_bytecode = True
HEADS = Path(__file__).resolve().parents[1] / 'recipes' / 'heads'
IDS = ('bolt', 'mossjaw', 'pip')
# What a head source may import: the standard library, Blender's own modules and the runner's helpers.
BLENDER = {'bpy', 'bmesh', 'mathutils'}


def imports(tree):
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            for name in node.names: yield name.name.split('.')[0]
        elif isinstance(node, ast.ImportFrom):
            if node.level: yield '.'
            else: yield (node.module or '').split('.')[0]


class ReferenceHeads(unittest.TestCase):
    def test_every_head_folder_is_a_known_head(self):
        self.assertEqual(sorted(p.name for p in HEADS.iterdir() if p.is_dir()), sorted(IDS))

    def test_each_head_is_one_source_and_one_config(self):
        for name in IDS:
            with self.subTest(head=name):
                folder = HEADS / name
                self.assertEqual(sorted(p.name for p in folder.iterdir() if p.name != '__pycache__'), sorted(['build.json', f'{name}_head.py']))
                config = json.loads((folder / 'build.json').read_text(encoding='utf8'))
                self.assertEqual(config['version'], 1)
                self.assertEqual(config['name'], name)
                self.assertEqual(config['blender'], {'script': f'{name}_head.py'})
                # Output lands in the ignored artifacts folder, never beside the source.
                self.assertEqual(config['output'], f'../../../artifacts/heads/{name}')

    def test_each_source_defines_build_and_imports_only_shared_helpers(self):
        for name in IDS:
            with self.subTest(head=name):
                tree = ast.parse((HEADS / name / f'{name}_head.py').read_text(encoding='utf8'))
                self.assertIn('build', [node.name for node in tree.body if isinstance(node, ast.FunctionDef)])
                self.assertIsNotNone(ast.get_docstring(tree))
                for module in set(imports(tree)):
                    allowed = module in sys.stdlib_module_names or module in BLENDER or module.startswith('agent_meshes_')
                    self.assertTrue(allowed, f'{name} imports {module}')

    def test_each_source_declares_the_face_contract(self):
        for name in IDS:
            with self.subTest(head=name):
                tree = ast.parse((HEADS / name / f'{name}_head.py').read_text(encoding='utf8'))
                called = {node.func.id for node in ast.walk(tree) if isinstance(node, ast.Call) and isinstance(node.func, ast.Name)}
                self.assertIn('face_contract', called)
                self.assertIn('face_skeleton', called)


if __name__ == '__main__':
    unittest.main()
