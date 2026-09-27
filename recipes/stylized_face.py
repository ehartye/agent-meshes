"""A living arkit-face/1 face for the stylized character recipe: blinking lids, gaze, a puppet jaw and expressions.

The character recipe (`stylized_character.py`, with `face='arkit'`) leaves the face's features out, and the shared
walk (`stylized_walk.rig_character`) builds the body skeleton whose `head` bone the clips turn. `add_face` then hangs
`eye_L`/`eye_R` under that head bone (`add_eye_bones`) and builds one continuous head skin with the face-rig helpers
(`agent_meshes_face`): eye holes whose lids are the skin, soft lips over a toothed mouth, a button nose, skin brows and
paint, with the 21 required ARKit morphs, all bound to `head`. The face rides the head in every clip; the morphs are
glTF morph targets on the skinned face mesh, so they survive skinning and play over the walk and jog.

`face_shape_values(values)`, `face_layout(values)`, `head_field(layout)` and `beard_weight` are pure (standard library
plus the pure face helpers). The layout is drawn on a canonical head and mapped onto the character's head envelope, with
proportions set by age (children's eyes are larger and their lower face short; adults' lower face and chin longer) and
the character's `face_shape`: eye size and spacing, nose, mouth width, lips, jaw width, chin, cheeks, brow weight, the
resting smile and a painted beard or stubble, so each character wears its own face.
Blender coordinates: Z up, meters, the face looks down -Y, the character's left is +X.
"""
import math

FACE_VERSION = 1
# The canonical head the layout is drawn on (the helper fixture's kid): an ellipsoid of these half sizes round CENTER.
CANONICAL_HALF_WIDTH, CANONICAL_HALF_DEPTH, CANONICAL_HALF_HEIGHT = .088, .085, .112
CANONICAL_CENTER = (0.0, 0.0, .13)
# Proportions in the canonical frame (meters on a 0.224 m tall head), by age. The concept boards' portraits: big dark
# eyes set wide, a small nose, the mouth well below the eyes (1.3-1.9 times the eyes' half spacing) and a soft, narrowing
# jaw. Children's eyes are larger and their lower face short and round; adults' lower face is longer, the chin lower.
PROPORTIONS = {
    'child': dict(eye=(.043, .124), eye_radius=.0212, eye_depth=1.05, iris=40, pupil=17, opening=(46, 34, 30), mouth_z=.070,
                  mouth_half_width=.019, nose=(0, .092), nose_size=(.0068, .0062, .0060), lip_fullness=.0019,
                  cheek=((.05, -.046, .094), (.024, .022, .02)), face=((0, -.012, .099), (.086, .075, .060)),
                  jaw=.12, chin=1.0, lower=.6, brow_inner=(.013, .152), brow_outer=(.061, .153), brow_height=.0068, bridge=.0015),
    'adult': dict(eye=(.043, .126), eye_radius=.0185, eye_depth=1.05, iris=38, pupil=16, opening=(45, 31, 27), mouth_z=.064,
                  mouth_half_width=.0205, nose=(0, .089), nose_size=(.0070, .0080, .0072), lip_fullness=.0019,
                  cheek=((.049, -.044, .093), (.02, .019, .019)), face=((0, -.014, .093), (.083, .074, .066)),
                  jaw=.2, chin=1.12, lower=.6, brow_inner=(.012, .151), brow_outer=(.061, .153), brow_height=.0068, bridge=.003),
}
# Shape values a character may set (face_shape), each a factor on its age's proportions unless noted, with its range.
SHAPE_RANGES = {
    'eye_size': (.8, 1.25),      # eyeball radius
    'eye_spacing': (.85, 1.15),  # the eyes' distance from the midline
    'nose': (.5, 1.8),           # nose size
    'mouth_width': (.7, 1.35),
    'lips': (.3, 2.5),           # lip fullness
    'jaw_width': (.7, 1.4),      # the lower face's width at the jaw
    'chin': (.75, 1.4),          # how far the face reaches below its middle
    'cheeks': (0.0, 2.5),        # how full and round the lower face is
    'brow': (.5, 2.5),           # brow weight (height)
    'smile': (0.0, 1.0),         # how far the resting mouth turns up (0: straight)
}
BEARDS = ('none', 'stubble', 'beard')
DEFAULT_SHAPE = {
    ('child', 'female'): dict(cheeks=1.2, smile=.5),
    ('child', 'male'): dict(cheeks=1.0, smile=.45, brow=1.15),
    ('adult', 'female'): dict(cheeks=1.0, smile=.45),
    ('adult', 'male'): dict(cheeks=.7, smile=.35, brow=1.4, jaw_width=1.1, nose=1.15, mouth_width=1.05, lips=.8),
}


