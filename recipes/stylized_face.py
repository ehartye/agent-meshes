"""A living arkit-face/1 face for the stylized character recipe, on the MakeHuman hm08 head: blinking lids, gaze, a
puppet jaw and expressions.

The character recipe (`stylized_character.py`, with `face='arkit'`) leaves the face out, and the shared walk
(`stylized_walk.rig_character`) builds the body skeleton whose `head` bone the clips turn. `add_face` then builds the
head from CC0 hm08 data (`agent_meshes_hm08`): the head and upper neck of one fixed quad topology, shaped by hm08's own
age, gender and feature targets and by our stylize target, fitted to the character's head envelope (the cranium the
hair is fitted to) and cropped where the neck rides the head. Its ARKit morphs are hm08's faceunits01 face units, with
the lids refitted to the stylized eyes. Eyeballs on `eye_L`/`eye_R`, teeth, a tongue, brows and paint join it, all
bound to `head`, so the face rides the head in every clip.

`face_shape_values(values)`, `head_spec(values)`, `face_layout(values)` and `beard_weight` are pure (numpy plus the pure
helpers). The character's `face_shape` sets the face: age in years, eye size, spacing and tilt, nose size, length,
width and bridge, mouth width, lips, jaw and chin width, chin length, cheek fullness, brow weight, the resting smile
and a sculpted beard.
Blender coordinates: Z up, meters, the face looks down -Y, the character's left is +X.
"""
import math

FACE_VERSION = 2
# Shape values a character may set (face_shape), each a factor round 1 unless noted, with its range.
SHAPE_RANGES = {
    'years': (3.0, 70.0),       # age in years (children default to 7, adults to 30)
    'stylize': (0.0, 1.2),      # how far the head takes the stylized proportions (big eyes, soft nose, small chin)
    'eye_size': (.8, 1.25),
    'eye_spacing': (.85, 1.15),
    'eye_tilt': (-1.0, 1.0),    # the outer corners up (+) or down (-)
    'nose': (.5, 1.8),          # nose size
    'nose_length': (.6, 1.5),
    'nose_width': (.6, 1.5),
    'nose_bridge': (.5, 1.6),   # how far the bridge stands out
    'mouth_width': (.7, 1.35),
    'lips': (.3, 2.5),          # lip fullness
    'jaw_width': (.7, 1.4),
    'chin': (.75, 1.4),         # chin length
    'chin_width': (.6, 1.5),
    'cheeks': (0.0, 2.5),       # how full and round the cheeks are
    'brow': (.5, 2.5),          # brow weight
    'smile': (0.0, 1.0),        # how far the resting mouth turns up (0: straight)
    'cartoon': (0.0, 1.5),      # how far past the stylize target toward the boards' faces: bigger eyes, a tiny nose, no
                                # eye bags, a rounder lower face and a warm resting mouth (0: none)
}
BEARDS = ('none', 'stubble', 'beard')
DEFAULT_SHAPE = {
    ('child', 'female'): dict(years=7, cheeks=1.2, smile=.5),
    ('child', 'male'): dict(years=9, cheeks=1.0, smile=.45, brow=1.15),
    ('adult', 'female'): dict(years=30, cheeks=1.0, smile=.45),
    ('adult', 'male'): dict(years=32, cheeks=.7, smile=.35, brow=1.4, jaw_width=1.1, nose=1.15, mouth_width=1.05, lips=.8),
}
# face_shape keys that shape the hm08 head (agent_meshes_hm08.FEATURES); the rest set age, stylize and paint.
HEAD_FEATURES = ('eye_size', 'eye_spacing', 'eye_tilt', 'nose', 'nose_length', 'nose_width', 'nose_bridge', 'mouth_width', 'lips',
                 'jaw_width', 'chin', 'chin_width', 'cheeks', 'brow', 'smile')
NEUTRAL = {'eye_tilt': 0.0, 'smile': 0.0, 'cartoon': 0.0}


