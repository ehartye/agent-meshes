"""Lip construction on full characters must not infer the head axis from a tail."""
import copy
import inspect
from collections import Counter
from pathlib import Path
import sys
import unittest

sys.dont_write_bytecode = True
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts/blender_lib'))
from agent_meshes_face import ellipsoid_geometry, join_geometry, sculpt_lips
from blender_face_geometry import closed_and_consistent


def surface_faces(mesh):
    """Oriented faces by coordinates, independent of unused-vertex compaction."""
    result = Counter()
    for polygon in mesh['faces']:
        points = tuple(tuple(mesh['vertices'][i]) for i in polygon)
        result[min(points[k:] + points[:k] for k in range(len(points)))] += 1
    return result


class LipAxisTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.head = ellipsoid_geometry((0, 0, .12), (.11, .085, .10), rings=40, segments=64)

    def api(self):
        self.assertIn('axis_y', inspect.signature(sculpt_lips).parameters,
                      'Complete character lip construction needs an explicit head axis')
        return sculpt_lips

    def test_tail_does_not_change_authored_head_or_lose_remote_geometry(self):
        build = self.api()
        tail = ellipsoid_geometry((0, .5, -.15), (.025, .1, .025), rings=8, segments=12)
        whole = join_geometry([self.head, tail])
        saved = copy.deepcopy(whole)
        head_lips = build(self.head['vertices'], self.head['faces'], .10, .055)
        result = build(whole['vertices'], whole['faces'], .10, .055, axis_y=0)
        self.assertEqual(surface_faces(result), surface_faces(head_lips) + surface_faces(tail))
        self.assertEqual(whole, saved, 'Inputs are not mutated')
        closed_and_consistent(self, result['vertices'], result['faces'])

    def test_omitted_none_and_explicit_legacy_midpoint_match(self):
        build = self.api()
        legacy = build(self.head['vertices'], self.head['faces'], .10, .055)
        self.assertEqual(legacy, build(self.head['vertices'], self.head['faces'], .10, .055, axis_y=None))
        self.assertEqual(legacy, build(self.head['vertices'], self.head['faces'], .10, .055, axis_y=0.0))

    def test_axis_rejects_nonfinite_and_nonreal_values(self):
        build = self.api()
        for axis in (True, False, float('nan'), float('inf'), -float('inf'), '0', [], 1j):
            with self.subTest(axis=axis), self.assertRaisesRegex(ValueError, 'Lip wrap axis'):
                build(self.head['vertices'], self.head['faces'], .10, .055, axis_y=axis)

    def test_axis_in_front_of_skin_keeps_positive_radius_guard(self):
        build = self.api()
        with self.assertRaisesRegex(ValueError, 'front of the head'):
            build(self.head['vertices'], self.head['faces'], .10, .055, axis_y=-.2)


if __name__ == '__main__':
    unittest.main()
