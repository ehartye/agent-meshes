"""Eye protection follows constructed lids instead of suppressing the cheek."""
import copy
import math
from pathlib import Path
import sys
import unittest

sys.dont_write_bytecode = True
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts/blender_lib'))
from agent_meshes_face import eye_hole_mask, ellipsoid_geometry
from agent_meshes_author import oriented_eye_hole


class GeometryEyeMask(unittest.TestCase):
    def fixture(self):
        # Separate real construction channels exercise motion, lining and rim.
        return {'motion': [((0, 0, 0), {})], 'lining_points': [(0, .02, 0)],
                'vertices': [(0, 0, .02)], 'rim': [0],
                'still': lambda p: 90, 'window': {'level': lambda p: 90},
                'lids': {'center': (0, 0, 0), 'eye_radius': .058}, 'mound': .084465}

    def mask(self, *holes, spatial=(.002, .035), **kwargs):
        # Fail as an assertion on the missing feature, not an accidental TypeError.
        import inspect
        self.assertIn('spatial', inspect.signature(eye_hole_mask).parameters)
        return eye_hole_mask(*holes, spatial=spatial, **kwargs)

    def test_protects_all_geometry_channels_and_releases_nearby_skin(self):
        hole = self.fixture()
        mask = self.mask(hole)
        for p in [(0, 0, 0), (0, .02, 0), (0, 0, .02), (.002, 0, 0)]:
            self.assertEqual(mask(p), 0)
        self.assertEqual(mask((.04, 0, 0)), 1)
        self.assertEqual(eye_hole_mask(hole)((.04, 0, 0)), 0)

    def test_smooth_distance_transition_and_union_of_eyes(self):
        hole = self.fixture()
        other = copy.deepcopy(hole)
        other['motion'] = [((.09, 0, 0), {})]
        other['lining_points'] = [(.09, .02, 0)]
        other['vertices'] = [(.09, 0, .02)]
        mask = self.mask(hole, other)
        for t in [0, .1, .25, .5, .75, .9, 1]:
            distance = .002 + .033*t
            self.assertAlmostEqual(mask((distance, 0, 0)), t*t*(3-2*t), places=12)
        self.assertEqual(mask((.09, 0, 0)), 0)
        self.assertEqual(mask((.045, 0, 0)), 1)

    def test_snapshot_does_not_mutate_or_depend_on_later_input_edits(self):
        hole = self.fixture()
        before = copy.deepcopy(hole)
        mask = self.mask(hole)
        self.assertEqual(hole, before)
        hole['motion'].clear()
        self.assertEqual(mask((0, 0, 0)), 0)
        self.assertEqual(mask([.04, 0, 0]), 1)

    def test_validates_distance_and_construction_data(self):
        for value in [(-.001, .035), (.035, .035), (.04, .035), (0, 0), (False, .035),
                      (0, float('nan')), (0, float('inf')), (0,), 'near']:
            with self.subTest(value=value), self.assertRaises(ValueError):
                self.mask(self.fixture(), spatial=value)
        with self.assertRaises(ValueError):
            self.mask(self.fixture(), band=20)
        for field in ['motion', 'lining_points', 'rim']:
            hole = self.fixture(); hole[field] = []
            with self.subTest(field=field), self.assertRaises(ValueError): self.mask(hole)
        hole = self.fixture(); hole['lining_points'] = [(0, float('nan'), 0)]
        with self.assertRaises(ValueError): self.mask(hole)

    def test_actual_oriented_continuous_eye_is_fully_protected(self):
        blank = ellipsoid_geometry((-.045, .052, -.062), (.11, .085, .10), rings=56, segments=72)
        hole = oriented_eye_hole(blank['vertices'], blank['faces'], (0,0,0), .02,
                                 opening=(48,36,28))
        mask = self.mask(hole, spatial=(.001, .01))
        points = [p for p,_ in hole['motion']] + hole['lining_points'] + [hole['vertices'][i] for i in hole['rim']]
        self.assertGreater(len(points), 100)
        self.assertTrue(all(mask(p) == 0 for p in points))
        # Rotate/translate/scale construction coordinates and distances together.
        transform = lambda p: (3*p[2]+.4, 3*p[0]-.7, 3*p[1]+1.2)
        changed = dict(hole, motion=[(transform(p), targets) for p,targets in hole['motion']],
                       lining_points=[transform(p) for p in hole['lining_points']],
                       vertices=[transform(p) for p in hole['vertices']])
        moved = self.mask(changed, spatial=(.003, .03))
        for p in points[::17] + [(x/1000, -.025, -.04) for x in range(-40, 41, 4)]:
            self.assertAlmostEqual(mask(p), moved(transform(p)), places=11)

    def test_matches_direct_distance_on_irregular_points(self):
        import random
        rng = random.Random(84)
        points = [tuple(rng.uniform(-.1, .1) for _ in range(3)) for _ in range(127)]
        hole = self.fixture()
        hole['motion'] = [(p, {}) for p in points]
        hole['lining_points'] = points[:3]
        hole['vertices'] = points[:3]
        mask = self.mask(hole)
        for _ in range(200):
            p = tuple(rng.uniform(-.15, .15) for _ in range(3))
            t = max(0, min(1, (min(math.dist(p, q) for q in points)-.002)/.033))
            self.assertAlmostEqual(mask(p), t*t*(3-2*t), places=12)


if __name__ == '__main__': unittest.main()
