"""Motion diagnostics: measured samples, no visual-quality pass threshold.

Run with Python/NumPy; Blender adds the native sampler/state-restoration checks.
"""
from pathlib import Path
import json
import sys
import unittest

sys.dont_write_bytecode = True
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts' / 'blender_lib'))
import numpy as np
import agent_meshes_retarget as rt
try:
    import bpy
except ImportError:
    bpy = None

NATIVE_REPORT = {}


class MotionDiagnostics(unittest.TestCase):
    def audit(self, times, points, **kwargs):
        return rt.analyze_motion_samples(times, {'ball': points},
                                         np.zeros((len(times), 3)), **kwargs)

    def test_low_recovery_is_not_reported_as_backward_stance(self):
        # A deliberately low forward recovery makes the unsigned median misleading.
        points = [(0, y, 0) for y in (0, -1, 2, 5, 8)]
        report = self.audit(np.arange(5), points, scenario_speed=3.1)
        foot = report['markers']['ball']
        self.assertEqual(foot['lowHeight']['backwardIntervals'], 1)
        self.assertEqual(foot['lowHeight']['forwardIntervals'], 3)
        self.assertEqual(foot['lowHeight']['backwardSpeed']['p50'], 1)
        self.assertEqual(foot['lowHeight']['absoluteForwardSpeed']['p50'], 3)
        self.assertAlmostEqual(foot['lowHeight']['backwardCycleSecondsAtScenarioSpeed'], 4 / 3.1)
        self.assertEqual(foot['lowHeight']['backwardRuns'], [[0.0, 1.0]])

    def test_slow_sampled_boundary_can_hide_a_bad_loop(self):
        points = [(0, y, 0) for y in (0, -1, -2, 0, 0)]
        foot = self.audit(np.arange(5), points)['markers']['ball']
        self.assertEqual(foot['loop']['positionGap'], 0)
        self.assertEqual(foot['loop']['velocityGap'], 1)
        self.assertEqual(foot['temporal']['maximumSpeed'], 2)
        self.assertEqual(foot['temporal']['maximumAcceleration'], 3)

    def test_root_travel_and_coordinate_rotation_do_not_become_stance_speed(self):
        t = np.array([0., .25, 1., 2.])
        root = np.column_stack((t * 7, t * 3, np.zeros(4)))
        points = root + np.column_stack((-t * 2, np.zeros(4), np.zeros(4)))
        report = rt.analyze_motion_samples(t, {'toe': points}, root, forward=(1, 0, 0))
        foot = report['markers']['toe']
        self.assertAlmostEqual(foot['lowHeight']['backwardSpeed']['p50'], 2)
        self.assertEqual(foot['lowHeight']['backwardIntervals'], 3)
        self.assertEqual(report['rootTravel'], [14., 6., 0.])

    def test_absent_backward_contact_has_no_invented_minimum_speed(self):
        foot = self.audit([0, 1, 2], [(0, 0, 0)] * 3)['markers']['ball']
        self.assertIsNone(foot['lowHeight']['backwardSpeed'])
        self.assertIsNone(foot['lowHeight']['backwardEquivalentCycleDistance'])
        self.assertEqual(foot['lowHeight']['stationaryIntervals'], 2)
        json.dumps(foot, allow_nan=False)

    def test_height_gate_and_contiguous_phase_runs_are_visible(self):
        points = [(0, y, z) for y, z in ((0, 0), (-1, 0), (-2, 1), (-3, 1), (-4, 0))]
        foot = self.audit(np.arange(5), points, height_margin=0)['markers']['ball']
        self.assertEqual(foot['lowHeight']['intervals'], 2)
        self.assertEqual(foot['lowHeight']['durationFraction'], .5)
        self.assertEqual(foot['lowHeight']['backwardRuns'], [[0., 2.]])

    def test_invalid_samples_and_axes_reject(self):
        for times in ([0, 0, 1], [0, 2, 1], [0, float('nan'), 1]):
            with self.assertRaises(ValueError):
                self.audit(times, np.zeros((3, 3)))
        for options in ({'forward': (0, 0, 1)}, {'forward': (0, 0, 0)},
                        {'height_quantile': 2}, {'height_margin': -.1}, {'scenario_speed': 0}):
            with self.assertRaises(ValueError):
                self.audit([0, 1, 2], np.zeros((3, 3)), **options)
        with self.assertRaises(ValueError):
            self.audit([0, 1, 2], [(0, 0, 0)] * 2)


