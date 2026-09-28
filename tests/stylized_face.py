"""Living-face contract for the stylized character recipe on the hm08 head (numpy; Blender not required).

Blender coordinates: Z up, meters, the face looks down -Y, the character's left is +X.
"""
import math
from pathlib import Path
import sys
import unittest
sys.dont_write_bytecode = True
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'recipes'))
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts' / 'blender_lib'))

import numpy as np

import agent_meshes_hm08 as hm
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


def shape_marks(values):
    """The hm08 head a character's spec shapes (before the envelope fit), in meters, and its landmarks."""
    spec = face.head_spec(dict(values, face='arkit'))
    head = hm.load_head()
    V = hm.to_blender(hm.head_shape(spec['years'], spec['gender'], spec['stylize'], spec['shape']))
    return V, hm.face_landmarks(V, head.kind_faces('body'), hm.hm08_eyes(head, V))


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
            for kept in ['hair-cap', 'left-ear', 'swept-hair-lock-0', 'neck', 'left-boot']:
                self.assertIn(kept, living, name)


class FaceShape(unittest.TestCase):
    def test_face_shape_is_a_validated_character_parameter_of_the_living_face(self):
        values = dict(CAST['adult-male'], face='arkit', face_shape={'beard': 'stubble', 'brow': 1.6})
        self.assertEqual(character.parameters(values)['face_shape'], {'beard': 'stubble', 'brow': 1.6})
        with self.assertRaises(ValueError): character.parameters(dict(CAST['girl'], face_shape={'nose': 1.2}))
        for invalid in [{'snout': 1}, {'nose': 5}, {'nose': 0}, {'nose': True}, {'nose': 'big'}, {'beard': 'goatee'},
                        {'smile': -.1}, {'jaw_width': float('nan')}, {'beard_color': 'brown'}, {'years': 90}, {'eye_tilt': 2}]:
            with self.assertRaises(ValueError, msg=str(invalid)): face.face_shape_values(dict(values, face_shape=invalid))

    def test_every_shape_has_a_default_and_children_are_children(self):
        for name, values in CAST.items():
            shape = face.face_shape_values(dict(values, face='arkit'))
            self.assertEqual(set(shape), set(face.SHAPE_RANGES) | {'beard', 'beard_color'}, name)
            self.assertEqual(shape['beard'], 'none', name)
            self.assertEqual(shape['years'] < 12, values['age'] == 'child', name)
        man, woman = (face.face_shape_values(dict(CAST[n], face='arkit')) for n in ('adult-male', 'adult-female'))
        self.assertGreater(man['brow'], woman['brow'])
        self.assertGreater(man['jaw_width'], woman['jaw_width'])

    def test_every_head_control_reaches_hm08_targets(self):
        for key in face.HEAD_FEATURES:
            low, high = face.SHAPE_RANGES[key]
            for value in (low, high):
                self.assertTrue(hm.feature_weights({key: value}) or value == face.NEUTRAL.get(key, 1.0), key)

    def test_shape_parameters_move_the_features_measurably(self):
        base = dict(CAST['adult-female'])
        _, rest = shape_marks(base)

        def marks(**shape): return shape_marks(dict(base, face_shape=shape))[1]
        width = lambda m, a, b: m[a][0] - m[b][0]
        iod = width(rest, 'eye_center_L', 'eye_center_R')
        eye_area = lambda m: width(m, 'eye_outer_L', 'eye_inner_L') * (m['eye_upper_L'][2] - m['eye_lower_L'][2])
        self.assertGreater(eye_area(marks(eye_size=1.25)), 1.06 * eye_area(rest))
        self.assertGreater(width(marks(eye_spacing=1.15), 'eye_center_L', 'eye_center_R'), iod + .002)
        self.assertLess(marks(nose_length=1.5)['subnasale'][2], rest['subnasale'][2] - .0005)
        self.assertLess(marks(nose_bridge=1.6)['nose_tip'][1], rest['nose_tip'][1] - .0005)
        self.assertGreater(width(marks(mouth_width=1.35), 'mouth_corner_L', 'mouth_corner_R'), width(rest, 'mouth_corner_L', 'mouth_corner_R') + .001)
        self.assertLess(marks(chin=1.4)['menton'][2], rest['menton'][2] - .001)
        self.assertGreater(width(marks(jaw_width=1.4), 'jaw_L', 'jaw_R'), width(rest, 'jaw_L', 'jaw_R') + .001)
        self.assertGreater(width(marks(cheeks=2.5), 'cheek_L', 'cheek_R'), width(rest, 'cheek_L', 'cheek_R') + .0005)
        full = marks(lips=2.5)   # fuller lips pout: both lips come forward
        self.assertLess(full['upper_lip'][1] + full['lower_lip'][1], rest['upper_lip'][1] + rest['lower_lip'][1] - .002)

    def test_children_have_larger_eyes_and_shorter_lower_faces_than_adults(self):
        def proportions(values):
            _, m = shape_marks(values)
            height = m['crown'][2] - m['menton'][2]
            eye = m['eye_outer_L'][0] - m['eye_inner_L'][0]
            return eye / height, (m['nasion'][2] - m['menton'][2]) / height
        adult, girl = proportions(CAST['adult-female']), proportions(CAST['girl'])
        self.assertGreater(girl[0], adult[0])
        self.assertLess(girl[1], adult[1])


