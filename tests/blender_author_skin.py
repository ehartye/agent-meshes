"""Pure skin-weight validation; run with Python, without Blender."""
import math
from pathlib import Path
import sys
import unittest

sys.dont_write_bytecode = True
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts' / 'blender_lib'))
from agent_meshes_author import normalize_skin_weights


class SkinWeightsTests(unittest.TestCase):
    def test_normalizes_fresh_rows_without_mutating_inputs(self):
        row = {'root': 2, 'tip': 6, 'unused': 0}
        result = normalize_skin_weights([row, row], ['root', 'tip', 'unused'], 2)
        self.assertEqual(result, [{'root': .25, 'tip': .75}] * 2)
        result[0]['root'] = 1
        self.assertEqual(result[1]['root'], .25)
        self.assertEqual(row['root'], 2)

    def test_normalizes_large_and_subnormal_finite_weights(self):
        for amount in [1e308, 5e-324]:
            result = normalize_skin_weights([{'a': amount, 'b': amount}], ['a', 'b'], 1)
            self.assertEqual(result, [{'a': .5, 'b': .5}])

    def test_accepts_exactly_four_influences(self):
        self.assertEqual(sum(normalize_skin_weights([dict.fromkeys('abcd', 1)], list('abcd'), 1)[0].values()), 1)

    def test_rejects_bad_rows_counts_names_and_weights(self):
        cases = [[], [None], [{}], [{'a': 0}], [{'a': -1}], [{'a': math.inf}],
                 [{'a': math.nan}], [{'a': True}], [{'a': '1'}], [{'missing': 0, 'a': 1}],
                 [{'a': 1}, {'a': 1}], {0: {'a': 1}}, 'a', [[1]],
                 [dict.fromkeys('abcde', 1)], [{'a': 1, 'b': 0, 'c': 0, 'd': 0, 'e': 0}]]
        for rows in cases:
            with self.subTest(rows=rows), self.assertRaises(ValueError):
                normalize_skin_weights(rows, list('abcde'), 1)

    def test_rejects_invalid_vertex_count_and_bone_list(self):
        for count in [0, -1, True, 1.5, math.inf]:
            with self.subTest(count=count), self.assertRaises(ValueError):
                normalize_skin_weights([{'a': 1}], ['a'], count)
        for names in [[], ['a', 'a'], [''], [None], 'a', {'a': 1}]:
            with self.subTest(names=names), self.assertRaises(ValueError):
                normalize_skin_weights([{'a': 1}], names, 1)


if __name__ == '__main__':
    unittest.main()