def _character():
    """The character recipe: this file's own globals when embedded after it, else the sibling module."""
    if 'landmarks' in globals() and 'parameters' in globals(): return globals()
    import stylized_character
    return vars(stylized_character)


def face_shape_values(values=None):
    """The living face's shape values for a character: its `face_shape` over the defaults for its age and presentation.

    Every SHAPE_RANGES key is a number in its range (1 is the age's own proportion; `smile` 0
    rests straight), `beard` one of BEARDS ('stubble' shades the jaw, chin and upper lip; 'beard' paints a short full
    beard and moustache) and `beard_color` a hex color (default: the hair's, darkened)."""
    p = _character()['parameters']({} if values is None else values)
    given = p['face_shape']
    unknown = set(given) - set(SHAPE_RANGES) - {'beard', 'beard_color'}
    if unknown: raise ValueError(f'Unknown face_shape keys: {sorted(unknown)}')
    shape = {key: 1.0 for key in SHAPE_RANGES}
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


def face_layout(values=None):
    """Where the face's features go on this character's head (Blender coordinates), and its scale from the canonical head."""
    recipe = _character()
    p = recipe['parameters']({} if values is None else values)
    d = recipe['landmarks'](p)
    base, shape = PROPORTIONS[p['age']], face_shape_values(p)
    axes = (d['rx'] / CANONICAL_HALF_WIDTH, d['rz'] / CANONICAL_HALF_DEPTH, d['ry'] / CANONICAL_HALF_HEIGHT)
    k = axes[2]
    center = (0.0, 0.0, d['head_y'])

    def at(point):
        return tuple(center[i] + axes[i] * (point[i] - CANONICAL_CENTER[i]) for i in range(3))

    def xz(point):
        x, z = point
        return (axes[0] * x, center[2] + axes[2] * (z - CANONICAL_CENTER[2]))

    (cheek_center, cheek_radii), (face_center, face_radii) = base['cheek'], base['face']
    chin, fullness = base['chin'] * shape['chin'], shape['cheeks']
    layout = dict(
        center=center, scale=k, axes=axes, radii=(d['rx'], d['rz'], d['ry']),
        eye_radius=k * base['eye_radius'] * shape['eye_size'], opening=base['opening'],
        mouth_z=xz((0, base['mouth_z']))[1], mouth_half_width=axes[0] * base['mouth_half_width'] * shape['mouth_width'],
        nose=xz(base['nose']), nose_size=tuple(k * shape['nose'] * v for v in base['nose_size']),
        lip_fullness=k * base['lip_fullness'] * shape['lips'],
        # Full cheeks round the whole lower face out: a wider, fuller face mass that narrows less toward the chin. Cheek
        # balls added to the face stood out as pads with a ledge under them at the mouth. `cheek` is where the cheeks'
        # blush, squint and smile lift go.
        cheek=(at(cheek_center), tuple(a * r for a, r in zip(axes, cheek_radii))), cheek_fullness=fullness,
        face=(at(face_center), tuple(a * r * (1 + (.08, .05, .02)[i] * (fullness - 1)) for i, (a, r) in enumerate(zip(axes, face_radii)))),
        chin=chin, chin_z=center[2] + axes[2] * (face_center[2] - chin * face_radii[2] - CANONICAL_CENTER[2]),
        brow_inner=xz(base['brow_inner']), brow_outer=xz(base['brow_outer']), brow_height=k * base['brow_height'] * shape['brow'],
        iris=base['iris'], pupil=base['pupil'], jaw=max(0.0, base['jaw'] * (1 - .3 * (fullness - 1))), jaw_width=shape['jaw_width'], lower=base['lower'],
        bridge=k * base['bridge'], resting_smile=shape['smile'], beard=shape['beard'],
        beard_color=shape['beard_color'] or _hex(_mix(linear_color_of(p['hair']), (.01, .008, .007), .35)),
        skin=p['skin'], hair=p['hair'], eyes=p['eyes'], age=p['age'], presentation=p['presentation'],
    )
    ex, ez = xz(base['eye'])
    ex = max(ex * shape['eye_spacing'], 1.35 * layout['eye_radius'])
    layout['eye_x'], layout['eye_z'] = ex, ez
    # The brows sit clear of the upper lid's reach, which grows with the eye: skin a blink moves must not slide under
    # a brow (a big-eyed child's brow at its age's height sat on the lid).
    lift = max(0.0, ez + 1.45 * layout['eye_radius'] - layout['brow_inner'][1])
    layout['brow_inner'] = (layout['brow_inner'][0], layout['brow_inner'][1] + lift)
    layout['brow_outer'] = (layout['brow_outer'][0], layout['brow_outer'][1] + lift)
    # Each eyeball's center sits `eye_depth` of its radius behind the face's surface, so the eye fills its socket and
    # the lids wrap it close to the skin: an eye standing proud of the skin raises a mound of lid round it, and two
    # mounds either side of the bridge read as a V-shaped ridge.
    front = _front(head_field(layout), ex, ez, d['rz'])
    eye = (ex, front + base['eye_depth'] * layout['eye_radius'], ez)
    layout.update(eye_left=eye, eye_right=(-eye[0], eye[1], eye[2]))
    return layout


