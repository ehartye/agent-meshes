import copy
import importlib
import sys
import unittest
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1]/'scripts/blender_lib'))


class SkinWeightTransfer(unittest.TestCase):
    def api(self):
        try:
            return importlib.import_module('agent_meshes_skin_weights')
        except ModuleNotFoundError:
            self.fail('Shared localized skin-weight transfer API is missing')

    def test_ellipsoid_support_and_anisotropic_dimensions(self):
        api = self.api()
        points = [[2, 3, 4], [3, 3, 4], [4, 3, 4], [2, 7, 4], [2, 3, 11]]
        result = api.ellipsoid_falloff(points, [2, 3, 4], [2, 4, 6], strength=.8)
        np.testing.assert_allclose(result, [.8, .45, 0, 0, 0])
        np.testing.assert_array_equal(api.ellipsoid_falloff(points, [2, 3, 4], [2, 4, 6], strength=0), np.zeros(5))

    def test_transfer_preserves_other_bones_mass_and_input(self):
        api = self.api()
        rows = [{'hand': .6, 'thumb': .1, 'wrist': .3}, {'hand': 1}, {'finger': 1}]
        before = copy.deepcopy(rows)
        out = api.transfer_influence(rows, 'hand', 'thumb', [.5, 0, 1])
        self.assertEqual(rows, before)
        self.assertEqual(out[0]['wrist'], .3)
        self.assertAlmostEqual(out[0]['hand'], .3)
        self.assertAlmostEqual(out[0]['thumb'], .4)
        self.assertEqual(out[1:], before[1:])
        self.assertIsNot(out[1], rows[1])
        for a, b in zip(out, before):
            self.assertAlmostEqual(sum(a.values()), sum(b.values()))

    def test_full_transfer_reuses_freed_influence_slot(self):
        api = self.api()
        row = {'hand': .4, 'a': .3, 'b': .2, 'c': .1}
        out = api.transfer_influence([row], 'hand', 'thumb', [1])
        self.assertEqual(out, [{'thumb': .4, 'a': .3, 'b': .2, 'c': .1}])

    def test_rejects_added_fifth_influence_without_pruning_or_mutation(self):
        api = self.api()
        rows = [{'hand': 1}, {'hand': .4, 'a': .3, 'b': .2, 'c': .1}]
        before = copy.deepcopy(rows)
        with self.assertRaisesRegex(ValueError, 'influence'):
            api.transfer_influence(rows, 'hand', 'thumb', [.5, .5])
        self.assertEqual(rows, before)

    def test_zero_amount_does_not_repair_or_change_unrelated_rows(self):
        api = self.api()
        row = {'hand': .2, 'a': .2, 'b': .2, 'c': .2, 'd': .2}
        self.assertEqual(api.transfer_influence([row], 'hand', 'thumb', [0]), [row])

    def test_numpy_single_precision_does_not_erase_partial_donor(self):
        api = self.api()
        row = {name: np.float32(value) for name, value in [('hand', .4), ('a', .3), ('b', .2), ('c', .1)]}
        with self.assertRaisesRegex(ValueError, 'influence'):
            api.transfer_influence([row], 'hand', 'thumb', [.99999999])
        pair = {'hand': np.float32(.5), 'thumb': np.float32(.5)}
        out = api.transfer_influence([pair], 'hand', 'thumb', [.3])[0]
        self.assertEqual(sum(out.values()), 1)

    def test_transfer_changes_only_requested_rigid_motion_share(self):
        api = self.api()
        rows = api.transfer_influence([{'hand': .75, 'thumb': .25}], 'hand', 'thumb', [1/3])
        # Identity hand versus a thumb translated two units: the point moves one unit.
        point = np.array([3., 4., 5.])
        deformed = rows[0]['hand']*point+rows[0]['thumb']*(point+[2, 0, 0])
        np.testing.assert_array_equal(deformed, [4, 4, 5])

    def test_nonunit_totals_and_zero_entries_are_preserved(self):
        api = self.api()
        rows = [{'hand': 2., 'thumb': 0., 'wrist': 3., 'unused': 0.}, {'hand': 0., 'thumb': 2.}]
        out = api.transfer_influence(rows, 'hand', 'thumb', [.25, 1], max_influences=3)
        self.assertEqual(out, [{'hand': 1.5, 'thumb': .5, 'wrist': 3., 'unused': 0.}, rows[1]])

    def test_invalid_fields_and_rows_are_rejected(self):
        api = self.api()
        for center, radii, strength in [([0, 0], [1, 1, 1], 1), ([0]*3, [1, 0, 1], 1),
                                       ([0]*3, [1, 1, np.inf], 1), ([0]*3, [1]*3, 1.1),
                                       ([0]*3, [1]*3, True)]:
            with self.subTest(center=center, radii=radii, strength=strength), self.assertRaises(ValueError):
                api.ellipsoid_falloff([[0, 0, 0]], center, radii, strength)
        for rows, amounts in [([{'hand': -1}], [.5]), ([{'hand': np.nan}], [.5]),
                              ([{'hand': True}], [.5]), ([{}], [.5]),
                              ([{'hand': 1}], []), ([{'hand': 1}], [True]),
                              ([{'hand': 1}], [np.inf]), ([{'hand': 1}], [-.1])]:
            with self.subTest(rows=rows, amounts=amounts), self.assertRaises(ValueError):
                api.transfer_influence(rows, 'hand', 'thumb', amounts)
        with self.assertRaises(ValueError):
            api.transfer_influence([{'hand': 1}], 'hand', 'hand', [.5])
        with self.assertRaises(ValueError):
            api.transfer_influence([{'hand': 1}], 'hand', 'thumb', [.5], max_influences=True)


if __name__ == '__main__':
    unittest.main()
