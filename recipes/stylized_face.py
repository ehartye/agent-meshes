"""A living arkit-face/1 face for the stylized character recipe: blinking lids, gaze, a puppet jaw and expressions.

The character recipe (`stylized_character.py`, with `face='arkit'`) leaves the face's features out, and the shared
walk (`stylized_walk.rig_character`) builds the body skeleton whose `head` bone the clips turn. `add_face` then hangs
`eye_L`/`eye_R` under that head bone (`add_eye_bones`) and builds one continuous head skin with the face-rig helpers
(`agent_meshes_face`): eye holes whose lids are the skin, soft lips over a toothed mouth, a button nose, skin brows and
paint, with the 21 required ARKit morphs, all bound to `head`. The face rides the head in every clip; the morphs are
glTF morph targets on the skinned face mesh, so they survive skinning and play over the walk and jog.

`face_layout(values)` and `head_field(layout)` are pure (standard library plus the pure face helpers). The layout is
the proven kid test head (tests/fixtures/face-rig/test_lips_kid.py) mapped onto the character's head envelope, with
proportions set by age and presentation: children's eyes are larger, adults' noses and mouths longer.
Blender coordinates: Z up, meters, the face looks down -Y, the character's left is +X.
"""
import math

FACE_VERSION = 1
# The canonical head the layout is drawn on (the helper fixture's kid): an ellipsoid of these half sizes round CENTER.
CANONICAL_HALF_WIDTH, CANONICAL_HALF_DEPTH, CANONICAL_HALF_HEIGHT = .088, .085, .112
CANONICAL_CENTER = (0.0, 0.0, .13)
# Proportions in the canonical frame (meters on a 0.224 m tall head), by age; presentation adjusts a few. The concept
# boards' portraits: big dark eyes set wide at mid-face, a small nose, a short upper lip and a soft, narrowing jaw.
PROPORTIONS = {
    'child': dict(eye=(.040, .122), eye_radius=.0215, eye_depth=.8, iris=40, pupil=17, opening=(46, 34, 30), mouth_z=.077,
                  mouth_half_width=.020, nose=(0, .094), nose_size=(.0085, .0078, .0072),
                  cheek=((.046, -.046, .088), (.026, .024, .022)), face=((0, -.012, .104), (.086, .075, .058)),
                  jaw=.08, lower=.6, brow_inner=(.013, .148), brow_outer=(.058, .151)),
    'adult': dict(eye=(.039, .124), eye_radius=.0192, eye_depth=.8, iris=38, pupil=16, opening=(45, 32, 28), mouth_z=.076,
                  mouth_half_width=.021, nose=(0, .095), nose_size=(.0090, .0095, .0088),
                  cheek=((.045, -.044, .092), (.018, .018, .018)), face=((0, -.012, .103), (.084, .074, .060)),
                  jaw=.22, lower=.6, brow_inner=(.012, .149), brow_outer=(.058, .152)),
}
PRESENTATION = {'female': dict(nose_scale=1.0, mouth_scale=1.0, brow_height=1.0, jaw_scale=1.0),
                'male': dict(nose_scale=1.12, mouth_scale=1.05, brow_height=1.35, jaw_scale=.7)}


def _character():
    """The character recipe: this file's own globals when embedded after it, else the sibling module."""
    if 'landmarks' in globals() and 'parameters' in globals(): return globals()
    import stylized_character
    return vars(stylized_character)


