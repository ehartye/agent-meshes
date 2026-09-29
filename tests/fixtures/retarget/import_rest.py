"""A GLB's initial animation frame must never become the rig fitting rest pose."""
from pathlib import Path
import tempfile
import bpy
from mathutils import Quaternion
from agent_meshes_author import export_glb
from agent_meshes_retarget import import_reference


def build():
    bpy.ops.object.armature_add()
    arm = bpy.context.object
    arm.name = 'reference'
    bpy.ops.mesh.primitive_cube_add(size=.2)
    body = bpy.context.object
    body.vertex_groups.new(name='Bone').add(list(range(8)), 1, 'REPLACE')
    mod = body.modifiers.new('rig', 'ARMATURE'); mod.object = arm
    body.parent = arm
    pb = arm.pose.bones['Bone']
    pb.rotation_mode = 'QUATERNION'
    for frame, angle in [(1, .8), (10, 1.1)]:
        pb.rotation_quaternion = Quaternion((1, 0, 0), angle)
        pb.location = (.1, .2, .3)
        pb.scale = (1.2, 1.2, 1.2)
        for prop in ('rotation_quaternion', 'location', 'scale'):
            pb.keyframe_insert(prop, frame=frame)
    arm.animation_data.action.name = 'bent'
    bpy.context.scene.frame_set(1)
    with tempfile.TemporaryDirectory() as d:
        file = Path(d) / 'reference.glb'
        export_glb(file, [body, arm])
        bpy.ops.wm.read_factory_settings(use_empty=True)
        imported, meshes, actions = import_reference(file)
    assert 'bent' in actions, 'Resetting the reference must preserve its animation library'
    for bone in imported.pose.bones:
        error = max(abs(bone.matrix_basis[i][j] - (1 if i == j else 0)) for i in range(4) for j in range(4))
        assert error < 1e-5, f'Imported animation leaked into fitting rest: {bone.name}, matrix error {error}'
    # Its action remains playable after the rest reset.
    imported.animation_data.action = actions['bent']
    bpy.context.scene.frame_set(5)
    assert abs(imported.pose.bones['Bone'].rotation_quaternion.angle) > .5
    imported.animation_data.action = None
    return [*meshes, imported]
