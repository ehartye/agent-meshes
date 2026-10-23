"""Blender object, material and rig adapters for the face helpers.

Blender and agent_meshes_author imports stay inside calls so geometry and contract
consumers can import independently and author wildcard exports remain cycle-free.
Objects use identity transforms and world-space vertices for aligned morphs/weights.
"""
import json
import math
from agent_meshes_face_geometry import (
    EYE_MATERIALS,
    SEAM_TOLERANCE,
    _SIDES,
    _add,
    _area_loop_normals,
    _number,
    _sharp_edges,
    _smooth_states,
    _snap_to_plane,
    _vector,
    chin_drop,
    eye_window,
    eyeball_geometry,
    folded_faces,
    join_geometry,
    lash_geometry,
    lid_geometry,
    lip_lining_geometry,
    shutter_geometry,
    socket_geometry,
)
from agent_meshes_face_contract import (
    EXTRAS_PROPERTY,
    face_contract_extras,
    validate_face_contract_extras,
)

__all__ = [
    'smooth_skin',
    'paint_vertices',
    'use_vertex_colors',
    'PAINT_LAYER',
    'join_face_parts',
    'face_skeleton',
    'add_eye_bones',
    'bind_rigid',
    'build_eye',
    'add_jaw_open',
    'slit_mouth',
    'mesh_from_geometry',
    'build_lip_lining',
    'collect_morph_names',
    'SEAM_ATTRIBUTE',
    'set_face_contract',
    'face_contract',
    'mark_face_region',
]


def mark_face_region(obj, vertices):
    """Declare anatomical face vertices on a final combined body mesh, independent of bone weights.

    Call after topology changes/joining, using the sculpt's authored face selection (include skull,
    chin and lids; exclude neck/body). Do not derive this selection from the weights being verified.
    The POINT/FLOAT attribute survives glTF vertex splitting; export_glb enables its export.
    Repeating this call replaces the membership, after validating every input without mutation.
    """
    from numbers import Integral
    if getattr(obj, 'type', None) != 'MESH' or obj.mode != 'OBJECT':
        raise ValueError('Face ownership requires a mesh in Object mode')
    if obj.data.users != 1:
        raise ValueError('Face ownership requires a single-user mesh')
    try:
        vertices = list(vertices)
    except TypeError as exc:
        raise ValueError('Face vertices must be vertex indices') from exc
    count = len(obj.data.vertices)
    if any(isinstance(v, bool) or not isinstance(v, Integral) or v < 0 or v >= count for v in vertices):
        raise ValueError('Face vertices must be integer indices within the mesh')
    attribute = obj.data.attributes.get('_FACE_REGION')
    if attribute and (attribute.domain != 'POINT' or attribute.data_type != 'FLOAT'):
        raise ValueError('Existing _FACE_REGION must be a POINT/FLOAT attribute')
    values = [0.] * count
    for v in vertices:
        values[v] = 1.
    if attribute is None:
        attribute = obj.data.attributes.new('_FACE_REGION', 'FLOAT', 'POINT')
    attribute.data.foreach_set('value', values)
    obj.data.update()
    return attribute


def face_skeleton(head, eye_left, eye_right, name='Face rig', bone_length=None):
    """Create the contract skeleton: `head` (root) with `eye_L` and `eye_R` children pivoting at the eyeball centers.

    Left means the character's left (+X). Bones point up (+Z) with zero roll, so
    after glTF export each bone's rest rotation is identity: gaze yaw is a rotation
    about its local Y (up) and pitch about its local X. Returns the armature object.
    """
    head, eye_left, eye_right = (_vector(p, 3, label) for p, label in ((head, 'Head'), (eye_left, 'Left eye'), (eye_right, 'Right eye')))
    if eye_left[0] <= eye_right[0]: raise ValueError("eye_L is the character's left eye and must have the larger x (+X)")
    length = .25 * abs(eye_left[0] - eye_right[0]) if bone_length is None else _number(bone_length, 'Bone length', 0, low_open=True)
    import bpy
    data = bpy.data.armatures.new(name)
    rig = bpy.data.objects.new(name, data)
    bpy.context.collection.objects.link(rig)
    bpy.context.view_layer.objects.active = rig
    if bpy.context.object and bpy.context.object.mode != 'OBJECT': bpy.ops.object.mode_set(mode='OBJECT')
    bpy.ops.object.mode_set(mode='EDIT')
    root = data.edit_bones.new('head'); root.head = head; root.tail = _add(head, (0, 0, 2 * length)); root.roll = 0
    bpy.ops.object.mode_set(mode='OBJECT')
    return add_eye_bones(rig, eye_left, eye_right, bone_length=length)


