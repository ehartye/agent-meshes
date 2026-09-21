"""Optional real-Blender integration fixture; run through authorGLB, not plain Python.

build() tests fusion boundaries, then returns a transformed overlapping result
for the caller to export and validate as GLB. No Blender is needed in CI.
"""
import bpy
from mathutils import Matrix, Vector
from agent_meshes_author import fuse_meshes, make_mesh, shape_key, topology_report


def cube(name, position, scale=(1,1,1)):
    bpy.ops.mesh.primitive_cube_add(size=1, location=position)
    obj = bpy.context.object
    obj.name = name
    obj.scale = scale
    return obj


def report(obj):
    return topology_report([tuple(v.co) for v in obj.data.vertices], [tuple(p.vertices) for p in obj.data.polygons])


def rejects(call, message):
    try:
        call()
    except ValueError as error:
        assert message.lower() in str(error).lower(), str(error)
    else:
        raise AssertionError(f'Expected rejection: {message}')


def build():
    vertices = [(-.5,-.5,-.5),(.5,-.5,-.5),(.5,.5,-.5),(-.5,.5,-.5),
                (-.5,-.5,.5),(.5,-.5,.5),(.5,.5,.5),(-.5,.5,.5)]
    faces = [(0,3,2,1),(4,5,6,7),(0,1,5,4),(1,2,6,5),(2,3,7,6),(3,0,4,7)]
    # No operator or explicit view-layer refresh between data linking and fusion.
    fresh = make_mesh('Fresh linked cube', vertices, faces)
    fresh.location.x = 3
    fused_fresh = fuse_meshes([fresh], 'Fresh fused cube', .1)
    fresh_report = report(fused_fresh)
    assert fresh_report['components'] == 1, fresh_report
    assert 2.3 < min(v.co.x for v in fused_fresh.data.vertices) < 2.7
    assert 3.3 < max(v.co.x for v in fused_fresh.data.vertices) < 3.7
    bpy.data.objects.remove(fused_fresh, do_unlink=True)

    unlinked = make_mesh('Truly unlinked cube', vertices, faces)
    bpy.context.collection.objects.unlink(unlinked)
    before_unlinked = set(bpy.data.objects.keys())
    rejects(lambda: fuse_meshes([unlinked], 'Rejected', .1), 'active view layer')
    assert set(bpy.data.objects.keys()) == before_unlinked
    assert len(unlinked.data.vertices) == 8
    bpy.data.objects.remove(unlinked, do_unlink=True)

    morph = cube('Morph input', (0,0,0))
    other = cube('Other input', (.5,0,0))
    shape_key(morph, 'Stretch', [tuple(v.co * 1.2) for v in morph.data.vertices])
    before = set(bpy.data.objects.keys())
    rejects(lambda: fuse_meshes([other,morph], 'Rejected', .1), 'shape key')
    assert set(bpy.data.objects.keys()) == before, 'Morph rejection must precede destructive joining'
    assert other.data.vertices[0].co.x == -.5
    bpy.data.objects.remove(morph, do_unlink=True)
    modifier = other.modifiers.new('Unresolved', 'SUBSURF')
    rejects(lambda: fuse_meshes([other], 'Rejected', .1), 'modifier')
    other.modifiers.remove(modifier)
    attachment = bpy.data.objects.new('Unowned attachment', None)
    bpy.context.collection.objects.link(attachment)
    attachment.parent = other
    rejects(lambda: fuse_meshes([other], 'Rejected', .1), 'children')
    assert attachment.parent == other
    bpy.data.objects.remove(attachment, do_unlink=True)
    for voxel in [0, -.1, float('inf'), float('nan')]:
        rejects(lambda: fuse_meshes([other], 'Rejected', voxel), 'voxel')
    for passes in [-1, 1.5, True, 51]:
        rejects(lambda: fuse_meshes([other], 'Rejected', .1, smooth_passes=passes), 'smooth')
    rejects(lambda: fuse_meshes([other], 'Rejected', 1e-8), 'voxel')
    rejects(lambda: fuse_meshes([other,other], 'Rejected', .1), 'duplicate')
    bpy.data.objects.remove(other, do_unlink=True)

    left, right = cube('Separate L', (-3,0,0)), cube('Separate R', (3,0,0))
    rejects(lambda: fuse_meshes([left,right], 'Disconnected', .1, smooth_passes=0), 'components')
    disconnected = bpy.data.objects['Disconnected']
    assert report(disconnected) == {'components': 2, 'boundary_edges': 0, 'nonmanifold_edges': 0}
    disconnected = fuse_meshes([disconnected], 'Allowed components', .1, smooth_passes=0, expected_components=None)
    assert report(disconnected)['components'] == 2
    bpy.data.objects.remove(disconnected, do_unlink=True)

    for sign in [1, -1]:
        sheared_parent = bpy.data.objects.new('Shear parent', None)
        bpy.context.collection.objects.link(sheared_parent)
        sheared_parent.scale = (sign*3,.7,1)
        sheared_parent.rotation_euler.z = .35
        child = cube('Sheared child', (0,0,0))
        child.parent = sheared_parent
        child.rotation_euler.z = .78
        bpy.context.view_layer.update()
        original = [child.matrix_world @ Vector(corner) for corner in child.bound_box]
        expected_low = [min(p[i] for p in original) for i in range(3)]
        expected_high = [max(p[i] for p in original) for i in range(3)]
        # This acute sheared solid needs .02 voxels to retain one component;
        # coarser grids can create detached corner fragments, which must fail.
        result = fuse_meshes([child], 'Reflected shear' if sign < 0 else 'Shear', .02, smooth_passes=0)
        actual_low = [min(v.co[i] for v in result.data.vertices) for i in range(3)]
        actual_high = [max(v.co[i] for v in result.data.vertices) for i in range(3)]
        assert all(abs(a-b) < .04 for a,b in zip(actual_low+actual_high, expected_low+expected_high)), (sign, actual_low, actual_high, expected_low, expected_high)
        volume = 0
        for face in result.data.polygons:
            points = [result.data.vertices[i].co for i in face.vertices]
            for i in range(1,len(points)-1): volume += points[0].dot(points[i].cross(points[i+1]))/6
        assert volume > 0, ('Outward winding must survive reflection', sign, volume)
        assert report(result) == {'components': 1, 'boundary_edges': 0, 'nonmanifold_edges': 0}
        bpy.data.objects.remove(result, do_unlink=True)
        bpy.data.objects.remove(sheared_parent, do_unlink=True)

    # Parent transform, nonuniform scale and rotation must be baked into the
    # fusion frame; sharing input mesh data must not alter an unrelated object.
    parent = bpy.data.objects.new('Parent', None)
    bpy.context.collection.objects.link(parent)
    parent.location = (10,0,0)
    first = cube('Transformed A', (0,0,0), (2,1,1))
    first.parent = parent
    second = cube('Transformed B', (10.6,0,0), (1,1.5,1))
    second.rotation_euler.z = .3
    untouched = bpy.data.objects.new('Untouched shared mesh', first.data)
    bpy.context.collection.objects.link(untouched)
    old_vertices = [tuple(v.co) for v in untouched.data.vertices]
    bpy.ops.object.select_all(action='DESELECT')
    untouched.select_set(True)
    bpy.context.view_layer.objects.active = untouched
    bpy.ops.object.mode_set(mode='EDIT')
    fused = fuse_meshes([first,second], 'Fused sculpture', .075, smooth_passes=2)
    assert fused.name == 'Fused sculpture'
    assert fused.parent is None
    assert all(abs(fused.matrix_world[i][j] - Matrix.Identity(4)[i][j]) < 1e-6 for i in range(4) for j in range(4))
    assert [tuple(v.co) for v in untouched.data.vertices] == old_vertices
    assert report(fused) == {'components': 1, 'boundary_edges': 0, 'nonmanifold_edges': 0}
    xs = [v.co.x for v in fused.data.vertices]
    assert abs(min(xs)-9) < .15 and abs(max(xs)-11.3) < .2, (min(xs), max(xs))
    assert not fused.modifiers and not fused.data.shape_keys
    # Shape keys remain authorable after topology is fixed.
    shape_key(fused, 'Rise', [(v.co.x, v.co.y, v.co.z*1.1) for v in fused.data.vertices])
    return [fused]
