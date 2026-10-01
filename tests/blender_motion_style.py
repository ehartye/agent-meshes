"""Run with Blender --background --factory-startup --python this_file -- --report path.

Optional --asset path validates the adapter against every quaternion bone track
in a real GLB. The GLB is imported only; no source asset is overwritten.
"""
import argparse
import hashlib
import json
import math
from pathlib import Path
import sys

import bpy
from mathutils import Quaternion

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts/blender_lib'))
from agent_meshes_motion_style import scale_action_rotations


def curves(action):
    return [c for layer in action.layers for strip in layer.strips
            for bag in strip.channelbags for c in bag.fcurves]


def snapshot(action):
    return [(c.data_path, c.array_index,
             [(tuple(k.co), tuple(k.handle_left), tuple(k.handle_right), k.interpolation)
              for k in c.keyframe_points]) for c in curves(action)]


def fixture(rotations):
    bpy.ops.object.select_all(action='DESELECT')
    data = bpy.data.armatures.new('fixture')
    arm = bpy.data.objects.new('fixture', data)
    bpy.context.collection.objects.link(arm)
    bpy.context.view_layer.objects.active = arm
    arm.select_set(True)
    bpy.ops.object.mode_set(mode='EDIT')
    for name in ('selected"with\\escapes', 'untouched'):
        bone = data.edit_bones.new(name)
        bone.head, bone.tail = (0, 0, 0), (0, .2, 1)
    bpy.ops.object.mode_set(mode='OBJECT')
    arm.animation_data_create()
    action = bpy.data.actions.new('fixture')
    arm.animation_data.action = action
    for i, rotation in enumerate(rotations):
        for bone in arm.pose.bones:
            bone.rotation_mode = 'QUATERNION'
            bone.rotation_quaternion = rotation
            bone.keyframe_insert('rotation_quaternion', frame=i)
    return arm, action


def assert_orientation(actual, expected):
    # Component comparison avoids float32 angle-acos sensitivity close to identity.
    a, b = actual.normalized(), expected.normalized()
    error = min(max(abs(x-y) for x, y in zip(a, b)), max(abs(x+y) for x, y in zip(a, b)))
    assert error < 2e-6, error


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--report', required=True)
    parser.add_argument('--asset')
    args = parser.parse_args(sys.argv[sys.argv.index('--') + 1:])
    passed = []
    qs = [Quaternion((.2, .7, .4), math.radians(d)) for d in (20, 60, 100)]
    name = 'selected"with\\escapes'
    arm, action = fixture(qs)
    before = snapshot(action)
    result = scale_action_rotations(action, [name], .3)
    expected = [Quaternion((1, 0, 0, 0)).slerp(q, .3) for q in qs]
    for i, q in enumerate(expected):
        bpy.context.scene.frame_set(i)
        assert_orientation(arm.pose.bones[name].rotation_quaternion, q)
    bpy.context.scene.frame_set(0, subframe=.5)
    midpoint = Quaternion([(a+b)/2 for a, b in zip(expected[0], expected[1])])
    assert_orientation(arm.pose.bones[name].rotation_quaternion, midpoint)
    assert [r for r in before if 'untouched' in r[0]] == [r for r in snapshot(action) if 'untouched' in r[0]]
    assert result['samples'] == 3
    passed.append('escaped names, arbitrary axis, evaluated keys/midframe and untouched curves')
    before = snapshot(action)
    scale_action_rotations(action, [name], 1)
    assert before == snapshot(action)
    passed.append('gain one preserves exact curves and handles')
    scale_action_rotations(action, [name], 0)
    for i in range(3):
        bpy.context.scene.frame_set(i)
        assert_orientation(arm.pose.bones[name].rotation_quaternion, Quaternion((1, 0, 0, 0)))
    passed.append('gain zero returns rest')
    arm, action = fixture([Quaternion((0, 1, 0), math.radians(d)) for d in (179, 181)])
    before = snapshot(action)
    try:
        scale_action_rotations(action, [name], .3)
    except ValueError as exc:
        assert 'branch' in str(exc)
    else:
        raise AssertionError('Branch crossing accepted')
    assert before == snapshot(action)
    passed.append('branch crossing rejected without edits')
    arm, action = fixture([Quaternion((0, 1, 0), math.pi)])
    before = snapshot(action)
    try:
        scale_action_rotations(action, [name], .3)
    except ValueError as exc:
        assert 'half-turn' in str(exc)
    else:
        raise AssertionError('Half-turn accepted')
    assert before == snapshot(action)
    scale_action_rotations(action, [name], 1)
    assert before == snapshot(action)
    passed.append('float32 half-turn rejected without edits; gain one unchanged')
    arm, action = fixture(qs)
    before = snapshot(action)
    try:
        scale_action_rotations(action, [name, 'absent'], .3)
    except ValueError as exc:
        assert 'Missing' in str(exc)
    else:
        raise AssertionError('Missing bone accepted')
    assert before == snapshot(action)
    passed.append('missing selected track rejected without edits')
    report = {'blender': bpy.app.version_string, 'passed': passed}
    if args.asset:
        before_actions = set(bpy.data.actions)
        before_objects = set(bpy.data.objects)
        bpy.ops.import_scene.gltf(filepath=str(Path(args.asset).resolve()))
        rigs = [o for o in set(bpy.data.objects)-before_objects if o.type == 'ARMATURE']
        assert len(rigs) == 1
        rig = rigs[0]
        summaries = []
        for action in set(bpy.data.actions)-before_actions:
            original = snapshot(action)
            paths = {c.data_path for c in curves(action)}
            names = [b.name for b in rig.pose.bones if b.path_from_id('rotation_quaternion') in paths]
            if not names:
                continue
            scale_action_rotations(action, names, 1)
            assert snapshot(action) == original
            copied = action.copy()
            result = scale_action_rotations(copied, names, .3)
            source = { (c.data_path, c.array_index): c for c in curves(action) }
            styled = { (c.data_path, c.array_index): c for c in curves(copied) }
            for name in names:
                path = rig.pose.bones[name].path_from_id('rotation_quaternion')
                for i in range(len(source[path, 0].keyframe_points)):
                    q = Quaternion([source[path, k].keyframe_points[i].co.y for k in range(4)]).normalized()
                    if q.w < 0: q.negate()
                    expected = Quaternion((1, 0, 0, 0)).slerp(q, .3)
                    actual = Quaternion([styled[path, k].keyframe_points[i].co.y for k in range(4)])
                    assert_orientation(actual, expected)
            assert snapshot(action) == original
            summaries.append({'action': action.name, **result})
        assert summaries
        report['asset'] = {'sha256': hashlib.sha256(Path(args.asset).read_bytes()).hexdigest(),
                           'actions': sorted(summaries, key=lambda r: r['action'])}
    Path(args.report).write_text(json.dumps(report, indent=2) + '\n', encoding='utf-8')
    print(json.dumps(report))


if __name__ == '__main__':
    main()