def add_eye_bones(rig, eye_left, eye_right, head='head', bone_length=None):
    """Give an existing armature the contract's eye bones: `eye_L` and `eye_R`, children of its `head` bone.

    This is how a full-body character carries an `arkit-face/1` face: its body
    skeleton already has a `head` bone (under the neck or spine) that the walk and
    jog clips turn, and the eyes, lids and mouth ride it. Each eye bone pivots at its
    eyeball center (world coordinates; the rig's transform is honored), points up
    (+Z) with zero roll like `face_skeleton`'s, and is not connected, so it adds no
    keyframes and follows the head in every clip. Declare the rig with
    `face_contract(rig, objects, ..., skeleton='body')`. Returns the armature.
    """
    import bpy
    if getattr(rig, 'type', None) != 'ARMATURE': raise ValueError('add_eye_bones needs an armature object')
    eye_left, eye_right = (_vector(p, 3, label) for p, label in ((eye_left, 'Left eye'), (eye_right, 'Right eye')))
    if eye_left[0] <= eye_right[0]: raise ValueError("eye_L is the character's left eye and must have the larger x (+X)")
    if rig.data.bones.get(head) is None: raise ValueError(f'The rig has no {head!r} bone for the eyes to hang from')
    for label in ('eye_L', 'eye_R'):
        if rig.data.bones.get(label) is not None: raise ValueError(f'The rig already has an {label} bone')
    length = .25 * abs(eye_left[0] - eye_right[0]) if bone_length is None else _number(bone_length, 'Bone length', 0, low_open=True)
    inverse = rig.matrix_world.inverted()
    if bpy.context.object and bpy.context.object.mode != 'OBJECT': bpy.ops.object.mode_set(mode='OBJECT')
    bpy.context.view_layer.objects.active = rig
    bpy.ops.object.mode_set(mode='EDIT')
    parent = rig.data.edit_bones[head]
    for label, position in (('eye_L', eye_left), ('eye_R', eye_right)):
        from mathutils import Vector
        start = inverse @ Vector(position)
        bone = rig.data.edit_bones.new(label); bone.head = start; bone.tail = inverse @ Vector(_add(position, (0, 0, length))); bone.roll = 0
        bone.parent = parent; bone.use_connect = False
    bpy.ops.object.mode_set(mode='OBJECT')
    return rig


def bind_rigid(mesh, rig, bone='head'):
    """Bind every vertex of `mesh` 100% to one bone (see `bind_skin`)."""
    from agent_meshes_author import bind_skin
    return bind_skin(mesh, rig, [{bone: 1.0}] * len(mesh.data.vertices))


def _material(value, name, color, metalness=0, roughness=.4, double_sided=False):
    from agent_meshes_author import material
    import bpy
    if value is not None: return value
    existing = bpy.data.materials.get(name)
    if existing is not None: return existing
    result = material(name, color, metalness, roughness)
    result.use_backface_culling = not double_sided
    return result


def build_lip_lining(skin, mouth_z, half_width, *, material, offsets, front_y, center_x=0.0,
                     tolerance=1e-6, name='mouth_lip_lining'):
    """Blender wrapper for lip_lining_geometry; creates an unbound mesh with copied shape keys.

    Character composition supplies the material and offsets, then binds/joins the
    result with its face. Boundary and geometry validation run before object creation.
    """
    from agent_meshes_author import shape_key
    geometry = lip_lining_geometry(skin, mouth_z, half_width, front_y=front_y,
                                  offsets=offsets, center_x=center_x, tolerance=tolerance)
    lining = mesh_from_geometry(name, geometry, [material])
    for morph, targets in geometry['morphs'].items():
        shape_key(lining, morph, targets)
    return lining


def mesh_from_geometry(name, geometry, materials, smooth=True):
    """Make a mesh object from a geometry dict (vertices, faces, optional material_indices) and a list of materials (None leaves a slot empty)."""
    from agent_meshes_author import make_mesh
    obj = make_mesh(name, geometry['vertices'], geometry['faces'])
    for mat in materials: obj.data.materials.append(mat)
    indices = geometry.get('material_indices')
    for index, polygon in enumerate(obj.data.polygons):
        polygon.use_smooth = smooth
        if indices is not None: polygon.material_index = indices[index]
    obj.data.update()
    return obj


class _PointLookup:
    """Find the entry stored at (within `tolerance` of) a point: a continuous eye's lid data travels by position."""

    def __init__(self, entries, tolerance=2e-6):
        self.tolerance, self.cells = tolerance, {}
        for point, value in entries:
            self.cells.setdefault(tuple(round(c / tolerance) for c in point), []).append((point, value))

    def get(self, point):
        key = tuple(round(c / self.tolerance) for c in point)
        best = None
        for dx in (-1, 0, 1):
            for dy in (-1, 0, 1):
                for dz in (-1, 0, 1):
                    for stored, value in self.cells.get((key[0] + dx, key[1] + dy, key[2] + dz), ()):
                        d = math.dist(stored, point)
                        if d <= self.tolerance and (best is None or d < best[0]): best = (d, value)
        return None if best is None else best[1]


