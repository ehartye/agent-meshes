"""Mesh-array validation contracts, runnable without Blender."""
import math
from pathlib import Path
import sys
import unittest

sys.dont_write_bytecode = True
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts' / 'blender_lib'))
from agent_meshes_author import mesh_from_arrays, validate_mesh_arrays

VERTICES = [(0, 0, 0), (2, 0, 0), (0, 3, 0), (0, 0, 4)]
FACES = [(0, 1, 2), (0, 2, 3)]
UVS = [(.1, .2), (.9, .2), (.1, .8), (.3, .4), (.7, .8), (.2, .9)]
COLORS = [(.1, .2, .3, .25), (.3, .4, .5, .5), (.6, .7, .8, .75),
          (.8, .2, .1, 1), (.5, .2, .4, .4), (.2, .8, .6, .6)]


class MeshArrayTests(unittest.TestCase):
    def valid(self, **changes):
        return validate_mesh_arrays(**(dict(vertices=VERTICES, faces=FACES,
            corner_uvs=UVS, colors=COLORS) | changes))

    def test_default_preserves_coordinates_corner_order_and_float_rgba(self):
        data = self.valid()
        self.assertEqual(data['vertices'], VERTICES)
        self.assertEqual(data['faces'], FACES)
        self.assertEqual(data['corner_uvs'], UVS)
        self.assertEqual(data['colors'], COLORS)
        self.assertEqual(data['color_domain'], 'CORNER')
        data['vertices'].append((9, 9, 9))
        self.assertEqual(len(VERTICES), 4, 'validation snapshots caller arrays')

    def test_explicit_top_left_uvs_and_gltf_y_up_transform(self):
        data = self.valid(uv_origin='TOP_LEFT', coordinate_space='GLTF')
        self.assertEqual(data['vertices'], [(x, -z, y) for x, y, z in VERTICES])
        for value, (u, v) in zip(data['corner_uvs'], UVS):
            self.assertEqual(value, (u, 1-v))
        self.assertEqual(data['faces'], FACES, 'a rotation preserves winding')

    def test_point_colors_and_optional_attributes(self):
        self.assertEqual(self.valid(color_domain='POINT', colors=COLORS[:4])['colors'], COLORS[:4])
        data = self.valid(corner_uvs=None, colors=None)
        self.assertIsNone(data['corner_uvs'])
        self.assertIsNone(data['colors'])
        # Tile coordinates are allowed; only origin conversion is applied.
        self.assertEqual(self.valid(corner_uvs=[(-2, 3)] * 6)['corner_uvs'], [(-2, 3)] * 6)

    def test_rejects_invalid_geometry_without_bpy_or_native_side_effects(self):
        cases = [dict(vertices=[]), dict(vertices=[(0, 0)] * 4),
                 dict(vertices=[(0, 0, math.nan)] * 4), dict(vertices=[(0, 0, math.inf)] * 4),
                 dict(vertices=[(0, 0, 1e300)] * 4), dict(vertices=[(True, 0, 0)] * 4),
                 dict(faces=[]), dict(faces=[(0, 1)]), dict(faces=[(0, 1, 1)]),
                 dict(faces=[(0, 1, 4)]), dict(faces=[(0, -1, 2)]),
                 dict(faces=[(0, 1, True)]), dict(faces=[(0, 1, 2.0)]),
                 dict(vertices=None), dict(faces=None), dict(faces=[None])]
        for changes in cases:
            with self.subTest(changes=changes), self.assertRaises(ValueError):
                mesh_from_arrays('Bad array', **(dict(vertices=VERTICES, faces=FACES) | changes))

    def test_rejects_wrong_lengths_shapes_ranges_and_conventions(self):
        cases = [dict(corner_uvs=UVS[:-1]), dict(corner_uvs=[(0, 1, 2)] * 6),
                 dict(corner_uvs=[(0, math.nan)] * 6), dict(corner_uvs=[(0, 1e300)] * 6),
                 dict(colors=COLORS[:-1]), dict(colors=[(0, 0, 0)] * 6),
                 dict(colors=[(0, 0, 0, math.inf)] * 6), dict(colors=[(0, 0, 0, -0.1)] * 6),
                 dict(colors=[(0, 0, 1.1, 1)] * 6), dict(colors=[(0, 0, 0, True)] * 6),
                 dict(colors=COLORS, color_domain='POINT'), dict(color_domain='FACE'),
                 dict(uv_origin='top-left'), dict(coordinate_space='UNREAL')]
        for changes in cases:
            with self.subTest(changes=changes), self.assertRaises(ValueError): self.valid(**changes)

    def test_rejects_bad_names_and_shading_before_importing_bpy(self):
        for changes in [dict(name=''), dict(uv_name=''), dict(color_name=''),
                        dict(uv_name='Shared', color_name='Shared'), dict(smooth=1)]:
            with self.subTest(changes=changes), self.assertRaises(ValueError):
                mesh_from_arrays(**(dict(name='Arrays', vertices=VERTICES,
                    faces=FACES, corner_uvs=UVS, colors=COLORS) | changes))


if __name__ == '__main__': unittest.main()