def _character():
    """The character recipe: this file's own globals when embedded after it, else the sibling module."""
    if 'landmarks' in globals() and 'parameters' in globals(): return globals()
    import stylized_character
    return vars(stylized_character)


def face_shape_values(values=None):
    """The living face's shape values for a character: its `face_shape` over the defaults for its age and presentation.

    Every SHAPE_RANGES key is a number in its range, `beard` one of BEARDS ('stubble' shades the jaw, chin and upper
    lip; 'beard' adds a sculpted short beard and moustache) and `beard_color` a hex color (default: the hair's,
    darkened)."""
    p = _character()['parameters']({} if values is None else values)
    given = p['face_shape']
    unknown = set(given) - set(SHAPE_RANGES) - {'beard', 'beard_color'}
    if unknown: raise ValueError(f'Unknown face_shape keys: {sorted(unknown)}')
    shape = {key: NEUTRAL.get(key, 1.0) for key in SHAPE_RANGES}
    shape.update(DEFAULT_SHAPE[(p['age'], p['presentation'])])
    for key, (low, high) in SHAPE_RANGES.items():
        if key not in given: continue
        value = given[key]
        if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or not low <= value <= high:
            raise ValueError(f'face_shape {key} must be a number in {low}..{high}')
        shape[key] = float(value)
    shape['beard'] = given.get('beard', 'none')
    if shape['beard'] not in BEARDS: raise ValueError(f'face_shape beard must be one of {BEARDS}')
    color = given.get('beard_color')
    if color is not None and not (isinstance(color, str) and len(color) == 7 and color[0] == '#'
                                  and all(c in '0123456789abcdefABCDEF' for c in color[1:])):
        raise ValueError('face_shape beard_color must be a six-digit hex color')
    shape['beard_color'] = color
    return shape


def neck_head_share(z, d):
    """How much of a neck vertex at height `z` rides the head bone rather than the spine (0 at the shoulders, 1 from
    below the chin up), for the character's landmarks `d`. The walk leans the spine under an upright head, and a neck
    riding the spine alone swings its top, which rises inside the head to the mouth, forward into the open mouth. Pure."""
    bottom, top = d['shoulder_y'] + .02 * d['s'], d['head_y'] - .55 * d['ry']
    t = min(1.0, max(0.0, (z - bottom) / (.6 * (top - bottom))))
    return t * t * (3 - 2 * t)


def head_spec(values=None):
    """What `agent_meshes_hm08.character_face` needs for this character: age in years, gender (0 female, 1 male), the
    envelope (center, radii (x, y, z)), the head's shape controls, the stylize weight and the neck height where the
    head is cropped (where the neck rides the head alone, so the crop never parts from the body's neck)."""
    recipe = _character()
    p = recipe['parameters']({} if values is None else values)
    d = recipe['landmarks'](p)
    shape = face_shape_values(p)
    bottom, top = d['shoulder_y'] + .02 * d['s'], d['head_y'] - .55 * d['ry']
    neck_z = bottom + .62 * (top - bottom)
    # The body's neck (stylized_character): a tube from .053 x .051 at the shoulders to .058 x .053 under the head.
    t = (neck_z - bottom) / (top - bottom)
    neck = (d['s'] * (.053 + .005 * t), d['s'] * (.051 + .002 * t))
    return dict(
        years=shape['years'], gender=1.0 if p['presentation'] == 'male' else 0.0,
        center=(0.0, 0.0, d['head_y']), radii=(d['rx'], d['rz'], d['ry']),
        shape={k: shape[k] for k in HEAD_FEATURES if shape[k] != NEUTRAL.get(k, 1.0)},
        stylize=shape['stylize'], cartoon=shape['cartoon'], neck_z='chin', neck=neck,
    )


_FACES = {}


