"""Small procedural authoring helper. Geometry math is usable without Blender.

Cross sections use parallel-transport frames, positive ellipse radii and closed
caps. Point/ring counts stay fixed so independently evaluated shapes can become
named glTF morph targets. Blender-only helpers import bpy lazily.
"""
import math
from numbers import Integral, Real
from collections.abc import Mapping, Sequence


def _number(value, label):
    if isinstance(value, bool) or not isinstance(value, Real) or not math.isfinite(value):
        raise ValueError(f'{label} must be a finite number')
    return float(value)


def _vector(value, size, label):
    try:
        values = tuple(value)
    except TypeError as exc:
        raise ValueError(f'{label} must contain {size} numbers') from exc
    if len(values) != size:
        raise ValueError(f'{label} must contain {size} numbers')
    return tuple(_number(v, label) for v in values)


def _name(value):
    if not isinstance(value, str) or not value.strip():
        raise ValueError('An object, material or shape key needs a non-empty name')
    return value


def add(a, b): return tuple(x+y for x,y in zip(a,b))
def sub(a, b): return tuple(x-y for x,y in zip(a,b))
def mul(a, s): return tuple(x*s for x in a)
def dot(a, b): return sum(x*y for x,y in zip(a,b))
def cross(a, b): return (a[1]*b[2]-a[2]*b[1], a[2]*b[0]-a[0]*b[2], a[0]*b[1]-a[1]*b[0])
def unit(v):
    length = math.hypot(*v)
    if not math.isfinite(length) or length < 1e-10:
        raise ValueError('Degenerate or overflowing sweep path or frame')
    return mul(v, 1/length)


def topology_report(vertices, faces):
    """Count vertex-connected components and edge incidences, without Blender.

    Boundary edges have one incident face; nonmanifold_edges counts edges with
    more than two. Isolated vertices count as components. This is not a test of
    winding, vertex fans, zero-area faces, geometric intersections or volume.
    """
    vertices = [_vector(v, 3, 'Vertex') for v in vertices]
    parents = list(range(len(vertices)))
    sizes = [1] * len(vertices)
    edges = {}

    def root(index):
        while parents[index] != index:
            parents[index] = parents[parents[index]]
            index = parents[index]
        return index

    for polygon in faces:
        face = tuple(polygon)
        if len(face) < 3 or any(isinstance(i, bool) or not isinstance(i, int) or i < 0 or i >= len(vertices) for i in face):
            raise ValueError('Faces must contain at least three valid integer vertex indices')
        if len(set(face)) != len(face):
            raise ValueError('Faces must not repeat a vertex index')
        for a, b in zip(face, face[1:] + face[:1]):
            edge = (min(a, b), max(a, b))
            edges[edge] = edges.get(edge, 0) + 1
            first, second = root(a), root(b)
            if first != second:
                if sizes[first] < sizes[second]: first, second = second, first
                parents[second] = first
                sizes[first] += sizes[second]
    return {
        'components': len({root(i) for i in range(len(vertices))}),
        'boundary_edges': sum(count == 1 for count in edges.values()),
        'nonmanifold_edges': sum(count > 2 for count in edges.values()),
    }


def normalize_skin_weights(weights, bone_names, vertex_count):
    """Validate and copy dense rows of at most four named skin influences.

    No Blender dependency. Counts include supplied zero entries; missing names
    and negative/nonfinite values are never silently discarded. Normalize using
    the largest weight first, avoiding overflow of otherwise finite inputs.
    """
    if isinstance(vertex_count, bool) or not isinstance(vertex_count, int) or vertex_count < 1:
        raise ValueError('Skin vertex count must be a positive integer')
    if not isinstance(bone_names, (list, tuple, set, frozenset)) or not bone_names:
        raise ValueError('Skin needs a collection of deform bone names')
    names = [_name(name) for name in bone_names]
    if len(set(names)) != len(names): raise ValueError('Duplicate deform bone name')
    names = set(names)
    if not isinstance(weights, Sequence) or isinstance(weights, (str, bytes)) or len(weights) != vertex_count:
        raise ValueError('Skin weights need one dense row per vertex')
    result = []
    for index, row in enumerate(weights):
        if not isinstance(row, Mapping) or not 1 <= len(row) <= 4:
            raise ValueError(f'Skin vertex {index} needs a mapping of 1 to 4 influences')
        values = {}
        for name, weight in row.items():
            if not isinstance(name, str) or name not in names:
                raise ValueError(f'Skin vertex {index} references an unknown deform bone: {name!r}')
            weight = _number(weight, f'Skin vertex {index} weight')
            if weight < 0: raise ValueError(f'Skin vertex {index} has a negative weight')
            values[name] = weight
        largest = max(values.values())
        if largest == 0: raise ValueError(f'Skin vertex {index} has zero total weight')
        scaled = {name: value/largest for name, value in values.items() if value > 0}
        total = math.fsum(scaled.values())
        result.append({name: value/total for name, value in scaled.items() if value > 0})
    return result


