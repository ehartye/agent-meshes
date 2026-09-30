"""Changing an arm's neutral must carry its children without erasing an artist's grip."""
import bpy
from mathutils import Matrix, Quaternion
from agent_meshes_retarget import retarget, world_frames


def build():
    bpy.ops.object.armature_add()
    source = bpy.context.object
    bpy.ops.object.mode_set(mode='EDIT')
    root = source.data.edit_bones[0]; root.name = 'pelvis'
    upper = source.data.edit_bones.new('upperarm'); upper.parent = root
    upper.head = (0, 1, 0); upper.tail = (0, 2, 0)
    finger = source.data.edit_bones.new('finger'); finger.parent = upper
    finger.head = (0, 2, 0); finger.tail = (0, 2.2, 0)
    bpy.ops.object.mode_set(mode='OBJECT')
    target = bpy.data.objects.new('target', source.data.copy()); bpy.context.collection.objects.link(target)
    for name, axis, angles in [('upperarm', (1, 0, 0), (.5, .9)), ('finger', (0, 0, 1), (.7, 1.1))]:
        p = source.pose.bones[name]; p.rotation_mode = 'QUATERNION'
        for frame, angle in zip((0, 4), angles):
            p.rotation_quaternion = Quaternion(axis, angle)
            p.keyframe_insert('rotation_quaternion', frame=frame)
    action = source.animation_data.action
    bpy.context.scene.frame_set(0)
    source_frames = world_frames(source, ['upperarm', 'finger'])
    target_frame = source.data.bones['upperarm'].matrix_local.to_3x3()
    calibration = {'source': {'upperarm': source_frames['upperarm']}, 'target': {'upperarm': target_frame}}
    baked = retarget(source, target, action, neutral=calibration)
    source.animation_data.action = action
    target.animation_data.action = baked
    for frame in (0, 1, 2, 3, 4):
        bpy.context.scene.frame_set(frame); bpy.context.view_layer.update()
        reference = world_frames(source, ['upperarm', 'finger'])
        frames = world_frames(target, ['upperarm', 'finger'])
        expected = reference['upperarm'].inverted() @ reference['finger']
        actual = frames['upperarm'].inverted() @ frames['finger']
        error = actual.to_quaternion().rotation_difference(expected.to_quaternion()).angle
        assert error < 1e-4, f'Neutral calibration changed child articulation at {frame} by {error} radians'
    bpy.ops.mesh.primitive_cube_add(size=.1)
    return [bpy.context.object, target]
