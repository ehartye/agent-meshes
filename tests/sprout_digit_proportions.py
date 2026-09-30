"""Digit controls keep source surfaces, skin regions and joints in agreement."""
import hashlib
import inspect
import json
import math
import sys
import unittest
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts/blender_lib'))
from agent_meshes_sprout_kin import anatomy, geometry, build_anatomy
from agent_meshes_sprout_rig import skeleton, skin_regions, weight_function

FIXTURE = json.loads((Path(__file__).parent / 'fixtures/sprout-default-hands.json').read_text())


class DigitProportions(unittest.TestCase):
    def controls(self, **kwargs):
        for name in ('finger_scale', 'thumb_scale'):
            self.assertIn(name, inspect.signature(anatomy).parameters,
                          'Anatomy must carry explicit digit ratios')
        return anatomy(**kwargs)

    def test_default_matches_pre_change_geometry_samples_and_all_bones(self):
        # Independent capture from the previous commit, not new default vs new 1.
        for record in FIXTURE['records']:
            args = {k: record[k] for k in ('age', 'height')}
            parts = {p['name']: p for p in geometry(**args)}
            for name, frozen in record['hands'].items():
                vertices = np.array(parts[name]['vertices'])
                self.assertEqual(len(vertices), frozen['count'])
                np.testing.assert_allclose(vertices[frozen['indices']], frozen['vertices'], atol=2e-12, rtol=0)
                np.testing.assert_allclose(vertices.min(axis=0), frozen['min'], atol=2e-12, rtol=0)
                np.testing.assert_allclose(vertices.max(axis=0), frozen['max'], atol=2e-12, rtol=0)
                digest = hashlib.sha256(json.dumps(parts[name]['faces'], separators=(',', ':')).encode()).hexdigest()
                self.assertEqual(digest, frozen['facesSha256'])
            bones = skeleton(anatomy(**args))
            self.assertEqual(bones.keys(), record['bones'].keys())
            for name, frozen in record['bones'].items():
                self.assertEqual(bones[name]['parent'], frozen['parent'])
                for endpoint in ('head', 'tail'):
                    np.testing.assert_allclose(bones[name][endpoint], frozen[endpoint], atol=2e-12, rtol=0)

    def test_independent_ratios_keep_roots_and_scale_each_chain_about_its_root(self):
        for age, height in [('adult', 1.7), ('child', 1.12), ('adult', 2.2)]:
            original = skeleton(anatomy(age=age, height=height))
            for finger, thumb in [(.7, 1), (1, .85), (.7, .85), (.5, 1.5)]:
                a = self.controls(age=age, height=height, finger_scale=finger, thumb_scale=thumb)
                fitted = skeleton(a)
                self.assertEqual(a['finger_scale'], finger)
                self.assertEqual(a['thumb_scale'], thumb)
                for side in ('l', 'r'):
                    for digit in ('finger_'+side+'0', 'finger_'+side+'1', 'thumb_'+side):
                        scale = thumb if digit.startswith('thumb') else finger
                        root = np.array(original[digit+'_base']['head'])
                        for suffix in ('_base', '_tip'):
                            for endpoint in ('head', 'tail'):
                                expected = root + (np.array(original[digit+suffix][endpoint])-root)*scale
                                np.testing.assert_allclose(fitted[digit+suffix][endpoint], expected, atol=2e-12, rtol=0)
                for name in original:
                    if not name.startswith(('finger_', 'thumb_')):
                        self.assertEqual(original[name], fitted[name])

    def test_both_tip_surfaces_follow_bones_and_retain_tip_radius(self):
        for age, height in [('adult', 1.7), ('child', 1.12)]:
            a = self.controls(age=age, height=height, finger_scale=.7, thumb_scale=.85)
            bones = skeleton(a)
            parts = {p['name']: np.array(p['vertices']) for p in geometry(
                age=age, height=height, finger_scale=.7, thumb_scale=.85)}
            for side in ('l', 'r'):
                for surface, bone in [('digit-tip_'+side+'0', 'finger_'+side+'0_tip'),
                                      ('digit-tip_'+side+'1', 'finger_'+side+'1_tip'),
                                      ('thumb-tip_'+side, 'thumb_'+side+'_tip')]:
                    tip = np.array(bones[bone]['tail'])
                    np.testing.assert_allclose(parts[surface].mean(axis=0), tip, atol=2e-12, rtol=0)
                    np.testing.assert_allclose(np.linalg.norm(parts[surface]-tip, axis=1), .009*a['scale'], atol=2e-12, rtol=0)

    def test_source_regions_and_weights_use_custom_serialized_anatomy(self):
        for age, height in [('adult', 1.7), ('child', 1.12)]:
            a = self.controls(age=age, height=height, finger_scale=.7, thumb_scale=.85)
            a = json.loads(json.dumps(a))
            expected = [p for p in geometry(age=age, height=height, finger_scale=.7, thumb_scale=.85) if p['kind']=='skin']
            self.assertEqual(skin_regions(a), expected)
            weight = weight_function(a)
            for side in ('l', 'r'):
                for digit in ('finger_'+side+'0', 'finger_'+side+'1', 'thumb_'+side):
                    bones = skeleton(a)
                    self.assertEqual(weight(bones[digit+'_tip']['tail'], digit), {digit+'_tip': 1.})
                    weights = weight(bones[digit+'_tip']['head'], digit)
                    self.assertAlmostEqual(weights[digit+'_base'], .5)
                    self.assertAlmostEqual(weights[digit+'_tip'], .5)

    def test_non_digit_source_parts_and_anatomical_landmarks_stay_exact(self):
        for age, height in [('adult', 1.7), ('child', 1.12)]:
            original = anatomy(age=age, height=height)
            fitted = self.controls(age=age, height=height, finger_scale=.7, thumb_scale=.85)
            for key in original:
                if key not in ('finger_scale', 'thumb_scale'):
                    self.assertEqual(original[key], fitted[key])
            before = geometry(age=age, height=height)
            after = geometry(age=age, height=height, finger_scale=.7, thumb_scale=.85)
            self.assertEqual([p['name'] for p in before], [p['name'] for p in after])
            for p, q in zip(before, after):
                if not p['name'].startswith(('finger_', 'digit-tip_', 'thumb_', 'thumb-tip_')):
                    self.assertEqual(p, q)

    def test_legacy_anatomy_dictionaries_keep_default_rig_and_regions(self):
        for record in FIXTURE['records']:
            a = self.controls(age=record['age'], height=record['height'])
            legacy = {k:v for k,v in a.items() if k not in ('finger_scale', 'thumb_scale')}
            self.assertEqual(skeleton(legacy), skeleton(a))
            self.assertEqual(skin_regions(legacy), skin_regions(a))

    def test_ratios_are_explicit_on_all_authoring_entry_points_and_bounded(self):
        for entry in (anatomy, geometry, build_anatomy):
            for name in ('finger_scale', 'thumb_scale'):
                self.assertIn(name, inspect.signature(entry).parameters)
                self.assertEqual(inspect.signature(entry).parameters[name].default, 1.)
        for name in ('finger_scale', 'thumb_scale'):
            for value in (False, True, None, '0.7', math.nan, math.inf, -math.inf, 0, -.5, .49, 1.51):
                for entry in (anatomy, geometry):
                    with self.subTest(entry=entry.__name__, name=name, value=value):
                        with self.assertRaises(ValueError):
                            entry(**{name: value})


if __name__ == '__main__':
    unittest.main()
