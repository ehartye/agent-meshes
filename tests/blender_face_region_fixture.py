"""Anatomical face ownership survives GLB export and vertex splitting."""
from agent_meshes_author import make_mesh, material, shape_key, mark_face_region


def build():
    vertices = [(x, y, z) for z in (0, 1) for x, y in ((-1, -1), (1, -1), (1, 1), (-1, 1))]
    faces = [(0, 3, 2, 1), (4, 5, 6, 7)]
    faces += [(j, (j + 1) % 4, (j + 1) % 4 + 4, j + 4) for j in range(4)]
    obj = make_mesh('combined-skin', vertices, faces, material('skin', (.5, .3, .2)))
    # Sharp normals cause the exporter to split shared corners into multiple vertices.
    for polygon in obj.data.polygons:
        polygon.use_smooth = False
    mark_face_region(obj, [4, 5, 6, 7])
    before = [v.value for v in obj.data.attributes['_FACE_REGION'].data]
    for invalid in ([True], [-1], [8], [2.5], [4, '5']):
        try:
            mark_face_region(obj, invalid)
        except ValueError:
            pass
        else:
            raise AssertionError('Invalid face region accepted')
        assert [v.value for v in obj.data.attributes['_FACE_REGION'].data] == before
    shape_key(obj, 'jawOpen', [(x, y - .02 if z else y, z) for x, y, z in vertices])
    return [obj]