def bind_skin(mesh, armature, weights):
    """Bind a local, unparented, single-user mesh to an existing armature.

    All inputs and ownership conflicts are checked before creating groups,
    modifier or parent. Leaves coordinates, selection and mode alone; preserves
    world transform with the inverse parent matrix. Returns the new modifier.
    Existing unrelated groups/modifiers survive. Author weights in the rig's
    rest space; posing the armature deforms the mesh immediately after binding.
    """
    import bpy
    if not isinstance(mesh, bpy.types.Object) or mesh.type != 'MESH':
        raise ValueError('Skin input must be a Blender mesh object')
    if not isinstance(armature, bpy.types.Object) or armature.type != 'ARMATURE':
        raise ValueError('Skin target must be a Blender armature object')
    if mesh.mode != 'OBJECT' or armature.mode != 'OBJECT':
        raise ValueError('Skin binding needs mesh and armature in Object mode')
    if any(obj.library or obj.data.library or obj.override_library for obj in (mesh, armature)):
        raise ValueError('Skin binding needs local editable objects and data')
    if mesh.data.users != 1: raise ValueError('Skin binding needs single-user mesh data')
    if mesh.parent is not None or mesh.constraints:
        raise ValueError('Skin mesh already has a parent or constraint')
    ancestor = armature.parent
    while ancestor is not None:
        if ancestor == mesh: raise ValueError('Skin parenting would create a cycle')
        ancestor = ancestor.parent
    if any(mod.type == 'ARMATURE' for mod in mesh.modifiers):
        raise ValueError('Skin mesh already has an Armature modifier')
    names = [bone.name for bone in armature.data.bones if bone.use_deform]
    rows = normalize_skin_weights(weights, names, len(mesh.data.vertices))
    if any(name in mesh.vertex_groups for name in names):
        raise ValueError('Skin mesh already has a deform-bone vertex group')
    bpy.context.view_layer.update()
    for obj in (mesh, armature):
        if bpy.context.view_layer.objects.get(obj.name) != obj:
            raise ValueError('Skin objects must be in the active view layer')
        for row in obj.matrix_world: _vector(row, 4, 'Skin world transform')
    try:
        inverse = armature.matrix_world.inverted()
    except ValueError as exc:
        raise ValueError('Skin armature world transform must be invertible') from exc
    for row in inverse: _vector(row, 4, 'Skin inverse transform')

    groups, modifier = [], None
    previous_inverse = mesh.matrix_parent_inverse.copy()
    try:
        used = {name for row in rows for name in row}
        by_name = {}
        for name in names:
            if name in used:
                group = mesh.vertex_groups.new(name=name)
                groups.append(group); by_name[name] = group
        for index, row in enumerate(rows):
            for name, weight in row.items(): by_name[name].add([index], weight, 'REPLACE')
        modifier = mesh.modifiers.new('Authored skin', 'ARMATURE')
        modifier.object = armature
        modifier.use_vertex_groups = True
        modifier.use_bone_envelopes = False
        modifier.use_deform_preserve_volume = False
        mesh.parent = armature
        mesh.matrix_parent_inverse = inverse
        return modifier
    except Exception:
        # Blender runtime failures also leave no partial binding behind.
        mesh.parent = None
        mesh.matrix_parent_inverse = previous_inverse
        if modifier is not None: mesh.modifiers.remove(modifier)
        for group in reversed(groups): mesh.vertex_groups.remove(group)
        raise


