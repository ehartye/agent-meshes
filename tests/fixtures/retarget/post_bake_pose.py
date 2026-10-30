"""Baking from a reference must hand the caller's scene frame and pose back, and leave the baked clips as they were.

rig_from_reference, retarget and ground_clip all sample the scene frame by frame and pose bones to do it. Their
postcondition: the scene frame, every touched pose bone's matrix_basis and the armatures' active actions are the
caller's again, also when a step fails, and a failing restore never replaces the failure that was propagating. The pose
is not forced to rest; the returned fitted rig stands in the pose it was created in (its rest), so a neutral
attachment captured straight after the call is the bind-pose attachment.

What is posed, and why it bites:
- rig_from_reference creates its armature (and imports the reference) inside the call, so no armature the caller posed
  is handed to it. It samples frames of the whole scene, though, which re-evaluates every animated armature already
  there: `caller` carries a keyed action and is manually posed off it at the caller's frame, so the bake overwrites
  that pose unless the helper restored it. A posed bone on an armature rig_from_reference never touches would pass
  vacuously on any version.
- retarget and ground_clip receive the caller's armatures (`direct_calls`), which they mutate: those are posed and
  animated before the call, with a world matrix captured for the foot attachment.
- The neutral attachment is the bone world matrix a consumer captures for a prop (arm.matrix_world @ pose_bone.matrix).
  For the direct calls it must equal the value captured before the call. rig_from_reference returns a rig that
  did not exist before, so there is no earlier value: the attachment must equal the fitted-rest world matrix
  (arm.matrix_world @ bone.matrix_local), which is what the docs promise a consumer.

EXPECTED holds the baked fcurve values (rounded to 5 places, keyed at BAKED_FRAMES) that the helper produced before
it restored anything; snapshot() keeps full precision, so the comparison tolerates the rounding (5e-6) and no more. They were recorded by running scenarios `grounded` and `neutral` below against agent-meshes
0.35.0's unmodified agent_meshes_retarget.py (main at e82590c): copy this file next to that module, replace the
`compare` function with one that prints `snapshot(action)` per label, run `blender -b --python-exit-code 1 --python
scripts/blender-author.py -- tests/fixtures/retarget/post_bake_pose.py out.glb`, and paste the printed dict here.
"""
from pathlib import Path
import tempfile
import bpy
from mathutils import Matrix, Quaternion
import agent_meshes_retarget as lib
from agent_meshes_author import export_glb
from agent_meshes_retarget import ground_clip, import_reference, retarget, rig_from_reference

FRAME = 7
TOLERANCE = 1e-6
VALUE_TOLERANCE = 1e-5
ATTACHMENTS = ('thigh_l', 'foot_l')         # the neutral-configured bone and its child, where a prop would sit
CLIPS = ['walk', 'sway']
# Reference joint -> body point: the body is the reference scaled 1.2 about the origin.
REFERENCE_JOINTS = {'pelvis': (0, 0, 1), 'pelvis:tail': (0, 0, 1.2), 'thigh_l': (.1, 0, 1), 'thigh_l:tail': (.1, 0, .55),
                    'foot_l': (.1, 0, .1), 'foot_l:tail': (.1, .15, .1)}
CORRESPONDENCE = {name: tuple(1.2 * v for v in point) for name, point in REFERENCE_JOINTS.items()}