def face_layout(values=None):
    """Where the face's features go on this character's head (Blender coordinates), and its scale from the canonical head."""
    recipe = _character()
    p = recipe['parameters']({} if values is None else values)
    d = recipe['landmarks'](p)
    base, look = PROPORTIONS[p['age']], PRESENTATION[p['presentation']]
    axes = (d['rx'] / CANONICAL_HALF_WIDTH, d['rz'] / CANONICAL_HALF_DEPTH, d['ry'] / CANONICAL_HALF_HEIGHT)
    k = axes[2]
    center = (0.0, 0.0, d['head_y'])

    def at(point):
        return tuple(center[i] + axes[i] * (point[i] - CANONICAL_CENTER[i]) for i in range(3))

    def xz(point):
        x, z = point
        return (axes[0] * x, center[2] + axes[2] * (z - CANONICAL_CENTER[2]))

    nose_scale, mouth_scale = look['nose_scale'], look['mouth_scale']
    layout = dict(
        center=center, scale=k, axes=axes, radii=(d['rx'], d['rz'], d['ry']),
        eye_radius=k * base['eye_radius'], opening=base['opening'],
        mouth_z=xz((0, base['mouth_z']))[1], mouth_half_width=axes[0] * base['mouth_half_width'] * mouth_scale,
        nose=xz(base['nose']), nose_size=tuple(k * nose_scale * v for v in base['nose_size']),
        cheek=(at(base['cheek'][0]), tuple(a * r for a, r in zip(axes, base['cheek'][1]))),
        face=(at(base['face'][0]), tuple(a * r for a, r in zip(axes, base['face'][1]))),
        brow_inner=xz(base['brow_inner']), brow_outer=xz(base['brow_outer']), brow_height=look['brow_height'],
        iris=base['iris'], pupil=base['pupil'], jaw=base['jaw'] * look['jaw_scale'], lower=base['lower'],
        skin=p['skin'], hair=p['hair'], eyes=p['eyes'], age=p['age'], presentation=p['presentation'],
    )
    # Each eyeball's center sits `eye_depth` of its radius behind the face's surface, so the eye fills its socket and
    # the lids wrap it close to the skin. An eye set deeper needs a deep funnel of lid and socket skin round it, which
    # reads as a pinched brow and a trough across the bridge.
    ex, ez = xz(base['eye'])
    sdf, front = head_field(layout), 0.0
    while sdf((ex, front, ez)) < 0: front -= .001
    low, high = front, front + .001
    for _ in range(40):
        mid = (low + high) / 2
        if sdf((ex, mid, ez)) < 0: high = mid
        else: low = mid
    eye = (ex, high + base['eye_depth'] * layout['eye_radius'], ez)
    layout.update(eye_left=eye, eye_right=(-eye[0], eye[1], eye[2]))
    return layout


def head_field(layout):
    """The head's signed-distance field: the character's head envelope (the cranium the hair is fitted to) above, and a
    rounded face mass below the eyes that makes the cheeks, jaw and chin in one piece, with soft cheeks on its front.

    The cranium's lower half is squashed to `lower` of its height so the face mass, not the cranium, is the jaw and
    chin: one smooth ellipsoid gives a round face with a small soft chin (the boards' portraits), where a chin ball
    added to a narrowed cranium read as a knob on a melted jaw. `jaw` narrows the face mass toward the chin."""
    from agent_meshes_face import ellipsoid_sdf, smooth_min
    k, center, radii, jaw, lower = layout['scale'], layout['center'], layout['radii'], layout['jaw'], layout['lower']
    cheek_center, cheek_radii = layout['cheek']
    face_center, face_radii = layout['face']

    def sdf(p):
        # The cranium: squashed below its middle, easing in over its lower half so no crease runs round the head.
        below = min(1.0, max(0.0, (center[2] - p[2]) / radii[2]))
        z = center[2] + (p[2] - center[2]) * (1 + (1 / lower - 1) * below * below * (3 - 2 * below))
        d = ellipsoid_sdf((p[0], p[1], z), center, radii)
        # The face mass narrows by up to `jaw` of its width from its middle to the chin.
        t = min(1.0, max(0.0, (face_center[2] - p[2]) / face_radii[2]))
        narrow = 1 - jaw * t * t * (3 - 2 * t)
        d = smooth_min(d, ellipsoid_sdf((p[0] / narrow, p[1], p[2]), face_center, face_radii), .015 * k)
        for sx in (1, -1):
            d = smooth_min(d, ellipsoid_sdf(p, (sx * cheek_center[0], cheek_center[1], cheek_center[2]), cheek_radii), .018 * k)
        return d
    return sdf


def _mix(a, b, t): return tuple(x + (y - x) * t for x, y in zip(a, b))