def linear_color_of(hex_color):
    """Linear RGB of an sRGB hex color (pure: agent_meshes_author.linear_color needs Blender)."""
    def channel(v):
        v /= 255
        return v / 12.92 if v <= .04045 else ((v + .055) / 1.055) ** 2.4
    return tuple(channel(int(hex_color[i:i + 2], 16)) for i in (1, 3, 5))


def head_field(layout):
    """The head's signed-distance field: the character's head envelope (the cranium the hair is fitted to) above, and a
    rounded face mass below the eyes that makes the cheeks, jaw and chin in one piece.

    The cranium's lower half is squashed to `lower` of its height so the face mass, not the cranium, is the jaw and
    chin: one smooth ellipsoid gives a round face with a small soft chin (the boards' portraits), where a chin ball
    added to a narrowed cranium read as a knob on a melted jaw. `jaw` narrows the face mass toward the chin,
    `jaw_width` widens (or narrows) it over the same span and `chin` stretches its lower half. Once the eyes are placed
    (`eye_x`), the face is flattened across them so the bridge stands only `bridge` in front of the skin over the eyes:
    a round cranium puts the midline a centimetre in front of them, a ridge down the nose between two troughs."""
    from agent_meshes_face import ellipsoid_sdf, smooth_max, smooth_min
    k, center, radii, jaw, lower = layout['scale'], layout['center'], layout['radii'], layout['jaw'], layout['lower']
    face_center, face_radii = layout['face']
    chin, jaw_width = layout['chin'], layout['jaw_width']

    def base(p):
        # The cranium: squashed below its middle, easing in over its lower half so no crease runs round the head.
        below = min(1.0, max(0.0, (center[2] - p[2]) / radii[2]))
        z = center[2] + (p[2] - center[2]) * (1 + (1 / lower - 1) * below * below * (3 - 2 * below))
        d = ellipsoid_sdf((p[0], p[1], z), center, radii)
        # The face mass, its lower half stretched by `chin`, narrowing toward the chin.
        fz = p[2] if p[2] >= face_center[2] else face_center[2] + (p[2] - face_center[2]) / chin
        t = min(1.0, max(0.0, (face_center[2] - fz) / face_radii[2]))
        # `jaw_width` eases in over the same span as the narrowing: a change that starts at the mouth leaves a ledge.
        s = t * t * (3 - 2 * t)
        narrow = (1 - jaw * s) * (1 + (jaw_width - 1) * s)
        d = smooth_min(d, ellipsoid_sdf((p[0] / narrow, p[1], fz), face_center, face_radii), .03 * k)
        return d

    if 'eye_x' not in layout: return base
    ex, ez = layout['eye_x'], layout['eye_z']
    target = _front(base, ex, ez, radii[1]) - layout['bridge']
    if _front(base, 0.0, ez, radii[1]) >= target: return base
    # Carve the midline back: an ellipsoid whose back reaches `target`, as wide as the bridge between the eyes.
    ry = .03 * k
    carve_center, carve_radii = (0.0, target - ry, ez + .004 * k), (.72 * ex, ry, .03 * k)
    blend = .014 * k

    def sdf(p):
        return smooth_max(base(p), -ellipsoid_sdf(p, carve_center, carve_radii), blend)
    return sdf