BAKED_FRAMES = (0.0, 1.0, 2.0, 3.0)
EXPECTED = {
    'grounded:walk': {
        'pose.bones["pelvis"].rotation_quaternion[0]': (1.0, 1.0, 1.0, 1.0),
        'pose.bones["pelvis"].rotation_quaternion[1]': (0.0, 0.0, 0.0, 0.0),
        'pose.bones["pelvis"].rotation_quaternion[2]': (0.0, 0.0, 0.0, 0.0),
        'pose.bones["pelvis"].rotation_quaternion[3]': (0.0, 0.0, 0.0, 0.0),
        'pose.bones["pelvis"].location[0]': (0.0, 0.0, 0.0, 0.0),
        'pose.bones["pelvis"].location[1]': (-0.06, -0.05435, -0.10581, -0.16409),
        'pose.bones["pelvis"].location[2]': (0.0, 0.0, 0.0, 0.0),
        'pose.bones["thigh_l"].rotation_quaternion[0]': (1.0, 0.99595, 0.96641, 0.93937),
        'pose.bones["thigh_l"].rotation_quaternion[1]': (0.0, 0.08995, 0.25701, 0.3429),
        'pose.bones["thigh_l"].rotation_quaternion[2]': (0.0, 0.0, 0.0, 0.0),
        'pose.bones["thigh_l"].rotation_quaternion[3]': (0.0, 0.0, 0.0, 0.0),
        'pose.bones["foot_l"].rotation_quaternion[0]': (1.0, 0.99866, 0.98903, 0.98007),
        'pose.bones["foot_l"].rotation_quaternion[1]': (0.0, -0.05171, -0.14773, -0.19867),
        'pose.bones["foot_l"].rotation_quaternion[2]': (0.0, 0.0, 0.0, 0.0),
        'pose.bones["foot_l"].rotation_quaternion[3]': (0.0, 0.0, 0.0, 0.0),
    },
    'grounded:sway': {
        'pose.bones["pelvis"].rotation_quaternion[0]': (1.0, 1.0, 1.0, 1.0),
        'pose.bones["pelvis"].rotation_quaternion[1]': (0.0, 0.0, 0.0, 0.0),
        'pose.bones["pelvis"].rotation_quaternion[2]': (0.0, 0.0, 0.0, 0.0),
        'pose.bones["pelvis"].rotation_quaternion[3]': (0.0, 0.0, 0.0, 0.0),
        'pose.bones["pelvis"].location[0]': (0.0, 0.0, 0.0, 0.0),
        'pose.bones["pelvis"].location[1]': (0.05387, 0.01381, -0.0606, -0.10066),
        'pose.bones["pelvis"].location[2]': (0.0, 0.0, 0.0, 0.0),
        'pose.bones["thigh_l"].rotation_quaternion[0]': (1.0, 0.99792, 0.98286, 0.96891),
        'pose.bones["thigh_l"].rotation_quaternion[1]': (0.0, -0.06453, -0.18437, -0.2474),
        'pose.bones["thigh_l"].rotation_quaternion[2]': (0.0, 0.0, 0.0, 0.0),
        'pose.bones["thigh_l"].rotation_quaternion[3]': (0.0, 0.0, 0.0, 0.0),
        'pose.bones["foot_l"].rotation_quaternion[0]': (1.0, 0.99925, 0.99383, 0.98877),
        'pose.bones["foot_l"].rotation_quaternion[1]': (0.0, 0.03883, 0.11093, 0.14944),
        'pose.bones["foot_l"].rotation_quaternion[2]': (0.0, 0.0, 0.0, 0.0),
        'pose.bones["foot_l"].rotation_quaternion[3]': (0.0, 0.0, 0.0, 0.0),
    },
    'neutral:walk': {
        'pose.bones["pelvis"].rotation_quaternion[0]': (1.0, 1.0, 1.0, 1.0),
        'pose.bones["pelvis"].rotation_quaternion[1]': (0.0, 0.0, 0.0, 0.0),
        'pose.bones["pelvis"].rotation_quaternion[2]': (0.0, 0.0, 0.0, 0.0),
        'pose.bones["pelvis"].rotation_quaternion[3]': (0.0, 0.0, 0.0, 0.0),
        'pose.bones["pelvis"].location[0]': (0.0, 0.0, 0.0, 0.0),
        'pose.bones["pelvis"].location[1]': (0.0, 0.06009, 0.1717, 0.23179),
        'pose.bones["pelvis"].location[2]': (0.0, 0.0, 0.0, 0.0),
        'pose.bones["thigh_l"].rotation_quaternion[0]': (0.98196, 0.97798, 0.94897, 0.92242),
        'pose.bones["thigh_l"].rotation_quaternion[1]': (0.0, 0.08833, 0.25237, 0.33671),
        'pose.bones["thigh_l"].rotation_quaternion[2]': (0.0, 0.01701, 0.0486, 0.06484),
        'pose.bones["thigh_l"].rotation_quaternion[3]': (-0.18911, -0.18834, -0.18276, -0.17764),
        'pose.bones["foot_l"].rotation_quaternion[0]': (1.0, 0.99866, 0.98903, 0.98007),
        'pose.bones["foot_l"].rotation_quaternion[1]': (0.0, -0.05171, -0.14773, -0.19867),
        'pose.bones["foot_l"].rotation_quaternion[2]': (0.0, 0.0, 0.0, 0.0),
        'pose.bones["foot_l"].rotation_quaternion[3]': (0.0, 0.0, 0.0, 0.0),
    },
    'neutral:sway': {
        'pose.bones["pelvis"].rotation_quaternion[0]': (1.0, 1.0, 1.0, 1.0),
        'pose.bones["pelvis"].rotation_quaternion[1]': (0.0, 0.0, 0.0, 0.0),
        'pose.bones["pelvis"].rotation_quaternion[2]': (0.0, 0.0, 0.0, 0.0),
        'pose.bones["pelvis"].rotation_quaternion[3]': (0.0, 0.0, 0.0, 0.0),
        'pose.bones["pelvis"].location[0]': (0.0, 0.0, 0.0, 0.0),
        'pose.bones["pelvis"].location[1]': (0.0, -0.04006, -0.11446, -0.15453),
        'pose.bones["pelvis"].location[2]': (0.0, 0.0, 0.0, 0.0),
        'pose.bones["thigh_l"].rotation_quaternion[0]': (0.98196, 0.97991, 0.96512, 0.95143),
        'pose.bones["thigh_l"].rotation_quaternion[1]': (0.0, -0.06336, -0.18104, -0.24294),
        'pose.bones["thigh_l"].rotation_quaternion[2]': (0.0, -0.0122, -0.03487, -0.04679),
        'pose.bones["thigh_l"].rotation_quaternion[3]': (-0.18911, -0.18871, -0.18587, -0.18323),
        'pose.bones["foot_l"].rotation_quaternion[0]': (1.0, 0.99925, 0.99383, 0.98877),
        'pose.bones["foot_l"].rotation_quaternion[1]': (0.0, 0.03883, 0.11093, 0.14944),
        'pose.bones["foot_l"].rotation_quaternion[2]': (0.0, 0.0, 0.0, 0.0),
        'pose.bones["foot_l"].rotation_quaternion[3]': (0.0, 0.0, 0.0, 0.0),
    },
}