def fuse_meshes(objects, name, voxel_size, smooth_passes=2, expected_components=1):
    """Consume mesh objects into a voxel-fused, globally smooth-shaded surface.

    Returns an unparented mesh with identity transform and world-space vertices.
    Call before shape keys, animation, UVs or final material assignment. Rejects
    unresolved modifiers and shape keys before any destructive operation. After
    validation it owns selection/mode and consumes inputs, even if remeshing or
    the topology check fails; keep source recipes, not references to old objects.
    """
    name = _name(name)
    voxel_size = _number(voxel_size, 'Voxel size')
    if voxel_size <= 0: raise ValueError('Voxel size must be positive')
    if isinstance(smooth_passes, bool) or not isinstance(smooth_passes, int) or not 0 <= smooth_passes <= 50:
        raise ValueError('Smooth passes must be an integer from 0 to 50')
    if expected_components is not None and (isinstance(expected_components, bool) or not isinstance(expected_components, int) or not 1 <= expected_components <= 256):
        raise ValueError('Expected components must be an integer from 1 to 256, or None')
    objects = list(objects)
    if not 1 <= len(objects) <= 256: raise ValueError('Fusion needs 1 to 256 mesh objects')
    import bpy
    from mathutils import Matrix, Vector
    if any(not isinstance(obj, bpy.types.Object) or obj.type != 'MESH' for obj in objects):
        raise ValueError('Fusion inputs must be Blender mesh objects')
    if len({obj.as_pointer() for obj in objects}) != len(objects): raise ValueError('Duplicate fusion input')
    # Data-linked objects need a refresh before view-layer membership is current.
    # Keep all destructive operations after the validation below.
    bpy.context.view_layer.update()
    for obj in objects:
        if obj.data.shape_keys: raise ValueError(f'Fuse before adding shape keys: {obj.name}')
        if obj.modifiers: raise ValueError(f'Resolve modifiers before fusion: {obj.name}')
        if obj.constraints or obj.animation_data: raise ValueError(f'Fuse before constraints or animation: {obj.name}')
        if any(child not in objects for child in obj.children): raise ValueError(f'Fusion input has children outside the input list: {obj.name}')
        if obj.library or obj.data.library: raise ValueError(f'Fusion needs local editable objects: {obj.name}')
        if bpy.context.view_layer.objects.get(obj.name) != obj: raise ValueError(f'Fusion input is outside the active view layer: {obj.name}')
        if not obj.data.vertices or not obj.data.polygons: raise ValueError(f'Fusion input has no surface: {obj.name}')
        for vertex in obj.data.vertices: _vector(vertex.co, 3, 'Fusion vertex')
    corners = [_vector(obj.matrix_world @ Vector(corner), 3, 'World bound') for obj in objects for corner in obj.bound_box]
    # Reject accidental microscopic voxels before allocating an enormous grid.
    # This is a conservative bounding-grid budget, not a memory-use guarantee.
    dimensions = [(max(p[i] for p in corners)-min(p[i] for p in corners))/voxel_size for i in range(3)]
    if any(not math.isfinite(d) or d > 32000000 for d in dimensions) or math.prod(math.ceil(d)+3 for d in dimensions) > 32000000:
        raise ValueError('Voxel size exceeds the 32-million-cell fusion grid budget')

    if bpy.context.object and bpy.context.object.mode != 'OBJECT': bpy.ops.object.mode_set(mode='OBJECT')
    bpy.ops.object.select_all(action='DESELECT')
    # Snapshot the entire hierarchy before changing any parent. Bake full affine
    # matrices into geometry: assigning a sheared world matrix to an unparented
    # object would decompose it into location/rotation/scale and lose the shear.
    worlds = [obj.matrix_world.copy() for obj in objects]
    for obj, world in zip(objects, worlds):
        if obj.data.users > 1: obj.data = obj.data.copy()
        obj.data.transform(world)
        if world.determinant() < 0: obj.data.flip_normals()
        obj.data.update()
        obj.parent = None
        obj.matrix_world = Matrix.Identity(4)
        obj.hide_set(False)
        obj.hide_viewport = False
        obj.hide_select = False
        obj.select_set(True)
    bpy.context.view_layer.objects.active = objects[0]
    with bpy.context.temp_override(object=objects[0], active_object=objects[0], selected_objects=objects, selected_editable_objects=objects):
        bpy.ops.object.join()
    fused = bpy.context.view_layer.objects.active
    fused.name = name
    bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)
    remesh = fused.modifiers.new('Fused surface', 'REMESH')
    remesh.mode = 'VOXEL'
    remesh.voxel_size = voxel_size
    remesh.use_remove_disconnected = False
    remesh.use_smooth_shade = True
    bpy.ops.object.modifier_apply(modifier=remesh.name)
    if smooth_passes:
        smoothing = fused.modifiers.new('Fused contours', 'SMOOTH')
        smoothing.factor = .5
        smoothing.iterations = smooth_passes
        bpy.ops.object.modifier_apply(modifier=smoothing.name)
    for face in fused.data.polygons: face.use_smooth = True
    fused.data.update()
    report = topology_report([tuple(v.co) for v in fused.data.vertices], [tuple(face.vertices) for face in fused.data.polygons])
    if not fused.data.polygons or report['boundary_edges'] or report['nonmanifold_edges']:
        raise ValueError(f'Fusion did not produce a closed edge-manifold surface: {report}')
    if expected_components is not None and report['components'] != expected_components:
        raise ValueError(f"Fusion expected {expected_components} components, found {report['components']}: {report}")
    return fused


