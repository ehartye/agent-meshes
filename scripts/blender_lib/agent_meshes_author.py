"""Small procedural authoring helper. Geometry math is usable without Blender.

Cross sections use parallel-transport frames, positive ellipse radii and closed
caps. Point/ring counts stay fixed so independently evaluated shapes can become
named glTF morph targets. Blender-only helpers import bpy lazily.
"""
import math
from numbers import Real


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


def sweep_mesh(centers, radii, radial_segments=48, twist=None, initial_normal=None):
    """Return vertices and outward faces; radians twist is per ring.

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
    if count < 2 or len(radii) != count:
        raise ValueError('Need matching centers/radii and at least 3 radial segments')
    if any(dot(sub(b,a),sub(b,a)) < 1e-20 for a,b in zip(centers, centers[1:])):
        raise ValueError('Repeated path point')
    if any(min(r) <= 0 for r in radii): raise ValueError('Ellipse radii must be positive')
    twist = [_number(v, 'Twist') for v in twist] if twist is not None else [0.0] * count
    if len(twist) != count: raise ValueError('Twist must match ring count')
    tangents = [unit(sub(centers[min(i+1,count-1)], centers[max(0,i-1)])) for i in range(count)]
    t = tangents[0]
    axis = unit(_vector(initial_normal, 3, 'Initial normal')) if initial_normal is not None else min(((1,0,0),(0,1,0),(0,0,1)), key=lambda v: abs(dot(v,t)))
    n = unit(sub(axis,mul(t,dot(axis,t))))
    vertices = []
    previous = t
    for center, radius, t, angle in zip(centers, radii, tangents, twist):
        axis = cross(previous,t)
        c = max(-1.0,min(1.0,dot(previous,t)))
        if c < -0.99999: raise ValueError('Sweep path has an antiparallel cusp')
        # Rodrigues in the cross-product form, stable for near-parallel tangents.
        n = add(add(n,cross(axis,n)),mul(cross(axis,cross(axis,n)),1/(1+c)))
        n = unit(sub(n,mul(t,dot(n,t))))
        b = cross(t,n)
        for j in range(radial_segments):
            theta = math.tau*j/radial_segments
            x,y = radius[0]*math.cos(theta), radius[1]*math.sin(theta)
            rx,ry = x*math.cos(angle)-y*math.sin(angle), x*math.sin(angle)+y*math.cos(angle)
            vertices.append(add(center,add(mul(n,rx),mul(b,ry))))
        previous = t
    faces = []
    for i in range(count-1):
        for j in range(radial_segments):
            a,b = i*radial_segments+j, i*radial_segments+(j+1)%radial_segments
            faces.append((a,b,b+radial_segments,a+radial_segments))
    faces.append(tuple(reversed(range(radial_segments))))
    faces.append(tuple((count-1)*radial_segments+j for j in range(radial_segments)))
    return vertices, faces


def make_mesh(name, vertices, faces, material=None):
    """Create a smooth named mesh; caps retain flat shading."""
    name = _name(name)
    vertices = [_vector(v, 3, 'Vertex') for v in vertices]
    import bpy
    mesh = bpy.data.meshes.new(name)
    mesh.from_pydata(vertices, [], faces)
    mesh.update()
    obj = bpy.data.objects.new(name, mesh)
    bpy.context.collection.objects.link(obj)
    if material: mesh.materials.append(material)
    for face in mesh.polygons: face.use_smooth = len(face.vertices) == 4
    return obj


def material(name, color, metalness=0, roughness=0.4):
    """Create PBR material. RGB values are linear components in the range 0..1."""
    name = _name(name)
    color = _vector(color, 3, 'Linear color')
    metalness, roughness = _number(metalness, 'Metalness'), _number(roughness, 'Roughness')
    if any(v < 0 or v > 1 for v in (*color, metalness, roughness)):
        raise ValueError('Color, metalness and roughness must be in 0..1')
    import bpy
    mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    shader = mat.node_tree.nodes.get('Principled BSDF')
    shader.inputs['Base Color'].default_value = (*color[:3],1)
    shader.inputs['Metallic'].default_value = metalness
    shader.inputs['Roughness'].default_value = roughness
    return mat


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


def export_glb(path, objects):
    """Export selected objects with PBR materials, skins, morphs and animation.

    Geometry modifiers must be resolved by the author before adding morphs;
    applying them here would discard morph topology. Original selection is
    restored after export. This function deliberately preserves authored weights.
    """
    import bpy
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
            export_animations=True, export_skins=True, export_yup=True,
            export_cameras=False, export_lights=False)
    finally:
        bpy.ops.object.select_all(action='DESELECT')
        for obj in previous_selection: obj.select_set(True)
        bpy.context.view_layer.objects.active = previous_active