def snapshot(action):
    """Every fcurve of the action's keyed channels: 'path[index]' -> values, with the key frames checked on the way."""
    curves = {}
    for layer in action.layers:
        for strip in layer.strips:
            for bag in strip.channelbags:
                for curve in bag.fcurves:
                    points = curve.keyframe_points
                    assert tuple(round(p.co[0], 3) for p in points) == BAKED_FRAMES, f'{curve.data_path}: key frames changed'
                    curves[f'{curve.data_path}[{curve.array_index}]'] = tuple(p.co[1] for p in points)
    return curves


def compare(label, got):
    want = EXPECTED[label]
    assert got.keys() == want.keys(), f'{label}: baked channels changed: {sorted(got.keys() ^ want.keys())}'
    for key, values in want.items():
        error = max(abs(a - b) for a, b in zip(got[key], values))
        assert error < VALUE_TOLERANCE, f'{label} {key}: baked values changed by {error}: {got[key]} != {values}'


def gap(a, b):
    return max(abs(a[i][j] - b[i][j]) for i in range(4) for j in range(4))


def basis_of(arm):
    return {pb.name: pb.matrix_basis.copy() for pb in arm.pose.bones}


def attachment_world(arm, name):
    """The world matrix a consumer captures for something attached to the bone, as posed now."""
    bpy.context.view_layer.update()
    return (arm.matrix_world @ arm.pose.bones[name].matrix).copy()


def assert_attachment(label, arm, name, expected):
    error = gap(attachment_world(arm, name), expected)
    assert error < TOLERANCE, f'{label}: {arm.name}.{name} attachment world matrix differs by {error}'


def active_action(arm):
    return arm.animation_data.action if arm.animation_data else None