def sweep_mesh(centers, radii, radial_segments=48, twist=None, initial_normal=None, closed=False):
    """Return vertices and outward faces; radians twist is per ring.

    With `closed`, the path is a loop (a ring, a collar, a torus-shaped rim): the last
    center joins the first (do not repeat it), there are no caps, and the frame's
    twist mismatch round the loop is spread evenly over the rings so there is no seam.

    Uses the minimum rotation taking one tangent to the next. Cusps/repeated
    points are rejected rather than hiding a frame reversal. No arbitrary
    world-up choice is made after the first ring. Morph families should supply
    the same initial_normal so changes cannot select different starting axes.
    """
    centers = [_vector(v, 3, 'Center') for v in centers]
    radii = [_vector(v, 2, 'Ellipse radius') for v in radii]
    count = len(centers)
    if isinstance(radial_segments, bool) or not isinstance(radial_segments, int) or radial_segments < 3:
        raise ValueError('Radial segments must be an integer of at least 3')
    if count < (3 if closed else 2) or len(radii) != count:
        raise ValueError('Need matching centers/radii and at least 3 radial segments')
    if closed and dot(sub(centers[0], centers[-1]), sub(centers[0], centers[-1])) < 1e-20:
        raise ValueError('A closed sweep joins its last point to its first point: do not repeat the first point at the end')
    if any(dot(sub(b,a),sub(b,a)) < 1e-20 for a,b in zip(centers, centers[1:])):
        raise ValueError('Repeated path point')
    if any(min(r) <= 0 for r in radii): raise ValueError('Ellipse radii must be positive')
    twist = [_number(v, 'Twist') for v in twist] if twist is not None else [0.0] * count
    if len(twist) != count: raise ValueError('Twist must match ring count')
    if closed: tangents = [unit(sub(centers[(i+1) % count], centers[i-1])) for i in range(count)]
    else: tangents = [unit(sub(centers[min(i+1,count-1)], centers[max(0,i-1)])) for i in range(count)]
    t = tangents[0]
    axis = unit(_vector(initial_normal, 3, 'Initial normal')) if initial_normal is not None else min(((1,0,0),(0,1,0),(0,0,1)), key=lambda v: abs(dot(v,t)))
    n = unit(sub(axis,mul(t,dot(axis,t))))
    def transport(n, previous, t):
        axis = cross(previous,t)
        c = max(-1.0,min(1.0,dot(previous,t)))
        if c < -0.99999: raise ValueError('Sweep path has an antiparallel cusp')
        # Rodrigues in the cross-product form, stable for near-parallel tangents.
        n = add(add(n,cross(axis,n)),mul(cross(axis,cross(axis,n)),1/(1+c)))
        return unit(sub(n,mul(t,dot(n,t))))

    if closed:
        # Carry the first frame once round the loop; spread the angle it comes back turned by over the rings.
        start, m, previous = n, n, tangents[0]
        for t_ in tangents[1:] + tangents[:1]:
            m = transport(m, previous, t_); previous = t_
        mismatch = math.atan2(dot(cross(m, start), tangents[0]), dot(m, start))
        twist = [angle - mismatch * i / count for i, angle in enumerate(twist)]
        n = start
    vertices = []
    previous = t
    for center, radius, t, angle in zip(centers, radii, tangents, twist):
        n = transport(n, previous, t)
        b = cross(t,n)
        for j in range(radial_segments):
            theta = math.tau*j/radial_segments
            x,y = radius[0]*math.cos(theta), radius[1]*math.sin(theta)
            rx,ry = x*math.cos(angle)-y*math.sin(angle), x*math.sin(angle)+y*math.cos(angle)
            vertices.append(add(center,add(mul(n,rx),mul(b,ry))))
        previous = t
    faces = []
    for i in range(count if closed else count-1):
        k = (i+1) % count
        for j in range(radial_segments):
            a,b = i*radial_segments+j, i*radial_segments+(j+1)%radial_segments
            c,d = k*radial_segments+(j+1)%radial_segments, k*radial_segments+j
            faces.append((a,b,c,d))
    if not closed:
        faces.append(tuple(reversed(range(radial_segments))))
        faces.append(tuple((count-1)*radial_segments+j for j in range(radial_segments)))
    return vertices, faces


def _new_mesh_object(name, vertices, faces, material):
    """Shared native allocation; callers validate their own geometry contract."""
    import bpy
    mesh = bpy.data.meshes.new(name)
    obj = None
    try:
        mesh.from_pydata(vertices, [], faces)
        mesh.update()
        obj = bpy.data.objects.new(name, mesh)
        bpy.context.collection.objects.link(obj)
        if material: mesh.materials.append(material)
        return obj
    except Exception:
        if obj is not None: bpy.data.objects.remove(obj, do_unlink=True)
        bpy.data.meshes.remove(mesh)
        raise


def make_mesh(name, vertices, faces, material=None):
    """Create a smooth named mesh; caps retain flat shading."""
    name = _name(name)
    vertices = [_vector(v, 3, 'Vertex') for v in vertices]
    obj = _new_mesh_object(name, vertices, faces, material)
    mesh = obj.data
    for face in mesh.polygons: face.use_smooth = len(face.vertices) == 4
    return obj


