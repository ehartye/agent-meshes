"""Cheap source-constant forwarding contract; no Blender process required."""
from pathlib import Path
import runpy
import sys
import tempfile
from types import ModuleType, SimpleNamespace
import unittest
from unittest.mock import patch

WRAPPER = Path(__file__).resolve().parents[1] / 'scripts' / 'blender-author.py'


class ExportControlTests(unittest.TestCase):
    def execute(self, constants):
        class Object:
            type = 'MESH'
        bpy = ModuleType('bpy')
        bpy.app = SimpleNamespace(binary_path=sys.executable)
        bpy.types = SimpleNamespace(Object=Object)
        bpy.ops = SimpleNamespace(wm=SimpleNamespace(read_factory_settings=lambda **_: None))
        calls = []
        author = ModuleType('agent_meshes_author')
        author.export_glb = lambda *args, **kwargs: calls.append((args, kwargs))
        audit = ModuleType('agent_meshes_read_audit')
        class ReadAudit:
            def __init__(self, **_): pass
            def finish(self): return {'installed': True}
        audit.ReadAudit = ReadAudit
        with tempfile.TemporaryDirectory(prefix='mesh-author-controls-') as directory:
            source, output = Path(directory) / 'asset.py', Path(directory) / 'model.glb'
            source.write_text(constants + '\nimport bpy\ndef build():\n    return [bpy.types.Object()]\n', encoding='utf8')
            with patch.dict(sys.modules, {'bpy': bpy, 'agent_meshes_author': author, 'agent_meshes_read_audit': audit}), patch.object(sys, 'path', list(sys.path)):
                wrapper = runpy.run_path(str(WRAPPER))
                self.assertEqual(wrapper['main'](source, output), (1, {'installed': True}))
        self.assertEqual(len(calls), 1)
        return calls[0][1]

    def test_omission_preserves_the_original_exporter_invocation(self):
        self.assertEqual(self.execute(''), {'animation_mode': 'ACTIONS'})

    def test_explicit_active_and_false_are_forwarded_without_truthiness_defaults(self):
        self.assertEqual(self.execute("EXPORT_VERTEX_COLOR = 'ACTIVE'\nEXPORT_ALL_VERTEX_COLORS = False"),
                         {'animation_mode': 'ACTIONS', 'vertex_color': 'ACTIVE', 'all_vertex_colors': False})

    def test_explicit_none_is_forwarded_for_native_default_semantics(self):
        self.assertEqual(self.execute('EXPORT_VERTEX_COLOR = None\nEXPORT_ALL_VERTEX_COLORS = None'),
                         {'animation_mode': 'ACTIONS', 'vertex_color': None, 'all_vertex_colors': None})

    def test_animation_override_stays_independent(self):
        self.assertEqual(self.execute("EXPORT_ANIMATION_MODE = 'NLA_TRACKS'\nEXPORT_VERTEX_COLOR = 'NONE'"),
                         {'animation_mode': 'NLA_TRACKS', 'vertex_color': 'NONE'})


if __name__ == '__main__':
    unittest.main()