def face_layout(values=None):
    """The character's face (`agent_meshes_hm08.character_face`, cached) and where its features are: `eye_left`,
    `eye_right`, `eye_radius`, `mouth_z`, `mouth_front`, `mouth_half_width`, `center`, `radii`, `scale` (the head's
    size against a realistic one) and the landmarks."""
    import json
    from agent_meshes_hm08 import character_face
    spec = head_spec(values)
    key = json.dumps(spec, sort_keys=True)
    if key not in _FACES:
        _FACES[key] = character_face(spec['years'], spec['gender'], spec['center'], spec['radii'], shape=spec['shape'],
                                     stylize=spec['stylize'], cartoon=spec['cartoon'], neck_z=spec['neck_z'], neck=spec['neck'])
    face = _FACES[key]
    marks = face['landmarks']
    (left, r), (right, _) = face['eyes']
    return dict(face=face, landmarks=marks, center=spec['center'], radii=spec['radii'], scale=float(face['scale'][2]),
                eye_left=tuple(float(v) for v in left), eye_right=tuple(float(v) for v in right), eye_radius=float(r),
                mouth_z=float(marks['stomion'][2]), mouth_front=float(marks['stomion'][1]),
                mouth_half_width=float(abs(marks['mouth_corner_L'][0])), spec=spec)


def teeth_layout(layout):
    """Where the tooth rows sit for a face layout (`face_layout`): per row ('upper', 'lower') the arch's front middle at
    the gum line (`center`), `half_width`, `depth` and tooth `height`. The upper row's edge sits just under the lip line,
    so the closed lips hide it and the open jaw (which lifts the upper lip) shows it. Pure."""
    from agent_meshes_hm08 import UPPER_GUM
    k, hw, mz, front = layout['scale'], layout['mouth_half_width'], layout['mouth_z'], layout['mouth_front']
    return {'upper': dict(center=(0.0, front + .0065 * k, mz + UPPER_GUM * k), half_width=.72 * hw, depth=.01 * k, height=(UPPER_GUM + .0008) * k),
            'lower': dict(center=(0.0, front + .011 * k, mz - .0075 * k), half_width=.6 * hw, depth=.01 * k, height=.005 * k)}


def linear_color_of(hex_color):
    """Linear RGB of an sRGB hex color (pure: agent_meshes_author.linear_color needs Blender)."""
    def channel(v):
        v /= 255
        return v / 12.92 if v <= .04045 else ((v + .055) / 1.055) ** 2.4
    return tuple(channel(int(hex_color[i:i + 2], 16)) for i in (1, 3, 5))


def beard_weight(point, marks, k):
    """How much beard (0..1) covers a skin point: the jaw, chin, lower cheeks and a moustache over the upper lip, on
    the front half of the head, leaving the lips, the nostrils and the neck under the jaw bare. `marks` are the face's
    landmarks and `k` its scale against a realistic head. Pure."""
    x, y, z = point
    mouth_z, hw = marks['stomion'][2], abs(marks['mouth_corner_L'][0])
    nose_z = marks['subnasale'][2]

    def ramp(e0, e1, v):
        t = min(1.0, max(0.0, (v - e0) / (e1 - e0)))
        return t * t * (3 - 2 * t)
    # Down the face from under the cheekbones (a little above the nose's base, rising toward the ears into sideburns).
    top = nose_z + .004 * k + .25 * max(0.0, abs(x) - 1.2 * hw)
    vertical = 1 - ramp(top - .016 * k, top + .006 * k, z)
    # Round the head: the front and sides back to the ears, not the nape.
    around = 1 - ramp(marks['occiput'][1] - .1 * k, marks['occiput'][1] - .04 * k, y)
    # Under the jaw it thins out toward the throat.
    under = ramp(marks['menton'][2] - .03 * k, marks['menton'][2] - .005 * k, z)
    # Bare lips: an ellipse round the mouth; the moustache stays above it.
    lips = ((x / (1.1 * hw)) ** 2 + ((z - mouth_z + .001 * k) / (.009 * k)) ** 2) ** .5
    bare = 1 - ramp(.85, 1.15, lips)
    nostrils = 1 - ramp(nose_z - .006 * k, nose_z - .002 * k, z) if abs(x) < .6 * hw else 1.0
    return max(0.0, min(1.0, vertical * around * under * (1 - bare) * nostrils))


