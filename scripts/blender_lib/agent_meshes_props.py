"""Helpers for Blender-authored STATIC props (one mesh, one material, no rig): chess pieces, furniture, tools.

Coordinates. Every public function takes and returns glTF-style coordinates: x right, y up, z forward (a model
faces +Z). Blender is Z-up with forward = -Y, so the conversion is Blender (x, y, z) = glTF (x, -z, y). `P()` does it for
you; the glTF exporter converts back when `export_yup=True`, so nothing is rotated at export time.

    import sys; sys.path.insert(0, '<plugin-root>/scripts/blender_lib')
    import agent_meshes_props as ap
    ap.reset_scene()
    body = ap.lathe('body', [(0, 0), (.38, 0), (.3, .2), (.15, .8), (0, .8)], steps=32)
    ap.export_static_glb('piece.glb', [ap.finish_static(body, ap.static_material('Ivory', '#e9ddc2', .55))])

The helpers encode what building a 12-piece chess set taught (see mesh-build "Blender-authored static props"):
boolean order, real triangle counts, the metaball unit trap and the exporter flags. Run the self-test with
`blender -b --python agent_meshes_props.py -- --self-test`; it prints one JSON line and exits nonzero on failure.
`bpy`, `bmesh` and `mathutils` are imported inside Blender only, so importing this module elsewhere only fails when a
Blender-dependent function is called.
"""
import json
import math
import struct
import sys

try:  # Blender's bundled Python has these; a plain interpreter does not.
    import bpy
    import bmesh
    from mathutils import Matrix, Vector
except ImportError:  # pragma: no cover - only outside Blender
    bpy = bmesh = Matrix = Vector = None

#: A metaball element's isolated surface sits at META_K * radius * size when the field threshold is 0.6 and stiffness 2
#: (measured by converting test elements). Fields of overlapping elements add, so overlaps bulge.
META_K = 0.558


def _need_blender():
    if bpy is None:
        raise RuntimeError('agent_meshes_props needs Blender (bpy); run it with blender -b --python')


# ---- coordinates, colour, scene --------------------------------------------------------------------------------------

def P(x, y=None, z=None):
    """glTF (x right, y up, z forward) -> Blender Vector (x, -z, y). Also accepts one 3-sequence."""
    if y is None:
        x, y, z = x
    return Vector((x, -z, y))


def from_blender(v):
    """Blender vector -> glTF (x, y, z) tuple."""
    return (v.x, v.z, -v.y)


def linear(hex_colour):
    """'#rrggbb' sRGB -> linear RGB list, which is what a Principled BSDF Base Color wants."""
    c = [int(hex_colour[i:i + 2], 16) / 255 for i in (1, 3, 5)]
    return [((v + 0.055) / 1.055) ** 2.4 if v > 0.04045 else v / 12.92 for v in c]


def reset_scene():
    """Empty factory scene; returns the scene."""
    _need_blender()
    bpy.ops.wm.read_factory_settings(use_empty=True)
    return bpy.context.scene


def args_after_dashes():
    """The script arguments after Blender's `--`."""
    return sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []


def static_material(name, hex_colour, roughness=0.5, metallic=0.0):
    """One opaque Principled material from an sRGB hex colour. Name it; the GLB keeps the name."""
    _need_blender()
    mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    bsdf = mat.node_tree.nodes['Principled BSDF']
    bsdf.inputs['Base Color'].default_value = (*linear(hex_colour), 1)
    bsdf.inputs['Roughness'].default_value = roughness
    bsdf.inputs['Metallic'].default_value = metallic
    return mat


def _link(name, mesh):
    ob = bpy.data.objects.new(name, mesh)
    bpy.context.scene.collection.objects.link(ob)
    return ob


def _activate(ob):
    bpy.context.view_layer.objects.active = ob
    ob.select_set(True)


def bake_transform(ob):
    """Apply location, rotation and scale into the mesh, so every later weld distance, ray cast and refine radius is in metres."""
    bpy.context.view_layer.update()
    bpy.ops.object.select_all(action='DESELECT')
    _activate(ob)
    bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)
    return ob


def to_object(name, bm):
    """Turn a bmesh into a linked object and free the bmesh."""
    me = bpy.data.meshes.new(name)
    bm.to_mesh(me)
    bm.free()
    return _link(name, me)


# ---- counting ----------------------------------------------------------------------------------------------------------

