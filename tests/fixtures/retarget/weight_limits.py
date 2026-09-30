"""An anatomical weight limit must keep collarbone motion out of a chin."""
import bpy
from mathutils import Vector
from agent_meshes_retarget import restrict_weights, make_rigid


def build():
    bpy.ops.object.armature_add()
    arm = bpy.context.object
    bpy.ops.object.mode_set(mode='EDIT')
    neck = arm.data.edit_bones[0]; neck.name = 'neck'
    neck.head = (0, 0, 1); neck.tail = (0, 0, 1.4)
    head = arm.data.edit_bones.new('head')
    head.head = neck.tail; head.tail = (0, 0, 1.8); head.parent = neck
    clavicle = arm.data.edit_bones.new('clavicle')
    clavicle.head = (0, 0, 1); clavicle.tail = (.4, 0, 1)
    for i in range(2, 5):
        extra = arm.data.edit_bones.new(f'clavicle{i}')
        extra.head = (0, i * .01, 1); extra.tail = (.4, i * .01, 1)
    bpy.ops.object.mode_set(mode='OBJECT')
    points = [(-.02, -.1, z) for z in (.9, 1.1, 1.3, 1.5)] + [(.02, -.1, 1.1), (.02, -.1, 1.04)]
    mesh = bpy.data.meshes.new('skin'); mesh.from_pydata(points, [], [(0, 1, 2), (1, 2, 3), (0, 4, 5)])
    body = bpy.data.objects.new('body', mesh); bpy.context.collection.objects.link(body)
    for name in ('clavicle', 'neck', 'head'): body.vertex_groups.new(name=name)
    body.vertex_groups['clavicle'].add([0, 1, 2], 1, 'REPLACE')
    for name, weight in [('clavicle', .5), ('neck', .2), ('head', .3)]:
        body.vertex_groups[name].add([3], weight, 'REPLACE')
    for name in ['clavicle', 'clavicle2', 'clavicle3', 'clavicle4']:
        group = body.vertex_groups.get(name) or body.vertex_groups.new(name=name)
        group.add([5], .25, 'REPLACE')
    restrict_weights(body, ['neck', 'head'], 'neck', (0, 0, 1), (0, 0, 1), band=.2)
    weights = [{body.vertex_groups[g.group].name: g.weight for g in v.groups} for v in body.data.vertices]
    assert weights[0].get('clavicle', 0) == 1, weights[0]
    assert abs(weights[1].get('clavicle', 0) - .5) < 1e-5, weights[1]
    assert weights[2].get('clavicle', 0) == 0, weights[2]
    assert abs(weights[2].get('neck', 0) - 1) < 1e-5, weights[2]
    assert abs(weights[3].get('neck', 0) - .4) < 1e-5, weights[3]
    assert abs(weights[3].get('head', 0) - .6) < 1e-5, weights[3]
    assert weights[4].get('neck', 0) == 1, 'Unweighted skin must get a normalized fallback even in the feather'
    assert len([w for w in weights[5].values() if w > 0]) <= 4, 'The anatomical fallback must survive four-influence export'
    assert abs(weights[5].get('neck', 0) - .104) < 1e-5, weights[5]
    assert all(abs(sum(w.values()) - 1) < 1e-5 for w in weights)
    body.parent = arm
    mod = body.modifiers.new('skin', 'ARMATURE'); mod.object = arm
    arm.pose.bones['clavicle'].rotation_mode = 'XYZ'
    arm.pose.bones['clavicle'].rotation_euler.z = 1
    bpy.context.view_layer.update()
    evaluated = body.evaluated_get(bpy.context.evaluated_depsgraph_get()).to_mesh()
    try:
        for i in (2, 3):
            assert (evaluated.vertices[i].co - Vector(points[i])).length < 1e-6, 'Collarbone pulled the protected chin'
        assert (evaluated.vertices[0].co - Vector(points[0])).length > .01, 'Test motion must move unrestricted skin'
    finally:
        body.evaluated_get(bpy.context.evaluated_depsgraph_get()).to_mesh_clear()
    # A later rigid override must likewise retain its blend share within four slots.
    make_rigid(body, 'head', (0, 0, 1), (0, 0, 1), band=.2)
    weights = {body.vertex_groups[g.group].name: g.weight for g in body.data.vertices[5].groups if g.weight > 0}
    assert len(weights) <= 4, weights
    assert abs(weights.get('head', 0) - .2) < 1e-5, weights
    return [body, arm]