def beard_shell(face, k, thickness=.006, weight=beard_weight):
    """A sculpted beard: the skin's beard region lifted into a shell `thickness` (times the head's scale) proud of the
    skin, thickest on the chin and jaw, its rim tucked just under the skin so it meets it in a clean line. Carries
    every morph of the skin (the shell rides the jaw and the smile). Returns vertices, faces and morphs. Pure (numpy)."""
    import numpy as np
    from agent_meshes_hm08 import vertex_normals
    V, F, marks = face['vertices'], face['faces'], face['landmarks']
    w = np.array([weight(v, marks, k) for v in V])
    # The beard's edge is the weight field's contour at `edge`, cut through the skin's triangles (each edge that
    # crosses it gets a point where the weight is exactly `edge`), so the rim runs as a smooth line, not a staircase of
    # whole faces. Every shell point is a blend of two skin vertices: (a, b, t) = a + t (b - a).
    edge = .2
    points, index, faces = [], {}, []

    def point(a, b=None, t=0.0):
        key = (a, b) if b is not None and a < b else (b, a) if b is not None else (a,)
        if b is not None and a > b: t = 1 - t
        if key not in index:
            index[key] = len(points)
            points.append((key[0], key[-1], t if b is not None else 0.0))
        return index[key]

    # (kept to the middle of its edge: a cut near a corner would leave a sliver the morphs turn over)
    def crossing(a, b): return point(a, b, min(.75, max(.25, (edge - w[a]) / (w[b] - w[a]))))
    for f in F:
        c = [int(i) for i in f if i >= 0]
        for tri in [c[:3]] + ([[c[0], c[2], c[3]]] if len(c) == 4 else []):
            inside = [w[i] >= edge for i in tri]
            if all(inside): faces.append([point(i) for i in tri]); continue
            if not any(inside): continue
            # Rotate so the odd corner out is first, keeping the winding.
            odd = inside.index(True) if sum(inside) == 1 else inside.index(False)
            i0, i1, i2 = tri[odd:] + tri[:odd]
            if sum(inside) == 1:
                faces.append([point(i0), crossing(i0, i1), crossing(i0, i2)])
            else:
                p1, p2 = crossing(i1, i0), crossing(i2, i0)
                faces.append([point(i1), point(i2), p2]); faces.append([point(i1), p2, p1])
    if not faces: return None
    A = np.array([p[0] for p in points]); B = np.array([p[1] for p in points]); T = np.array([p[2] for p in points])[:, None]
    blend = lambda X: X[A] + T * (X[B] - X[A])
    base, ww = blend(V), blend(w[:, None])[:, 0]
    normals = blend(vertex_normals(V, F))
    normals /= np.maximum(np.linalg.norm(normals, axis=1, keepdims=True), 1e-12)
    # Fuller on the chin, thinning up the cheeks, and easing to nothing at the edge, where the rim tucks 0.8 mm (scaled)
    # under the skin: the beard grows out of the face instead of sitting on it like a cut-out.
    fullness = np.clip(1.4 - (base[:, 2] - marks['menton'][2]) / (marks['subnasale'][2] - marks['menton'][2]), .55, 1.0)
    grow = np.clip((ww - edge) / .45, 0, 1)
    grow = grow * grow * (3 - 2 * grow)
    tuck = 1 - np.clip((ww - edge) / .2, 0, 1)
    lift = (thickness * k * fullness * grow - .0008 * k * tuck)[:, None]
    shell = base + normals * lift
    # The shell rides the skin: each vertex takes its skin vertex's motion in every morph, then any face that motion
    # turns over is relaxed (the beard's own mixes, the contract's emotion presets with the jaw).
    from agent_meshes_face import CANONICAL_EMOTIONS
    from agent_meshes_hm08 import unfold_morphs
    morphs = {}
    for name, targets in face['morphs'].items():
        moved = blend(targets) - base
        if np.abs(moved).max() < 1e-7: continue
        morphs[name] = shell + moved
    mixes = [dict(p) for p in CANONICAL_EMOTIONS.values() if p] + [dict(p, jawOpen=1.0) for p in CANONICAL_EMOTIONS.values() if p]
    tris = np.array([f + [-1] for f in faces])
    if 'jawOpen' in morphs:
        jaw, _ = unfold_morphs(shell, tris, {'jawOpen': morphs['jawOpen']}, calm=False, iterations=80, coherent=True)
        morphs.update(jaw)
    morphs, _ = unfold_morphs(shell, tris, morphs, mixes, keep=['jawOpen'])
    return {'vertices': shell, 'faces': [[int(i) for i in t if i >= 0] for t in tris], 'morphs': morphs, 'weights': ww}


