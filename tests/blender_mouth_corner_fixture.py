"""A coarse head must open to the authored width, with shared, stable corners."""
import bpy
from agent_meshes_author import (
    JawHinge, SEAM_ATTRIBUTE, add_jaw_open, ellipsoid_geometry, folded_faces, material,
    mesh_from_geometry, slit_mouth,
)


def build():
    # Distinct close seam vertices must not all snap onto one mouth corner.
    xs, zs = [-.04, 0, .0152551226, .0152556226, .04], [.05, .075, .1]
    vertices = [(x, -.1, z) for z in zs for x in xs]
    faces = []
    for row in range(2):
        for col in range(4):
            a = row * 5 + col
            faces += [(a, a + 1, a + 6), (a, a + 6, a + 5)]
    patch = mesh_from_geometry('close_seam_vertices', {'vertices': vertices, 'faces': faces}, [material('patch', '#c48f70')])
    slit_mouth(patch, .075, .0152556226, front_y=0)
    patch.data.calc_loop_triangles()
    for triangle in patch.data.loop_triangles:
        a, b, c = [patch.data.vertices[i].co for i in triangle.vertices]
        assert (b - a).cross(c - a).length > 1e-15, 'Corner snapping collapsed a valid triangle'
    bpy.data.objects.remove(patch, do_unlink=True)
    last = None
    cases = [(0, .022, 64), (.003, .019, 48), (0, .011, 32)]
    # This width lies on the original coarse seam. Numerical proximity to an
    # existing vertex must not produce a second corner or detach either lip.
    cases += [(0, .0152556226 + offset, 64) for offset in (-1e-8, 0, 1e-8)]
    for center_x, half_width, segments in cases:
        geometry = ellipsoid_geometry((0, 0, .12), (.085, .09, .115), rings=48, segments=segments)
        head = mesh_from_geometry('head_skin', geometry, [material('skin', '#c48f70')])
        slit_mouth(head, .075, half_width, center_x=center_x)
        rest = [tuple(v.co) for v in head.data.vertices]
        faces = [tuple(p.vertices) for p in head.data.polygons]
        owners = {}
        for face in faces:
            for a, b in zip(face, face[1:] + face[:1]):
                edge = tuple(sorted((a, b)))
                owners[edge] = owners.get(edge, 0) + 1
        boundary = {v for edge, count in owners.items() if count == 1 for v in edge}
        assert boundary
        assert all(count <= 2 for count in owners.values()), 'No nonmanifold edges'
        for sign in (-1, 1):
            wanted = center_x + sign * half_width
            actual = (min if sign < 0 else max)(rest[i][0] for i in boundary)
            assert abs(actual - wanted) < 1e-7, (actual, wanted)
            # Nearby interior seam vertices legitimately have separate upper/
            # lower copies. Only the extremum is the shared mouth corner.
            corners = [i for i in boundary if abs(rest[i][0] - actual) < 1e-9]
            assert len(corners) == 1, 'Each corner must join the upper and lower lip'
            assert head.data.attributes[SEAM_ATTRIBUTE].data[corners[0]].value == 0, 'A shared corner belongs to neither lip alone'
        assert all(abs(rest[i][2] - .075) < 1e-7 and rest[i][1] < 0 for i in boundary)
        jaw = JawHinge.ear(geometry['vertices'], .075, half_width, center_x=center_x)
        try:
            add_jaw_open(head, jaw, min_chin_drop=.1)
        except ValueError as error:
            raise AssertionError((center_x, half_width, segments, str(error))) from error
        target = [tuple(p.co) for p in head.data.shape_keys.key_blocks['jawOpen'].data]
        for weight in (.25, .5, .75, 1):
            points = [tuple(a + weight * (b - a) for a, b in zip(p, q)) for p, q in zip(rest, target)]
            assert not folded_faces(rest, points, faces), (segments, weight)
        if last is not None:
            bpy.data.objects.remove(last, do_unlink=True)
        last = head
    return [last]