def assert_frame(label):
    current = bpy.context.scene.frame_current
    assert current == FRAME, f'{label}: scene.frame_current is {current}, not the caller\'s {FRAME}'


def assert_basis(label, arm, expected):
    bpy.context.view_layer.update()
    for name, matrix in expected.items():
        error = gap(arm.pose.bones[name].matrix_basis, matrix)
        assert error < TOLERANCE, f'{label}: {arm.name}.{name} matrix_basis differs from the caller\'s by {error}'


def pose_non_identity(arm):
    """Put every bone in a visible non-identity pose; the root also moves. Returns the captured matrix_basis values."""
    for index, pb in enumerate(arm.pose.bones):
        pb.rotation_mode = 'QUATERNION'
        pb.rotation_quaternion = Quaternion((0, 0, 1), .3 + .1 * index)
        if index == 0:
            pb.location = (.02, .05, .1)
    bpy.context.view_layer.update()
    return basis_of(arm)


def make_reference(path):
    """A pelvis, thigh_l, foot_l reference with a skinned box and two clips ('walk', 'sway'), exported as a GLB."""
    bpy.ops.object.armature_add()
    arm = bpy.context.object
    arm.name = 'reference'
    bpy.ops.object.mode_set(mode='EDIT')
    pelvis = arm.data.edit_bones[0]; pelvis.name = 'pelvis'
    pelvis.head, pelvis.tail = (0, 0, 1), (0, 0, 1.2)
    thigh = arm.data.edit_bones.new('thigh_l'); thigh.parent = pelvis
    thigh.head, thigh.tail = (.1, 0, 1), (.1, 0, .55)
    foot = arm.data.edit_bones.new('foot_l'); foot.parent = thigh
    foot.head, foot.tail = (.1, 0, .1), (.1, .15, .1)
    bpy.ops.object.mode_set(mode='OBJECT')
    bpy.ops.mesh.primitive_cube_add(size=1, location=(.05, 0, .6))
    skin = bpy.context.object
    skin.scale = (.4, .3, 1.1)
    bpy.ops.object.transform_apply(scale=True)
    groups = {name: skin.vertex_groups.new(name=name) for name in ('pelvis', 'thigh_l', 'foot_l')}
    for v in skin.data.vertices:
        if v.co.z > .6:
            groups['pelvis'].add([v.index], 1, 'REPLACE')
        else:
            groups['thigh_l'].add([v.index], .5, 'REPLACE'); groups['foot_l'].add([v.index], .5, 'REPLACE')
    skin.modifiers.new('rig', 'ARMATURE').object = arm
    skin.parent = arm
    arm.animation_data_create()
    for name, thigh_angle, foot_angle, travel in [('walk', .7, -.4, .3), ('sway', -.5, .3, -.2)]:
        action = bpy.data.actions.new(name)
        action.use_fake_user = True
        arm.animation_data.action = action
        for frame, k in [(1, 0), (4, 1)]:
            for bone, angle in [('thigh_l', thigh_angle), ('foot_l', foot_angle)]:
                pb = arm.pose.bones[bone]; pb.rotation_mode = 'QUATERNION'
                pb.rotation_quaternion = Quaternion((1, 0, 0), angle * k)
                pb.keyframe_insert('rotation_quaternion', frame=frame)
            root = arm.pose.bones['pelvis']; root.rotation_mode = 'QUATERNION'
            root.location = (0, travel * k, 0)
            root.keyframe_insert('location', frame=frame)
    arm.animation_data.action = None
    for pb in arm.pose.bones:
        pb.matrix_basis.identity()
    export_glb(path, [skin, arm])


def make_body():
    bpy.ops.mesh.primitive_cube_add(size=1, location=(.06, 0, .72))
    body = bpy.context.object
    body.name = 'body'
    body.scale = (.48, .36, 1.32)
    bpy.ops.object.transform_apply(scale=True)
    return body


