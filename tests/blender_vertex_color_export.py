"""Real Blender export proof. Run with -- --output-dir <private-directory>."""
import argparse
import hashlib
import json
from pathlib import Path
import struct
import sys
import unittest

import bpy

sys.dont_write_bytecode = True
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts/blender_lib'))
import agent_meshes_author as author


def sha(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def read_glb(path):
    raw = path.read_bytes()
    length, kind = struct.unpack_from('<II', raw, 12)
    assert raw[:4] == b'glTF' and kind == 0x4E4F534A
    doc = json.loads(raw[20:20 + length])
    offset = 20 + length
    length, kind = struct.unpack_from('<II', raw, offset)
    assert kind == 0x004E4942
    return doc, raw[offset + 8:offset + 8 + length]


def accessor(doc, binary, index):
    a = doc['accessors'][index]
    view = doc['bufferViews'][a['bufferView']]
    fmt, size, denominator = {5121: ('B', 1, 255), 5123: ('H', 2, 65535),
                              5126: ('f', 4, 1)}[a['componentType']]
    count = {'VEC3': 3, 'VEC4': 4}[a['type']]
    offset = view.get('byteOffset', 0) + a.get('byteOffset', 0)
    divisor = denominator if a.get('normalized', False) else 1
    return [tuple(v / divisor for v in struct.unpack_from('<' + fmt * count, binary,
            offset + i * view.get('byteStride', size * count))) for i in range(a['count'])]


class VertexColorExportTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        bpy.ops.object.select_all(action='SELECT')
        bpy.ops.object.delete(use_global=False)
        cls.sources = {}
        for role, color in [('base_color', (.6, .5, .4, 1)),
                            ('normal', (.5, .5, 1, 1)), ('roughness', (.7, .7, .7, 1))]:
            image = bpy.data.images.new(role, width=4, height=4)
            image.generated_color = color
            file = OUTPUT / (role + '.png')
            image.filepath_raw, image.file_format = str(file), 'PNG'
            image.save()
            bpy.data.images.remove(image)
            cls.sources[role] = file
        mat = author.image_material('Texture times CraftColor', **cls.sources,
                                    uv_layer='SurfaceUV', normal_strength=.28)
        nodes, links = mat.node_tree.nodes, mat.node_tree.links
        shader = next(n for n in nodes if n.type == 'BSDF_PRINCIPLED')
        base = shader.inputs['Base Color'].links[0].from_socket
        colors = nodes.new('ShaderNodeVertexColor')
        colors.layer_name = 'CraftColor'
        multiply = nodes.new('ShaderNodeMixRGB')
        multiply.blend_type = 'MULTIPLY'
        multiply.inputs[0].default_value = 1
        links.new(base, multiply.inputs[1])
        links.new(colors.outputs['Color'], multiply.inputs[2])
        links.new(multiply.outputs['Color'], shader.inputs['Base Color'])
        mesh = bpy.data.meshes.new('Color proof mesh')
        mesh.from_pydata([(0, 0, 0), (1, 0, 0), (1, 1, 0), (0, 1, 0)], [], [(0, 1, 2, 3)])
        uv = mesh.uv_layers.new(name='SurfaceUV')
        for item, pair in zip(uv.data, [(0, 0), (1, 0), (1, 1), (0, 1)]):
            item.uv = pair
        mesh.color_attributes.new(name='UnusedWhite', type='FLOAT_COLOR', domain='POINT')
        paint = mesh.color_attributes.new(name='CraftColor', type='FLOAT_COLOR', domain='POINT')
        cls.native = [(.24, .37, .51, 1), (.42, .55, .68, 1),
                      (.62, .73, .75, 1), (.31, .45, .59, 1)]
        for item, color in zip(paint.data, cls.native):
            item.color = color
        mesh.color_attributes.active_color_index = 1
        mesh.color_attributes.render_color_index = 1
        cls.obj = bpy.data.objects.new('Color proof', mesh)
        bpy.context.collection.objects.link(cls.obj)
        mesh.materials.append(mat)
        REPORT['native'] = {'active': mesh.color_attributes.active_color_name,
                            'render_index': mesh.color_attributes.render_color_index,
                            'attributes': [{'name': a.name, 'domain': a.domain, 'type': a.data_type,
                                            'colors': [list(v.color) for v in a.data]}
                                           for a in mesh.color_attributes]}
        cls.sentinel = bpy.data.objects.new('Selection sentinel', None)
        bpy.context.collection.objects.link(cls.sentinel)

    def setUp(self):
        bpy.ops.object.select_all(action='DESELECT')
        self.sentinel.select_set(True)
        bpy.context.view_layer.objects.active = self.sentinel

    def selection(self):
        return (tuple(bpy.context.selected_objects), bpy.context.view_layer.objects.active)

    def export(self, name, **options):
        before, hashes = self.selection(), {role: sha(p) for role, p in self.sources.items()}
        def native_colors():
            attrs = self.obj.data.color_attributes
            return (attrs.active_color_name, attrs.render_color_index,
                    tuple((a.name, a.domain, a.data_type, tuple(tuple(v.color) for v in a.data)) for a in attrs))
        color_state = native_colors()
        output = OUTPUT / (name + '.glb')
        author.export_glb(output, [self.obj], **options)
        self.assertEqual(self.selection(), before)
        self.assertEqual(native_colors(), color_state)
        self.assertEqual(hashes, {role: sha(p) for role, p in self.sources.items()})
        doc, binary = read_glb(output)
        primitive = doc['meshes'][0]['primitives'][0]
        images = [hashlib.sha256(binary[v.get('byteOffset', 0):v.get('byteOffset', 0) + v['byteLength']]).hexdigest()
                  for image in doc['images'] for v in [doc['bufferViews'][image['bufferView']]]]
        REPORT['exports'][name] = {'sha256': sha(output), 'attributes': primitive['attributes'], 'images': images}
        return doc, binary, primitive, images

    def test_active_preserves_nonwhite_native_colors_and_material_texture_slots(self):
        default, _, _, original_images = self.export('default-before-active')
        doc, binary, primitive, images = self.export('active', vertex_color='ACTIVE', all_vertex_colors=False)
        self.assertIn('COLOR_0', primitive['attributes'])
        values = accessor(doc, binary, primitive['attributes']['COLOR_0'])
        self.assertTrue(values)
        for value in values:
            self.assertTrue(any(max(abs(a - b) for a, b in zip(value[:3], color[:3])) < 2 / 65535
                                for color in self.native), value)
        self.assertLess(min(v[0] for v in values), .3)
        self.assertGreater(max(v[2] for v in values), .7)
        self.assertEqual(doc['materials'], default['materials'])
        self.assertEqual(images, original_images)
        pbr = doc['materials'][0]['pbrMetallicRoughness']
        self.assertIn('baseColorTexture', pbr)
        self.assertIn('metallicRoughnessTexture', pbr)
        self.assertAlmostEqual(doc['materials'][0]['normalTexture']['scale'], .28, places=6)
        REPORT['exports']['active']['colors'] = values

    def test_active_single_layer_preserves_native_values_without_all_color_override(self):
        original = self.obj.data
        mesh = original.copy()
        self.obj.data = mesh
        try:
            mesh.color_attributes.remove(mesh.color_attributes['UnusedWhite'])
            mesh.color_attributes.active_color_index = 0
            mesh.color_attributes.render_color_index = 0
            doc, binary, primitive, _ = self.export('active-single-layer', vertex_color='ACTIVE')
            values = accessor(doc, binary, primitive['attributes']['COLOR_0'])
            for value in values:
                self.assertTrue(any(max(abs(a - b) for a, b in zip(value[:3], color[:3])) < 2 / 65535
                                    for color in self.native), value)
        finally:
            self.obj.data = original
            bpy.data.meshes.remove(mesh)

    def test_none_omits_colors_but_preserves_materials_images_and_default_behavior(self):
        default, binary, primitive, images = self.export('default')
        explicit, _, _, explicit_images = self.export('explicit-none-default', vertex_color=None, all_vertex_colors=None)
        self.assertEqual(explicit, default)
        self.assertEqual(explicit_images, images)
        all_colors, _, _, _ = self.export('explicit-all-default', all_vertex_colors=True)
        self.assertEqual(all_colors, default)
        material, _, _, _ = self.export('explicit-material', vertex_color='MATERIAL')
        self.assertEqual(material, default)
        doc, _, primitive_none, none_images = self.export('none', vertex_color='NONE')
        self.assertFalse(any(name.startswith('COLOR_') for name in primitive_none['attributes']))
        self.assertEqual(doc['materials'], default['materials'])
        self.assertEqual(none_images, images)
        # Native default remains MATERIAL; this graph reproduces the all-white failure.
        self.assertEqual(bpy.ops.export_scene.gltf.get_rna_type().properties['export_vertex_color'].default, 'MATERIAL')
        self.assertTrue(all(all(abs(c - 1) < 1e-6 for c in v)
                            for v in accessor(default, binary, primitive['attributes']['COLOR_0'])))

    def test_invalid_options_fail_before_objects_selection_or_files_are_touched(self):
        class Untouchable:
            def __iter__(self):
                raise AssertionError('Invalid option reached object iteration')
        before = self.selection()
        for mode in ['', 'active', 'NAME', True, 0, [], {}]:
            with self.subTest(mode=mode), self.assertRaises(ValueError):
                author.export_glb(OUTPUT / 'invalid.glb', Untouchable(), vertex_color=mode)
            self.assertEqual(self.selection(), before)
            self.assertFalse((OUTPUT / 'invalid.glb').exists())
        with self.assertRaises(TypeError):
            author.export_glb(OUTPUT / 'positional.glb', [self.obj], 'ACTIONS', 'ACTIVE')
        self.assertEqual(self.selection(), before)
        for value in [0, 1, 'false', [], {}]:
            with self.subTest(all_vertex_colors=value), self.assertRaises(ValueError):
                author.export_glb(OUTPUT / 'invalid-all.glb', Untouchable(), all_vertex_colors=value)
            self.assertEqual(self.selection(), before)
            self.assertFalse((OUTPUT / 'invalid-all.glb').exists())

    def test_native_export_failure_restores_selection(self):
        blocker = OUTPUT / 'parent-is-a-file'
        blocker.write_text('block directory creation', encoding='utf8')
        before = self.selection()
        with self.assertRaises((RuntimeError, OSError)):
            author.export_glb(blocker / 'cannot-export.glb', [self.obj], vertex_color='ACTIVE')
        self.assertEqual(self.selection(), before)


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--output-dir', type=Path, required=True)
    OUTPUT = parser.parse_args(sys.argv[sys.argv.index('--') + 1:]).output_dir
    OUTPUT.mkdir(parents=True, exist_ok=True)
    properties = bpy.ops.export_scene.gltf.get_rna_type().properties
    prop = properties['export_vertex_color']
    REPORT = {'blender': bpy.app.version_string, 'scope': 'Real Blender export/accessor/texture/selection proof; no visual acceptance',
              'sourceSha256': sha(__file__), 'helperSha256': sha(Path(author.__file__)),
              'nativeEnum': [{'id': e.identifier, 'description': e.description} for e in prop.enum_items],
              'nativeDefault': prop.default, 'nativeAllColorsDefault': properties['export_all_vertex_colors'].default,
              'exports': {}}
    result = unittest.TextTestRunner(verbosity=2).run(unittest.defaultTestLoader.loadTestsFromTestCase(VertexColorExportTests))
    REPORT.update(ok=result.wasSuccessful(), testsRun=result.testsRun, failures=result.failures, errors=result.errors)
    (OUTPUT / 'report.json').write_text(json.dumps(REPORT, indent=2, default=str) + '\n', encoding='utf8')
    print('VERTEX_COLOR_EXPORT_RESULT ' + json.dumps(REPORT, default=str))
    if not result.wasSuccessful():
        raise SystemExit(1)