def _mix(a, b, t): return tuple(x + (y - x) * t for x, y in zip(a, b))


def _hex(linear):
    """An sRGB hex string for a linear RGB triple."""
    def channel(v):
        v = max(0.0, min(1.0, v))
        return round(255 * (12.92 * v if v <= .0031308 else 1.055 * v ** (1 / 2.4) - .055))
    return '#' + ''.join(f'{channel(v):02x}' for v in linear)


def add_face(objects, values=None):
    """Give a rigged stylized character (`rig_character`'s objects) a living arkit-face/1 face on its `head` bone.

    Returns the objects (less the recipe's simple ears: the hm08 head has its own) plus the face mesh and the two
    eyeballs. The rig's extras declare the face contract with `skeleton='body'`. The character must have been built
    with `face='arkit'`; its `face_shape` sets the features.
    """
    import bpy
    import numpy as np
    from agent_meshes_author import (
        add_eye_bones, add_jaw_open, bind_rigid, eyeball_geometry, face_contract, join_face_parts, linear_color, material,
        mesh_from_geometry, paint_vertices, shape_key, skin_brow_geometry, skin_tints, teeth_row_geometry, tongue_geometry,
        use_vertex_colors,
    )
    p = _character()['parameters']({} if values is None else values)
    if p['face'] != 'arkit': raise ValueError("add_face needs a character built with face='arkit' (its static face would double up)")
    rigs = [obj for obj in objects if getattr(obj, 'type', None) == 'ARMATURE']
    if len(rigs) != 1: raise ValueError(f'add_face needs exactly one armature among the objects (found {len(rigs)}): run rig_character first')
    rig = rigs[0]
    L = face_layout(p)
    face, marks, k = L['face'], L['landmarks'], L['scale']
    shape = face_shape_values(p)
    eye_left, eye_right, radius = L['eye_left'], L['eye_right'], L['eye_radius']
    add_eye_bones(rig, eye_left, eye_right)

    # The recipe's ears give way to the head's own.
    kept = []
    for obj in objects:
        if getattr(obj, 'type', None) == 'MESH' and '-ear' in obj.name:
            bpy.data.objects.remove(obj, do_unlink=True)
            continue
        kept.append(obj)
    objects = kept
    # The neck rises inside the head: its upper part rides the head (neck_head_share), like the head's own neck.
    d = _character()['landmarks'](p)
    # Whatever the neck's own weights (the spine alone, or the gait rig's chest, neck and head joints), each vertex
    # blends toward the head by `share`: w' = (1 - share) w + share [head].
    for obj in objects:
        if getattr(obj, 'type', None) != 'MESH' or obj.name != 'neck' or not obj.vertex_groups: continue
        head_group = obj.vertex_groups.get('head') or obj.vertex_groups.new(name='head')
        for v in obj.data.vertices:
            share = neck_head_share((obj.matrix_world @ v.co).z, d)
            rows = {obj.vertex_groups[g.group].name: g.weight for g in v.groups if g.weight > 0}
            head = rows.pop('head', 0.0)
            for name, weight in rows.items(): obj.vertex_groups[name].add([v.index], (1 - share) * weight, 'REPLACE')
            head_group.add([v.index], share + (1 - share) * head, 'REPLACE')

    skin_hex, hair_hex = p['skin'], p['hair']
    skin = material('skin', skin_hex, roughness=.55)
    # Near black and matte: an open mouth reads as a dark cavity in any light.
    dark = material('mouth_cavity', '#0a0304', roughness=1.0)
    dark.use_backface_culling = False
    V, F = face['vertices'], face['faces']
    lash_set = set(face['lash'])
    indices = [1 if inside else 0 for inside in face['mouth_inside']]
    head = mesh_from_geometry('head_skin', {'vertices': [tuple(v) for v in V], 'faces': [[int(i) for i in f if i >= 0] for f in F],
                                            'material_indices': indices}, [skin, dark])
    for name, targets in face['morphs'].items(): shape_key(head, name, [tuple(v) for v in targets])
    # The body's neck rises inside the head, where only the open mouth sees it: that part is the mouth's dark too.
    from agent_meshes_hm08 import boundary_loops
    rim = min(boundary_loops(F), key=lambda loop: float(np.mean(V[loop, 2])))
    inside_from = float(V[rim, 2].max())
    for obj in objects:
        if getattr(obj, 'type', None) != 'MESH' or obj.name != 'neck': continue
        import bmesh
        from mathutils import Vector
        local = obj.matrix_world.inverted()
        bm = bmesh.new(); bm.from_mesh(obj.data)
        cut = local @ Vector((0.0, 0.0, inside_from))
        normal = (local.to_3x3() @ Vector((0.0, 0.0, 1.0))).normalized()
        bmesh.ops.bisect_plane(bm, geom=bm.verts[:] + bm.edges[:] + bm.faces[:], plane_co=cut, plane_no=normal)
        obj.data.materials.append(dark)
        slot = len(obj.data.materials) - 1
        for f in bm.faces:
            if min((obj.matrix_world @ v.co).z for v in f.verts) > inside_from - 1e-6: f.material_index = slot
        bm.to_mesh(obj.data); bm.free()

    # Paint: warm cheeks, tinted lips and a darker lash line.
    base = linear_color(skin_hex)
    blush = (base[0] * .92, base[1] * .62, base[2] * .6)
    lip = (base[0] * .72, base[1] * .42, base[2] * .42)
    hw, mz, front = L['mouth_half_width'], L['mouth_z'], L['mouth_front']
    lip_h = abs(marks['upper_lip'][2] - marks['lower_lip'][2])
    patches = []
    for sx in (1, -1):
        cheek = np.array(marks['eye_lower_L']) * [sx, 1, 1] + [sx * .15 * hw, 0, -1.1 * lip_h * 2]
        patches.append({'center': tuple(cheek), 'radius': (.9 * hw, .02 * k, .7 * hw), 'color': blush, 'strength': .55})
    patches.append({'center': (0, front, mz), 'radius': (hw * 1.05, .02 * k, lip_h * 1.4), 'color': lip, 'strength': .75})
    # The lip line: a thin dark crease where the lips meet, as the boards draw a closed mouth (and no light catches
    # the crack between them).
    patches.append({'center': (0, front + .004 * k, mz), 'radius': (hw * .98, .012 * k, .0014 * k), 'color': tuple(c * .35 for c in lip), 'strength': .8})
    tints = skin_tints([tuple(v) for v in V], base=skin_hex, patches=patches)
    lash_tint = tuple(.3 for _ in range(3))
    tints = [lash_tint if i in lash_set else t for i, t in enumerate(tints)]
    if shape['beard'] == 'stubble':
        color = linear_color(shape['beard_color'] or _hex(_mix(linear_color(hair_hex), (.01, .008, .007), .35)))
        tint = tuple(min(1.0, c / b) if b > 0 else 1.0 for c, b in zip(color, base))
        tints = [tuple(c + .55 * beard_weight(v, marks, k) * (c * m - c) for c, m in zip(t, tint)) for v, t in zip(V, tints)]
    paint_vertices(head, tints)
    use_vertex_colors(skin)

    parts = [head]
    # Teeth behind the lips and a tongue on the mouth's floor; the lower row and the tongue ride the jaw.
    teeth = '#eeeae0'
    rows = teeth_layout(L)
    upper, lower = (mesh_from_geometry(f'teeth_{row}', teeth_row_geometry('rounded', rows[row]['center'], rows[row]['half_width'],
                                       rows[row]['depth'], 8, rows[row]['height'], row=row), [material(f'teeth_{row}', teeth, roughness=.3)])
                    for row in ('upper', 'lower'))
    jaw = face['jaw']
    add_jaw_open(lower, jaw, rigid=True)
    tongue_hex = _hex(_mix(linear_color('#b24c55'), (base[0] * .5, base[1] * .2, base[2] * .2), .25))
    # The tongue lies on the floor of the head's own mouth, behind the lower teeth.
    t_len = .024 * k
    tongue = mesh_from_geometry('tongue', tongue_geometry((0, front + .02 * k + t_len / 2, mz - .014 * k), length=t_len,
                                width=.8 * hw, thickness=.0045 * k), [material('tongue', tongue_hex, roughness=.45)])
    add_jaw_open(tongue, jaw, rigid=True)
    parts += [upper, lower, tongue]

    if shape['beard'] == 'beard':
        shell = beard_shell(face, k)
        if shell is not None:
            color = shape['beard_color'] or _hex(_mix(linear_color(hair_hex), (.01, .008, .007), .35))
            beard = mesh_from_geometry('beard', {'vertices': [tuple(v) for v in shell['vertices']], 'faces': shell['faces']},
                                       [material('beard', color, roughness=.9)])
            for name, targets in shell['morphs'].items(): shape_key(beard, name, [tuple(v) for v in targets])
            parts.append(beard)

    # Eyeballs on the eye bones.
    eye_mats = [material('eye_white', '#efece4', roughness=.2), material('eye_iris', p['eyes'], roughness=.25),
                material('eye_pupil', '#0b0908', roughness=.15)]
    eyeballs = []
    toon = min(1.0, shape['cartoon'])
    for side, center in (('L', eye_left), ('R', eye_right)):
        # (the boards' eyes are mostly dark iris: the cartoon strength widens it)
        ball = mesh_from_geometry(f'eyeball_{side}', eyeball_geometry(center, radius, iris=38 + 12 * toon, pupil=17 + 5 * toon), eye_mats)
        bind_rigid(ball, rig, f'eye_{side}')
        eyeballs.append(ball)

    # Brows a shade darker than the hair, laid on the skin above each eye.
    brow_mat = material('brow', _hex(_mix(linear_color(hair_hex), (.01, .008, .007), .75)), roughness=.7)
    w = abs(marks['eye_outer_L'][0] - marks['eye_inner_L'][0])
    top = marks['eye_upper_L'][2]
    # A realistic brow's inner end sits higher (a worried look on a cartoon face); the cartoon strength levels the brow,
    # thickens it and gives it a soft arch, as the boards draw them: relaxed and warm.
    inner, outer = (marks['eye_inner_L'][0] + .02 * w, top + (.42 - .15 * toon) * w), (marks['eye_outer_L'][0] + .08 * w, top + .3 * w)
    h = .11 * w * shape['brow'] ** .5 * (1 + .35 * toon)
    brows = [skin_brow_geometry(head, side, inner=inner, outer=outer, height=h, thickness=.2 * h, arch=(.15 + .45 * toon) * h,
                                down=.25 * h, inner_up=.3 * h, outer_up=.3 * h, pinch=.12 * h) for side in 'LR']
    from agent_meshes_author import join_geometry
    bgeo = join_geometry(brows)
    brow = mesh_from_geometry('brows', bgeo, [brow_mat])
    for name, targets in bgeo['morphs'].items(): shape_key(brow, name, targets)
    parts.append(brow)

    face_obj = join_face_parts(parts, 'face', rig=rig, area_normals=True)
    new = [face_obj] + eyeballs
    for obj in new:
        # Like the body's skins, export at the scene root (rig_character does the same).
        world = obj.matrix_world.copy(); obj.parent = None; obj.matrix_world = world
    face_contract(rig, list(objects) + new, yaw_max=25, pitch_max=18, skeleton='body')
    return list(objects) + new