def make_caller():
    """An animated armature of the caller's own. Changing the frame re-evaluates its action, so any helper that samples
    frames overwrites a pose set by hand on it unless the pose is restored."""
    bpy.ops.object.armature_add(location=(3, 0, 0))
    caller = bpy.context.object
    caller.name = 'caller'
    caller.animation_data_create()
    caller.animation_data.action = bpy.data.actions.new('caller-sway')
    pb = caller.pose.bones[0]
    pb.rotation_mode = 'QUATERNION'
    for frame, angle in [(1, 0), (20, 1.0)]:
        pb.rotation_quaternion = Quaternion((1, 0, 0), angle)
        pb.keyframe_insert('rotation_quaternion', frame=frame)
    return caller


def rig_scenario(label, reference, **options):
    bpy.context.scene.frame_set(1)
    body = make_body()
    caller = make_caller()
    bpy.context.scene.frame_set(FRAME)
    action = active_action(caller)
    captured = pose_non_identity(caller)
    arm, baked = rig_from_reference(body, reference, CORRESPONDENCE, CLIPS, **options)
    assert_frame(label)
    assert_basis(label, caller, captured)
    assert active_action(caller) is action, f'{label}: the caller armature lost its active action'
    assert arm.name != caller.name and set(baked) == set(CLIPS)
    assert active_action(arm) is None, f'{label}: the returned rig must not hold a clip'
    for pb in arm.pose.bones:
        rest = arm.matrix_world @ arm.data.bones[pb.name].matrix_local
        error = gap(arm.matrix_world @ pb.matrix, rest)
        assert error < TOLERANCE, f'{label}: {pb.name} world matrix is {error} from its fitted rest'
        assert gap(pb.matrix_basis, Matrix()) < TOLERANCE, f'{label}: {pb.name} keeps a sampled clip pose'
    for name in ATTACHMENTS:                     # no earlier value exists for a rig made in the call: it must be its rest
        assert_attachment(label, arm, name, arm.matrix_world @ arm.data.bones[name].matrix_local)
    for clip in CLIPS:
        compare(f'{label}:{clip}', snapshot(baked[clip]))
    return body, arm, baked


def direct_calls(reference, body, arm, baked):
    """retarget and ground_clip on the caller's own armatures, posed and animated before the call."""
    scene = bpy.context.scene
    scene.frame_set(1)
    ref_arm, meshes, actions = import_reference(reference)
    arm.animation_data_create().action = baked['sway']
    ref_arm.animation_data_create().action = actions['sway']
    scene.frame_set(FRAME)
    captured = {ref_arm: pose_non_identity(ref_arm), arm: pose_non_identity(arm)}
    prior = {ref_arm: actions['sway'], arm: baked['sway']}
    attached = {(armature, name): attachment_world(armature, name) for armature in captured for name in ATTACHMENTS}

    def assert_untouched(label, only=None):
        # ground_clip never touches the reference: its keyed pose is not the caller's to keep across frame changes.
        assert_frame(label)
        for armature, basis in captured.items():
            if only is not None and armature is not only:
                continue
            assert_basis(label, armature, basis)
            for name in ATTACHMENTS:
                assert_attachment(label, armature, name, attached[armature, name])
            assert active_action(armature) is prior[armature], f'{label}: {armature.name} lost its active action'

    out = retarget(ref_arm, arm, actions['walk'])
    assert_untouched('retarget')
    assert out is not baked['walk'] and out.users == 0, 'retarget returns a new, unassigned action'
    calibration = {'source': {'thigh_l': Matrix().to_3x3()}, 'target': {'thigh_l': Quaternion((0, 0, 1), .5).to_matrix()}}
    neutral_out = retarget(ref_arm, arm, actions['walk'], neutral=calibration)
    assert_untouched('retarget with a neutral calibration')
    assert neutral_out.users == 0, 'retarget returns a new, unassigned action'
    try:
        retarget(ref_arm, arm, actions['walk'], neutral={'source': {}, 'target': {'thigh_l': Matrix().to_3x3()}})
    except KeyError:
        pass
    else:
        raise AssertionError('The failing neutral must raise so the restore-on-failure path is exercised')
    assert_untouched('retarget after a failure')
    ground_clip(arm, body, baked['walk'], 'pelvis', 'lowest')
    assert_untouched('ground_clip', only=arm)
    try:
        ground_clip(arm, body, baked['walk'], 'missing_bone')
    except KeyError:
        pass
    else:
        raise AssertionError('An unknown root must raise so the restore-on-failure path is exercised')
    assert_untouched('ground_clip after a failure', only=arm)
    return meshes + [ref_arm]


