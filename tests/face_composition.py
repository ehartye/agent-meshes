"""Explicit project recipe composition and the legacy stylized-face path."""
import inspect
from pathlib import Path
import sys
from types import ModuleType, SimpleNamespace
import unittest
from unittest.mock import patch

sys.dont_write_bytecode = True
ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'recipes'))
sys.path.insert(0, str(ROOT / 'scripts' / 'blender_lib'))

import numpy as np
import stylized_character as character
import stylized_face as face


def project_recipe():
    # Project-owned callbacks need not come from the sibling module's namespace.
    def parameters(values):
        return character.parameters(values)

    def landmarks(values):
        marks = character.landmarks(values)
        return dict(marks, head_y=marks['head_y'] + .05)

    return {'parameters': parameters, 'landmarks': landmarks}


class FaceComposition(unittest.TestCase):
    values = {'face': 'arkit', 'age': 'child', 'presentation': 'female', 'height': 1.22,
              'face_shape': {'brow': 1.3}}

    def test_explicit_callbacks_reach_nested_shape_and_spec_without_legacy_lookup(self):
        recipe = project_recipe()
        expected = face.head_spec(self.values)
        expected['center'] = (0.0, 0.0, expected['center'][2] + .05)
        # Fail loudly if any nested call consults embedded globals or the sibling.
        with patch.object(face, 'parameters', create=True, side_effect=AssertionError('legacy parameters')), \
             patch.object(face, 'landmarks', create=True, side_effect=AssertionError('legacy landmarks')):
            shape = face.face_shape_values(self.values, recipe=recipe)
            self.assertEqual(shape['brow'], 1.3)
            self.assertEqual(shape['years'], 7)
            self.assertEqual(face.head_spec(self.values, recipe=recipe), expected)
            own_head = {'center': (0, 0, 2), 'radii': (.08, .07, .1), 'neck': (.04, .03)}
            self.assertEqual(face.head_spec(self.values, own_head, recipe=recipe)['center'], (0, 0, 2))

    def test_explicit_invalid_recipe_never_falls_back_even_when_globals_are_usable(self):
        good = project_recipe()
        with patch.object(face, 'parameters', good['parameters'], create=True), \
             patch.object(face, 'landmarks', good['landmarks'], create=True):
            for bad in (None, {}, {'parameters': good['parameters']},
                        {'parameters': 1, 'landmarks': good['landmarks']},
                        {'parameters': good['parameters'], 'landmarks': None}, object()):
                for entry in (face.face_shape_values, face.head_spec, face.face_layout):
                    with self.subTest(entry=entry.__name__, bad=bad):
                        with self.assertRaisesRegex(ValueError, 'recipe'):
                            entry(self.values, recipe=bad)
                with self.assertRaisesRegex(ValueError, 'recipe'):
                    face.add_face([], self.values, recipe=bad)

    def test_all_composition_entrypoints_make_recipe_keyword_only(self):
        for entry in (face.face_shape_values, face.head_spec, face.face_layout, face.add_face):
            self.assertEqual(inspect.signature(entry).parameters['recipe'].kind, inspect.Parameter.KEYWORD_ONLY)

    def test_legacy_embedded_callbacks_still_override_the_sibling(self):
        expected = face.head_spec(self.values, recipe=project_recipe())
        recipe = project_recipe()
        with patch.object(face, 'parameters', recipe['parameters'], create=True), \
             patch.object(face, 'landmarks', recipe['landmarks'], create=True):
            self.assertEqual(face.head_spec(self.values), expected)

    def test_explicit_callback_errors_propagate_without_legacy_lookup(self):
        def broken(values):
            raise ValueError('project callback failed')

        recipe = project_recipe()
        recipe['parameters'] = broken
        for entry in (face.face_shape_values, face.head_spec, face.face_layout, face.add_face):
            with self.subTest(entry=entry.__name__):
                with self.assertRaisesRegex(ValueError, 'project callback failed'):
                    entry(self.values, recipe=recipe)

    def test_add_face_threads_the_recipe_through_layout_shape_and_neck_landmarks(self):
        import agent_meshes_author as author

        class ReachedNeck(Exception):
            pass

        def landmarks(parameters):
            self.assertEqual(parameters, character.parameters(self.values))
            raise ReachedNeck

        recipe = {'parameters': character.parameters, 'landmarks': landmarks}
        rig = SimpleNamespace(type='ARMATURE')
        layout_data = dict(face={}, landmarks={}, scale=1, eye_left=(.03, 0, 1),
                           eye_right=(-.03, 0, 1), eye_radius=.01)
        # Stop at the neck boundary before mesh mutation. Real layout output is
        # covered separately; native Blender/export parity is coordinator-owned.
        with patch.dict(sys.modules, {'bpy': ModuleType('bpy')}), \
             patch.object(face, 'face_layout', return_value=layout_data) as layout, \
             patch.object(face, 'face_shape_values', wraps=face.face_shape_values) as shape, \
             patch.object(author, 'add_eye_bones'), \
             patch.object(face, 'parameters', create=True, side_effect=AssertionError('legacy parameters')), \
             patch.object(face, 'landmarks', create=True, side_effect=AssertionError('legacy landmarks')):
            with self.assertRaises(ReachedNeck):
                face.add_face([rig], self.values, recipe=recipe)
        parameters = character.parameters(self.values)
        layout.assert_called_once_with(parameters, None, recipe=recipe)
        shape.assert_called_once_with(parameters, recipe=recipe)



if __name__ == '__main__':
    unittest.main()
