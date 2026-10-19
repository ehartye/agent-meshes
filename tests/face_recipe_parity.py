"""Real hm08 recipe comparison; selected with examples, not every helper edit."""
import unittest
from unittest.mock import patch
import face_composition as composition
character, face, np = composition.character, composition.face, composition.np


class FaceRecipeParity(unittest.TestCase):
    values = composition.FaceComposition.values

    def test_existing_real_layout_agrees_in_legacy_and_explicit_modes(self):
        # Build one existing hm08 layout per mode; bypass the cache for the second
        # call so equality verifies actual geometry, morphs and feature output.
        recipe = {'parameters': character.parameters, 'landmarks': character.landmarks}
        with patch.object(face, '_FACES', {}):
            legacy = face.face_layout(self.values)
        with patch.object(face, '_FACES', {}), \
             patch.object(face, 'parameters', create=True, side_effect=AssertionError('legacy parameters')), \
             patch.object(face, 'landmarks', create=True, side_effect=AssertionError('legacy landmarks')):
            explicit = face.face_layout(self.values, recipe=recipe)
        for key in legacy.keys() - {'face', 'landmarks'}:
            self.assertEqual(legacy[key], explicit[key], key)
        for key in ('vertices', 'faces', 'mouth_inside'):
            np.testing.assert_array_equal(legacy['face'][key], explicit['face'][key])
        self.assertGreater(len(explicit['face']['vertices']), 100)
        self.assertEqual(legacy['face']['morphs'].keys(), explicit['face']['morphs'].keys())
        for key, values in legacy['face']['morphs'].items():
            np.testing.assert_array_equal(values, explicit['face']['morphs'][key])
        for key, value in legacy['landmarks'].items():
            np.testing.assert_array_equal(value, explicit['landmarks'][key])


if __name__ == '__main__':
    unittest.main()