def _continuous_lids(skin, side, hole, lash, lash_side, lining_material):
    """Give a skin with a continuous eye hole its eye's shape keys and paint: eyeBlink, eyeSquint, eyeWide and the lash."""
    from agent_meshes_author import shape_key
    import bpy
    if skin is None or getattr(skin, 'type', None) != 'MESH':
        raise ValueError("A continuous eye_hole's lids are the skin: pass build_eye(..., hole=hole, skin=<the head mesh object>)")
    suffix = _SIDES[side]
    world = skin.matrix_world
    inverse = world.inverted()
    points = [tuple(world @ v.co) for v in skin.data.vertices]
    motion = _PointLookup(hole['motion'])
    found, targets = 0, {name: list(points) for name in ('blink', 'squint', 'wide')}
    for i, point in enumerate(points):
        moved = motion.get(point)
        if moved is None: continue
        found += 1
        for name, target in moved.items(): targets[name][i] = target
    if found < len(hole['motion']) * .98:
        raise ValueError(f'Only {found} of the {len(hole["motion"])} lid vertices of this eye are on {skin.name}: build the head from the '
                         'eye_hole result and leave the eye region alone (lips, noses and slits elsewhere are fine)')
    keys = skin.data.shape_keys
    for key, morph in (('blink', 'eyeBlink'), ('squint', 'eyeSquint'), ('wide', 'eyeWide')):
        if keys and f'{morph}{suffix}' in keys.key_blocks: raise ValueError(f'{skin.name} already has {morph}{suffix}')
        from mathutils import Vector
        shape_key(skin, f'{morph}{suffix}', [tuple(inverse @ Vector(p)) for p in targets[key]])
    # Paint by material: the lash line on the upper lid's margin (and the lower's with lash_side='both'), the lining inside.
    def slot_of(mat):
        for k, existing in enumerate(skin.data.materials):
            if existing is not None and existing.name == mat.name: return k
        skin.data.materials.append(mat)
        return len(skin.data.materials) - 1
    regions = []
    if lash is not None:
        lash_mat = lash if hasattr(lash, 'node_tree') else _material(None, 'lash', (.03, .02, .02), roughness=.7)
        for which in (('upper', 'lower') if lash_side == 'both' else (lash_side,)):
            regions.append((hole['lash'][which], lash_mat))
    lining_mat = lining_material if hasattr(lining_material, 'node_tree') else _material(None, 'eye_lining', (.05, .028, .024), roughness=.85)
    regions.append((hole['lining_points'], lining_mat))
    for members, mat in regions:
        lookup = _PointLookup([(p, True) for p in members])
        inside = [lookup.get(p) is not None for p in points]
        index = None
        for polygon in skin.data.polygons:
            if all(inside[v] for v in polygon.vertices):
                if index is None: index = slot_of(mat)
                polygon.material_index = index
    skin.data.update()
    return found