def validate_mesh_arrays(vertices, faces, *, corner_uvs=None, colors=None,
                         color_domain='CORNER', uv_origin='BOTTOM_LEFT',
                         coordinate_space='BLENDER'):
    """Copy and validate mesh arrays without Blender; never repair or clamp.

    UV rows follow flattened face-corner order, including seams. Colors are
    linear RGBA in 0..1, one row per CORNER or POINT. Vertices and UVs must fit
    finite native float32 storage. This checks array structure, not manifoldness,
    intersections, face planarity, zero area or winding consistency.
    """
    def rows(value, label):
        if isinstance(value, (str, bytes)):
            raise ValueError(f'{label} must be an iterable of rows')
        try: return list(value)
        except TypeError as exc:
            raise ValueError(f'{label} must be an iterable of rows') from exc

    def float_vector(value, size, label):
        result = _vector(value, size, label)
        if any(abs(v) > 3.4028234663852886e38 for v in result):
            raise ValueError(f'{label} must fit finite float32 storage')
        return result

    if color_domain not in ('CORNER', 'POINT'):
        raise ValueError('color_domain must be CORNER or POINT')
    if uv_origin not in ('BOTTOM_LEFT', 'TOP_LEFT'):
        raise ValueError('uv_origin must be BOTTOM_LEFT or TOP_LEFT')
    if coordinate_space not in ('BLENDER', 'GLTF'):
        raise ValueError('coordinate_space must be BLENDER or GLTF')
    vertices = [float_vector(v, 3, 'Vertex') for v in rows(vertices, 'Vertices')]
    if len(vertices) < 3: raise ValueError('Mesh arrays need at least three vertices')
    polygons = []
    for value in rows(faces, 'Faces'):
        face = tuple(rows(value, 'Face'))
        if len(face) < 3 or any(isinstance(i, bool) or not isinstance(i, Integral)
                               or i < 0 or i >= len(vertices) for i in face):
            raise ValueError('Faces must contain at least three valid integer vertex indices')
        if len(set(face)) != len(face): raise ValueError('Faces must not repeat a vertex index')
        polygons.append(tuple(int(i) for i in face))
    if not polygons: raise ValueError('Mesh arrays need at least one face')
    corners = sum(len(face) for face in polygons)
    if corner_uvs is not None:
        corner_uvs = [float_vector(uv, 2, 'Corner UV') for uv in rows(corner_uvs, 'Corner UVs')]
        if len(corner_uvs) != corners: raise ValueError('UVs need one row per face corner')
        if uv_origin == 'TOP_LEFT': corner_uvs = [(u, 1-v) for u, v in corner_uvs]
    if colors is not None:
        colors = [_vector(color, 4, 'Linear RGBA color') for color in rows(colors, 'Colors')]
        if len(colors) != (corners if color_domain == 'CORNER' else len(vertices)):
            raise ValueError(f'Colors need one RGBA row per {color_domain.lower()}')
        if any(value < 0 or value > 1 for color in colors for value in color):
            raise ValueError('Linear RGBA components must be in 0..1')
    if coordinate_space == 'GLTF': vertices = [(x, -z, y) for x, y, z in vertices]
    return dict(vertices=vertices, faces=polygons, corner_uvs=corner_uvs,
                colors=colors, color_domain=color_domain)


def mesh_from_arrays(name, vertices, faces, material=None, *, corner_uvs=None,
                     colors=None, color_domain='CORNER', uv_origin='BOTTOM_LEFT',
                     coordinate_space='BLENDER', uv_name='UVMap', color_name='Color',
                     smooth=False):
    """Create one mesh with optional corner UVs and selected FLOAT_COLOR RGBA.

    BLENDER coordinates pass through unchanged (Z-up). GLTF explicitly rotates
    right-handed Y-up input (x,y,z) to Blender (x,-z,y), preserving face winding.
    BOTTOM_LEFT UVs pass through; TOP_LEFT maps native V to 1-V. The glTF exporter
    also flips V, so TOP_LEFT source UVs round-trip unchanged in exported glTF.
    No UV origin, units, axis convention or shading is inferred from the data.

    Colors are linear 0..1 RGBA, CORNER by default or POINT, and alpha remains
    data: this helper never changes the material graph or opacity. Export with
    vertex_color='ACTIVE', all_vertex_colors=False to retain the selected layer.
    A supplied material occupies slot zero; all faces use that slot. The helper
    preserves selection, active object and mode. Validation precedes allocation;
    a native failure removes only this call's new object and mesh datablock.
    """
    name, uv_name, color_name = _name(name), _name(uv_name), _name(color_name)
    if not isinstance(smooth, bool): raise ValueError('smooth must be a bool')
    if corner_uvs is not None and colors is not None and uv_name == color_name:
        raise ValueError('UV and color layers need different names')
    data = validate_mesh_arrays(vertices, faces, corner_uvs=corner_uvs, colors=colors,
        color_domain=color_domain, uv_origin=uv_origin, coordinate_space=coordinate_space)
    import bpy
    if material is not None and not isinstance(material, bpy.types.Material):
        raise ValueError('material must be a Blender material or None')
    obj = _new_mesh_object(name, data['vertices'], data['faces'], material)
    mesh = obj.data
    try:
        for polygon in mesh.polygons: polygon.use_smooth = smooth
        if data['corner_uvs'] is not None:
            layer = mesh.uv_layers.new(name=uv_name)
            for item, uv in zip(layer.data, data['corner_uvs']): item.uv = uv
            layer.active_render = True
        if data['colors'] is not None:
            layer = mesh.color_attributes.new(name=color_name, type='FLOAT_COLOR', domain=color_domain)
            for item, color in zip(layer.data, data['colors']): item.color = color
            mesh.color_attributes.active_color_index = 0
            mesh.color_attributes.render_color_index = 0
        return obj
    except Exception:
        bpy.data.objects.remove(obj, do_unlink=True)
        bpy.data.meshes.remove(mesh)
        raise


