"""Real Blender binding, failure atomicity, transform and exported-animation proof."""
import math
import bpy
from mathutils import Matrix
from agent_meshes_author import bind_skin, make_mesh, material


def build():
    data = bpy.data.armatures.new('Proof bones')
    rig = bpy.data.objects.new('Proof rig', data)
    bpy.context.collection.objects.link(rig)
    bpy.context.view_layer.objects.active = rig
    rig.select_set(True)
    bpy.ops.object.mode_set(mode='EDIT')
    root = data.edit_bones.new('root'); root.head = (0, 0, 0); root.tail = (0, 0, 1)
    tip = data.edit_bones.new('tip'); tip.head = (0, 0, 1); tip.tail = (0, 0, 2); tip.parent = root
    helper = data.edit_bones.new('control'); helper.head = (1, 0, 0); helper.tail = (1, 0, 1); helper.use_deform = False
    bpy.ops.object.mode_set(mode='OBJECT')
    vertices = [(x, y, z) for z in (0, .7, 1.3, 2) for x, y in ((-.2,-.2),(.2,-.2),(.2,.2),(-.2,.2))]
    faces = [(0,3,2,1), (12,13,14,15)]
    faces += [(i*4+j, i*4+(j+1)%4, (i+1)*4+(j+1)%4, (i+1)*4+j) for i in range(3) for j in range(4)]
    mesh = make_mesh('Bound surface', vertices, faces, material('Skin', (.16,.42,.6)))
    transform = Matrix.Translation((2,-1,.4)) @ Matrix.Rotation(.2, 4, 'Z') @ Matrix.Diagonal((1.1,.9,1.3,1))
    rig.matrix_world = transform; mesh.matrix_world = transform
    weights = [{'root': 1-z/2, 'tip': z/2} for _, _, z in vertices]

    def snapshot():
        return (mesh.parent, tuple(g.name for g in mesh.vertex_groups), tuple(m.name for m in mesh.modifiers),
                tuple(tuple(row) for row in mesh.matrix_world), tuple(tuple((g.group,g.weight) for g in v.groups) for v in mesh.data.vertices))

    def rejects(rows=weights, obj=mesh, arm=rig):
        before = snapshot()
        try: bind_skin(obj, arm, rows)
        except ValueError: pass
        else: raise AssertionError('Expected invalid binding rejection')
        assert snapshot() == before, 'Rejected binding mutated existing state'

    bpy.context.view_layer.update()
    rejects(weights[:-1]); rejects([{'control': 1}] * len(vertices)); rejects([{}] * len(vertices))
    rejects(obj=rig); rejects(arm=mesh)
    collision = mesh.vertex_groups.new(name='tip'); rejects(); mesh.vertex_groups.remove(collision)
    conflict = mesh.modifiers.new('Existing', 'ARMATURE'); rejects(); mesh.modifiers.remove(conflict)
    constraint = mesh.constraints.new('LIMIT_LOCATION'); rejects(); mesh.constraints.remove(constraint)
    rig.parent = mesh; rejects(); rig.parent = None; rig.matrix_world = transform
    bpy.context.view_layer.objects.active = rig
    bpy.ops.object.mode_set(mode='POSE'); rejects(); bpy.ops.object.mode_set(mode='OBJECT')
    mesh.parent = rig; bpy.context.view_layer.update(); rejects(); mesh.parent = None; mesh.matrix_world = transform
    rig.scale.z = 0; bpy.context.view_layer.update(); rejects(); rig.matrix_world = transform
    alias = bpy.data.objects.new('Shared mesh', mesh.data); bpy.context.collection.objects.link(alias)
    rejects(); bpy.data.objects.remove(alias, do_unlink=True)
    unrelated = mesh.vertex_groups.new(name='Paint mask'); unrelated.add([0], .37, 'REPLACE')
    bpy.context.view_layer.update()
    before = mesh.matrix_world.copy()
    modifier = bind_skin(mesh, rig, weights)
    bpy.context.view_layer.update()
    assert modifier.object == rig and mesh.parent == rig
    assert max(abs(before[i][j]-mesh.matrix_world[i][j]) for i in range(4) for j in range(4)) < 1e-6
    assert abs(unrelated.weight(0)-.37) < 1e-6
    for vertex, row in zip(mesh.data.vertices, weights):
        for name, value in row.items():
            if value: assert abs(mesh.vertex_groups[name].weight(vertex.index)-value) < 1e-6
    rejects()  # Rebinding must not overwrite authored weights or add a modifier.
    tip_pose = rig.pose.bones['tip']; tip_pose.rotation_mode = 'XYZ'
    for frame, angle in [(1, 0), (25, math.pi/3), (49, 0)]:
        tip_pose.rotation_euler.x = angle; tip_pose.keyframe_insert('rotation_euler', frame=frame)
    bpy.context.scene.frame_end = 49
    bpy.context.scene.frame_set(1)
    print('PASS bind_skin: invalid inputs unchanged, normalized groups, preserved world, animation fixture')
    return [mesh, rig]
