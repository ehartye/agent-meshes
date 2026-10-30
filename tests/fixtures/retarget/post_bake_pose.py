"""Baking from a reference must hand the caller's scene frame and pose back, and leave the baked clips as they were.

rig_from_reference, retarget and ground_clip all sample the scene frame by frame and pose bones to do it. Their
postcondition: the scene frame, every touched pose bone's matrix_basis and the armatures' active actions are the
caller's again, also when a step fails. The pose is not forced to rest; the returned fitted rig stands in the pose it
was created in (its rest), so a neutral attachment captured straight after the call is the bind-pose attachment.

EXPECTED holds the baked fcurve values (rounded to 5 places, keyed at BAKED_FRAMES) that the helper produced before
it restored anything. They were recorded by running scenarios `grounded` and `neutral` below against agent-meshes
0.35.0's unmodified agent_meshes_retarget.py (main at e82590c): copy this file next to that module, replace the
`compare` function with one that prints `snapshot(action)` per label, run `blender -b --python-exit-code 1 --python
scripts/blender-author.py -- tests/fixtures/retarget/post_bake_pose.py out.glb`, and paste the printed dict here.
"""
from pathlib import Path
import tempfile
import bpy
from mathutils import Matrix, Quaternion
from agent_meshes_author import export_glb
from agent_meshes_retarget import ground_clip, import_reference, retarget, rig_from_reference

FRAME = 7
TOLERANCE = 1e-6
VALUE_TOLERANCE = 2e-5
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
                    curves[f'{curve.data_path}[{curve.array_index}]'] = tuple(round(p.co[1], 5) for p in points)
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
    """An armature of the caller's own, in a pose of its own, that no helper should touch."""
    bpy.ops.object.armature_add(location=(3, 0, 0))
    caller = bpy.context.object
    caller.name = 'caller'
    return caller


def rig_scenario(label, reference, **options):
    bpy.context.scene.frame_set(1)
    body = make_body()
    caller = make_caller()
    bpy.context.scene.frame_set(FRAME)
    captured = pose_non_identity(caller)
    arm, baked = rig_from_reference(body, reference, CORRESPONDENCE, CLIPS, **options)
    assert_frame(label)
    assert_basis(label, caller, captured)
    assert arm.name != caller.name and set(baked) == set(CLIPS)
    assert active_action(arm) is None, f'{label}: the returned rig must not hold a clip'
    for pb in arm.pose.bones:
        rest = arm.matrix_world @ arm.data.bones[pb.name].matrix_local
        error = gap(arm.matrix_world @ pb.matrix, rest)
        assert error < TOLERANCE, f'{label}: {pb.name} world matrix is {error} from its fitted rest'
        assert gap(pb.matrix_basis, Matrix()) < TOLERANCE, f'{label}: {pb.name} keeps a sampled clip pose'
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

    def assert_untouched(label, only=None):
        # ground_clip never touches the reference: its keyed pose is not the caller's to keep across frame changes.
        assert_frame(label)
        for armature, basis in captured.items():
            if only is not None and armature is not only:
                continue
            assert_basis(label, armature, basis)
            assert active_action(armature) is prior[armature], f'{label}: {armature.name} lost its active action'

    out = retarget(ref_arm, arm, actions['walk'])
    assert_untouched('retarget')
    assert out is not baked['walk'] and out.users == 0, 'retarget returns a new, unassigned action'
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


def build():
    with tempfile.TemporaryDirectory() as d:
        reference = str(Path(d) / 'reference.glb')
        make_reference(reference)
        bpy.ops.wm.read_factory_settings(use_empty=True)
        body, arm, baked = rig_scenario('grounded', reference, ground={'walk': 'always', 'sway': 'lowest'})
        neutral = {'source': ('walk', 1), 'bones': ['thigh_l'], 'target': {'thigh_l': (.4, 0, -1)}}
        rig_scenario('neutral', reference, neutral=neutral)
        direct_calls(reference, body, arm, baked)
    bpy.ops.mesh.primitive_cube_add(size=.1)
    return [bpy.context.object]