def linear_color(value):
    """A linear RGB triple from an sRGB hex string ('#rrggbb' or '#rgb', as in a concept sheet) or a linear 0..1 triple."""
    if isinstance(value, str):
        text = value.strip()
        if not text.startswith('#') or len(text) not in (4, 7) or any(c not in '0123456789abcdefABCDEF' for c in text[1:]):
            raise ValueError(f'Color {value!r} must be an sRGB hex string like "#ffaa00" or a linear (r, g, b) triple')
        digits = text[1:] if len(text) == 7 else ''.join(c * 2 for c in text[1:])
        srgb = [int(digits[k:k + 2], 16) / 255 for k in (0, 2, 4)]
        return tuple(c / 12.92 if c <= .04045 else ((c + .055) / 1.055) ** 2.4 for c in srgb)
    color = _vector(value, 3, 'Linear color')
    if any(v < 0 or v > 1 for v in color): raise ValueError('Linear color components must be in 0..1')
    return color


def glass_settings(opacity=1.0, transmission=0.0, ior=None, double_sided=None):
    """Validate glass fields without Blender: opacity and transmission in 0..1, ior 1..2.333 or None.

    Returns (opacity, transmission, ior, double_sided, is_glass). Glass (opacity below 1 or any
    transmission) is double-sided unless double_sided says otherwise; for an opaque finish None
    keeps Blender's default (no backface culling, which the glTF exporter writes as doubleSided).
    """
    opacity, transmission = _number(opacity, 'Opacity'), _number(transmission, 'Transmission')
    if not 0 <= opacity <= 1: raise ValueError('Opacity must be in 0..1')
    if not 0 <= transmission <= 1: raise ValueError('Transmission must be in 0..1')
    if ior is not None:
        ior = _number(ior, 'IOR')
        if not 1 <= ior <= 2.333: raise ValueError('IOR must be in 1..2.333 (1.5 is glass)')
    if double_sided is not None and not isinstance(double_sided, bool): raise ValueError('double_sided must be a boolean')
    glass = opacity < 1 or transmission > 0
    return opacity, transmission, ior, (True if glass else None) if double_sided is None else double_sided, glass


def material(name, color, metalness=0, roughness=0.4, emission=None, emission_strength=1.0,
             opacity=1.0, transmission=0.0, ior=None, double_sided=None):
    """Create a PBR material. `color` is an sRGB hex string ('#e8a27c', converted to linear) or linear 0..1 RGB.

    `emission` (hex or linear, like `color`) makes it glow: a robot's lens glass or
    antenna bulb. glTF exports it as `emissiveFactor`, and a strength above 1 as
    `KHR_materials_emissive_strength`; three.js and Unreal both read them.

    Glass: `opacity` below 1 blends the surface over what is behind it (glTF `alphaMode`
    BLEND, base color alpha = opacity); `transmission` 0..1 is physically transmitted light
    (`KHR_materials_transmission`); `ior` sets `KHR_materials_ior` (1.5 is glass). A glass
    material renders blended, casts no shadow in Blender and is double-sided by default,
    so a hollow bubble shows its far wall. A clear visor is opacity about 0.2, roughness 0.05.
    """
    name = _name(name)
    color = linear_color(color)
    metalness, roughness = _number(metalness, 'Metalness'), _number(roughness, 'Roughness')
    if any(v < 0 or v > 1 for v in (metalness, roughness)):
        raise ValueError('Metalness and roughness must be in 0..1')
    glow = None if emission is None else linear_color(emission)
    strength = _number(emission_strength, 'Emission strength')
    if strength < 0: raise ValueError('Emission strength must be at least 0')
    opacity, transmission, ior, double_sided, glass = glass_settings(opacity, transmission, ior, double_sided)
    import bpy
    mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    shader = mat.node_tree.nodes.get('Principled BSDF')
    shader.inputs['Base Color'].default_value = (*color[:3],1)
    shader.inputs['Metallic'].default_value = metalness
    shader.inputs['Roughness'].default_value = roughness
    if glow is not None:
        socket = shader.inputs.get('Emission Color') or shader.inputs.get('Emission')
        socket.default_value = (*glow, 1)
        shader.inputs['Emission Strength'].default_value = strength
    if glass:
        shader.inputs['Alpha'].default_value = opacity
        socket = shader.inputs.get('Transmission Weight') or shader.inputs.get('Transmission')
        socket.default_value = transmission
        if ior is not None: shader.inputs['IOR'].default_value = ior
        # Blender 4.2+ names the blended path surface_render_method; older releases use blend_method.
        if hasattr(mat, 'surface_render_method'): mat.surface_render_method = 'BLENDED'
        if hasattr(mat, 'blend_method'): mat.blend_method = 'BLEND'
        if hasattr(mat, 'use_transparency_overlap'): mat.use_transparency_overlap = True
        if hasattr(mat, 'shadow_method'): mat.shadow_method = 'NONE'
    elif ior is not None:
        shader.inputs['IOR'].default_value = ior
    if double_sided is not None: mat.use_backface_culling = not double_sided
    return mat