def build_eye(rig, side, center, radius, style='lid', lid_material=None, socket_material=None, eye_materials=None,
              iris=26, pupil=12, socket=True, margin=6, hole=None, slit=None, split_borders=False, lash=None, lash_width=5,
              lash_side='upper', skin=None, lining_material=None, **options):
    """Build one eye: an eyeball bound to `eye_L`/`eye_R`, lids (or shutters) with morphs, and a socket cup.

    `style='lid'` uses `lid_geometry`, `style='shutter'` uses `shutter_geometry`;
    extra keyword options go to that function. For lid eyes, open the skin with
    `eye_hole(...)` and pass its result as `hole`: the lids are then exactly the ones
    the hole was shaped around, and no dark socket cup is made (the hole's lining
    seals the eye; `result['socket']` is None). Without `hole`, a dark socket cup
    opening past `eye_window(lids, margin)` sits behind a lid eye. A shutter eye gets
    a housing instead: the same cup in the blades' material (`eye_housing_<side>`),
    a bezel you may see around the lens when the blades open. The lids object gets
    `eyeBlink<Side>`, `eyeSquint<Side>` and `eyeWide<Side>` and is bound to `head`
    with the socket. The eyeball has three material slots named eye_white,
    eye_iris and eye_pupil; `eye_materials` overrides them, and the overrides must
    keep those names exactly (the ID render and the verifier find eyeballs by them;
    a Blender-renamed `eye_white.001` is rejected). `slit` and `split_borders` go to
    `eyeball_geometry` (a slit pupil; iris vertices of its own for painted irises).
    `lash` gives the lids a crisp lash line: `True` for a near-black `lash` material
    or a material of your own, on a tapered band `lash_width` degrees tall hugging
    the `lash_side` ('upper', 'lower', 'both') lid's rim and, on the upper lid,
    hanging a few degrees past it (`lash_geometry`).
    Returns a dict with the objects and the lid geometry report (radii, clearance,
    squint ratio).

    A hole from oriented_eye_hole carries its explicit rest-space frame. Its
    continuous skin targets are already world-space; the eyeball is generated
    in that same frame. Eye bones must still be authored with suitable gaze axes.
    """
    from agent_meshes_author import shape_key
    if side not in _SIDES: raise ValueError("Eye side must be 'L' or 'R'")
    suffix = _SIDES[side]
    center = _vector(center, 3, 'Eye center')
    bone = rig.data.bones.get(f'eye_{side}')
    if bone is None: raise ValueError(f'Rig has no eye_{side} bone; build it with face_skeleton')
    pivot = rig.matrix_world @ bone.head_local
    if math.dist(tuple(pivot), center) > 1e-5: raise ValueError(f'eye_{side} pivots at {tuple(pivot)}, not at the eyeball center {center}')
    continuous = hole is not None and hole.get('style') == 'continuous'
    if continuous:
        if style != 'lid': raise ValueError("This hole was made for lid eyes: eye_hole for lids, shutter_hole for shutters")
        if options: raise ValueError(f'Pass the lid options ({", ".join(sorted(options))}) to eye_hole; build_eye reuses its lids')
        lids = hole['lids']
        if math.dist(tuple(lids['center']), center) > 1e-9 or abs(lids['eye_radius'] - radius) > 1e-12:
            raise ValueError('This eye_hole was cut for another eye center or radius')
        if lash_side not in ('upper', 'lower', 'both'): raise ValueError("Lash side must be 'upper', 'lower' or 'both'")
        socket = False
    elif hole is not None:
        lids = hole['lids']
        if lids['style'] != style:
            raise ValueError(f"This hole was made for {lids['style']} eyes: eye_hole for lids, shutter_hole for shutters")
        helper = 'eye_hole' if style == 'lid' else 'shutter_hole'
        if options: raise ValueError(f'Pass the {style} options ({", ".join(sorted(options))}) to {helper}; build_eye reuses its {style}s')
        if math.dist(tuple(lids['center']), center) > 1e-9 or abs(lids['eye_radius'] - radius) > 1e-12:
            raise ValueError('This eye_hole was cut for another eye center or radius')
        socket = socket and style == 'shutter'  # a lid eye's lining seals it; a shutter eye keeps its housing
    elif style == 'lid': lids = lid_geometry(center, radius, **options)
    elif style == 'shutter': lids = shutter_geometry(center, radius, **options)
    else: raise ValueError("Eye style must be 'lid' or 'shutter'")
    if eye_materials is not None:
        names = [getattr(m, 'name', m) for m in eye_materials]
        if len(names) != 3 or any(str(n) != want for n, want in zip(names, EYE_MATERIALS)):
            renamed = [n for n, want in zip(names, EYE_MATERIALS) if str(n).startswith(want + '.')]
            hint = (f'; Blender renamed {", ".join(map(str, renamed))} because a material of that name already existed: make the three '
                    'materials once and pass the same list to both eyes') if renamed else ''
            raise ValueError(f'eye_materials must be three materials named exactly {", ".join(EYE_MATERIALS)} (in that order), got {names}{hint}')
    materials = eye_materials or [
        _material(None, 'eye_white', (.9, .88, .84), roughness=.25),
        _material(None, 'eye_iris', (.05, .35, .45), roughness=.3),
        _material(None, 'eye_pupil', (.01, .01, .012), roughness=.2),
    ]
    if hole is not None and 'frame' in hole:
        from agent_meshes_eye_frames import oriented_eyeball_geometry
        frame = hole['frame']
        if not continuous or not isinstance(frame, dict) or not all(k in frame for k in ('center', 'forward', 'up')):
            raise ValueError('An oriented eye frame must come from an oriented_eye_hole with continuous lids')
        frame_center = _vector(frame['center'], 3, 'Eye frame center')
        if math.dist(frame_center, center) > 1e-9:
            raise ValueError('The eye frame belongs to another eye center')
        ball_geometry = oriented_eyeball_geometry(center, radius, forward=frame['forward'], up=frame['up'],
                                                   iris=iris, pupil=pupil, slit=slit, split_borders=split_borders)
    else:
        ball_geometry = eyeball_geometry(center, radius, iris, pupil, slit=slit, split_borders=split_borders)
    eyeball = mesh_from_geometry(f'eyeball_{side}', ball_geometry, materials)
    bind_rigid(eyeball, rig, f'eye_{side}')
    if continuous:
        _continuous_lids(skin, side, hole, lash, lash_side, lining_material)
        return {'eyeball': eyeball, 'lids': None, 'socket': None, 'geometry': lids}
    lid_mat = _material(lid_material, 'lid', (.6, .36, .25), roughness=.55)
    if lash is not None and style != 'lid': raise ValueError('A lash line belongs to lid eyes')
    if style == 'lid':
        # Lid eyes always get the upper band that hangs past the lid's edge (lash_geometry): morphs add positions, so
        # blink 1 + wide 1 parts the lids by the wide travel, and the band keeps them overlapping, seen from below
        # too. With `lash` it is the lash line (upper, lower or both, in the lash material); without, a thin seal in
        # the lid's own material, a slightly fuller lid edge.
        if lash_side not in ('upper', 'lower', 'both'): raise ValueError("Lash side must be 'upper', 'lower' or 'both'")
        parts = [{'vertices': lids['vertices'], 'faces': lids['faces'], 'morphs': lids['morphs'], 'materials': ['lid']}]
        if lash is not None:
            lash_mat = lash if hasattr(lash, 'node_tree') else _material(None, 'lash', (.03, .02, .02), roughness=.7, double_sided=True)
            for which in (('upper', 'lower') if lash_side == 'both' else (lash_side,)):
                band = lash_geometry(lids, lash_width, which=which)
                parts.append({'vertices': band['vertices'], 'faces': band['faces'], 'morphs': band['morphs'], 'materials': ['lash']})
            if lash_side == 'lower':
                seal = lash_geometry(lids, 1.5)
                parts.append({'vertices': seal['vertices'], 'faces': seal['faces'], 'morphs': seal['morphs'], 'materials': ['lid']})
        else:
            seal = lash_geometry(lids, 1.5)
            parts.append({'vertices': seal['vertices'], 'faces': seal['faces'], 'morphs': seal['morphs'], 'materials': ['lid']})
        joined = join_geometry(parts)
        lids_out = dict(lids, vertices=joined['vertices'], faces=joined['faces'], morphs=joined['morphs'])
        slots = [lid_mat] + ([lash_mat] if lash is not None else [])
        lid_obj = mesh_from_geometry(f'lids_{side}', dict(lids_out, material_indices=joined['material_indices']), slots, smooth=True)
    else:
        lids_out = lids
        lid_obj = mesh_from_geometry(f'lids_{side}', lids, [lid_mat], smooth=False)
    for key, morph in (('blink', 'eyeBlink'), ('squint', 'eyeSquint'), ('wide', 'eyeWide')):
        shape_key(lid_obj, f'{morph}{suffix}', lids_out['morphs'][key])
    bind_rigid(lid_obj, rig, 'head')
    result = {'eyeball': eyeball, 'lids': lid_obj, 'socket': None, 'geometry': lids}
    if socket:
        if style == 'lid':
            # Behind eye_hole's wall: the cup opens wider than the window, so no ray through the window can reach it.
            radius_s = (radius + lids['lower_radius']) / 2
            hole = eye_window(lids, margin)['polar_max'] + 4
        else:
            # Inside a shutter_hole's tube the housing lines the tube's back: a cup much narrower than a wide well
            # would show its outside to oblique views past its rim (round 5: wells wider than ~1.25 eyeball radii).
            radius_s = max(radius * 1.02, .97 * hole['radius']) if hole is not None else radius * 1.02
            hole = 80
        if style == 'shutter':
            cup = mesh_from_geometry(f'eye_housing_{side}', socket_geometry(center, radius, radius_s, hole),
                                     [socket_material or lid_mat], smooth=False)
        else:
            cup = mesh_from_geometry(f'eye_socket_{side}', socket_geometry(center, radius, radius_s, min(170.0, hole)),
                                     [_material(socket_material, 'eye_socket', (.03, .015, .015), roughness=.9, double_sided=True)])
        bind_rigid(cup, rig, 'head')
        result['socket'] = cup
    return result