def count_tris(objects):
    """REAL triangles: sum(len(polygon) - 2). Blender's polygon count under-reports after booleans, which leave n-gons
    (a model reported as 6,162 faces had more triangles than that)."""
    if hasattr(objects, 'data'):
        objects = [objects]
    return sum(len(p.vertices) - 2 for ob in objects for p in ob.data.polygons)


def bounds_gltf(obj):
    """World-space (min, max) tuples of an object's vertices in glTF axes."""
    pts = [from_blender(obj.matrix_world @ v.co) for v in obj.data.vertices]
    return tuple(min(p[k] for p in pts) for k in range(3)), tuple(max(p[k] for p in pts) for k in range(3))


# ---- shapes ------------------------------------------------------------------------------------------------------------

def lathe(name, profile, steps=32):
    """Turn a [(radius, y), ...] profile in metres (y up, y = 0 on the ground) around the Y axis, as a Screw modifier
    applied. Profile points with radius 0 sit on the axis and close the caps (the poles weld, so each saves `steps`
    triangles). Triangles ~= steps * (2 * (len(profile) - 1) - zero_radius_endpoints). Corners in the profile are real
    points; shade with finish_static(smooth_angle_deg=...) to keep them crisp."""
    _need_blender()
    bm = bmesh.new()
    vs = [bm.verts.new((r, 0, y)) for r, y in profile]  # Blender Z is up: glTF y -> Blender z
    for a, b in zip(vs, vs[1:]):
        bm.edges.new((a, b))
    ob = to_object(name, bm)
    sm = ob.modifiers.new('screw', 'SCREW')
    sm.axis = 'Z'
    sm.angle = math.radians(360)
    sm.steps = sm.render_steps = steps
    sm.use_merge_vertices = True
    sm.merge_threshold = 1e-5
    _activate(ob)
    bpy.ops.object.modifier_apply(modifier=sm.name)
    return ob


def frame_from_axis(axis, side_hint=(1, 0, 0)):
    """Rotation Matrix (Blender space) whose X is `axis`, Y is as close to `side_hint` as possible and Z is their cross
    product, all given in glTF axes. This is the hand-built frame every oriented ellipsoid needs."""
    a = P(*axis).normalized()
    s = P(*side_hint)
    s = (s - a * s.dot(a))
    if s.length < 1e-6:  # hint parallel to the axis: pick any perpendicular
        s = a.orthogonal()
    s.normalize()
    n = a.cross(s)
    return Matrix(((a.x, s.x, n.x), (a.y, s.y, n.y), (a.z, s.z, n.z)))