def image_material(name, *, base_color, normal, roughness, uv_layer,
                   normal_strength, metalness=0.0):
    """Create a packed, repeating PBR material from three explicit image roles.

    Supply an sRGB base-color image, tangent-space OpenGL (+Y) normal and linear
    roughness image. All channels use the same named, caller-authored UV layer.
    UV coordinates already define physical tile scale; this helper does not
    unwrap, rescale, tint or infer materials. Normal strength is explicit 0..2.
    Every mesh using this material must contain `uv_layer` before export.
    """
    from pathlib import Path
    name = _name(name)
    if not isinstance(uv_layer, str) or not uv_layer.strip():
        raise ValueError('uv_layer must be a non-empty UV layer name')
    normal_strength = _number(normal_strength, 'Normal strength')
    metalness = _number(metalness, 'Metalness')
    if not 0 <= normal_strength <= 2:
        raise ValueError('Normal strength must be in 0..2')
    if not 0 <= metalness <= 1:
        raise ValueError('Metalness must be in 0..1')
    paths = {}
    for role, value in [('base_color', base_color), ('normal', normal), ('roughness', roughness)]:
        try:
            path = Path(value).resolve(strict=True)
            if not path.is_file():
                raise ValueError(f'{role} must reference a regular image file')
            with path.open('rb') as source:
                if not source.read(1):
                    raise ValueError(f'{role} image file is empty')
        except (OSError, TypeError, RuntimeError) as exc:
            raise ValueError(f'{role} must reference a readable image file: {value!r}') from exc
        paths[role] = path
    import bpy
    images, mat = [], None
    try:
        # Separate datablocks avoid changing color space on images already used
        # elsewhere, including when one path is intentionally used in two roles.
        by_role = {}
        for role, path in paths.items():
            image = bpy.data.images.load(str(path), check_existing=False)
            images.append(image)
            if image.source != 'FILE' or min(image.size) < 1:
                raise ValueError(f'{role} must be a decodable still image')
            image.colorspace_settings.name = 'sRGB' if role == 'base_color' else 'Non-Color'
            image.pack()
            by_role[role] = image
        mat = material(name, (1, 1, 1), metalness=metalness, roughness=1)
        nodes, links = mat.node_tree.nodes, mat.node_tree.links
        shader = nodes.get('Principled BSDF')
        uv = nodes.new('ShaderNodeUVMap')
        uv.uv_map = uv_layer
        textures = {}
        for role, image in by_role.items():
            node = nodes.new('ShaderNodeTexImage')
            node.label = role
            node.image, node.extension = image, 'REPEAT'
            links.new(uv.outputs['UV'], node.inputs['Vector'])
            textures[role] = node
        normal_map = nodes.new('ShaderNodeNormalMap')
        normal_map.space, normal_map.uv_map = 'TANGENT', uv_layer
        normal_map.inputs['Strength'].default_value = normal_strength
        links.new(textures['base_color'].outputs['Color'], shader.inputs['Base Color'])
        links.new(textures['roughness'].outputs['Color'], shader.inputs['Roughness'])
        links.new(textures['normal'].outputs['Color'], normal_map.inputs['Color'])
        links.new(normal_map.outputs['Normal'], shader.inputs['Normal'])
        return mat
    except Exception as exc:
        if mat is not None:
            bpy.data.materials.remove(mat)
        for image in images:
            bpy.data.images.remove(image)
        raise ValueError(f'Could not create image material {name!r}: {exc}') from exc