SEAM_ATTRIBUTE = 'jaw_seam'
SEAM_LOWER, SEAM_UPPER = 1, 2


def add_jaw_open(obj, jaw, weight=None, name='jawOpen', rigid=False, min_chin_drop=None):
    """Add the `jawOpen` shape key to `obj` from a `JawHinge` (weight as in `JawHinge.targets`).

    `rigid=True` is the rigid-plate mode: the whole object moves with the jaw as one
    body (lower teeth, tongue, a robot chin plate). On a skin cut by `slit_mouth`,
    the tagged lower-lip seam (the `jaw_seam` point attribute) opens with the jaw and
    the upper-lip seam stays, whatever float rounding did to the mouth line.
    `min_chin_drop` (a fraction, 0.1 for the face-rig acceptance bar) rejects a jaw whose
    lowest point drops by less than that share of the object's height: pass it for
    the head skin or chin plate so a hinge that only opens the lips fails here, not
    in review. Rejects morphs that fold faces.
    """
    if rigid:
        if weight is not None: raise ValueError('Pass either rigid=True or a weight, not both')
        weight = 1.0
    from agent_meshes_author import shape_key
    world = obj.matrix_world
    inverse = world.inverted()
    points = [tuple(world @ v.co) for v in obj.data.vertices]
    seam = obj.data.attributes.get(SEAM_ATTRIBUTE)
    lower = [i for i, item in enumerate(seam.data) if item.value == SEAM_LOWER] if seam is not None and weight is None else []
    targets = jaw.targets(points, weight, lower_lip=lower)
    folded = folded_faces(points, targets, [tuple(p.vertices) for p in obj.data.polygons])
    if folded:
        raise ValueError(f'jawOpen folds {len(folded)} faces of {obj.name}; widen JawHinge band, move the pivot back toward the ears (JawHinge.ear) or lower the angle')
    if min_chin_drop is not None:
        report = chin_drop(points, targets)
        need = _number(min_chin_drop, 'Minimum chin drop', 0, 1)
        if report['ratio'] < need:
            moved = 'drops' if report['drop'] >= 0 else 'raises'
            raise ValueError(f"jawOpen {moved} the lowest point of {obj.name} by {abs(report['drop']) * 1000:.1f} mm, "
                             f"{report['ratio']:.1%} of its {report['height'] * 1000:.1f} mm height (needs {need:.0%}): hinge the jaw "
                             f"at the back of the head (JawHinge.ear) or give it more drop")
    from mathutils import Vector
    return shape_key(obj, name, [tuple(inverse @ Vector(p)) for p in targets])


