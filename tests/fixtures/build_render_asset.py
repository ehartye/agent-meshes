"""A one-bone skinned column with two animation clips, for the build render proof."""
import bpy
from agent_meshes_author import bind_skin, make_mesh, material

EXPORT_ANIMATION_MODE = 'NLA_TRACKS'


def clip(rig, name, axis, angle):
    rig.animation_data_create()
    pose_bone = rig.pose.bones['root']
    pose_bone.rotation_mode = 'XYZ'
    for frame, value in ((0, 0.0), (12, angle), (24, 0.0)):
        pose_bone.rotation_euler = (value if axis == 0 else 0, 0, value if axis == 2 else 0)
        pose_bone.keyframe_insert('rotation_euler', frame=frame)
    action = rig.animation_data.action
    action.name = name
    rig.animation_data.action = None
    track = rig.animation_data.nla_tracks.new()
    track.name = name
    track.strips.new(name, 0, action)


def build():
    data = bpy.data.armatures.new('Column bones')
    rig = bpy.data.objects.new('Column rig', data)
    bpy.context.collection.objects.link(rig)
    bpy.context.view_layer.objects.active = rig
    rig.select_set(True)
    bpy.ops.object.mode_set(mode='EDIT')
    root = data.edit_bones.new('root')
    root.head, root.tail = (0, 0, 0), (0, 0, 1)
    bpy.ops.object.mode_set(mode='OBJECT')
    vertices = [(x, y, z) for z in (0, 1) for x, y in ((-.2, -.2), (.2, -.2), (.2, .2), (-.2, .2))]
    faces = [(0, 3, 2, 1), (4, 5, 6, 7)] + [(j, (j + 1) % 4, 4 + (j + 1) % 4, 4 + j) for j in range(4)]
    column = make_mesh('Column', vertices, faces, material('Clay', (.6, .4, .3)))
    bind_skin(column, rig, [{'root': 1.0} for _ in vertices])
    clip(rig, 'Sway', 0, 0.5)
    clip(rig, 'Turn', 2, 0.8)
    return [rig, column]
