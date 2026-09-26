"""Geometry contract for the reusable character recipe (no Blender required)."""
import importlib.util
import math
from pathlib import Path
import unittest

SOURCE = Path(__file__).resolve().parents[1] / 'recipes' / 'stylized_character.py'

class CharacterContract(unittest.TestCase):
    def recipe(self):
        self.assertTrue(SOURCE.is_file(), 'Reusable character recipe must exist in the tool')
        spec = importlib.util.spec_from_file_location('character', SOURCE)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        return module

    def test_repeatable_anatomy_and_ground_contact(self):
        recipe = self.recipe()
        config = {'height': 1.82, 'age': 'adult', 'presentation': 'female'}
        first = recipe.geometry(config)
        self.assertEqual(first, recipe.geometry(config))
        by_name = {p['name']: p for p in first}
        self.assertIn('face', by_name)
        self.assertIn('left-upper-eyelid', by_name)
        self.assertIn('left-thumb', by_name)
        foot = by_name['left-boot']['vertices']
        self.assertGreater(max(v[2] for v in foot), .18)
        self.assertLess(min(v[2] for v in foot), -.05)
        self.assertAlmostEqual(min(v[1] for p in first for v in p['vertices']), 0, places=5)
        for part in first:
            self.assertTrue(all(math.isfinite(c) for v in part['vertices'] for c in v))
            self.assertTrue(all(0 <= i < len(part['vertices']) for f in part['faces'] for i in f))

    def test_variants_and_bad_parameters(self):
        recipe = self.recipe()
        for species in ['human', 'alien']:
            for age, height in [('adult', 1.8), ('child', 1.2)]:
                for vacuum in [False, True]:
                    parts = recipe.geometry({'species':species,'age':age,'height':height,'vacuum':vacuum})
                    self.assertEqual(len(parts), len({p['name'] for p in parts}))
                    self.assertGreater(len(parts), 20)
                    self.assertLess(max(v[1] for p in parts for v in p['vertices']), height * 1.15)
        for invalid in [{'height':float('nan')}, {'height':-1}, {'species':'typo'}, {'vacuum':'false'}, {'unexpected':1}]:
            with self.assertRaises(ValueError): recipe.geometry(invalid)

if __name__ == '__main__': unittest.main()