def slit_mouth(obj, mouth_z, half_width, center_x=0.0, front_y=None):
    """Cut a closed mouth slit into a skin mesh along z = mouth_z for |x - center_x| < half_width on the front.

    Bisects the mesh at the mouth line and splits the edges on that line so the lips
    can part (the corners stay joined). Corners are inserted at the requested
    half-width, reusing a nearby seam vertex within `SEAM_TOLERANCE`; coarse
    topology does not shorten the opening. Vertices closer to the line than a quarter of
    their crossing edge first slide along that edge onto it, so the cut leaves no
    sliver faces (they shade as a seam across the face and fold when the jaw opens). The seam vertices are tagged in the `jaw_seam`
    point attribute (1 lower lip, 2 upper lip), so `add_jaw_open` opens exactly the
    lower lip: comparing coordinates against the mouth line would depend on how
    float32 rounds `mouth_z`. The front is y < `front_y` (default: the mean vertex
    y, matching `JawHinge.ear`'s `slit_back`). Call it before shape keys and
    skinning. Returns the number of split edges.
    """
    import bmesh
    mouth_z, half_width = _number(mouth_z, 'Mouth line'), _number(half_width, 'Mouth half-width', 0, low_open=True)
    if obj.data.shape_keys: raise ValueError('Cut the mouth before adding shape keys')
    bm = bmesh.new()
    bm.from_mesh(obj.data)
    if front_y is None: front_y = sum(v.co.y for v in bm.verts) / max(1, len(bm.verts))
    # Vertices a hair off the line slide onto it first: the cut would leave slivers that shade as a seam and fold.
    bm.verts.ensure_lookup_table()
    snapped = _snap_to_plane([tuple(v.co) for v in bm.verts], [tuple(v.index for v in f.verts) for f in bm.faces], mouth_z)
    for vertex, point in zip(bm.verts, snapped): vertex.co = point
    bmesh.ops.bisect_plane(bm, geom=bm.verts[:] + bm.edges[:] + bm.faces[:], dist=1e-7, plane_co=(0, 0, mouth_z), plane_no=(0, 0, 1))
    # Put the two corners on the requested boundary. Selecting only existing
    # vertices silently shortens a coarse head's slit by up to two whole edges.
    # Split the horizontal seam edges in place: their adjacent faces keep the
    # same surface and no vertical cut propagates into the rest of the head.
    corner_faces = set()
    seam_edge = lambda e: all(abs(v.co.z - mouth_z) < SEAM_TOLERANCE and v.co.y < front_y for v in e.verts)
    for corner in (center_x - half_width, center_x + half_width):
        # Reuse a numerically coincident vertex instead of creating a sliver
        # edge whose jaw weight is dominated by float32 coordinate rounding.
        nearby = {v for v in bm.verts if abs(v.co.z - mouth_z) < SEAM_TOLERANCE and v.co.y < front_y and abs(v.co.x - corner) <= SEAM_TOLERANCE}
        while nearby:
            seed = min(nearby, key=lambda v: abs(v.co.x - corner))
            group, pending = {seed}, [seed]
            nearby.remove(seed)
            while pending:
                vertex = pending.pop()
                for edge in vertex.link_edges:
                    other = edge.other_vert(vertex)
                    if other in nearby and seam_edge(edge):
                        nearby.remove(other); group.add(other); pending.append(other)
            # Keep the other nearby vertices: snapping them too would collapse
            # an existing short edge, even when its triangles are valid.
            min(group, key=lambda v: abs(v.co.x - corner)).co.x = corner
        for edge in list(bm.edges):
            if not seam_edge(edge): continue
            a, b = edge.verts
            if min(a.co.x, b.co.x) + 1e-8 < corner < max(a.co.x, b.co.x) - 1e-8:
                corner_faces.update(edge.link_faces)
                bmesh.utils.edge_split(edge, a, (corner - a.co.x) / (b.co.x - a.co.x))
    on_line = lambda v: abs(v.co.z - mouth_z) < SEAM_TOLERANCE and abs(v.co.x - center_x) <= half_width + 1e-8 and v.co.y < front_y
    edges = [e for e in bm.edges if all(on_line(v) for v in e.verts)]
    bmesh.ops.split_edges(bm, edges=edges)
    # A new point on a polygon edge must not become a zero-area fan triangle
    # in the deformation check or export. Only retriangulate the corner faces.
    bmesh.ops.triangulate(bm, faces=[f for f in corner_faces if len(f.verts) > 3])
    bm.verts.ensure_lookup_table()
    layer = bm.verts.layers.int.get(SEAM_ATTRIBUTE) or bm.verts.layers.int.new(SEAM_ATTRIBUTE)
    for vertex in bm.verts:
        if not on_line(vertex) or not vertex.link_faces: continue
        sides = {sum(v.co.z for v in f.verts) / len(f.verts) < mouth_z for f in vertex.link_faces}
        if sides == {True}: vertex[layer] = SEAM_LOWER
        elif sides == {False}: vertex[layer] = SEAM_UPPER
    bm.to_mesh(obj.data)
    bm.free()
    obj.data.update()
    return len(edges)


# The color attribute skin paint lives in; glTF exports it as COLOR_0 when a material uses it.
PAINT_LAYER = 'tint'