def shape_key(obj, name, vertices):
    """Create a zero-rest morph. The caller must preserve vertex correspondence."""
    name = _name(name)
    vertices = [_vector(v, 3, 'Morph vertex') for v in vertices]
    if len(vertices) != len(obj.data.vertices): raise ValueError('Morph topology mismatch')
    if obj.data.shape_keys and name in obj.data.shape_keys.key_blocks:
        raise ValueError(f'Shape key already exists: {name}')
    if name == 'Basis': raise ValueError('Basis is reserved for the rest shape')
    if not obj.data.shape_keys: obj.shape_key_add(name='Basis', from_mix=False)
    key = obj.shape_key_add(name=name, from_mix=False)
    for point, coordinate in zip(key.data, vertices): point.co = coordinate
    key.slider_min, key.slider_max = 0, 1
    key.value = 0
    return key


def export_glb(path, objects, animation_mode='ACTIONS', *, vertex_color=None, all_vertex_colors=None):
    """Export selected objects with PBR materials, skins, morphs and animation.

    Geometry modifiers must be resolved by the author before adding morphs;
    applying them here would discard morph topology. Original selection is
    restored after export. This function deliberately preserves authored weights.
    Morph deltas that are float noise (at most a micron, or 1e-4 of a normal) are
    dropped after export and the rest stored as sparse accessors (`prune_glb_morphs`).
    vertex_color=None leaves Blender's default unchanged; MATERIAL follows the
    material, ACTIVE selects the render color, and NONE omits vertex colors. Explicit modes require
    native exporter support and are checked before selection is changed.
    all_vertex_colors=None preserves the native default; explicit bool controls
    native export_all_vertex_colors without modifying/reordering color layers.
    """
    import bpy
    if animation_mode not in ('ACTIONS', 'NLA_TRACKS'):
        raise ValueError('animation_mode must be ACTIONS or NLA_TRACKS')
    export_options = {}
    if vertex_color is not None:
        if not isinstance(vertex_color, str) or vertex_color not in ('MATERIAL', 'ACTIVE', 'NONE'):
            raise ValueError('vertex_color must be None, MATERIAL, ACTIVE or NONE')
        prop = bpy.ops.export_scene.gltf.get_rna_type().properties.get('export_vertex_color')
        if prop is None or vertex_color not in {item.identifier for item in prop.enum_items}:
            raise ValueError(f'This Blender glTF exporter does not support vertex_color={vertex_color!r}')
        export_options['export_vertex_color'] = vertex_color
    if all_vertex_colors is not None:
        if not isinstance(all_vertex_colors, bool):
            raise ValueError('all_vertex_colors must be None or a bool')
        prop = bpy.ops.export_scene.gltf.get_rna_type().properties.get('export_all_vertex_colors')
        if prop is None or prop.type != 'BOOLEAN':
            raise ValueError('This Blender glTF exporter does not support all_vertex_colors')
        export_options['export_all_vertex_colors'] = all_vertex_colors
    objects = list(objects)
    if not objects: raise ValueError('At least one object must be exported')
    previous_selection = list(bpy.context.selected_objects)
    previous_active = bpy.context.view_layer.objects.active
    try:
        bpy.ops.object.select_all(action='DESELECT')
        for obj in objects: obj.select_set(True)
        bpy.context.view_layer.objects.active = objects[0]
        bpy.context.view_layer.update()
        bpy.ops.export_scene.gltf(filepath=str(path), export_format='GLB', use_selection=True,
            export_apply=False, export_morph=True, export_morph_normal=True,
            export_attributes=any(obj.type == 'MESH' and '_FACE_REGION' in obj.data.attributes for obj in objects),
            export_animations=True, export_animation_mode=animation_mode, export_skins=True, export_yup=True,
            export_cameras=False, export_lights=False, **export_options)
        # Blender's exporter drops JSON-shaped custom properties; write root extras (for
        # example the arkit-face/1 contract from set_face_contract) into the GLB directly.
        import json
        from agent_meshes_face import EXTRAS_PROPERTY, merge_glb_node_extras, prune_glb_morphs
        extras = {obj.name: json.loads(obj[EXTRAS_PROPERTY]) for obj in objects if EXTRAS_PROPERTY in obj.keys()}
        if extras: merge_glb_node_extras(path, extras)
        # Blender writes float-noise normal deltas (~1e-7) for every vertex of every shape key: about 1.2 MB a face.
        prune_glb_morphs(path)
    finally:
        bpy.ops.object.select_all(action='DESELECT')
        for obj in previous_selection: obj.select_set(True)
        bpy.context.view_layer.objects.active = previous_active


# Face-rig helpers live in a sibling module; importing them here keeps one entry point.
# agent_meshes_face never imports this module at load time, so there is no import cycle.
from agent_meshes_face import *  # noqa: E402,F401,F403
from agent_meshes_eye_frames import *  # noqa: E402,F401,F403