def add_face(objects, values=None):
    """Give a rigged stylized character (`rig_character`'s objects) a living arkit-face/1 face on its `head` bone.

    Returns the objects plus the face mesh and the two eyeballs. The rig's extras declare the face contract with
    `skeleton='body'`. The character must have been built with `face='arkit'`.
    """
    from agent_meshes_author import (
        JawHinge, add_eye_bones, add_jaw_open, build_eye, eye_hole_mask, eye_holes, face_contract, front_surface,
        join_face_parts, linear_color, material, mesh_from_geometry, mouth_cavity_geometry, nose_geometry,
        paint_vertices, recommended_gaze, sculpt_lips, sdf_blank, shape_key, skin_brow_geometry, skin_tints,
        slit_mouth, soft_offset, symmetric_offsets, teeth_row_geometry, tongue_geometry, use_vertex_colors,
        join_geometry,
    )
    p = _character()['parameters']({} if values is None else values)
    if p['face'] != 'arkit': raise ValueError("add_face needs a character built with face='arkit' (its static face would double up)")
    rigs = [obj for obj in objects if getattr(obj, 'type', None) == 'ARMATURE']
    if len(rigs) != 1: raise ValueError(f'add_face needs exactly one armature among the objects (found {len(rigs)}): run rig_character first')
    rig = rigs[0]
    L = face_layout(p)
    k, eye_left, eye_right, radius = L['scale'], L['eye_left'], L['eye_right'], L['eye_radius']
    mouth_z, half_width = L['mouth_z'], L['mouth_half_width']
    add_eye_bones(rig, eye_left, eye_right)

    skin_hex, hair_hex = L['skin'], L['hair']
    skin = material('skin', skin_hex, roughness=.55)
    nostril = material('nostril', _hex(_mix(linear_color(skin_hex), (.05, .01, .01), .75)), roughness=.8)

    blank = sdf_blank(head_field(L), L['center'], rings=72, segments=96)
    holes = eye_holes(blank['vertices'], blank['faces'], eye_left, radius, opening=L['opening'], max_edge=.15 * radius)
    lips = sculpt_lips(holes['vertices'], holes['faces'], mouth_z, half_width)
    nose = nose_geometry(lips['vertices'], lips['faces'], L['nose'], L['nose_size'])
    vertices, faces = nose['vertices'], nose['faces']
    front = front_surface(vertices, faces)
    jaw = JawHinge.ear(vertices, mouth_z, half_width)
    head = mesh_from_geometry('head_skin', {'vertices': vertices, 'faces': faces, 'material_indices': nose['material_indices']},
                              [skin, nostril])
    slit_mouth(head, mouth_z, half_width)
    rest = [tuple(v.co) for v in head.data.vertices]
    corner = (half_width, front(half_width, mouth_z), mouth_z)
    still = eye_hole_mask(holes['L'], holes['R'])

    mouth_front = front(0, mouth_z)
    (bx, bz), (ox, oz) = L['brow_inner'], L['brow_outer']
    cheek_x, cheek_z = L['cheek'][0][0], L['cheek'][0][2]
    pairs = {
        'browDown': ((bx * 2.5, front(bx * 2.5, bz), bz), .018 * k, (0, -.001 * k, -.004 * k)),
        'browOuterUp': ((ox, front(ox, oz), oz), .016 * k, (0, 0, .004 * k)),
        'cheekSquint': ((cheek_x, front(cheek_x, cheek_z + .006 * k), cheek_z + .006 * k), .02 * k, (0, -.001 * k, .004 * k)),
        'mouthSmile': (corner, .016 * k, (.003 * k, .001 * k, .004 * k)),
        'mouthFrown': (corner, .016 * k, (0, 0, -.004 * k)),
        'mouthStretch': (corner, .016 * k, (.004 * k, 0, -.001 * k)),
    }
    for name, (center, reach, offset) in pairs.items():
        left, right = symmetric_offsets(rest, center, reach, offset, mask=still)
        shape_key(head, f'{name}Left', left)
        shape_key(head, f'{name}Right', right)
    left, right = symmetric_offsets(rest, *nose['sneer'])
    shape_key(head, 'noseSneerLeft', left); shape_key(head, 'noseSneerRight', right)
    shape_key(head, 'browInnerUp', soft_offset(rest, (0, front(0, bz), bz), (.03 * k, .02 * k, .016 * k), (0, 0, .004 * k), mask=still))
    shape_key(head, 'mouthFunnel', soft_offset(rest, (0, mouth_front, mouth_z), (.026 * k, .02 * k, .016 * k), (0, -.004 * k, 0)))
    add_jaw_open(head, jaw, min_chin_drop=.1)

    # Paint: warm cheeks, tinted lips and a little shade in each socket.
    base = linear_color(skin_hex)
    blush = _mix(base, (base[0] * .92, base[1] * .62, base[2] * .6), 1)
    lip = (base[0] * .72, base[1] * .42, base[2] * .42)
    patches = [{'center': (sx * cheek_x, front(sx * cheek_x, cheek_z), cheek_z), 'radius': (.017 * k, .012 * k, .011 * k),
                'color': blush, 'strength': .55} for sx in (1, -1)]
    patches.append({'center': (0, mouth_front, mouth_z - .002 * k), 'radius': (half_width * 1.05, .01 * k, .006 * k), 'color': lip, 'strength': .75})
    patches.append({'center': (0, mouth_front, mouth_z + .0015 * k), 'radius': (half_width, .01 * k, .004 * k), 'color': lip, 'strength': .55})
    # The lip line and its corners: a thin dark crease, as the boards draw a closed smiling mouth.
    ink = tuple(c * .45 for c in lip)
    patches.append({'center': (0, mouth_front, mouth_z), 'radius': (half_width * 1.02, .01 * k, .0011 * k), 'color': ink, 'strength': .5})
    for sx in (1, -1):
        patches.append({'center': (sx * half_width, front(sx * half_width, mouth_z), mouth_z + .0012 * k), 'radius': .0028 * k, 'color': ink, 'strength': .35})
    for eye in (eye_left, eye_right):
        patches.append({'center': eye, 'radius': radius * 1.9, 'color': tuple(c * .88 for c in base), 'strength': .25})
    paint_vertices(head, skin_tints(rest, base=skin_hex, patches=patches))
    use_vertex_colors(skin)

    dark = material('mouth_cavity', '#260a0e', roughness=.9)
    dark.use_backface_culling = False
    cavity = mesh_from_geometry('mouth_cavity', mouth_cavity_geometry((0, mouth_front, mouth_z - .001 * k), width=2 * half_width - .004 * k,
                                height=.03 * k, depth=.05 * k, surface=front), [dark])
    add_jaw_open(cavity, jaw)
    teeth = '#eeeae0'
    # The upper gum line sits well above the lips (a real mouth's does), so the smiling corners stay below it.
    upper = mesh_from_geometry('teeth_upper', teeth_row_geometry('rounded', (0, mouth_front + .005 * k, mouth_z + .0045 * k), .8 * half_width,
                               .011 * k, 6, .008 * k, row='upper'), [material('teeth_upper', teeth, roughness=.3)])
    lower = mesh_from_geometry('teeth_lower', teeth_row_geometry('rounded', (0, mouth_front + .006 * k, mouth_z - .0015 * k), .76 * half_width,
                               .011 * k, 6, .0045 * k, row='lower'), [material('teeth_lower', teeth, roughness=.3)])
    add_jaw_open(lower, jaw, rigid=True)
    tongue = mesh_from_geometry('tongue', tongue_geometry((0, mouth_front + .025 * k, mouth_z - .012 * k), length=.028 * k, width=1.1 * half_width,
                                thickness=.007 * k), [material('tongue', '#9c3a44', roughness=.5)])
    add_jaw_open(tongue, jaw, rigid=True)

    brow_mat = material('brow', hair_hex, roughness=.7)
    h = L['brow_height']
    brows = [skin_brow_geometry(head, side, inner=(bx, bz), outer=(ox, oz), height=.004 * k * h, thickness=.0016 * k,
                                arch=.002 * k, down=.004 * k, inner_up=.004 * k, outer_up=.004 * k, pinch=.002 * k, hole=holes[side])
             for side in 'LR']
    bgeo = join_geometry(brows)
    brow = mesh_from_geometry('brows', bgeo, [brow_mat])
    for name, targets in bgeo['morphs'].items(): shape_key(brow, name, targets)

    eye_mats = [material('eye_white', '#efece4', roughness=.2), material('eye_iris', L['eyes'], roughness=.25),
                material('eye_pupil', '#0b0908', roughness=.15)]
    parts, eyeballs = [head, cavity, upper, lower, tongue, brow], []
    for side, center in (('L', eye_left), ('R', eye_right)):
        built = build_eye(rig, side, center, radius, lid_material=skin, hole=holes[side], eye_materials=eye_mats, lash=True, skin=head,
                          iris=L['iris'], pupil=L['pupil'])
        eyeballs.append(built['eyeball'])
        parts.append(built['lids'])
    # A warm resting face: the mouth corners turn up a little (the boards' portraits all smile). The lift is added to
    # the rest shape and every shape key alike, after the morphs were made on the neutral mouth, so every morph keeps
    # its motion and the jaw still parts the lips along the slit.
    left, right = symmetric_offsets(rest, corner, .014 * k, (.0005 * k, .0002 * k, .0017 * k), mask=still)
    lift = [tuple(a[i] + b[i] - 2 * r[i] for i in range(3)) for a, b, r in zip(left, right, rest)]
    for block in head.data.shape_keys.key_blocks:
        for point, delta in zip(block.data, lift): point.co = tuple(point.co[i] + delta[i] for i in range(3))
    for vertex, delta in zip(head.data.vertices, lift): vertex.co = tuple(vertex.co[i] + delta[i] for i in range(3))
    face = join_face_parts(parts, 'face', rig=rig, area_normals=True)
    new = [face] + eyeballs
    for obj in new:
        # Like the body's skins, export at the scene root (rig_character does the same).
        world = obj.matrix_world.copy(); obj.parent = None; obj.matrix_world = world
    gaze = recommended_gaze(L['opening'], iris=L['iris'])
    face_contract(rig, list(objects) + new, yaw_max=gaze['yawMax'], pitch_max=gaze['pitchMax'], skeleton='body')
    return list(objects) + new


def _hex(linear):
    """An sRGB hex string for a linear RGB triple."""
    def channel(v):
        v = max(0.0, min(1.0, v))
        return round(255 * (12.92 * v if v <= .0031308 else 1.055 * v ** (1 / 2.4) - .055))
    return '#' + ''.join(f'{channel(v):02x}' for v in linear)