def ellipsoid(name, centre, radii, axis=None, side_hint=(1, 0, 0), segments=16):
    """UV-sphere ellipsoid with its transform baked into the mesh. `radii` are semi-axes (a, b, c). With no `axis` they are glTF world axes (x, y, z). With an
    `axis` direction, `a` runs along it, `b` along the side hint and `c` along their cross product (the face normal)."""
    _need_blender()
    bm = bmesh.new()
    bmesh.ops.create_uvsphere(bm, u_segments=segments, v_segments=max(3, segments // 2), radius=1.0)
    ob = to_object(name, bm)
    if axis is None:
        # the world-axis trap: glTF (x, y, z) semi-axes map to Blender (x, z, y)
        ob.scale = (radii[0], radii[2], radii[1])
        ob.rotation_mode = 'XYZ'
    else:
        ob.rotation_mode = 'QUATERNION'
        ob.rotation_quaternion = frame_from_axis(axis, side_hint).to_quaternion()
        ob.scale = tuple(radii)
    ob.location = P(*centre)
    return bake_transform(ob)


def tapered_blade(name, base, direction, length, width_base, width_tip, thickness=None, sides=6):
    """A tapered spike (transform baked): a cone-frustum whose BASE is at `base` (glTF) pointing along `direction`, `length` long, with
    diameters `width_base` -> `width_tip`; `thickness` squashes it across the second axis (default: round).
    A cone with radius1/radius2 plus a matrix scale is the quickest tuft, ear, thorn or blade."""
    _need_blender()
    bm = bmesh.new()
    bmesh.ops.create_cone(bm, cap_ends=True, cap_tris=False, segments=sides, radius1=width_base / 2, radius2=width_tip / 2, depth=length,
                          matrix=Matrix.Translation((0, 0, length / 2)))  # base on the local origin, tip at +Z
    if thickness is not None:
        for v in bm.verts:
            v.co.y *= thickness / width_base
    ob = to_object(name, bm)
    d = P(*direction).normalized()
    ob.rotation_mode = 'QUATERNION'
    ob.rotation_quaternion = Vector((0, 0, 1)).rotation_difference(d)
    ob.location = P(*base)
    return bake_transform(ob)


def _smooth(points, passes):
    for _ in range(passes):
        points = [points[0]] + [(points[i - 1] + points[i] * 2 + points[i + 1]) / 4 for i in range(1, len(points) - 1)] + [points[-1]]
    return points


def tube_along(name, points, radius, sides=10, smooth_passes=3, end='cap'):
    """Round tube swept along a polyline of glTF points: rings bridged with quads, so a long groove cut with it is
    continuous instead of a scallop of overlapping spheres. `end='cap'` closes the ends flat; `'ball'` adds a sphere
    (a rounded groove end). Use as a boolean cutter (`boolean(body, tube, use_self=True)`)."""
    _need_blender()
    pts = _smooth([P(*p) for p in points], smooth_passes)
    bm = bmesh.new()
    rings = []
    for i, p in enumerate(pts):
        tg = (pts[min(i + 1, len(pts) - 1)] - pts[max(i - 1, 0)]).normalized()
        up = Vector((0, 0, 1)) if abs(tg.z) < .9 else Vector((1, 0, 0))
        u = tg.cross(up).normalized()
        v = tg.cross(u).normalized()
        rings.append([bm.verts.new(p + (u * math.cos(a) + v * math.sin(a)) * radius) for a in (2 * math.pi * k / sides for k in range(sides))])
    for r0, r1 in zip(rings, rings[1:]):
        for k in range(sides):
            bm.faces.new((r0[k], r0[(k + 1) % sides], r1[(k + 1) % sides], r1[k]))
    for ring in (rings[0], rings[-1]):
        bm.faces.new(ring)
    if end == 'ball':
        bmesh.ops.create_uvsphere(bm, u_segments=sides, v_segments=max(3, sides // 2), radius=radius * 1.15, matrix=Matrix.Translation(pts[-1]))
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    return to_object(name, bm)


def surface_hit(obj, origin, direction):
    """Ray-cast `obj` from `origin` along `direction` (glTF axes); returns (location, normal) in glTF axes or None.
    Offsetting cutters along the hit normal gives grooves of constant depth whatever the surface does."""
    o, d = P(*origin), P(*direction).normalized()
    ok, loc, nor, _ = obj.ray_cast(o, d)
    return (from_blender(loc), from_blender(nor)) if ok else None


# ---- booleans and cleanup ----------------------------------------------------------------------------------------------

def refine_near(obj, centres, radius, passes=2):
    """Subdivide the triangles whose edges lie within `radius` of any of `centres` (glTF points), so a later boolean
    lands in small even triangles instead of making needle fans in a coarse mesh. There is no built-in local remesh."""
    cs = [P(*c) for c in centres]
    for _ in range(passes):
        bm = bmesh.new()
        bm.from_mesh(obj.data)
        edges = [e for e in bm.edges if any((((e.verts[0].co + e.verts[1].co) / 2) - c).length < radius for c in cs)]
        bmesh.ops.subdivide_edges(bm, edges=edges, cuts=1, use_grid_fill=True)
        bmesh.ops.triangulate(bm, faces=bm.faces, quad_method='BEAUTY', ngon_method='BEAUTY')
        bm.to_mesh(obj.data)
        bm.free()
    obj.data.update()


def boolean(target, cutter, operation='DIFFERENCE', use_self=False, remove_cutter=True):
    """Apply an EXACT boolean (DIFFERENCE, UNION or INTERSECT) of `cutter` on `target`. An exact UNION of many shells can
    silently return only the shells; prefer cutting first and joining last (join_objects), and compare triangle counts."""
    m = target.modifiers.new('bool', 'BOOLEAN')
    m.operation = operation
    m.object = cutter
    m.solver = 'EXACT'
    m.use_self = use_self
    _activate(target)
    bpy.ops.object.modifier_apply(modifier=m.name)
    if remove_cutter:
        bpy.data.objects.remove(cutter)
    return target


def decimate_to(obj, target_tris, passes=3):
    """Collapse-decimate to about `target_tris`. Collapse stalls on thin parts, so it repeats up to `passes` times.
    Run it on the clean body BEFORE booleans; decimating after a boolean roughens the cut edges."""
    bm = bmesh.new()
    bm.from_mesh(obj.data)
    bmesh.ops.triangulate(bm, faces=bm.faces)
    bm.to_mesh(obj.data)
    bm.free()
    _activate(obj)
    for i in range(passes):
        n = count_tris(obj)
        if n <= target_tris * 1.05:
            break
        dm = obj.modifiers.new('decimate%d' % i, 'DECIMATE')
        dm.ratio = min(1.0, target_tris / n)
        bpy.ops.object.modifier_apply(modifier=dm.name)
    return obj


def clean_after_boolean(obj, weld=0.0005):
    """Weld (default 0.5 mm), dissolve degenerate slivers, triangulate with beauty, dissolve again. Never decimate after this."""
    bm = bmesh.new()
    bm.from_mesh(obj.data)
    bmesh.ops.remove_doubles(bm, verts=bm.verts, dist=weld)
    bmesh.ops.dissolve_degenerate(bm, dist=weld, edges=bm.edges)
    bmesh.ops.triangulate(bm, faces=bm.faces, quad_method='BEAUTY', ngon_method='BEAUTY')
    bmesh.ops.dissolve_degenerate(bm, dist=weld, edges=bm.edges)
    bm.to_mesh(obj.data)
    bm.free()
    obj.data.update()
    return obj


def join_objects(objects, name):
    """Join meshes into the first one (a plain join: no boolean, so nothing can swallow the body). Join LAST, after every cut."""
    bpy.ops.object.select_all(action='DESELECT')
    for ob in objects:
        ob.select_set(True)
    bpy.context.view_layer.objects.active = objects[0]
    bpy.ops.object.join()
    ob = bpy.context.view_layer.objects.active
    ob.name = name
    return ob


def finish_static(obj, material, smooth_angle_deg=55):
    """Outward normals, smooth-by-angle shading (35 keeps ring corners crisp, 55 softens them), ONE material, and no colour
    attributes (a stray COLOR_0 multiplies the base colour in viewers)."""
    _activate(obj)
    bpy.ops.object.mode_set(mode='EDIT')
    bpy.ops.mesh.select_all(action='SELECT')
    bpy.ops.mesh.normals_make_consistent(inside=False)
    bpy.ops.object.mode_set(mode='OBJECT')
    if hasattr(bpy.ops.object, 'shade_smooth_by_angle'):
        bpy.ops.object.shade_smooth_by_angle(angle=math.radians(smooth_angle_deg))
    else:  # Blender before 4.1
        bpy.ops.object.shade_smooth()
        obj.data.use_auto_smooth = True
        obj.data.auto_smooth_angle = math.radians(smooth_angle_deg)
    obj.data.materials.clear()
    obj.data.materials.append(material)
    while obj.data.color_attributes:
        obj.data.color_attributes.remove(obj.data.color_attributes[0])
    return obj


# ---- metaballs ---------------------------------------------------------------------------------------------------------

def new_metaball(name='body_mb', resolution=0.0095, threshold=0.6):
    """A metaball datablock. Coarser `resolution` (0.0095 for a 0.4 m piece) is the practical triangle lever; decimating
    a fine metaball body stalls well above the requested ratio."""
    mb = bpy.data.metaballs.new(name)
    mb.resolution = mb.render_resolution = resolution
    mb.threshold = threshold
    return mb


def meta_ellipsoid(mb, centre, semi, axis=None, side_hint=(1, 0, 0), stiffness=2.0):
    """Add a metaball ellipsoid whose isolated surface lies at `semi` metres. Handles the unit trap: surface =
    META_K * radius * size, so radius = max(semi) / META_K and each size is semi / (META_K * radius). `semi` is in glTF
    axes (x, y, z) for an unrotated element (Blender swaps y and z for you); with `axis` it is (along, side, normal).
    Overlapping elements ADD their fields and bulge: shrink radii about 15 percent where they overlap."""
    e = mb.elements.new()
    e.type = 'ELLIPSOID'
    e.stiffness = stiffness
    e.radius = max(semi) / META_K
    sizes = [s / (META_K * e.radius) for s in semi]
    if axis is None:
        e.size_x, e.size_y, e.size_z = sizes[0], sizes[2], sizes[1]
    else:
        e.size_x, e.size_y, e.size_z = sizes
        e.rotation = frame_from_axis(axis, side_hint).to_quaternion()
    e.co = P(*centre)
    return e


def meta_capsule(mb, a, b, radius, stiffness=2.0):
    """Capsule between two glTF points. A capsule's size_x is an ABSOLUTE half-length in metres (not scaled by radius)."""
    e = mb.elements.new()
    e.type = 'CAPSULE'
    e.stiffness = stiffness
    e.radius = radius / META_K
    A, B = P(*a), P(*b)
    e.co = (A + B) / 2
    e.size_x = (B - A).length / 2
    e.size_y = e.size_z = 1.0
    e.rotation = Vector((1, 0, 0)).rotation_difference((B - A).normalized())
    return e


def metaball_to_mesh(mb, name='body'):
    """Convert a metaball datablock to a mesh object."""
    ob = _link(name + '_mb', mb)
    _activate(ob)
    bpy.context.view_layer.update()
    bpy.ops.object.convert(target='MESH')
    body = bpy.context.view_layer.objects.active
    body.name = name
    return body


# ---- export ------------------------------------------------------------------------------------------------------------

def export_static_glb(path, objects, texcoords=False):
    """Export `objects` as a Y-up GLB with the flags a static prop needs: modifiers applied, no vertex colours
    (`export_vertex_color='NONE'`, spelled `export_colors=False` before Blender 4.2), no cameras or lights, and UVs only if
    asked. Y-up is explicit, so Blender -Y (forward) lands on glTF +Z. Returns the path."""
    objects = list(objects)
    bpy.ops.object.select_all(action='DESELECT')
    for ob in objects:
        ob.select_set(True)
    bpy.context.view_layer.objects.active = objects[0]
    kw = dict(filepath=str(path), export_format='GLB', use_selection=True, export_apply=True, export_yup=True,
              export_cameras=False, export_lights=False, export_texcoords=texcoords, export_normals=True)
    try:
        bpy.ops.export_scene.gltf(export_vertex_color='NONE', **kw)
    except TypeError:
        bpy.ops.export_scene.gltf(export_colors=False, **kw)
    return path


def read_glb_summary(path):
    """Stdlib-only summary of a GLB: {materials: [names], attributes: [names], position_min/max}. For self-tests and asserts."""
    data = open(path, 'rb').read()
    length = struct.unpack_from('<I', data, 12)[0]
    j = json.loads(data[20:20 + length])
    prims = [p for m in j['meshes'] for p in m['primitives']]
    acc = [j['accessors'][p['attributes']['POSITION']] for p in prims]
    lo = [min(a['min'][k] for a in acc) for k in range(3)]
    hi = [max(a['max'][k] for a in acc) for k in range(3)]
    return {'materials': [m.get('name') for m in j.get('materials', [])],
            'attributes': sorted({k for p in prims for k in p['attributes']}), 'position_min': lo, 'position_max': hi,
            'nodes': len(j['nodes'])}


# ---- self-test ---------------------------------------------------------------------------------------------------------

def self_test(out_dir=None):
    """Exercise every helper in Blender and assert the documented facts. Returns a dict of measurements."""
    import os
    import tempfile
    out_dir = out_dir or tempfile.mkdtemp(prefix='agent-meshes-props-')
    results = {'blender': bpy.app.version_string}

    def check(condition, message):
        if not condition:
            raise AssertionError(message)

    # lathe: both endpoints on the axis weld their poles, so triangles = steps * (2 * (N - 1) - 2)
    reset_scene()
    prof = [(0, 0), (.4, 0), (.4, .1), (.2, .5), (.1, .9), (0, .9)]
    body = lathe('body', prof, steps=32)
    results['lathe_tris'] = count_tris(body)
    check(results['lathe_tris'] == 32 * (2 * (len(prof) - 1) - 2), 'lathe triangle formula: %r' % results['lathe_tris'])
    lo, hi = bounds_gltf(body)
    check(abs(lo[1]) < 1e-6 and abs(hi[1] - .9) < 1e-6 and abs(hi[0] - .4) < 1e-4, 'lathe sits on y = 0, radius .4, height .9: %r %r' % (lo, hi))

    # oriented ellipsoid: semi-axes a, b, c along axis, side and normal
    el = ellipsoid('el', (0, 1, 0), (.3, .1, .05), axis=(0, 1, 0), side_hint=(1, 0, 0), segments=24)
    lo, hi = bounds_gltf(el)
    check(abs((hi[1] - lo[1]) - .6) < 0.02 and abs((hi[0] - lo[0]) - .2) < 0.02 and abs((hi[2] - lo[2]) - .1) < 0.02, 'oriented ellipsoid extents: %r %r' % (lo, hi))
    ew = ellipsoid('ew', (0, 0, 0), (.1, .2, .3), segments=24)  # world axes: x .1, y .2, z .3
    lo, hi = bounds_gltf(ew)
    check(abs((hi[2] - lo[2]) - .6) < 0.02 and abs((hi[1] - lo[1]) - .4) < 0.02, 'world-axis ellipsoid keeps glTF y and z: %r %r' % (lo, hi))

    # tapered blade: base at the point, tip `length` away along the direction
    bl = tapered_blade('bl', (0, 0, 0), (0, 0, 1), .2, .06, .01)
    lo, hi = bounds_gltf(bl)
    check(abs(lo[2]) < 1e-4 and abs(hi[2] - .2) < 1e-4, 'blade runs +z from its base: %r %r' % (lo, hi))

    # tube along a polyline, used as a cutter
    tube = tube_along('tube', [(0, 0, 0), (.1, 0, 0), (.2, .05, 0)], .01)
    check(count_tris(tube) > 0, 'tube has faces')

    # boolean order: decimate-free body, local refinement, exact cut, weld, no degenerate
    sphere = ellipsoid('ball', (0, 0, 0), (.5, .5, .5), segments=24)
    before = count_tris(sphere)
    refine_near(sphere, [(0, 0, .5)], .15)
    check(count_tris(sphere) > before, 'refine_near adds triangles near the cut')
    cutter = ellipsoid('cutter', (0, 0, .5), (.1, .1, .1), segments=12)
    boolean(sphere, cutter)
    clean_after_boolean(sphere)
    polys = sum(1 for p in sphere.data.polygons if len(p.vertices) != 3)
    check(polys == 0, 'triangulated after the boolean')
    check(not any(p.area < 1e-9 for p in sphere.data.polygons), 'no degenerate faces after cleanup')

    # metaball unit trap: an isolated element's surface is META_K * radius * size; capsule half-length is absolute
    mb = new_metaball('mb', resolution=0.01)
    meta_ellipsoid(mb, (0, 0, 0), (.1, .2, .3))
    mesh = metaball_to_mesh(mb, 'meta')
    lo, hi = bounds_gltf(mesh)
    ext = [(hi[k] - lo[k]) / 2 for k in range(3)]
    results['metaball_semi'] = [round(v, 3) for v in ext]
    check(all(abs(ext[k] - s) < 0.02 for k, s in enumerate((.1, .2, .3))), 'metaball ellipsoid semi-axes in glTF axes: %r' % ext)
    mb2 = new_metaball('mb2', resolution=0.01)
    meta_capsule(mb2, (0, 0, 0), (0, .4, 0), .05)
    cap = metaball_to_mesh(mb2, 'cap')
    lo, hi = bounds_gltf(cap)
    check(abs((hi[1] - lo[1]) - .5) < 0.03, 'capsule spans the two points plus a radius at each end: %r %r' % (lo, hi))
    for ob in (mesh, cap, tube, el, ew, bl):
        bpy.data.objects.remove(ob)

    # finish + export: one named material, no COLOR_0, grounded, forward = +Z
    nose = ellipsoid('nose', (0, .3, .45), (.05, .05, .1), segments=12)  # a feature at glTF +z
    piece = join_objects([body, nose], 'piece')
    mat = static_material('Ivory', '#e9ddc2', .55)
    finish_static(piece, mat)
    path = export_static_glb(os.path.join(out_dir, 'piece.glb'), [piece])
    summary = read_glb_summary(path)
    results['glb'] = summary
    check(summary['materials'] == ['Ivory'], 'one named material: %r' % summary['materials'])
    check(not any(a.startswith('COLOR') for a in summary['attributes']), 'no vertex colour attributes: %r' % summary['attributes'])
    check(abs(summary['position_min'][1]) < 1e-4, 'grounded at y = 0')
    check(summary['position_max'][2] > .5 and summary['position_min'][2] > -.45, 'the feature at glTF +z exports at +z (z = -Blender y)')
    results['ok'] = True
    return results


if __name__ == '__main__':
    if '--self-test' in args_after_dashes():
        try:
            print('AGENT_MESHES_PROPS_SELFTEST ' + json.dumps(self_test(), sort_keys=True))
        except Exception as error:  # report one JSON line and a nonzero exit for the caller
            print('AGENT_MESHES_PROPS_SELFTEST ' + json.dumps({'ok': False, 'error': repr(error)}))
            sys.exit(1)