def smooth_skin(obj, weights, iterations=6, keep=()):
    """Smooth a skin mesh's rest shape and every shape key alike with `smooth_surface` (Blender).

    `weights` is one 0..1 value per vertex or a callable of the rest position; 0 holds a vertex still. The smoothing is
    linear, so the morphs blend as before. The keys named in `keep` keep their motion exactly as made, carried on the
    smoothed rest (a `jawOpen` whose motion must not spread above the mouth). Run it after the shape keys are made,
    before `join_face_parts`.
    """
    mesh = obj.data
    rest = [tuple(v.co) for v in mesh.vertices]
    weights = [weights(v) for v in rest] if callable(weights) else list(weights)
    faces = [tuple(p.vertices) for p in mesh.polygons]
    blocks = list(mesh.shape_keys.key_blocks) if mesh.shape_keys else []
    smoothed = [block for block in blocks if block.name not in keep]
    states = _smooth_states([rest] + [[tuple(point.co) for point in block.data] for block in smoothed], faces, weights, iterations)
    for block, targets in zip(smoothed, states[1:]):
        for point, target in zip(block.data, targets): point.co = target
    for block in blocks:
        if block.name not in keep: continue
        for point, before, after in zip(block.data, rest, states[0]):
            point.co = tuple(point.co[k] + after[k] - before[k] for k in range(3))
    for vertex, target in zip(mesh.vertices, states[0]): vertex.co = target
    mesh.update()
    return obj


def paint_vertices(obj, tints, layer=PAINT_LAYER):
    """Store per-vertex linear RGB tints (`skin_tints`) on a mesh object as a point color attribute; returns it.

    Paint parts before `join_face_parts`, which carries every part's color
    attributes into the joined face (unpainted parts get white, no tint).
    """
    tints = [_vector(t, 3, 'Tint') for t in tints]
    if len(tints) != len(obj.data.vertices): raise ValueError('Paint needs one tint per vertex')
    if any(c < 0 or c > 1 for t in tints for c in t): raise ValueError('Tints must be in 0..1')
    attribute = obj.data.color_attributes.get(layer) or obj.data.color_attributes.new(layer, 'FLOAT_COLOR', 'POINT')
    for item, tint in zip(attribute.data, tints): item.color = (*tint, 1.0)
    obj.data.color_attributes.active_color = attribute
    obj.data.color_attributes.render_color_index = obj.data.color_attributes.find(layer)
    return attribute


def use_vertex_colors(mat, color=None, layer=PAINT_LAYER):
    """Wire a material so its base color is multiplied by the vertex tint (glTF COLOR_0 times baseColorFactor).

    `color` (hex or linear) first sets the material's base color: pass `skin_tints(..., lighten=True)['material']`,
    the brightest tone painted, which the tints were made relative to.
    """
    from agent_meshes_author import linear_color
    tree = mat.node_tree
    shader = tree.nodes.get('Principled BSDF')
    if shader is None: raise ValueError(f'Material {mat.name} has no Principled BSDF')
    if color is not None:
        color = (*linear_color(color), 1.0)
        shader.inputs['Base Color'].default_value = color
        linked = [link for link in tree.links if link.to_socket == shader.inputs['Base Color']]
        for link in linked:
            if link.from_node.bl_idname == 'ShaderNodeMix': link.from_node.inputs[7].default_value = color
    if any(link.to_socket == shader.inputs['Base Color'] for link in tree.links): return mat
    color = tuple(shader.inputs['Base Color'].default_value)
    attribute = tree.nodes.new('ShaderNodeVertexColor')
    attribute.layer_name = layer
    multiply = tree.nodes.new('ShaderNodeMix')
    multiply.data_type, multiply.blend_type = 'RGBA', 'MULTIPLY'
    multiply.inputs['Factor'].default_value = 1.0
    tree.links.new(attribute.outputs['Color'], multiply.inputs[6])
    multiply.inputs[7].default_value = color
    tree.links.new(multiply.outputs[2], shader.inputs['Base Color'])
    return mat


def _set_area_normals(obj, sharp):
    mesh = obj.data
    vertices = [tuple(v.co) for v in mesh.vertices]
    faces = [tuple(p.vertices) for p in mesh.polygons]
    normals = _area_loop_normals(vertices, faces, sharp)
    if hasattr(mesh, 'use_auto_smooth'): mesh.use_auto_smooth = True   # Blender before 4.1 needs it for custom normals
    mesh.normals_split_custom_set(normals)
    mesh.update()


