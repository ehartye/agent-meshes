"""Actual Blender material/export proof; no bpy substitutes.

blender -b --factory-startup --python tests/blender_image_material.py --
  --output-dir <private-directory> [--asset-root <Poly-Haven-manifest-directory>]
"""
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


def glb(path):
    raw = path.read_bytes()
    assert raw[:4] == b'glTF'
    length, kind = struct.unpack_from('<II', raw, 12)
    assert kind == 0x4E4F534A
    document = json.loads(raw[20:20 + length])
    offset = 20 + length
    length, kind = struct.unpack_from('<II', raw, offset)
    assert kind == 0x004E4942
    return document, raw[offset + 8:offset + 8 + length]


class ImageMaterialTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.paths = {}
        for role, color in [('base_color', (.2, .4, .6, 1)),
                            ('normal', (.5, .5, 1, 1)), ('roughness', (.6, .6, .6, 1))]:
            image = bpy.data.images.new('fixture ' + role, width=4, height=4)
            image.generated_color = color
            path = OUTPUT / (role + '.png')
            image.filepath_raw, image.file_format = str(path), 'PNG'
            image.save()
            bpy.data.images.remove(image)
            cls.paths[role] = path

    def call(self, **changes):
        return author.image_material('Material proof', **(dict(self.paths,
            uv_layer='SurfaceUV', normal_strength=.28, metalness=.13) | changes))

    def test_required_helper_exists(self):
        self.assertTrue(callable(getattr(author, 'image_material', None)),
                        'Missing image_material authoring API')

    def test_invalid_input_leaves_materials_and_images_unchanged(self):
        bad = OUTPUT / 'not-an-image.jpg'
        bad.write_text('not an image', encoding='utf8')
        empty = OUTPUT / 'empty.png'
        empty.write_bytes(b'')
        cases = [dict(base_color=None), dict(normal=OUTPUT / 'missing.jpg'),
                 dict(roughness=OUTPUT), dict(uv_layer=''), dict(uv_layer=None),
                 dict(normal_strength=-.1), dict(normal_strength=2.1),
                 dict(normal_strength=float('nan')), dict(normal_strength=True),
                 dict(metalness=1.1), dict(metalness=float('inf')),
                 dict(base_color=bad), dict(roughness=empty)]
        for changes in cases:
            with self.subTest(changes=changes):
                before = (tuple(bpy.data.materials), tuple(bpy.data.images))
                with self.assertRaises(ValueError):
                    self.call(**changes)
                self.assertEqual(before, (tuple(bpy.data.materials), tuple(bpy.data.images)))
        for missing in ['base_color', 'normal', 'roughness', 'uv_layer', 'normal_strength']:
            values = dict(self.paths, uv_layer='SurfaceUV', normal_strength=.28)
            del values[missing]
            with self.subTest(missing=missing), self.assertRaises(TypeError):
                author.image_material('Missing required role', **values)

    def test_nodes_pack_originals_and_do_not_reconfigure_existing_images(self):
        original_hashes = {k: sha(v) for k, v in self.paths.items()}
        existing = bpy.data.images.load(str(self.paths['normal']), check_existing=False)
        existing.colorspace_settings.name = 'sRGB'
        mat = self.call()
        self.assertEqual(existing.colorspace_settings.name, 'sRGB')
        nodes = mat.node_tree.nodes
        uv = next(n for n in nodes if n.type == 'UVMAP')
        self.assertEqual(uv.uv_map, 'SurfaceUV')
        textures = [n for n in nodes if n.type == 'TEX_IMAGE']
        self.assertEqual(len(textures), 3)
        shader = next(n for n in nodes if n.type == 'BSDF_PRINCIPLED')
        normal = next(n for n in nodes if n.type == 'NORMAL_MAP')
        self.assertEqual(normal.space, 'TANGENT')
        self.assertEqual(normal.uv_map, 'SurfaceUV')
        self.assertAlmostEqual(normal.inputs['Strength'].default_value, .28)
        self.assertAlmostEqual(shader.inputs['Metallic'].default_value, .13)
        role_nodes = {
            'base_color': shader.inputs['Base Color'].links[0].from_node,
            'roughness': shader.inputs['Roughness'].links[0].from_node,
            'normal': normal.inputs['Color'].links[0].from_node,
        }
        self.assertEqual(shader.inputs['Normal'].links[0].from_node, normal)
        for role, node in role_nodes.items():
            self.assertEqual(node.extension, 'REPEAT')
            self.assertEqual(node.inputs['Vector'].links[0].from_node, uv)
            self.assertEqual(node.image.colorspace_settings.name,
                             'sRGB' if role == 'base_color' else 'Non-Color')
            self.assertEqual(Path(node.image.filepath).resolve(), self.paths[role].resolve())
            self.assertIsNotNone(node.image.packed_file)
            self.assertEqual(hashlib.sha256(node.image.packed_file.data).hexdigest(), original_hashes[role])
            self.assertNotEqual(node.image, existing)
        self.assertEqual(original_hashes, {k: sha(v) for k, v in self.paths.items()})

    def test_actual_glb_keeps_named_uv_texture_roles_normal_scale_and_images(self):
        mat = self.call()
        mesh = bpy.data.meshes.new('Proof plane')
        mesh.from_pydata([(0, 0, 0), (1, 0, 0), (1, 1, 0), (0, 1, 0)], [], [(0, 1, 2, 3)])
        for name, coords in [('UnusedUV', [(0, 0)] * 4),
                             ('SurfaceUV', [(.1, .2), (2.1, .2), (2.1, 3.2), (.1, 3.2)])]:
            layer = mesh.uv_layers.new(name=name)
            for item, coordinate in zip(layer.data, coords):
                item.uv = coordinate
        mesh.uv_layers.active_index = 0
        obj = bpy.data.objects.new('Image proof', mesh)
        bpy.context.collection.objects.link(obj)
        mesh.materials.append(mat)
        output = OUTPUT / 'image-material.glb'
        author.export_glb(output, [obj])
        document, binary = glb(output)
        material = document['materials'][0]
        pbr = material['pbrMetallicRoughness']
        slots = [pbr['baseColorTexture'], pbr['metallicRoughnessTexture'], material['normalTexture']]
        self.assertAlmostEqual(material['normalTexture']['scale'], .28, places=6)
        self.assertAlmostEqual(pbr['metallicFactor'], .13, places=6)
        self.assertEqual(pbr.get('baseColorFactor', [1, 1, 1, 1]), [1, 1, 1, 1])
        self.assertEqual([slot.get('texCoord', 0) for slot in slots], [1, 1, 1])
        attributes = document['meshes'][0]['primitives'][0]['attributes']
        accessor = document['accessors'][attributes['TEXCOORD_1']]
        self.assertEqual(accessor['componentType'], 5126)
        self.assertEqual(accessor['type'], 'VEC2')
        uv_view = document['bufferViews'][accessor['bufferView']]
        start = uv_view.get('byteOffset', 0) + accessor.get('byteOffset', 0)
        coords = [struct.unpack_from('<ff', binary, start + i * uv_view.get('byteStride', 8))
                  for i in range(accessor['count'])]
        for actual, expected in zip([min(u for u, v in coords), max(u for u, v in coords),
                                     min(v for u, v in coords), max(v for u, v in coords)],
                                    [.1, 2.1, -2.2, .8]):
            self.assertAlmostEqual(actual, expected, places=6)
        for slot in slots:
            texture = document['textures'][slot['index']]
            sampler = document['samplers'][texture['sampler']]
            self.assertEqual(sampler.get('wrapS', 10497), 10497)
            self.assertEqual(sampler.get('wrapT', 10497), 10497)
            image = document['images'][texture['source']]
            self.assertNotIn('uri', image)
            view = document['bufferViews'][image['bufferView']]
            self.assertGreater(view['byteLength'], 0)
        # The exporter may repack roughness into G. Base color and normals require no conversion.
        for role, slot in [('base_color', slots[0]), ('normal', slots[2])]:
            image = document['images'][document['textures'][slot['index']]['source']]
            view = document['bufferViews'][image['bufferView']]
            start = view.get('byteOffset', 0)
            self.assertEqual(hashlib.sha256(binary[start:start + view['byteLength']]).hexdigest(), sha(self.paths[role]))
        image = document['images'][document['textures'][slots[1]['index']]['source']]
        view = document['bufferViews'][image['bufferView']]
        start = view.get('byteOffset', 0)
        packed_path = OUTPUT / 'exported-roughness.png'
        packed_path.write_bytes(binary[start:start + view['byteLength']])
        packed = bpy.data.images.load(str(packed_path), check_existing=False)
        original = bpy.data.images.load(str(self.paths['roughness']), check_existing=False)
        packed.colorspace_settings.name = original.colorspace_settings.name = 'Non-Color'
        self.assertEqual(tuple(packed.size), tuple(original.size))
        # glTF roughness must be G, not red, blue, gamma converted or the normal image.
        self.assertEqual(list(packed.pixels)[1::4], list(original.pixels)[0::4])
        self.assertEqual(pbr.get('roughnessFactor', 1), 1)

    def test_optional_original_provider_inputs(self):
        if not ASSET_ROOT:
            self.skipTest('No optional provider input directory supplied')
        receipts = []
        for manifest in sorted(ASSET_ROOT.glob('*-manifest.json')):
            data = json.loads(manifest.read_text(encoding='utf8'))
            by_role = {r['channel']: r for r in data['channels']}
            paths = {role: ASSET_ROOT / by_role[channel]['name'] for role, channel in
                     [('base_color', 'Diffuse'), ('normal', 'nor_gl'), ('roughness', 'Rough')]}
            for role, channel in [('base_color', 'Diffuse'), ('normal', 'nor_gl'), ('roughness', 'Rough')]:
                self.assertEqual(sha(paths[role]), by_role[channel]['sha256'])
            mat = self.call(**paths)
            for node in mat.node_tree.nodes:
                if node.type == 'TEX_IMAGE':
                    self.assertEqual(hashlib.sha256(node.image.packed_file.data).hexdigest(), sha(Path(node.image.filepath)))
            receipts.append({'asset': data['asset'], 'sources': {k: sha(v) for k, v in paths.items()}})
        self.assertEqual(len(receipts), 3)
        PROVIDER_RECEIPTS.extend(receipts)


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--output-dir', type=Path, required=True)
    parser.add_argument('--asset-root', type=Path)
    args = parser.parse_args(sys.argv[sys.argv.index('--') + 1:])
    OUTPUT, ASSET_ROOT, PROVIDER_RECEIPTS = args.output_dir, args.asset_root, []
    OUTPUT.mkdir(parents=True, exist_ok=True)
    result = unittest.TextTestRunner(verbosity=2).run(unittest.defaultTestLoader.loadTestsFromTestCase(ImageMaterialTests))
    report = {'ok': result.wasSuccessful(), 'blender': bpy.app.version_string,
              'testsRun': result.testsRun, 'failures': result.failures, 'errors': result.errors,
              'skipped': result.skipped, 'providerInputs': PROVIDER_RECEIPTS}
    (OUTPUT / 'report.json').write_text(json.dumps(report, indent=2, default=str) + '\n', encoding='utf8')
    print('IMAGE_MATERIAL_RESULT ' + json.dumps(report, default=str))
    if not result.wasSuccessful():
        raise SystemExit(1)