def failing_rig(reference, broken_restore=False):
    """rig_from_reference with an unknown clip: the bake of 'walk' has sampled frames and posed the rig by the time the
    lookup of the second clip raises. The caller's frame and pose, and the rig it had begun, must be back, and the
    KeyError must be what propagates, also when the restore itself fails."""
    label = 'rig_from_reference after a failure' + (' with a failing restore' if broken_restore else '')
    bpy.context.scene.frame_set(1)
    body = make_body()
    caller = make_caller()
    bpy.context.scene.frame_set(FRAME)
    action = active_action(caller)
    captured = pose_non_identity(caller)
    before = set(bpy.data.objects)
    real = lib._restore_state
    if broken_restore:
        def broken(state):
            real(state)
            raise RuntimeError('restore failed')
        lib._restore_state = broken
    try:
        rig_from_reference(body, reference, CORRESPONDENCE, ['walk', 'no_such_clip'], ground={'walk': 'always'})
    except KeyError as error:
        propagated = error
    except Exception as error:
        raise AssertionError(f'{label}: {type(error).__name__} replaced the KeyError') from error
    else:
        raise AssertionError(f'{label}: an unknown clip must raise')
    finally:
        lib._restore_state = real
    if broken_restore:
        assert any('restore' in note for note in getattr(propagated, '__notes__', [])), f'{label}: the restore failure is not noted'
    assert_frame(label)
    assert_basis(label, caller, captured)
    assert active_action(caller) is action, f'{label}: the caller armature lost its active action'
    made = [o for o in bpy.data.objects if o not in before]
    rigs = [o for o in made if o.type == 'ARMATURE' and o.name.startswith('rig')]
    assert len(rigs) == 1, f'{label}: expected the half-built rig, found {[o.name for o in rigs]}'
    assert active_action(rigs[0]) is None, f'{label}: the half-built rig keeps a clip'
    for pb in rigs[0].pose.bones:
        assert gap(pb.matrix_basis, Matrix()) < TOLERANCE, f'{label}: {pb.name} keeps a sampled clip pose'
    for o in made + [body, caller]:
        bpy.data.objects.remove(o, do_unlink=True)


def restore_failures(body, arm, baked):
    """A restore that raises must not replace the failure in flight, and must surface when none is in flight."""
    real = lib._restore_state

    def broken(state):
        real(state)
        raise RuntimeError('restore failed')

    lib._restore_state = broken
    try:
        try:
            ground_clip(arm, body, baked['walk'], 'missing_bone')
        except KeyError as error:
            assert any('restore' in note for note in getattr(error, '__notes__', [])), 'the restore failure is not noted'
        except Exception as error:
            raise AssertionError(f'ground_clip: {type(error).__name__} replaced the KeyError') from error
        else:
            raise AssertionError('An unknown root must raise')
        try:
            ground_clip(arm, body, baked['walk'], 'pelvis', 'lowest')
        except RuntimeError as error:
            assert 'restore failed' in str(error)
        else:
            raise AssertionError('A restore failure with nothing in flight must be raised')
    finally:
        lib._restore_state = real


def build():
    with tempfile.TemporaryDirectory() as d:
        reference = str(Path(d) / 'reference.glb')
        make_reference(reference)
        bpy.ops.wm.read_factory_settings(use_empty=True)
        body, arm, baked = rig_scenario('grounded', reference, ground={'walk': 'always', 'sway': 'lowest'})
        neutral = {'source': ('walk', 1), 'bones': ['thigh_l'], 'target': {'thigh_l': (.4, 0, -1)}}
        rig_scenario('neutral', reference, neutral=neutral)
        direct_calls(reference, body, arm, baked)
        restore_failures(body, arm, baked)
        failing_rig(reference)
        failing_rig(reference, broken_restore=True)
    bpy.ops.mesh.primitive_cube_add(size=.1)
    return [bpy.context.object]
