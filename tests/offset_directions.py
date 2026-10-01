"""Offset directions must stay outward under the supplied skin deformation."""
from pathlib import Path
import importlib
import sys
import unittest
import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts/blender_lib'))


class OffsetDirections(unittest.TestCase):
    def solve(self, vertices, faces, normals, weights=None, poses=None, **options):
        module = importlib.import_module('agent_meshes_offset_directions')
        function = getattr(module, 'fit_offset_directions', None)
        self.assertTrue(callable(function), 'shared fit_offset_directions API is missing')
        return function(vertices, faces, normals,
                        weights or [{'root': 1}] * len(vertices),
                        poses if poses is not None else [{'root': np.eye(4)}], **options)

    def test_valid_plane_is_unchanged_and_inputs_are_not_mutated(self):
        v = np.array([[0., 0, 0], [1, 0, 0], [0, 1, 0]])
        n = np.tile([0., 0, 2], (3, 1))
        before = v.copy(), n.copy()
        result = self.solve(v, [(0, 1, 2)], n)
        np.testing.assert_array_equal(result['directions'], np.tile([0, 0, 1], (3, 1)))
        self.assertTrue(result['report']['converged'])
        self.assertEqual(result['report']['changed_vertices'], [])
        self.assertEqual(result['report']['samples'], 2)
        np.testing.assert_array_equal(v, before[0])
        np.testing.assert_array_equal(n, before[1])

    def test_moving_triangle_requires_direction_change_at_fixed_vertex(self):
        v = np.array([[0., 0, 0], [1, 0, 0], [0, 1, 0]])
        # Moving only the third corner tilts its face through the supplied normal.
        move = np.eye(4); move[2, 3] = 2
        n = np.tile([0., 1, 1], (3, 1))
        w = [{'root': 1}, {'root': 1}, {'tip': 1}]
        poses = [{'root': np.eye(4), 'tip': move}]
        result = self.solve(v, [(0, 1, 2)], n, w, poses)
        self.assertTrue(result['report']['converged'])
        self.assertEqual(result['report']['changed_vertices'], [0, 1, 2])
        for p in [v, v + np.array([[0, 0, 0], [0, 0, 0], [0, 0, 2]])]:
            normal = np.cross(p[1] - p[0], p[2] - p[0])
            self.assertTrue(np.all(result['directions'] @ normal > 0))

    def test_narrow_feasible_cone_uses_smaller_margin(self):
        v = [[0, 0, 0], [0, 1, 0], [-.01, 0, 1], [.01, 0, 1]]
        n = np.tile([1., 0, 1], (4, 1))
        result = self.solve(v, [(0, 1, 2), (0, 3, 1)], n)
        self.assertTrue(result['report']['converged'])
        for normal in [[1, 0, .01], [-1, 0, .01]]:
            self.assertGreater(np.dot(normal, result['directions'][0]), 0)
        row = next(r for r in result['report']['vertices'] if r['vertex'] == 0)
        self.assertLess(row['margin'], .025)

    def test_opposed_constraints_report_unresolved_and_keep_original_direction(self):
        mirror = np.diag([-1., 1, 1, 1])
        v = [[0, 0, 0], [1, 0, 0], [0, 1, 0]]
        n = np.tile([0., 0, 1], (3, 1))
        result = self.solve(v, [(0, 1, 2)], n, poses=[{'root': mirror}])
        self.assertFalse(result['report']['converged'])
        self.assertEqual(result['report']['unresolved_vertices'], [0, 1, 2])
        np.testing.assert_array_equal(result['directions'], n)

    def test_zero_iteration_budget_cannot_claim_success(self):
        result = self.solve([[0, 0, 0], [1, 0, 0], [0, 1, 0]],
                            [(0, 1, 2)], [[1, 0, -.1]] * 3, iterations=0)
        self.assertFalse(result['report']['converged'])
        self.assertEqual(result['report']['unresolved_vertices'], [0, 1, 2])

    def test_last_allowed_projection_is_checked(self):
        result = self.solve([[0, 0, 0], [1, 0, 0], [0, 1, 0]],
                            [(0, 1, 2)], [[1, 0, 0]] * 3, iterations=1)
        self.assertTrue(result['report']['converged'])
        self.assertTrue(np.all(result['directions'][:, 2] > 0))

    def test_large_finite_normals_and_weight_totals_are_normalized_safely(self):
        result = self.solve([[0, 0, 0], [1, 0, 0], [0, 1, 0]], [(0, 1, 2)],
                            [[0, 0, 1e308]] * 3,
                            [{'a': 1e308, 'b': 1e308}] * 3,
                            [{'a': np.eye(4), 'b': np.eye(4)}])
        np.testing.assert_array_equal(result['directions'], [[0, 0, 1]] * 3)
        self.assertTrue(result['report']['converged'])

    def test_malformed_inputs_are_rejected(self):
        arguments = dict(vertices=[[0, 0, 0], [1, 0, 0], [0, 1, 0]],
                         faces=[(0, 1, 2)], normals=[[0, 0, 1]] * 3,
                         weights=[{'root': 1}] * 3, poses=[{'root': np.eye(4)}])
        cases = [('vertices', [[0, 0, np.nan]] * 3),
                 ('normals', [[0, 0, 0]] * 3), ('normals', [[0, 0, 1]]),
                 ('faces', [(0, 1, 2, 0)]), ('faces', [([0], 1, 2)]),
                 ('faces', [(0., 1, 2)]), ('faces', [(0, 1, 9)]),
                 ('weights', [{'root': -1}] * 3), ('weights', [{'root': 0}] * 3),
                 ('weights', [dict.fromkeys('abcde', 1)] * 3),
                 ('poses', []), ('poses', [{}]),
                 ('poses', [{'root': np.zeros((4, 4))}]),
                 ('poses', [{'root': np.eye(4), 'unused': np.zeros((4, 4))}])]
        function = importlib.import_module('agent_meshes_offset_directions').fit_offset_directions
        for key, value in cases:
            with self.subTest(key=key, value=str(value)[:60]):
                with self.assertRaises(ValueError):
                    function(**{**arguments, key: value})
        for options in [dict(iterations=-1), dict(iterations=True), dict(iterations=1.5),
                        dict(margins=[]), dict(margins=[0]), dict(margins=[np.nan]),
                        dict(margins=[.01, .05]), dict(margins=[True]), dict(margins=[2])]:
            with self.subTest(options=options):
                with self.assertRaises(ValueError):
                    function(**arguments, **options)

    def test_collapsed_posed_triangle_rejects_with_pose_index(self):
        collapse = np.eye(4); collapse[1, 3] = -1
        with self.assertRaisesRegex(ValueError, 'pose 1'):
            self.solve([[0, 0, 0], [1, 0, 0], [0, 1, 0]], [(0, 1, 2)],
                       [[0, 0, 1]] * 3, [{'root': 1}, {'root': 1}, {'tip': 1}],
                       [{'root': np.eye(4), 'tip': collapse}])

    def test_rigid_coordinate_frame_and_uniform_scale_preserve_solution(self):
        v = np.array([[0., 0, 0], [1, 0, 0], [0, 1, 0]])
        n = np.tile([0., 1, 1], (3, 1))
        w = [{'root': 1}, {'root': 1}, {'tip': 1}]
        move = np.eye(4); move[2, 3] = 2
        poses = [{'root': np.eye(4), 'tip': move}]
        baseline = self.solve(v, [(0, 1, 2)], n, w, poses)
        rotation = np.array([[0., -1, 0], [0, 0, -1], [1, 0, 0]])
        for scale in [1e-6, 1, 1e6]:
            frame = np.eye(4); frame[:3, :3] = rotation * scale
            frame[:3, 3] = np.array([2, 3, -1]) * scale
            transformed = self.solve(v @ frame[:3, :3].T + frame[:3, 3], [(0, 1, 2)],
                                     n @ rotation.T, w,
                                     [{name: frame @ m @ np.linalg.inv(frame)
                                       for name, m in poses[0].items()}])
            np.testing.assert_allclose(transformed['directions'],
                                       baseline['directions'] @ rotation.T, atol=1e-12)
            self.assertTrue(transformed['report']['converged'])

    def test_blended_affine_skinning_uses_each_corner_transform(self):
        v = np.array([[0., 0, 0], [1, 0, 0], [0, 1, 0]])
        a = np.eye(4); a[:3, :3] = [[1, 0, .3], [0, 2, 0], [0, 0, .7]]
        b = np.eye(4); b[:3, :3] = [[.8, 0, 0], [.2, 1, 0], [0, .7, 1.4]]; b[2, 3] = 2
        w = [{'a': 1}, {'a': .7, 'b': .3}, {'b': 1}]
        result = self.solve(v, [(0, 1, 2)], [[0, 1, 1]] * 3, w, [{'a': a, 'b': b}])
        self.assertTrue(result['report']['converged'])
        blend = np.array([sum(row.get(name, 0) * m for name, m in [('a', a), ('b', b)]) for row in w])
        points = np.array([(m @ np.r_[point, 1])[:3] for point, m in zip(v, blend)])
        face_normal = np.cross(points[1] - points[0], points[2] - points[0])
        for direction, matrix in zip(result['directions'], blend):
            self.assertGreater((matrix[:3, :3] @ direction) @ face_normal, 0)
            self.assertGreater(direction[2], 0)

    def test_isolated_vertex_is_preserved_and_reported_as_unconstrained(self):
        result = self.solve([[0, 0, 0], [1, 0, 0], [0, 1, 0], [3, 4, 5]],
                            [(0, 1, 2)], [[0, 0, 1]] * 3 + [[1, 0, 0]])
        np.testing.assert_array_equal(result['directions'][3], [1, 0, 0])
        self.assertEqual(result['report']['unconstrained_vertices'], [3])

    def test_collapsed_blended_direction_rejects_even_when_face_survives(self):
        mirror = np.diag([1., 1, -1, 1])
        with self.assertRaisesRegex(ValueError, 'pulled directions at pose 1'):
            self.solve([[0, 0, 0], [1, 0, 0], [0, 1, 0]], [(0, 1, 2)],
                       [[0, 0, 1]] * 3, [{'a': .5, 'b': .5}] * 3,
                       [{'a': np.eye(4), 'b': mirror}])


if __name__ == '__main__':
    unittest.main()
