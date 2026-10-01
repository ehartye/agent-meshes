"""Existing eye surfaces gain gaze without changing skin, morphs or body animation."""
import bpy
from agent_meshes_author import (make_mesh, material, bind_skin, shape_key, mark_face_region,
                                 ellipsoid_geometry)
from agent_meshes_sculpt_face import rig_sculpt_eyes


def build():
    data = bpy.data.armatures.new('rig')
    rig = bpy.data.objects.new('rig', data)
    bpy.context.collection.objects.link(rig)
    bpy.context.view_layer.objects.active = rig
    rig.select_set(True)
    bpy.ops.object.mode_set(mode='EDIT')
    root = data.edit_bones.new('spine'); root.head = (0, 0, 0); root.tail = (0, 0, 1)
    head = data.edit_bones.new('head'); head.head = (0, 0, 1.3); head.tail = (0, 0, 1.6); head.parent = root
    bpy.ops.object.mode_set(mode='OBJECT')
    vertices = [(-.08, 0, 1.3), (.08, 0, 1.3), (0, 0, 1.6), (-.1, 0, .5), (.1, 0, .5), (0, 0, 1)]
    faces = [(0, 1, 2), (3, 4, 5)]
    centers = {'L': (.05, -.04, 1.5), 'R': (-.05, -.04, 1.5)}
    selected = {}; eye_faces = []
    for side, center in centers.items():
        geometry = ellipsoid_geometry(center, (.03, .03, .03), rings=12, segments=16)
        offset = len(vertices)
        selected[side] = list(range(offset, offset + len(geometry['vertices'])))
        eye_faces.extend(range(len(faces), len(faces) + len(geometry['faces'])))
        vertices += geometry['vertices']; faces += [tuple(v + offset for v in f) for f in geometry['faces']]
    body = make_mesh('combined-body', vertices, faces, material('skin', '#a87659'))
    body.data.materials.append(material('eye-white', '#ffffff'))
    # Object-linked overrides are the effective surface material, even when the
    # mesh data still points at white. Splitting eye primitives must retain it.
    override = material('eye-white-override-red', '#ff0000')
    body.material_slots[1].link = 'OBJECT'; body.material_slots[1].material = override
    for i in eye_faces: body.data.polygons[i].material_index = 1
    bind_skin(body, rig, [{'spine' if 3 <= i < 6 else 'head': 1} for i in range(len(vertices))])
    mark_face_region(body, [i for i in range(len(vertices)) if not 3 <= i < 6])
    shape_key(body, 'jawOpen', [(x, y, z - .01 if i < 2 else z) for i, (x, y, z) in enumerate(vertices)])
    paint = body.vertex_groups.new(name='artist-mask'); paint.add([0], .4, 'REPLACE')
    parts = {}
    for side, center in centers.items():
        x, y, z = center
        geometry = ellipsoid_geometry((x, y - .024, z), (.009, .003, .009), rings=8, segments=12)
        iris = make_mesh('iris-' + side, geometry['vertices'], geometry['faces'], material('iris', '#44220f'))
        bind_skin(iris, rig, [{'head': 1}] * len(iris.data.vertices)); parts[side] = [iris]
    pose = rig.pose.bones['head']; pose.rotation_mode = 'XYZ'
    for frame, angle in [(1, 0), (10, .2), (20, 0)]:
        pose.rotation_euler.z = angle; pose.keyframe_insert('rotation_euler', frame=frame)
    bpy.context.scene.frame_end = 20; bpy.context.scene.frame_set(1)
    def snapshot():
        return (tuple(data.bones.keys()), tuple(tuple(v.co) for v in body.data.vertices),
                tuple(tuple((g.group, g.weight) for g in v.groups) for v in body.data.vertices),
                tuple(p.material_index for p in body.data.polygons), len(body.data.materials),
                tuple(tuple(v.co) for v in body.data.shape_keys.key_blocks['jawOpen'].data))
    before = snapshot()
    for bad in ({'L': [0], 'R': selected['R']}, {'L': selected['L'], 'R': selected['L']}):
        try: rig_sculpt_eyes(body, rig, bad, centers, parts=parts)
        except ValueError: pass
        else: raise AssertionError('Invalid eye ownership accepted')
        assert snapshot() == before, 'Invalid eye selection mutated rig or skin'
    rig_sculpt_eyes(body, rig, selected, centers, parts=parts)
    after = snapshot()
    assert before[1] == after[1] and before[5] == after[5], 'Eye rig changed sculpt or morph positions'
    assert before[2][:6] == after[2][:6], 'Eye rig changed non-eye weights'
    assert abs(paint.weight(0) - .4) < 1e-6
    assert tuple(data.bones.keys()) == ('spine', 'head', 'eye_L', 'eye_R')
    for i in eye_faces:
        effective = body.material_slots[body.data.polygons[i].material_index].material
        color = lambda mat: tuple(mat.node_tree.nodes.get('Principled BSDF').inputs['Base Color'].default_value)
        assert color(effective) == color(override), 'Eye material override lost'
    for side in centers:
        assert data.bones['eye_' + side].parent.name == 'head'
        for obj, ids in [(body, selected[side])] + [(o, range(len(o.data.vertices))) for o in parts[side]]:
            for i in ids:
                weights = {obj.vertex_groups[g.group].name: g.weight for g in obj.data.vertices[i].groups if g.weight > 1e-7}
                assert weights == {'eye_' + side: 1.0}, weights
    def evaluated_points(obj):
        bpy.context.view_layer.update()
        evaluated = obj.evaluated_get(bpy.context.evaluated_depsgraph_get())
        mesh = evaluated.to_mesh()
        points = [v.co.copy() for v in mesh.vertices]
        evaluated.to_mesh_clear()
        return points
    resting = {obj: evaluated_points(obj) for obj in [body] + parts['L'] + parts['R']}
    for side, opposite in [('L', 'R'), ('R', 'L')]:
        eye_pose = rig.pose.bones['eye_' + side]; eye_pose.rotation_mode = 'XYZ'
        for axis in (0, 1):
            eye_pose.rotation_euler[axis] = .25
            moved = evaluated_points(body)
            assert max((moved[i] - resting[body][i]).length for i in selected[side]) > .005
            assert max((moved[i] - resting[body][i]).length for i in list(range(6)) + selected[opposite]) < 1e-6
            for part in parts[side]:
                assert max((a-b).length for a,b in zip(evaluated_points(part), resting[part])) > .004
            for part in parts[opposite]:
                assert max((a-b).length for a,b in zip(evaluated_points(part), resting[part])) < 1e-6
            eye_pose.rotation_euler[axis] = 0
    bpy.context.view_layer.update()
    # Keep the anatomy declaration separate from the incomplete face contract fixture.
    from agent_meshes_face import EXTRAS_PROPERTY
    rig[EXTRAS_PROPERTY] = '{"arkitFace":{"skeleton":"body"}}'
    return [body, rig] + parts['L'] + parts['R']
