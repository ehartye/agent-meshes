"""Limb isolation must exclude remote trunk influences, not just other limbs."""
import bpy
from agent_meshes_retarget import exclusive_regions


def build():
    bpy.ops.object.armature_add()
    arm = bpy.context.object
    bpy.ops.object.mode_set(mode='EDIT')
    trunk = arm.data.edit_bones[0]; trunk.name = 'spine'
    trunk.head = (0, 0, 0); trunk.tail = (0, 0, 1)
    limb = arm.data.edit_bones.new('upperarm')
    limb.head = (0, 0, 1); limb.tail = (1, 0, 1); limb.parent = trunk
    bpy.ops.object.mode_set(mode='OBJECT')
    vertices, faces = [], []
    for i in range(101):
        t = i / 50
        x, z = max(0, t - 1), min(1, t)
        vertices.extend([(x, -.03, z), (x, .03, z)])
    for i in range(100):
        a = 2 * i; faces.append((a, a + 1, a + 3, a + 2))
    mesh = bpy.data.meshes.new('skin'); mesh.from_pydata(vertices, [], faces)
    body = bpy.data.objects.new('body', mesh); bpy.context.collection.objects.link(body)
    spine = body.vertex_groups.new(name='spine')
    upper = body.vertex_groups.new(name='upperarm')
    for i in range(101):
        weight = .85 * min(1, max(0, (i / 50 - .8) / .4))
        spine.add([2 * i, 2 * i + 1], 1 - weight, 'REPLACE')
        upper.add([2 * i, 2 * i + 1], weight, 'REPLACE')
    exclusive_regions(body, arm, [['upperarm']])
    for v in body.data.vertices:
        weights = {body.vertex_groups[g.group].name: g.weight for g in v.groups}
        assert abs(sum(weights.values()) - 1) < 1e-5
        if v.co.x > .5:
            assert weights.get('spine', 0) < 1e-6, f'Remote trunk weight survived on limb: {weights}'
            assert weights.get('upperarm', 0) > .999
    junction = {body.vertex_groups[g.group].name: g.weight for g in body.data.vertices[100].groups}
    assert junction.get('spine', 0) > 0 and junction.get('upperarm', 0) > 0, 'The attachment must retain a blend'
    body.parent = arm
    mod = body.modifiers.new('skin', 'ARMATURE'); mod.object = arm
    return [body, arm]
