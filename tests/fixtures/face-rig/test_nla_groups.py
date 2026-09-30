"""An object and its shape keys contribute to the same exported clip."""
import bpy
from agent_meshes_author import shape_key

EXPORT_ANIMATION_MODE = 'NLA_TRACKS'


def build():
    bpy.ops.mesh.primitive_cube_add(size=1)
    obj = bpy.context.object
    key = shape_key(obj, 'expression', [(v.co.x, v.co.y, v.co.z*1.2) for v in obj.data.vertices])
    obj.location.x=0;obj.keyframe_insert('location',frame=0)
    obj.location.x=1;obj.keyframe_insert('location',frame=24)
    action=obj.animation_data.action;obj.animation_data.action=None
    track=obj.animation_data.nla_tracks.new();track.name='idle';track.strips.new(action.name,0,action)
    key.value=0;key.keyframe_insert('value',frame=0)
    key.value=1;key.keyframe_insert('value',frame=12)
    key.value=0;key.keyframe_insert('value',frame=24)
    data=obj.data.shape_keys.animation_data;action=data.action;data.action=None
    track=data.nla_tracks.new();track.name='idle';track.strips.new(action.name,0,action)
    return [obj]