class HeadSpec(unittest.TestCase):
    def test_the_spec_fits_the_character_envelope_and_crops_under_the_chin(self):
        for name, values in CAST.items():
            d = character.landmarks(values)
            spec = face.head_spec(dict(values, face='arkit'))
            self.assertEqual(spec['center'], (0.0, 0.0, d['head_y']), name)
            self.assertEqual(spec['radii'], (d['rx'], d['rz'], d['ry']), name)
            self.assertEqual(spec['neck_z'], 'chin', name)
            self.assertEqual(spec['gender'], 1.0 if values['presentation'] == 'male' else 0.0, name)


class NeckRidesTheHead(unittest.TestCase):
    def test_the_neck_inside_the_head_rides_the_head_and_its_base_the_spine(self):
        for name, values in CAST.items():
            d = character.landmarks(values)
            bottom, top = d['shoulder_y'] + .02 * d['s'], d['head_y'] - .55 * d['ry']
            share = lambda z: face.neck_head_share(z, d)
            self.assertEqual(share(bottom), 0.0, name)
            self.assertEqual(share(top), 1.0, name)
            steps = [share(bottom + (top - bottom) * i / 20) for i in range(21)]
            self.assertEqual(steps, sorted(steps), name)


class LivingFace(unittest.TestCase):
    """One adult's built face: its morphs keep the skin smooth and do what the board's faces do."""

    @classmethod
    def setUpClass(cls):
        cls.layout = face.face_layout(dict(CAST['adult-female'], face='arkit'))
        cls.face = cls.layout['face']
        cls.V, cls.F, cls.M = cls.face['vertices'], cls.face['faces'], cls.face['morphs']
        cls.marks = cls.face['landmarks']
        cls.T = cls.F[:, :3]

    def pose(self, **weights):
        return self.V + sum(w * (self.M[n] - self.V) for n, w in weights.items())

    def normals(self, P):
        n = np.cross(P[self.T[:, 1]] - P[self.T[:, 0]], P[self.T[:, 2]] - P[self.T[:, 0]])
        return n / np.maximum(np.linalg.norm(n, axis=1, keepdims=True), 1e-20)

    def region(self, name):
        """Triangles over the nose bridge (between the eyes) or under the left eye."""
        m, V = self.marks, self.V
        c = V[self.T].mean(axis=1)
        (eye, r), _ = self.face['eyes']
        if name == 'bridge':
            return (np.abs(c[:, 0]) < .35 * (m['eye_center_L'][0] - m['eye_center_R'][0])) & \
                (c[:, 2] < m['nasion'][2] + .5 * r) & (c[:, 2] > m['nose_tip'][2] + .3 * r) & (c[:, 1] < m['nasion'][1] + .2 * r)
        below = (c[:, 2] < m['eye_lower_L'][2] - .1 * r) & (c[:, 2] > m['eye_lower_L'][2] - .9 * r)
        return below & (np.abs(c[:, 0] - eye[0]) < .7 * r) & (c[:, 1] < eye[1])

    def turn(self, P, region):
        """The largest angle (degrees) between neighbouring triangles' normals in a region: a ripple or a pocket turns
        the surface hard over a few millimetres."""
        n = self.normals(P)
        pairs = {}
        for k, t in enumerate(self.T):
            if not region[k]: continue
            for a, b in ((t[0], t[1]), (t[1], t[2]), (t[2], t[0])): pairs.setdefault((min(a, b), max(a, b)), []).append(k)
        worst = 0.0
        for ks in pairs.values():
            if len(ks) == 2: worst = max(worst, math.degrees(math.acos(max(-1.0, min(1.0, float(n[ks[0]] @ n[ks[1]]))))))
        return worst

    def test_the_bridge_and_under_eye_stay_smooth_at_rest_and_in_every_state(self):
        states = {'rest': {}, 'blink .5': {'eyeBlinkLeft': .5}, 'blink': {'eyeBlinkLeft': 1}, 'squint': {'eyeSquintLeft': 1},
                  'smile': {'mouthSmileLeft': 1, 'mouthSmileRight': 1}, 'jaw': {'jawOpen': 1}}
        for where in ('bridge', 'under-eye'):
            region = self.region(where)
            self.assertGreater(region.sum(), 20, where)
            rest = self.turn(self.V, region)
            self.assertLess(rest, 45, where)   # hm08's own lid and nasal folds; round 2's pockets turned 90
            for label, weights in states.items():
                self.assertLess(self.turn(self.pose(**weights), region), rest + 12, f'{where} at {label}')

    def test_the_bridge_profile_has_no_terraces(self):
        m, V = self.marks, self.V
        box = (-.003, .003, m['nose_tip'][2], m['nasion'][2] + .01)
        D = hm.depth_map(V, self.F, box, .0003)
        profile = np.where(np.isfinite(D), D, np.nan)[:, D.shape[1] // 2]
        profile = profile[np.isfinite(profile)]
        slope = np.diff(profile)
        turns = np.sum(np.diff(np.sign(np.round(slope, 6))) != 0)
        self.assertLessEqual(turns, 3)

    def test_blink_and_squint_keep_the_under_eye_full(self):
        (eye, r), _ = self.face['eyes']
        region = self.region('under-eye')
        verts = np.unique(self.T[region])
        for label, weights in (('blink', {'eyeBlinkLeft': 1}), ('squint', {'eyeSquintLeft': 1})):
            P = self.pose(**weights)
            inward = np.linalg.norm(self.V[verts] - eye, axis=1) - np.linalg.norm(P[verts] - eye, axis=1)
            self.assertLess(inward.max(), .0003, label)

    def test_a_full_blink_closes_the_eye_and_no_morph_turns_a_face_over(self):
        for (eye, r), side in zip(self.face['eyes'], ('Left', 'Right')):
            self.assertEqual(hm.eyeball_shows(self.M[f'eyeBlink{side}'], self.F, eye, r), 0, side)
            self.assertGreater(hm.eyeball_shows(self.V, self.F, eye, r), 100, side)
        for name, target in self.M.items():
            self.assertEqual(len(hm.flipped(self.V, target, self.F)), 0, name)

    def test_the_open_jaw_parts_the_lips_in_a_rounded_d_and_drops_the_chin(self):
        m, J = self.marks, self.M['jawOpen']
        drop = self.V[:, 2] - J[:, 2]
        hw = abs(m['mouth_corner_L'][0])
        lower = (self.V[:, 2] < m['stomion'][2]) & (self.V[:, 2] > m['stomion'][2] - .006 * self.layout['scale']) & \
            (self.V[:, 1] < m['stomion'][1] + .004 * self.layout['scale'])
        at = lambda x: drop[lower & (np.abs(self.V[:, 0] - x) < .12 * hw)].max()
        self.assertGreater(at(.5 * hw), .8 * at(0.0))        # no V: half way to the corner it has nearly all the drop
        menton = int(np.argmin(np.linalg.norm(self.V - m['menton'], axis=1)))
        self.assertGreater(self.V[menton, 2] - J[menton, 2], .08 * (m['crown'][2] - m['menton'][2]))
        # The chin's outline at the open jaw stays round: its lowest points across the chin are level, not a point.
        chin = J[np.abs(J[:, 0]) < .6 * hw]
        side = J[(np.abs(J[:, 0]) > .5 * hw) & (np.abs(J[:, 0]) < .7 * hw)]
        self.assertLess(side[:, 2].min() - chin[:, 2].min(), .12 * (m['stomion'][2] - m['menton'][2]))

    def test_the_smile_lifts_the_corners_with_the_lips_closed(self):
        m = self.marks
        corner = int(np.argmin(np.linalg.norm(self.V - m['mouth_corner_L'], axis=1)))
        P = self.pose(mouthSmileLeft=1)
        self.assertGreater(P[corner, 2] - self.V[corner, 2], .002)
        # The lips stay together in the middle: the seam between the upper and lower lip does not open.
        mid = np.abs(self.V[:, 0]) < .003
        near = mid & (np.abs(self.V[:, 2] - m['stomion'][2]) < .003) & (self.V[:, 1] < m['stomion'][1] + .003)
        up, low = near & (self.V[:, 2] >= m['stomion'][2]), near & (self.V[:, 2] < m['stomion'][2])
        gap = lambda Q: Q[up, 2].min() - Q[low, 2].max()
        self.assertLess(gap(P), gap(self.V) + .0005)


class Beard(unittest.TestCase):
    def test_a_beard_covers_the_jaw_and_chin_but_not_the_lips_eyes_or_forehead(self):
        L = face.face_layout(dict(CAST['adult-female'], face='arkit'))
        m, k = L['landmarks'], L['scale']
        w = lambda p: face.beard_weight(p, m, k)
        self.assertGreater(w(m['pogonion']), .9)
        self.assertEqual(w(m['stomion']), 0.0)
        self.assertEqual(w(m['eye_center_L']), 0.0)
        self.assertEqual(w(m['nasion']), 0.0)
        shell = face.beard_shell(L['face'], k)
        self.assertIsNotNone(shell)
        self.assertIn('jawOpen', shell['morphs'])


class Embedding(unittest.TestCase):
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
            self.assertIn('neck_z', namespace['head_spec'](dict(CAST['girl'], face='arkit')))


if __name__ == '__main__': unittest.main()