def join_face_parts(parts, name='face', rig=None, bone='head', sharp_angle=60, area_normals=False):
    """Join every morph-bearing face part (skin, lids, teeth, tongue, cavity) into ONE mesh object.

    Unreal discards all morph names in a file when a name repeats across glTF
    meshes, so a face whose skin and lower teeth both carry `jawOpen` must be one
    mesh: this exports as one glTF mesh with one primitive per material, every
    primitive carrying the same morph names. Reads each part's world-space rest
    positions, polygons, material slots, smooth flags and shape keys; parts lacking
    a key keep their rest shape in it. The parts are removed (keep the source
    recipe, not the objects); UV maps are not carried. With `rig`, the result is
    bound 100% to `bone`. Eyeballs stay separate: they move with their eye bones.
    Color attributes (skin paint from `paint_vertices`) are carried over, white where
    a part has none. Edges where the surface turns by more than `sharp_angle` degrees (the fold from
    skin into an `eye_hole` wall, a lid's rim) are marked sharp, so smooth shading
    does not smear across them (None keeps every edge smooth). `area_normals=True` stores the rest normals
    weighted by face area (split at the sharp edges) as custom normals: Blender weights by corner angle, and a
    finely split row beside coarse faces (a continuous eye's rolled lid margin) then shades as ticks along it.
    """
    import bpy
    geometry, smooth, colors = [], [], []
    parts = [part for part in parts if part is not None]  # build_eye(hole=...) makes no socket
    for part in parts:
        if not isinstance(part, bpy.types.Object) or part.type != 'MESH': raise ValueError('Face parts must be Blender mesh objects')
        world = part.matrix_world
        keys = part.data.shape_keys
        morphs = {block.name: [tuple(world @ point.co) for point in block.data] for block in keys.key_blocks[1:]} if keys else {}
        geometry.append({
            'vertices': [tuple(world @ v.co) for v in part.data.vertices],
            'faces': [tuple(p.vertices) for p in part.data.polygons],
            'materials': [slot.material for slot in part.material_slots] or [None],
            'material_indices': [p.material_index if part.material_slots else 0 for p in part.data.polygons],
            'morphs': morphs,
        })
        smooth += [p.use_smooth for p in part.data.polygons]
        colors.append(_point_colors(part))
    joined = join_geometry(geometry)
    for part in parts: bpy.data.objects.remove(part, do_unlink=True)
    from agent_meshes_author import shape_key
    obj = mesh_from_geometry(name, joined, joined['materials'])
    for polygon, flag in zip(obj.data.polygons, smooth): polygon.use_smooth = flag
    if sharp_angle is not None:
        sharp = set(_sharp_edges(joined['vertices'], joined['faces'], _number(sharp_angle, 'Sharp angle', 0, 180)))
        for edge in obj.data.edges:
            a, b = edge.vertices
            if (min(a, b), max(a, b)) in sharp: edge.use_edge_sharp = True
    # Color attributes (skin paint): every part's, point domain, white where a part has none.
    for layer in dict.fromkeys(name for part in colors for name in part):
        attribute = obj.data.color_attributes.new(layer, 'FLOAT_COLOR', 'POINT')
        values = [c for part, geo in zip(colors, geometry) for c in (part.get(layer) or [(1.0, 1.0, 1.0, 1.0)] * len(geo['vertices']))]
        for item, value in zip(attribute.data, values): item.color = value
        if layer == PAINT_LAYER or obj.data.color_attributes.active_color is None:
            obj.data.color_attributes.active_color = attribute
            obj.data.color_attributes.render_color_index = obj.data.color_attributes.find(layer)
    if area_normals: _set_area_normals(obj, sharp if sharp_angle is not None else set())
    for morph, targets in joined['morphs'].items(): shape_key(obj, morph, targets)
    if rig is not None: bind_rigid(obj, rig, bone)
    return obj


def _point_colors(obj):
    """{name: one RGBA per vertex} for a mesh's color attributes (corner colors averaged onto their vertices)."""
    result = {}
    for attribute in obj.data.color_attributes:
        if attribute.domain == 'POINT':
            result[attribute.name] = [tuple(item.color) for item in attribute.data]
        elif attribute.domain == 'CORNER':
            sums = [[0.0, 0.0, 0.0, 0.0, 0] for _ in obj.data.vertices]
            for loop, item in zip(obj.data.loops, attribute.data):
                total = sums[loop.vertex_index]
                for k in range(4): total[k] += item.color[k]
                total[4] += 1
            result[attribute.name] = [tuple(t[k] / t[4] for k in range(4)) if t[4] else (1.0, 1.0, 1.0, 1.0) for t in sums]
    return result


def collect_morph_names(objects):
    """Shape-key names (except Basis) across Blender objects, in first-seen order."""
    names = []
    for obj in objects:
        keys = getattr(getattr(obj, 'data', None), 'shape_keys', None)
        if keys:
            for block in keys.key_blocks[1:]:
                if block.name not in names: names.append(block.name)
    return names


def set_face_contract(root, extras):
    """Attach validated `arkit-face/1` extras to `root`; `export_glb` writes them into that node's glTF extras."""
    errors = validate_face_contract_extras(extras)
    if errors: raise ValueError('; '.join(errors))
    current = json.loads(root.get(EXTRAS_PROPERTY, '{}'))
    current.update(extras)
    root[EXTRAS_PROPERTY] = json.dumps(current)
    return current


def face_contract(root, objects, yaw_max, pitch_max, **options):
    """Collect morph names from `objects`, build `face_contract_extras` and attach them to `root` (the rig)."""
    extras = face_contract_extras(collect_morph_names(objects), yaw_max, pitch_max, **options)
    set_face_contract(root, extras)
    return extras