def _front(sdf, x, z, depth):
    """The field's front surface y at (x, z), marching back from `2 depth` in front of the head's middle."""
    step, y = depth / 200, -2 * depth
    while sdf((x, y, z)) > 0 and y < 0: y += step
    low, high = y - step, y
    for _ in range(40):
        mid = (low + high) / 2
        if sdf((x, mid, z)) < 0: high = mid
        else: low = mid
    return high


def _mix(a, b, t): return tuple(x + (y - x) * t for x, y in zip(a, b))


def add_face(objects, values=None):
    """Give a rigged stylized character (`rig_character`'s objects) a living arkit-face/1 face on its `head` bone.

    Returns the objects plus the face mesh and the two eyeballs. The rig's extras declare the face contract with
    `skeleton='body'`. The character must have been built with `face='arkit'`; its `face_shape` sets the features.
    """
    from agent_meshes_author import (
        JawHinge, add_eye_bones, add_jaw_open, build_eye, eye_hole_mask, eye_holes, face_contract, follow_skin, front_surface,
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
    eye_options = dict(opening=L['opening'], meet=2, overlap=10, squint=.3, squint_upper_share=.5,
                       wide=(12, 4))
    holes = eye_holes(blank['vertices'], blank['faces'], eye_left, radius, max_edge=.25 * radius,
                      socket=0, crease=0,
                      blend=1.2 * radius, lash_width=8, **eye_options)
    lips = sculpt_lips(holes['vertices'], holes['faces'], mouth_z, half_width, fullness=L['lip_fullness'],
                       height=.5 * half_width)
    nose = nose_geometry(lips['vertices'], lips['faces'], L['nose'], L['nose_size'])
    vertices, faces = nose['vertices'], nose['faces']
    front = front_surface(vertices, faces)
    jaw = JawHinge.ear(vertices, mouth_z, half_width, band=.06 * k, lip_round=1.1)
    head = mesh_from_geometry('head_skin', {'vertices': vertices, 'faces': faces, 'material_indices': nose['material_indices']},
                              [skin, nostril])
    slit_mouth(head, mouth_z, half_width)
    rest = [tuple(v.co) for v in head.data.vertices]
    corner = (half_width, front(half_width, mouth_z), mouth_z)
    still = eye_hole_mask(holes['L'], holes['R'])

    mouth_front = front(0, mouth_z)
    (bx, bz), (ox, oz) = L['brow_inner'], L['brow_outer']
    cheek_x, cheek_z = L['cheek'][0][0], L['cheek'][0][2]
    cheek = (cheek_x, front(cheek_x, cheek_z), cheek_z)
    pairs = {
        'browDown': ((bx * 2.5, front(bx * 2.5, bz), bz), .018 * k, (0, -.001 * k, -.004 * k)),
        'browOuterUp': ((ox, front(ox, oz), oz), .016 * k, (0, 0, .004 * k)),
        'cheekSquint': (cheek, .03 * k, (0, -.0015 * k, .0045 * k)),
        'mouthFrown': (corner, .018 * k, (-.0005 * k, -.0005 * k, -.006 * k)),
        'mouthStretch': (corner, .026 * k, (.005 * k, .001 * k, -.0015 * k)),
    }
    for name, (center, reach, offset) in pairs.items():
        left, right = symmetric_offsets(rest, center, reach, offset, mask=still)
        shape_key(head, f'{name}Left', left)
        shape_key(head, f'{name}Right', right)
    # The smile: the corners draw up, out and back, and the cheek above each rises with them into the lower lid, so a
    # smile rounds the cheeks instead of pinching the corners into a grimace.
    for side, sx in (('Left', 1), ('Right', -1)):
        corner_side = (sx * corner[0], corner[1], corner[2])
        cheek_side = (sx * cheek[0], cheek[1], cheek[2])
        up = soft_offset(rest, corner_side, .03 * k, (sx * .004 * k, .001 * k, .0065 * k), mask=still)
        lift = soft_offset(rest, cheek_side, (.03 * k, .024 * k, .028 * k), (sx * .001 * k, -.0012 * k, .004 * k), mask=still)
        shape_key(head, f'mouthSmile{side}', [tuple(a[i] + b[i] - r[i] for i in range(3)) for a, b, r in zip(up, lift, rest)])
    left, right = symmetric_offsets(rest, *nose['sneer'])
    shape_key(head, 'noseSneerLeft', left); shape_key(head, 'noseSneerRight', right)
    shape_key(head, 'browInnerUp', soft_offset(rest, (0, front(0, bz), bz), (.03 * k, .02 * k, .016 * k), (0, 0, .004 * k), mask=still))
    shape_key(head, 'mouthFunnel', soft_offset(rest, (0, mouth_front, mouth_z), (.026 * k, .02 * k, .016 * k), (0, -.004 * k, 0)))
    add_jaw_open(head, jaw, min_chin_drop=.1)

    # A warm resting face: the mouth corners turn up (the boards' portraits all smile), by `smile` of the face shape,
    # at most to just under the upper gum line (the lower lip's corners open with the jaw; above the gum they would
    # drag the upper lip).
    # The lift is added to the rest shape and every shape key alike, after the morphs were made on the neutral mouth,
    # so every morph keeps its motion and the jaw still parts the lips along the slit.
    warm = L['resting_smile']
    if warm > 0:
        left, right = symmetric_offsets(rest, corner, .028 * k, (.001 * k * warm, 0, .004 * k * warm), mask=still)
        lift = [tuple(a[i] + b[i] - 2 * r[i] for i in range(3)) for a, b, r in zip(left, right, rest)]
        for block in head.data.shape_keys.key_blocks:
            for point, delta in zip(block.data, lift): point.co = tuple(point.co[i] + delta[i] for i in range(3))
        for vertex, delta in zip(head.data.vertices, lift): vertex.co = tuple(vertex.co[i] + delta[i] for i in range(3))
    # Paint: warm cheeks, tinted lips, a little shade in each socket, and stubble or a beard.
    base = linear_color(skin_hex)
    blush = (base[0] * .92, base[1] * .62, base[2] * .6)
    lip = (base[0] * .72, base[1] * .42, base[2] * .42)
    patches = [{'center': (sx * cheek_x, front(sx * cheek_x, cheek_z), cheek_z), 'radius': (.017 * k, .012 * k, .011 * k),
                'color': blush, 'strength': .5} for sx in (1, -1)]
    patches.append({'center': (0, mouth_front, mouth_z - .002 * k), 'radius': (half_width * 1.05, .01 * k, .006 * k), 'color': lip, 'strength': .7})
    patches.append({'center': (0, mouth_front, mouth_z + .0015 * k), 'radius': (half_width, .01 * k, .004 * k), 'color': lip, 'strength': .5})
    # The lip line: a thin dark crease, as the boards draw a closed smiling mouth.
    ink = tuple(c * .45 for c in lip)
    patches.append({'center': (0, mouth_front, mouth_z), 'radius': (half_width * 1.02, .01 * k, .0011 * k), 'color': ink, 'strength': .5})
    for eye in (eye_left, eye_right):
        patches.append({'center': eye, 'radius': radius * 1.9, 'color': tuple(c * .9 for c in base), 'strength': .2})
    tints = skin_tints(rest, base=skin_hex, patches=patches)
    if L['beard'] != 'none':
        tints = _beard_tints(rest, tints, L, front, linear_color(L['beard_color']), base)
    paint_vertices(head, tints)
    use_vertex_colors(skin)

    # The mouth: a dark bag wider and taller than the open lips, so no view past the corners finds the inside of the head.
    dark = material('mouth_cavity', '#1e0709', roughness=.9)
    dark.use_backface_culling = False
    # Its rim rides the skin's smile, frown and funnel (follow_skin): a still rim shows through the corners they draw back.
    bag = follow_skin(mouth_cavity_geometry((0, mouth_front, mouth_z - .002 * k), width=2 * half_width + .01 * k, height=.04 * k,
                                            depth=.055 * k, surface=front, inset=.006 * k), head, reach=.03 * k, skip=['jawOpen'])
    cavity = mesh_from_geometry('mouth_cavity', bag, [dark])
    for name, targets in bag['morphs'].items(): shape_key(cavity, name, targets)
    add_jaw_open(cavity, jaw)
    teeth = '#eeeae0'
    # The upper gum line sits well above the lips (a real mouth's does), so the smiling corners stay below it.
    upper = mesh_from_geometry('teeth_upper', teeth_row_geometry('rounded', (0, mouth_front + .005 * k, mouth_z + .0045 * k), .8 * half_width,
                               .011 * k, 8, .008 * k, row='upper'), [material('teeth_upper', teeth, roughness=.3)])
    lower = mesh_from_geometry('teeth_lower', teeth_row_geometry('rounded', (0, mouth_front + .006 * k, mouth_z - .0015 * k), .76 * half_width,
                               .011 * k, 8, .0045 * k, row='lower'), [material('teeth_lower', teeth, roughness=.3)])
    add_jaw_open(lower, jaw, rigid=True)
    tongue_hex = _hex(_mix(linear_color('#b24c55'), (base[0] * .5, base[1] * .2, base[2] * .2), .25))
    # The tongue lies on the mouth floor, its tip well behind the chin's skin (a short child's chin is close behind the lips).
    tongue_z, tongue_length = mouth_z - .013 * k, .03 * k
    tongue_y = max(mouth_front + .024 * k, front(0, tongue_z) + .006 * k + tongue_length / 2)
    tongue = mesh_from_geometry('tongue', tongue_geometry((0, tongue_y, tongue_z), length=tongue_length, width=1.2 * half_width,
                                thickness=.0075 * k), [material('tongue', tongue_hex, roughness=.45)])
    add_jaw_open(tongue, jaw, rigid=True)

    eye_mats = [material('eye_white', '#efece4', roughness=.2), material('eye_iris', L['eyes'], roughness=.25),
                material('eye_pupil', '#0b0908', roughness=.15)]
    parts, eyeballs = [head, cavity, upper, lower, tongue], []
    lash = material('lash', '#0b0706', roughness=.85)
    for side, center in (('L', eye_left), ('R', eye_right)):
        built = build_eye(rig, side, center, radius, lid_material=skin, hole=holes[side], eye_materials=eye_mats, lash=lash, skin=head,
                          iris=L['iris'], pupil=L['pupil'], lash_width=8)
        eyeballs.append(built['eyeball'])
        parts.append(built['lids'])
    # Brows a shade darker than the hair, so they read against the skin at lineup size whatever the two colors.
    brow_mat = material('brow', _hex(_mix(linear_color(hair_hex), (.01, .008, .007), .75)), roughness=.7)
    h = L['brow_height']
    brows = [skin_brow_geometry(head, side, inner=(bx, bz), outer=(ox, oz), height=h, thickness=.0022 * k,
                                arch=.0015 * k, down=.004 * k, inner_up=.004 * k, outer_up=.004 * k, pinch=.002 * k, hole=holes[side])
             for side in 'LR']
    bgeo = join_geometry(brows)
    brow = mesh_from_geometry('brows', bgeo, [brow_mat])
    for name, targets in bgeo['morphs'].items(): shape_key(brow, name, targets)
    parts.append(brow)

    face = join_face_parts(parts, 'face', rig=rig, area_normals=True)
    new = [face] + eyeballs
    for obj in new:
        # Like the body's skins, export at the scene root (rig_character does the same).
        world = obj.matrix_world.copy(); obj.parent = None; obj.matrix_world = world
    gaze = recommended_gaze(L['opening'], iris=L['iris'])
    face_contract(rig, list(objects) + new, yaw_max=gaze['yawMax'], pitch_max=gaze['pitchMax'], skeleton='body')
    return list(objects) + new


def beard_weight(point, layout, front_y):
    """How much beard (0..1) covers a skin point: the jaw, chin, cheeks below the cheekbones and a moustache over the
    upper lip, only on the front half of the head, leaving the lips themselves bare. `front_y` is the skin's front y at
    the point's (x, z) (None off the face). Pure."""
    x, y, z = point
    k, mouth_z, half_width = layout['scale'], layout['mouth_z'], layout['mouth_half_width']
    center = layout['center']
    if front_y is None: return 0.0

    def ramp(e0, e1, v):
        t = min(1.0, max(0.0, (v - e0) / (e1 - e0)))
        return t * t * (3 - 2 * t)
    # Down the face: from the cheekbones (below the nose's top) to under the chin; the cheek line rises toward the ears.
    top = layout['nose'][1] - .004 * k + .25 * abs(x)
    vertical = 1 - ramp(top - .006 * k, top + .004 * k, z)
    # Round the head: the front and sides back to the ears, not the neck behind.
    around = 1 - ramp(center[1] - .01 * k, center[1] + .025 * k, y)
    # Bare lips: an ellipse round the mouth, the moustache kept above it.
    lips = ((x / (1.1 * half_width)) ** 2 + ((z - mouth_z + .0015 * k) / (.0068 * k)) ** 2) ** .5
    bare = 1 - ramp(.8, 1.15, lips)
    # Under the nose the moustache stops short of the nostrils.
    nostril = 1 - ramp(layout['nose'][1] - .006 * k, layout['nose'][1] - .002 * k, z) if abs(x) < 1.4 * layout['nose_size'][0] else 1.0
    return max(0.0, min(1.0, vertical * around * (1 - bare) * nostril))


def _beard_tints(rest, tints, layout, front, color, base):
    """Stubble (a fine, mottled shade) or a short beard (denser, darker) painted over the skin's tints."""
    import math
    density = .55 if layout['beard'] == 'stubble' else .92
    tint = tuple(min(1.0, c / b) if b > 0 else 1.0 for c, b in zip(color, base))
    k = layout['scale']
    out = []
    for v, t in zip(rest, tints):
        w = beard_weight(v, layout, front(v[0], v[2]))
        if w <= 0: out.append(t); continue
        # A fine grain, so the beard reads as hair, not a painted patch.
        grain = .5 + .5 * math.sin(v[0] * 2900 / k) * math.sin(v[2] * 3100 / k + v[1] * 1700 / k)
        a = w * density * (.8 + .2 * grain)
        out.append(tuple(c + a * (c * m - c) for c, m in zip(t, tint)))
    return out


def _hex(linear):
    """An sRGB hex string for a linear RGB triple."""
    def channel(v):
        v = max(0.0, min(1.0, v))
        return round(255 * (12.92 * v if v <= .0031308 else 1.055 * v ** (1 / 2.4) - .055))
    return '#' + ''.join(f'{channel(v):02x}' for v in linear)
