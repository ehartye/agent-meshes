"""Numerical and action-adapter checks; runnable without Blender."""
import copy
import importlib.util
import math
from pathlib import Path
from types import SimpleNamespace as NS
import unittest

MODULE = Path(__file__).resolve().parents[1] / 'scripts/blender_lib/agent_meshes_motion_style.py'
motion = None
if MODULE.exists():
    spec = importlib.util.spec_from_file_location('motion_style', MODULE)
    motion = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(motion)


def rotation(degrees, axis=(0, 1, 0)):
    angle = math.radians(degrees) / 2
    length = math.hypot(*axis)
    return [math.cos(angle), *(math.sin(angle) * x / length for x in axis)]


def path(name):
    return 'pose.bones["' + name.replace('\\', '\\\\').replace('"', '\\"') + '"].rotation_quaternion'


class Curve:
    def __init__(self, name, index, values):
        self.data_path, self.array_index = path(name), index
        self.modifiers = []
        self.sampled_points = []
        self.mute = False
        self.keyframe_points = [NS(co=NS(x=i, y=v[index]), interpolation='BEZIER',
                                  handle_left=(i-.2, 12), handle_right=(i+.2, 13))
                               for i, v in enumerate(values)]
        self.updates = 0

    def update(self):
        self.updates += 1


def action_fixture(names=('selected', 'untouched')):
    values = [rotation(d, (.2, .7, .4)) for d in (20, 60, 100)]
    curves = [Curve(n, k, values) for n in names for k in range(4)]
    bag = NS(fcurves=curves)
    return NS(layers=[NS(strips=[NS(channelbags=[bag])])]), curves


class MotionStyle(unittest.TestCase):
    def setUp(self):
        self.assertIsNotNone(motion, 'The reusable baked rotation styling API is missing')

    def assertQuaternion(self, actual, expected):
        for a, b in zip(actual, expected):
            self.assertAlmostEqual(a, b, places=12)

    def test_arbitrary_axes_and_antipodal_inputs(self):
        values = [rotation(d, (.2, .7, .4)) for d in (20, 60, 100)]
        values[1] = [-v * 3 for v in values[1]]
        before = copy.deepcopy(values)
        out = motion.scale_rotation_samples(values, .3)
        for q, degrees in zip(out, (6, 18, 30)):
            self.assertQuaternion(q, rotation(degrees, (.2, .7, .4)))
        self.assertEqual(values, before)

    def test_endpoints_and_identity(self):
        values = [rotation(0), rotation(120), rotation(220)]
        self.assertEqual(motion.scale_rotation_samples(values, 1), values)
        self.assertEqual(motion.scale_rotation_samples(values[:2], 0), [[1., 0., 0., 0.]] * 2)
        self.assertQuaternion(motion.scale_rotation_samples([rotation(1e-8)], .5)[0], rotation(5e-9))

    def test_branch_crossing_is_rejected(self):
        with self.assertRaisesRegex(ValueError, 'branch'):
            motion.scale_rotation_samples([rotation(179), rotation(181)], .3)

    def test_half_turn_axis_ambiguity_rejected_but_noop_preserved(self):
        for q in ([0, 1, 0, 0], [0, -1, 0, 0], rotation(180)):
            with self.subTest(q=q), self.assertRaisesRegex(ValueError, 'half-turn'):
                motion.scale_rotation_samples([q], .5)
            self.assertEqual(motion.scale_rotation_samples([q], 1), [q])

    def test_invalid_samples_and_gains(self):
        for values in ([], [[0]*4], [[1, 2, 3]], [[math.nan, 0, 0, 0]], [[math.inf, 0, 0, 0]]):
            with self.subTest(values=values), self.assertRaises(ValueError):
                motion.scale_rotation_samples(values, .3)
        for gain in (-1, 2, math.nan, math.inf, True, '0.5'):
            with self.subTest(gain=gain), self.assertRaises(ValueError):
                motion.scale_rotation_samples([rotation(20)], gain)

    def test_adapter_scales_only_selected_tracks_and_escapes_names(self):
        name = 'digit"with\\escapes'
        action, curves = action_fixture((name, 'untouched'))
        untouched = copy.deepcopy([c.__dict__ for c in curves[4:]])
        result = motion.scale_action_rotations(action, [name], .3)
        self.assertEqual(result, {'bones': 1, 'samples': 3, 'gain': .3})
        for i, degrees in enumerate((6, 18, 30)):
            self.assertQuaternion([c.keyframe_points[i].co.y for c in curves[:4]],
                                  rotation(degrees, (.2, .7, .4)))
        self.assertTrue(all(c.updates == 1 for c in curves[:4]))
        self.assertTrue(all(k.interpolation == 'LINEAR' for c in curves[:4] for k in c.keyframe_points))
        self.assertEqual([c.__dict__ for c in curves[4:]], untouched)

    def test_gain_one_preserves_exact_keys_handles_and_update_state(self):
        action, curves = action_fixture()
        before = copy.deepcopy([c.__dict__ for c in curves])
        motion.scale_action_rotations(action, ['selected'], 1)
        self.assertEqual([c.__dict__ for c in curves], before)

    def test_invalid_selection_is_atomic(self):
        for names in ([], 'selected', ['selected', 'selected'], ['selected', 'absent'], [None]):
            action, curves = action_fixture()
            before = copy.deepcopy([c.__dict__ for c in curves])
            with self.subTest(names=names), self.assertRaises(ValueError):
                motion.scale_action_rotations(action, names, .3)
            self.assertEqual([c.__dict__ for c in curves], before)

    def test_malformed_late_track_is_atomic(self):
        def missing(curves): curves.pop()
        def duplicate(curves): curves.append(copy.deepcopy(curves[-1]))
        def modifier(curves): curves[-1].modifiers.append(object())
        def muted(curves): curves[-1].mute = True
        def sampled(curves): curves[-1].sampled_points.append(1)
        def staggered(curves): curves[-1].keyframe_points[1].co.x = 1.25
        def nonfinite(curves): curves[-1].keyframe_points[1].co.y = math.inf
        for mutate in (missing, duplicate, modifier, muted, sampled, staggered, nonfinite):
            action, curves = action_fixture()
            mutate(curves)
            # Keep the arbitrary modifier identity stable in the snapshot.
            if curves[-1].modifiers: curves[-1].modifiers = ['modifier']
            before = copy.deepcopy([c.__dict__ for c in curves])
            with self.subTest(case=mutate.__name__), self.assertRaises(ValueError):
                motion.scale_action_rotations(action, ['selected', 'untouched'], .3)
            self.assertEqual([c.__dict__ for c in curves], before)

    def test_non_increasing_or_nonfinite_key_times(self):
        for times in ((0, 0, 1), (0, 2, 1), (0, math.inf, 2)):
            action, curves = action_fixture()
            for c in curves[:4]:
                for key, t in zip(c.keyframe_points, times): key.co.x = t
            with self.subTest(times=times), self.assertRaises(ValueError):
                motion.scale_action_rotations(action, ['selected'], .3)

    def test_multilayer_or_split_slot_selection_is_rejected(self):
        action, curves = action_fixture()
        action.layers.append(NS(strips=[]))
        with self.assertRaises(ValueError): motion.scale_action_rotations(action, ['selected'], .3)
        action, curves = action_fixture()
        action.layers[0].strips[0].channelbags = [NS(fcurves=curves[:4]), NS(fcurves=curves[4:])]
        with self.assertRaises(ValueError):
            motion.scale_action_rotations(action, ['selected', 'untouched'], .3)


if __name__ == '__main__':
    unittest.main()
