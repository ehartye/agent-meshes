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


def surface_y(sdf, x, z, start=-.4):
    """The head field's front surface y at (x, z): marching back from in front of the face."""
    y = start
    while sdf((x, y, z)) > 0: y += .0005
    return y


def surface_x(sdf, y, z):
    """The head field's outermost x at (y, z): marching in from the side."""
    x = .4
    while sdf((x, y, z)) > 0: x -= .0005
    return x


class FaceShape(unittest.TestCase):
    def test_face_shape_is_a_validated_character_parameter_of_the_living_face(self):
        self.assertEqual(character.parameters({})['face_shape'], {})
        values = dict(CAST['adult-male'], face='arkit', face_shape={'beard': 'stubble', 'brow': 1.6})
        self.assertEqual(character.parameters(values)['face_shape'], {'beard': 'stubble', 'brow': 1.6})
        for invalid in [5, 'round', None, ['beard']]:
            with self.assertRaises(ValueError): character.parameters(dict(values, face_shape=invalid))
        # A static face has no living face to shape.
        with self.assertRaises(ValueError): character.parameters(dict(CAST['girl'], face_shape={'nose': 1.2}))
        for invalid in [{'snout': 1}, {'nose': 5}, {'nose': 0}, {'nose': True}, {'nose': 'big'}, {'beard': 'goatee'},
                        {'smile': -.1}, {'jaw_width': float('nan')}, {'beard_color': 'brown'}]:
            with self.assertRaises(ValueError, msg=str(invalid)): face.face_shape_values(dict(values, face_shape=invalid))

    def test_every_shape_has_a_default_and_adult_men_default_to_a_heavier_brow(self):
        for name, values in CAST.items():
            shape = face.face_shape_values(dict(values, face='arkit'))
            self.assertEqual(set(shape), set(face.SHAPE_RANGES) | {'beard', 'beard_color'}, name)
            self.assertEqual(shape['beard'], 'none', name)
        man, woman = face.face_shape_values(dict(CAST['adult-male'], face='arkit')), face.face_shape_values(dict(CAST['adult-female'], face='arkit'))
        self.assertGreater(man['brow'], woman['brow'])
        self.assertGreater(man['jaw_width'], woman['jaw_width'])
        explicit = face.face_shape_values(dict(CAST['adult-male'], face='arkit', face_shape={'brow': .8}))
        self.assertEqual(explicit['brow'], .8)

    def test_adults_have_a_longer_lower_face_and_smaller_eyes_than_children(self):
        adult, child = (face.face_layout(dict(CAST[n], face='arkit')) for n in ('adult-female', 'girl'))
        drop = lambda L: (L['eye_left'][2] - L['mouth_z']) / L['scale']
        self.assertGreater(drop(adult), 1.1 * drop(child))
        self.assertLess(adult['eye_radius'] / adult['scale'], .92 * child['eye_radius'] / child['scale'])
        # The mouth sits well below the eyes (the boards: about 1.3-1.9 times the half spacing of the eyes).
        for L in (adult, child):
            self.assertGreater((L['eye_left'][2] - L['mouth_z']) / L['eye_left'][0], 1.2)

    def test_shape_parameters_move_the_features(self):
        values = dict(CAST['adult-female'], face='arkit')
        base = face.face_layout(values)
        shaped = lambda **shape: face.face_layout(dict(values, face_shape=shape))
        self.assertAlmostEqual(shaped(nose=1.5)['nose_size'][0], 1.5 * base['nose_size'][0])
        self.assertAlmostEqual(shaped(mouth_width=1.2)['mouth_half_width'], 1.2 * base['mouth_half_width'])
        self.assertAlmostEqual(shaped(eye_size=1.1)['eye_radius'], 1.1 * base['eye_radius'])
        self.assertGreater(shaped(brow=2)['brow_height'], 1.5 * base['brow_height'])
        self.assertGreater(shaped(lips=2)['lip_fullness'], 1.5 * base['lip_fullness'])
        self.assertEqual(shaped(beard='beard')['beard'], 'beard')
        self.assertGreater(shaped(smile=1)['resting_smile'], base['resting_smile'])
        k = base['scale']
        # jaw_width widens the lower face at the jaw; cheeks fill the face out in front of the cheekbones.
        jaw_z = (base['mouth_z'] + base['chin_z']) / 2
        wide, narrow = (face.head_field(shaped(jaw_width=w)) for w in (1.3, .8))
        self.assertGreater(surface_x(wide, -.03 * k, jaw_z), surface_x(narrow, -.03 * k, jaw_z) + .006 * k)
        full, flat = (face.head_field(shaped(cheeks=c)) for c in (2, .3))
        cx, _, cz = base['cheek'][0]
        self.assertLess(surface_y(full, cx, cz), surface_y(flat, cx, cz) - .003 * k)
        # Bigger eyes push the brows up, clear of the upper lid's reach.
        big = face.face_layout(dict(CAST['girl'], face='arkit', face_shape={'eye_size': 1.2}))
        for brow in (big['brow_inner'], big['brow_outer']):
            self.assertGreaterEqual(brow[1], big['eye_left'][2] + 1.45 * big['eye_radius'] - 1e-9)
        # A longer chin reaches lower.
        self.assertLess(shaped(chin=1.3)['chin_z'], base['chin_z'] - .005 * k)

    def test_a_beard_covers_the_jaw_chin_and_upper_lip_but_not_the_lips_eyes_or_neck(self):
        L = face.face_layout(dict(CAST['adult-male'], face='arkit', face_shape={'beard': 'beard'}))
        sdf, k = face.head_field(L), L['scale']
        mouth_z, hw = L['mouth_z'], L['mouth_half_width']
        at = lambda x, z: face.beard_weight((x, surface_y(sdf, x, z), z), L, surface_y(sdf, x, z))
        chin = (L['mouth_z'] + L['chin_z']) / 2
        self.assertGreater(at(0, chin), .9)                                  # chin
        self.assertGreater(at(1.8 * hw, mouth_z - .01 * k), .9)              # jaw beside the mouth
        self.assertGreater(at(.6 * hw, mouth_z + .007 * k), .5)              # moustache
        self.assertLess(at(0, mouth_z), .05)                                 # the lips stay bare
        self.assertEqual(at(L['eye_left'][0], L['eye_left'][2]), 0)          # no beard on the eyes
        self.assertEqual(at(0, L['brow_inner'][1]), 0)
        # Behind the jaw, down the neck, is not beard.
        self.assertEqual(face.beard_weight((0, L['center'][1] + .05 * k, chin), L, 0.0), 0)

    def test_the_face_is_flat_across_the_eyes_with_no_ridge_standing_out_between_them(self):
        for name, values in CAST.items():
            L = face.face_layout(dict(values, face='arkit'))
            sdf, k = face.head_field(L), L['scale']
            ex, _, ez = L['eye_left']
            bridge, beside = surface_y(sdf, 0, ez), surface_y(sdf, ex, ez)
            # The bridge may stand a little proud of the skin over the eyes, but not a centimetre (the V-ridge).
            self.assertGreater(bridge, beside - .0045 * k, name)
            # And the eye's front sits near the skin: the lids wrap it with no mound.
            self.assertLess(abs((L['eye_left'][1] - L['eye_radius']) - beside), .25 * L['eye_radius'], name)


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

    def test_the_face_module_shadows_no_name_of_the_recipes_it_is_embedded_after(self):
        import ast
        recipe = Path(__file__).resolve().parents[1] / 'recipes'

        def top_level(module):
            names = set()
            for node in ast.parse((recipe / module).read_text()).body:
                if isinstance(node, (ast.FunctionDef, ast.ClassDef)): names.add(node.name)
                elif isinstance(node, ast.Assign):
                    names |= {n.id for target in node.targets for n in ast.walk(target) if isinstance(n, ast.Name)}
            return names
        shared = top_level('stylized_face.py') & (top_level('stylized_character.py') | top_level('stylized_walk.py'))
        self.assertEqual(shared, set())

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