@unittest.skipIf(bpy is None, 'native Blender sampler requires Blender')
class NativeSampler(unittest.TestCase):
    def setUp(self):
        bpy.ops.object.armature_add()
        self.arm = bpy.context.object
        bpy.ops.object.mode_set(mode='EDIT')
        root = self.arm.data.edit_bones[0]
        root.name = 'pelvis'
        ball = self.arm.data.edit_bones.new('ball')
        ball.parent = root
        ball.head, ball.tail = (0, 0, 0), (0, .1, 0)
        bpy.ops.object.mode_set(mode='OBJECT')
        self.ball = self.arm.pose.bones['ball']
        for frame, y in enumerate((0, -1, -2, 0, 0)):
            self.ball.location.y = y
            self.ball.keyframe_insert('location', frame=frame)
        self.action = self.arm.animation_data.action
        self.arm.animation_data.action = None
        self.prior = bpy.data.actions.new('prior')
        self.arm.animation_data.action = self.prior
        self.arm.animation_data.action_blend_type = 'ADD'
        self.arm.animation_data.action_influence = .37
        self.track = self.arm.animation_data.nla_tracks.new()
        self.track.mute = False
        bpy.context.scene.frame_set(8, subframe=.375)
        self.ball.location = (3, 4, 5)
        bpy.context.view_layer.update()
        self.before = self.ball.matrix_basis.copy()

    def check_restored(self):
        self.assertIs(self.arm.animation_data.action, self.prior)
        self.assertEqual(self.arm.animation_data.action_blend_type, 'ADD')
        self.assertAlmostEqual(self.arm.animation_data.action_influence, .37, places=6)
        self.assertFalse(self.track.mute)
        self.assertEqual(bpy.context.scene.frame_current, 8)
        self.assertAlmostEqual(bpy.context.scene.frame_subframe, .375)
        np.testing.assert_allclose(self.ball.matrix_basis, self.before, atol=1e-7)

    def test_native_evaluated_samples_and_state_restoration(self):
        report = rt.audit_clip_motion(self.arm, self.action, markers=['ball'], sample_count=5,
                                      fps=2, scenario_speed=3.1)
        self.assertEqual(report['duration'], 2)
        self.assertEqual(report['markers']['ball']['forwardExcursion'], 2)
        self.assertEqual(report['markers']['ball']['lowHeight']['backwardSpeed']['p50'], 2)
        self.check_restored()
        NATIVE_REPORT['sample'] = report
        NATIVE_REPORT['animationRNA'] = {
            name: self.arm.animation_data.bl_rna.properties[name].type
            for name in ('action', 'action_slot', 'action_blend_type', 'action_influence')}

    def test_analysis_failure_restores_native_state(self):
        with self.assertRaises(ValueError):
            rt.audit_clip_motion(self.arm, self.action, markers=['ball'], sample_count=5,
                                 forward=(0, 0, 0))
        self.check_restored()

    def test_unknown_bone_fails_without_mutation(self):
        with self.assertRaises(ValueError):
            rt.audit_clip_motion(self.arm, self.action, markers=['missing'])
        self.check_restored()

    def test_ambiguous_native_slot_requires_explicit_choice(self):
        slot = self.action.slots[0]
        self.action.slots.new(id_type='OBJECT', name='Other')
        with self.assertRaises(ValueError):
            rt.audit_clip_motion(self.arm, self.action, markers=['ball'])
        self.check_restored()
        report = rt.audit_clip_motion(self.arm, self.action, markers=['ball'], sample_count=5,
                                      fps=2, action_slot=slot)
        self.assertEqual(report['markers']['ball']['forwardExcursion'], 2)
        self.check_restored()

    def test_sampler_does_not_leave_created_animation_data(self):
        self.arm.animation_data_clear()
        self.ball.location = (3, 4, 5)
        before = self.ball.matrix_basis.copy()
        rt.audit_clip_motion(self.arm, self.action, markers=['ball'], sample_count=5)
        self.assertIsNone(self.arm.animation_data)
        np.testing.assert_allclose(self.ball.matrix_basis, before, atol=1e-7)

    def test_untracked_bones_do_not_inherit_callers_manual_pose(self):
        pelvis = self.arm.pose.bones['pelvis']
        pelvis.rotation_mode = 'XYZ'
        pelvis.rotation_euler.y = np.pi / 2
        before = pelvis.matrix_basis.copy()
        report = rt.audit_clip_motion(self.arm, self.action, markers=['ball'], sample_count=5,
                                      fps=2)
        self.assertAlmostEqual(report['markers']['ball']['forwardExcursion'], 2, places=6)
        np.testing.assert_allclose(pelvis.matrix_basis, before, atol=1e-7)

    def object_action_fixture(self, rotation_mode):
        # OBJECT slots may animate the armature itself, including delta transforms.
        # Use a caller with no animation data, so restoring an old action cannot
        # accidentally hide failure to preserve its manually placed transform.
        self.arm.animation_data_clear()
        self.arm.rotation_mode = rotation_mode
        channels = {
            'location': (5., -3., 2.),
            'rotation_euler': (.2, -.3, .4),
            'rotation_quaternion': (.9, .1, -.2, .3),
            'rotation_axis_angle': (.6, 0., 1., 0.),
            'scale': (1.2, .8, 1.1),
            'delta_location': (.3, -.2, .1),
            'delta_rotation_euler': (.1, .2, -.1),
            'delta_rotation_quaternion': (.95, .05, .1, -.15),
            'delta_scale': (.9, 1.1, 1.05),
        }
        for frame, offset in ((0, 1.), (4, 2.)):
            for name, values in channels.items():
                # Every keyed component differs from the caller's later value.
                setattr(self.arm, name, tuple(value + offset for value in values))
                self.arm.keyframe_insert(name, frame=frame)
        action = self.arm.animation_data.action
        self.arm.animation_data_clear()
        bpy.context.scene.frame_set(8, subframe=.375)
        for name, values in channels.items():
            setattr(self.arm, name, values)
        self.ball.location = (3, 4, 5)
        bpy.context.view_layer.update()
        return action, {
            'rotationMode': self.arm.rotation_mode,
            'channels': {name: tuple(getattr(self.arm, name)) for name in channels},
            'matrix': np.array(self.arm.matrix_world),
            'boneMatrix': np.array(self.ball.matrix_basis),
        }

    def check_object_restored(self, before):
        self.assertIsNone(self.arm.animation_data)
        self.assertEqual(self.arm.rotation_mode, before['rotationMode'])
        self.assertEqual(bpy.context.scene.frame_current, 8)
        self.assertAlmostEqual(bpy.context.scene.frame_subframe, .375)
        for name, values in before['channels'].items():
            np.testing.assert_allclose(tuple(getattr(self.arm, name)), values, atol=1e-7,
                                       err_msg=f'caller armature object {name} was changed')
        np.testing.assert_allclose(self.arm.matrix_world, before['matrix'], atol=1e-6)
        np.testing.assert_allclose(self.ball.matrix_basis, before['boneMatrix'], atol=1e-7)

    def test_object_action_restores_manually_placed_armature_on_success(self):
        for mode in ('ZYX', 'QUATERNION', 'AXIS_ANGLE'):
            with self.subTest(rotation_mode=mode):
                action, before = self.object_action_fixture(mode)
                report = rt.audit_clip_motion(self.arm, action, markers=['ball'], sample_count=5)
                # Prove the object curves were sampled, rather than ignored.
                self.assertGreater(np.linalg.norm(report['rootTravel']), 1.)
                self.check_object_restored(before)

    def test_object_action_restores_manually_placed_armature_on_analysis_error(self):
        for mode in ('ZYX', 'QUATERNION', 'AXIS_ANGLE'):
            with self.subTest(rotation_mode=mode):
                action, before = self.object_action_fixture(mode)
                with self.assertRaisesRegex(ValueError, 'forward'):
                    rt.audit_clip_motion(self.arm, action, markers=['ball'], sample_count=5,
                                         forward=(0, 0, 0))
                self.check_object_restored(before)


if __name__ == '__main__':
    result = unittest.main(argv=[sys.argv[0]], exit=False).result
    if '--report' in sys.argv:
        path = Path(sys.argv[sys.argv.index('--report') + 1])
        path.parent.mkdir(parents=True, exist_ok=True)
        import hashlib
        NATIVE_REPORT.update(ok=result.wasSuccessful(), testsRun=result.testsRun,
                             skipped=len(result.skipped),
                             errors=[{'test': str(test), 'traceback': trace} for test, trace in result.errors],
                             failures=[{'test': str(test), 'traceback': trace} for test, trace in result.failures],
                             helperSha256=hashlib.sha256(Path(rt.__file__).read_bytes()).hexdigest(),
                             fixtureSha256=hashlib.sha256(Path(__file__).read_bytes()).hexdigest())
        path.write_text(json.dumps(NATIVE_REPORT, indent=2, allow_nan=False))
    if not result.wasSuccessful():
        raise SystemExit(1)
