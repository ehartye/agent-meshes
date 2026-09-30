"""The vendored hm08 head, its targets, the stylize target and the landmark tools (numpy; Blender not required).

Blender frame: Z up, meters, the face looks down -Y, the character's left is +X.
"""
from pathlib import Path
import sys
import tempfile
import unittest

sys.dont_write_bytecode = True
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts' / 'blender_lib'))
import numpy as np

import agent_meshes_hm08 as hm
from agent_meshes_face import ARKIT_REQUIRED

ARKIT_52 = ('browDownLeft browDownRight browInnerUp browOuterUpLeft browOuterUpRight cheekPuff cheekSquintLeft cheekSquintRight '
            'eyeBlinkLeft eyeBlinkRight eyeLookDownLeft eyeLookDownRight eyeLookInLeft eyeLookInRight eyeLookOutLeft eyeLookOutRight '
            'eyeLookUpLeft eyeLookUpRight eyeSquintLeft eyeSquintRight eyeWideLeft eyeWideRight jawForward jawLeft jawOpen jawRight '
            'mouthClose mouthDimpleLeft mouthDimpleRight mouthFrownLeft mouthFrownRight mouthFunnel mouthLeft mouthLowerDownLeft '
            'mouthLowerDownRight mouthPressLeft mouthPressRight mouthPucker mouthRight mouthRollLower mouthRollUpper mouthShrugLower '
            'mouthShrugUpper mouthSmileLeft mouthSmileRight mouthStretchLeft mouthStretchRight mouthUpperUpLeft mouthUpperUpRight '
            'noseSneerLeft noseSneerRight tongueOut').split()


def eye_area(landmarks, side):
    """The eye opening's area, roughly: width times height at the middle."""
    width = abs(landmarks[f'eye_outer_{side}'][0] - landmarks[f'eye_inner_{side}'][0])
    return width * (landmarks[f'eye_upper_{side}'][2] - landmarks[f'eye_lower_{side}'][2])


class Data(unittest.TestCase):
    def test_the_head_is_hm08s_quad_head_with_its_helpers_joints_and_mirror(self):
        head = hm.load_head()
        self.assertEqual(len(head.kind_vertices('body')), 4328)
        self.assertTrue((head.kind_faces('body')[:, 3] >= 0).all(), 'the skin is all quads')
        for kind in hm.KINDS[1:]: self.assertGreater(len(head.kind_vertices(kind)), 20, kind)
        for joint in ('neck', 'head', 'jaw', 'l-eye', 'r-eye'): self.assertIn(joint, head.joints)
        # The mirror table pairs left and right: x flips, y and z agree.
        pairs = np.nonzero(head.mirror >= 0)[0]
        self.assertGreater(len(pairs), 4000)
        a, b = head.rest[pairs], head.rest[head.mirror[pairs]]
        self.assertLess(np.abs(a[:, 0] + b[:, 0]).max(), 1e-3)
        self.assertLess(np.abs(a[:, 1:] - b[:, 1:]).max(), 1e-3)

    def test_the_arkit_face_units_and_macros_are_vendored(self):
        head = hm.load_head()
        for name in ARKIT_52: self.assertIn(f'faceunits/{name}', head.targets, name)
        for name in ARKIT_REQUIRED: self.assertGreater(np.abs(head.dense(f'faceunits/{name}')).max(), 0, name)
        for race in hm.RACES:
            for sex in ('female', 'male'):
                for age in ('baby', 'child', 'young'): self.assertIn(f'macrodetails/{race}-{sex}-{age}', head.targets)

    def test_macro_weights_blend_age_gender_and_race(self):
        self.assertAlmostEqual(hm.age_parameter(1), 0)
        self.assertAlmostEqual(hm.age_parameter(11), .1875)
        self.assertAlmostEqual(hm.age_parameter(25), .5)
        for years, gender in ((6, 0), (10, 1), (30, .5)):
            self.assertAlmostEqual(sum(hm.macro_weights(years, gender).values()), 1.0)
        self.assertEqual({k.split('-')[-1] for k in hm.macro_weights(25, 0)}, {'young'})
        self.assertEqual({k.split('-')[1] for k in hm.macro_weights(25, 1)}, {'male'})
        with self.assertRaises(ValueError): hm.macro_weights(20, 1.5)

    def test_a_target_file_round_trips(self):
        head = hm.load_head()
        deltas = head.dense('faceunits/jawOpen')
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / 'x.target'
            hm.write_target(path, head, deltas, ['test'])
            index, delta = hm.read_target(path)
        dense = np.zeros_like(head.rest); dense[index] = delta
        self.assertLess(np.abs(dense - deltas).max(), 6e-4)


class Landmarks(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.head = hm.load_head()
        cls.base = hm.to_blender(cls.head.rest)
        cls.marks = hm.face_landmarks(cls.base, cls.head.kind_faces('body'), hm.hm08_eyes(cls.head, cls.base))

    def test_the_profile_reads_down_the_face_in_order(self):
        z = lambda k: self.marks[k][2]
        order = ['nasion', 'nose_tip', 'subnasale', 'upper_lip', 'stomion', 'lower_lip', 'sulcus', 'pogonion', 'menton']
        for a, b in zip(order, order[1:]): self.assertGreater(z(a), z(b), f'{a} above {b}')
        self.assertLess(self.marks['nose_tip'][1], self.marks['nasion'][1], 'the nose tip stands in front of the nasion')

    def test_eyes_and_mouth_corners_mirror(self):
        for a, b in (('eye_outer_L', 'eye_outer_R'), ('eye_inner_L', 'eye_inner_R'), ('mouth_corner_L', 'mouth_corner_R')):
            pa, pb = self.marks[a], self.marks[b]
            self.assertLess(abs(pa[0] + pb[0]), .002, a)
            self.assertLess(abs(pa[2] - pb[2]), .002, a)
        self.assertGreater(self.marks['eye_outer_L'][0], self.marks['eye_inner_L'][0])
        self.assertGreater(self.marks['eye_inner_L'][0], 0)
        self.assertGreater(eye_area(self.marks, 'L'), 1e-4)


class Stylize(unittest.TestCase):
    def test_the_stylize_target_gives_bigger_eyes_and_a_shorter_lower_face(self):
        head = hm.load_head()
        index, delta = hm.read_target(hm.DATA / 'stylize01.target')
        stylized = head.rest.copy(); stylized[index] += delta
        faces = head.kind_faces('body')
        measure = {}
        for name, shape in (('base', head.rest), ('stylized', stylized)):
            V = hm.to_blender(shape)
            marks = hm.face_landmarks(V, faces, hm.hm08_eyes(head, V))
            iod = marks['eye_center_L'][0] - marks['eye_center_R'][0]
            measure[name] = dict(eye=eye_area(marks, 'L') / iod ** 2, chin=(marks['stomion'][2] - marks['menton'][2]) / iod)
        self.assertGreater(measure['stylized']['eye'], 2 * measure['base']['eye'])
        self.assertLess(measure['stylized']['chin'], measure['base']['chin'])


if __name__ == '__main__':
    unittest.main()
