"""Living-face layout contract for the stylized character recipe (no Blender required).

Blender coordinates: Z up, meters, the face looks down -Y, the character's left is +X.
"""
import math
from pathlib import Path
import sys
import unittest
sys.dont_write_bytecode = True
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'recipes'))
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts' / 'blender_lib'))

import stylized_character as character
import stylized_face as face

CAST = {
    'adult-female': {'height': 1.82, 'age': 'adult', 'presentation': 'female'},
    'adult-male': {'height': 1.88, 'age': 'adult', 'presentation': 'male'},
    'girl': {'height': 1.22, 'age': 'child', 'presentation': 'female'},
    'boy': {'height': 1.19, 'age': 'child', 'presentation': 'male'},
}
FEATURES = ['face', 'left-eye-white', 'left-iris', 'left-upper-eyelid', 'left-lash', 'left-brow', 'mouth-line', 'upper-lip',
            'lower-lip', 'left-nostril']


def inside_head(point, d, slack=0.0):
    """Within the head's ellipsoid envelope (rx wide, rz deep, ry tall) around (0, 0, head_y)."""
    x, y, z = point
    return (x / d['rx']) ** 2 + (y / d['rz']) ** 2 + ((z - d['head_y']) / d['ry']) ** 2 <= (1 + slack) ** 2


class FaceParameters(unittest.TestCase):
    def test_face_is_a_validated_parameter_with_the_static_study_face_as_default(self):
        self.assertEqual(character.parameters({})['face'], 'static')
        self.assertEqual(character.parameters({'face': 'arkit'})['face'], 'arkit')
        for invalid in [{'face': 'rigged'}, {'face': True}, {'face': 'arkit', 'species': 'alien'}]:
            with self.assertRaises(ValueError): character.parameters(invalid)

    def test_a_living_face_leaves_its_features_to_the_face_rig_and_keeps_hair_and_ears(self):
        for name, values in CAST.items():
            static = {p['name'] for p in character.geometry(values)}
            living = {p['name'] for p in character.geometry(dict(values, face='arkit'))}
            for feature in FEATURES:
                self.assertIn(feature, static, name)
                self.assertNotIn(feature, living, name)
            for kept in ['hair-cap', 'left-ear', 'right-ear-helix', 'swept-hair-lock-0', 'neck', 'left-boot']:
                self.assertIn(kept, living, name)
            self.assertEqual(static - living, {n for n in static if n not in living})

    def test_a_suit_carries_the_living_head_and_hair_inside_its_helmet(self):
        for name, values in CAST.items():
            parts = {p['name'] for p in character.geometry(dict(values, face='arkit', vacuum=True))}
            self.assertIn('helmet-shell', parts, name)
            self.assertIn('hair-cap', parts, name)
            self.assertIn('left-ear', parts, name)
            self.assertNotIn('face', parts, name)
            # The static suit is unchanged: no head inside.
            self.assertNotIn('hair-cap', {p['name'] for p in character.geometry(dict(values, vacuum=True))})


class FaceLayout(unittest.TestCase):
    def test_features_sit_on_the_front_of_the_head_in_order_and_mirror(self):
        for name, values in CAST.items():
            d = character.landmarks(values)
            layout = face.face_layout(dict(values, face='arkit'))
            left, right = layout['eye_left'], layout['eye_right']
            self.assertEqual(right, (-left[0], left[1], left[2]), name)
            self.assertGreater(left[0], 0, name)
            self.assertLess(left[1], -.5 * d['rz'], name)      # forward (-Y), in the front half of the head
            self.assertTrue(inside_head(left, d), name)
            self.assertTrue(layout['mouth_z'] < layout['nose'][1] < left[2] < layout['brow_inner'][1], name)
            self.assertLess(layout['brow_inner'][0], layout['brow_outer'][0], name)
            self.assertGreater(layout['mouth_half_width'], layout['nose_size'][0], name)
            self.assertLess(layout['mouth_half_width'], left[0], name)
            self.assertAlmostEqual(layout['center'][2], d['head_y'], places=9)
            self.assertGreater(layout['eye_radius'], 0, name)
            self.assertLess(layout['eye_radius'], .8 * left[0], name)  # a bridge of skin between the eyes

    def test_the_face_scales_with_the_head_and_children_have_larger_eyes(self):
        adult = face.face_layout(CAST['adult-female'])
        girl = face.face_layout(CAST['girl'])
        da, dg = character.landmarks(CAST['adult-female']), character.landmarks(CAST['girl'])
        self.assertAlmostEqual(adult['scale'], da['ry'] / face.CANONICAL_HALF_HEIGHT, places=9)
        self.assertGreater(girl['eye_radius'] / dg['ry'], adult['eye_radius'] / da['ry'])
        male = face.face_layout(CAST['adult-male'])
        self.assertGreater(male['nose_size'][0] / male['scale'], adult['nose_size'][0] / adult['scale'])

    def test_the_head_field_is_inside_at_the_center_and_outside_past_the_hair_envelope(self):
        for name, values in CAST.items():
            d = character.landmarks(values)
            layout = face.face_layout(values)
            sdf = face.head_field(layout)
            self.assertLess(sdf((0, 0, d['head_y'])), 0, name)
            # The cranium is the head envelope the hair cap is fitted to: its crown and back are on it.
            self.assertAlmostEqual(sdf((0, 0, d['head_y'] + d['ry'])), 0, delta=.002 * layout['scale'])
            self.assertAlmostEqual(sdf((0, d['rz'], d['head_y'])), 0, delta=.002 * layout['scale'])
            for point in [(d['rx'] * 1.2, 0, d['head_y']), (0, 0, d['head_y'] + d['ry'] * 1.1), (0, -d['rz'] * 1.5, d['head_y'])]:
                self.assertGreater(sdf(point), 0, name)
            # Each eye's center is inside the field: the eye hole opens the skin in front of it.
            self.assertLess(sdf(layout['eye_left']), 0, name)

    def test_the_embedded_recipe_needs_no_sibling_module(self):
        from unittest.mock import patch
        recipe = Path(__file__).resolve().parents[1] / 'recipes'
        namespace = {}
        for module in ['stylized_character.py', 'stylized_walk.py', 'stylized_face.py']:
            exec((recipe / module).read_text(), namespace)
        original_import = __import__
        def import_without_sibling(name, *args, **kwargs):
            if name.startswith('stylized_'): raise ModuleNotFoundError(name)
            return original_import(name, *args, **kwargs)
        with patch('builtins.__import__', side_effect=import_without_sibling):
            self.assertIn('eye_left', namespace['face_layout'](CAST['girl']))


if __name__ == '__main__': unittest.main()
