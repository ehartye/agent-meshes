"""Normal build() proof: native arrays and an exported opaque RGBA/UV seam."""
import json
from pathlib import Path

import bpy
from agent_meshes_author import make_mesh, material, mesh_from_arrays

EXPORT_VERTEX_COLOR = 'ACTIVE'
EXPORT_ALL_VERTEX_COLORS = False
VERTICES = [(0, 0, 0), (2, 0, 0), (0, 3, 0), (2, 3, 0)]
FACES = [(0, 1, 2), (1, 3, 2)]
UVS = [(.1, .2), (.9, .2), (.1, .8), (.3, .4), (.7, .8), (.2, .9)]
COLORS = [(.1, .2, .3, .25), (.3, .4, .5, .5), (.6, .7, .8, .75),
          (.8, .2, .1, 1), (.5, .2, .4, .4), (.2, .8, .6, .6)]


def close(actual, expected):
    assert len(actual) == len(expected)
    assert all(abs(a-b) < 1e-6 for a, b in zip(actual, expected)), (actual, expected)


def build():
    sentinel = bpy.data.objects.new('Existing scene object', None)
    bpy.context.collection.objects.link(sentinel)
    sentinel.select_set(True)
    bpy.context.view_layer.objects.active = sentinel
    before_selection = tuple(bpy.context.selected_objects)
    mat = material('Opaque ink', (.8, .7, .6))
    obj = mesh_from_arrays('Array surface', VERTICES, FACES, mat,
        corner_uvs=UVS, colors=COLORS, uv_origin='TOP_LEFT',
        coordinate_space='GLTF', uv_name='InkUV', color_name='Wear')
    mesh = obj.data
    assert tuple(bpy.context.selected_objects) == before_selection
    assert bpy.context.view_layer.objects.active == sentinel
    assert len(mesh.vertices) == 4 and len(mesh.loops) == 6
    assert len(mesh.materials) == 1 and mesh.materials[0] == mat
    assert all(not face.use_smooth and face.material_index == 0 for face in mesh.polygons)
    for vertex, (x, y, z) in zip(mesh.vertices, VERTICES): close(vertex.co, (x, -z, y))
    for item, (u, v) in zip(mesh.uv_layers['InkUV'].data, UVS): close(item.uv, (u, 1-v))
    paint = mesh.color_attributes['Wear']
    assert paint.domain == 'CORNER' and paint.data_type == 'FLOAT_COLOR'
    assert mesh.color_attributes.render_color_index == 0
    for item, color in zip(paint.data, COLORS): close(item.color, color)

    point = mesh_from_arrays('Point colors', VERTICES, FACES,
        colors=COLORS[:4], color_domain='POINT', smooth=True)
    assert point.data.color_attributes['Color'].domain == 'POINT'
    assert all(face.use_smooth for face in point.data.polygons)
    for item, color in zip(point.data.color_attributes['Color'].data, COLORS[:4]): close(item.color, color)
    for vertex, expected in zip(point.data.vertices, VERTICES): close(vertex.co, expected)
    bpy.data.objects.remove(point, do_unlink=True)
    bpy.data.meshes.remove(bpy.data.meshes['Point colors'])

    # The original helper retains its quad-smooth, triangle-flat behavior.
    legacy = make_mesh('Legacy shading', VERTICES, [(0, 1, 3, 2), (0, 1, 2)], mat)
    assert [face.use_smooth for face in legacy.data.polygons] == [True, False]
    legacy_data = legacy.data
    bpy.data.objects.remove(legacy, do_unlink=True)
    bpy.data.meshes.remove(legacy_data)
    for vertices in [[], [(0, 0, 0)]]:
        legacy = make_mesh('Legacy point-only input', vertices, [])
        assert len(legacy.data.vertices) == len(vertices) and not legacy.data.polygons
        legacy_data = legacy.data
        bpy.data.objects.remove(legacy, do_unlink=True)
        bpy.data.meshes.remove(legacy_data)

    def state():
        return (tuple(bpy.data.objects), tuple(bpy.data.meshes), tuple(bpy.data.materials),
                tuple(bpy.context.selected_objects), bpy.context.view_layer.objects.active,
                tuple(tuple(item.color) for item in paint.data))
    before = state()
    invalid = [dict(vertices=[(0, 0, 1e300)] * 4), dict(faces=[(0, 1, 4)]),
               dict(corner_uvs=UVS[:-1]), dict(colors=COLORS[:-1]),
               dict(colors=[(0, 0, 0, float('nan'))] * 6),
               dict(colors=[(0, 0, 0, -1)] * 6), dict(material=object()),
               dict(uv_name='Wear'), dict(smooth=1)]
    for changes in invalid:
        try:
            mesh_from_arrays(**(dict(name='Rejected', vertices=VERTICES, faces=FACES,
                corner_uvs=UVS, colors=COLORS, color_name='Wear') | changes))
        except ValueError: pass
        else: raise AssertionError('Invalid arrays accepted: ' + str(changes))
        assert state() == before, 'Invalid input changed the existing scene'

    Path(str(__file__) + '.native.json').write_text(json.dumps({
        'blender': bpy.app.version_string,
        'nativeColor': {'type': paint.data_type, 'domain': paint.domain,
                        'values': [list(item.color) for item in paint.data]},
        'nativeUVs': [list(item.uv) for item in mesh.uv_layers['InkUV'].data],
        'pointColorPreserved': True, 'legacyShadingPreserved': True,
        'legacyEmptyAndPointOnlyPreserved': True,
        'invalidCases': len(invalid), 'priorScenePreserved': True,
        'selectionPreserved': True,
    }, indent=2) + '\n', encoding='utf-8')
    return [obj]
