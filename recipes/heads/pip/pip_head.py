"""Pip: a round-faced kid with a cowlick, big teal eyes, freckles and two proud front teeth (arkit-face/1).

Built with agent-meshes' face-rig helpers (agent_meshes_author / agent_meshes_face). This file
holds Pip's character: proportions, colors, parameters and emotion tuning. Target: a 2D concept sheet.

The head is one continuous skin: an SDF blank (`sdf_blank`) with round cheeks grown by `sculpt_skin`, mirrored eye
holes (`eye_holes`), soft lips with a lip line (`sculpt_lips`) and a small button nose (`nose_geometry`), all fused
into the same surface, so there is no face patch, no socket shell and no mouth-line row of Pip's own.

Blender coordinates: Z up, meters, the face looks down -Y, the character's left is +X.
Concept-sheet units map to meters by S: x -> (x - 100) * S, y -> (214 - y) * S (the shirt's hem sits on z = 0).
"""
import math

from agent_meshes_author import (
    JawHinge, add_jaw_open, attach_to_skin, bind_rigid, build_eye, ellipsoid_geometry, ellipsoid_sdf, exposed_teeth_geometry,
    eye_hole_mask, eye_holes, face_contract, face_skeleton, front_surface, join_face_parts, join_geometry, linear_color,
    material, mesh_from_geometry, mouth_cavity_geometry, nose_geometry, paint_vertices, recommended_gaze, sculpt_lips,
    sculpt_skin, sdf_blank, shape_key, smooth_max, skin_brow_geometry, skin_tints, slit_mouth, smooth_min, soft_offset, sweep_mesh,
    symmetric_offsets, teeth_row_geometry, tongue_geometry, use_vertex_colors,
)

S = .0017


def X(x): return (x - 100) * S


def Z(y): return (214 - y) * S


# ------------------------------------------------------------------ palette (sRGB hex; material() converts)
# MeshViewer's environment and key light push a front-lit color toward white and wash it out, so the materials are
# the concept's tones (pip.js C) taken darker and warmer until the rendered face matches the sheet (#d87850 renders
# as about #f6ceb0 on the forehead; the concept's skin is #f3b58d). Skin paint is set by the concept's own ratios.
CONCEPT_SKIN = '#f3b58d'
C = {
    'skin': '#d87850', 'neck': '#c46a45', 'freckle': '#8d5438', 'nostril': '#5a2618',
    'hair': '#502a17', 'hairSh': '#341809', 'hairHi': '#7c4b2c', 'brow': '#3f2213',
    'sclera': '#e6e2da', 'iris': '#226f80', 'irisDk': '#0e4353', 'irisLt': '#6ca4ab', 'pupil': '#090c0f',
    'mouth': '#370e16', 'tongue': '#ac535c', 'teeth': '#e8e3d8', 'shirt': '#2e606a', 'collar': '#d6cfc3',
}
# The concept's skin shades (pip.js C), applied as ratios to the skin material: blush, lips, creases, shadow, ink.
SHADES = {'blush': '#ef7f73', 'lip': '#e0877a', 'crease': '#b86a4c', 'skinSh': '#dc8f69', 'ink': '#4a2419'}


def mix(a, b, t): return tuple(x + (y - x) * t for x, y in zip(a, b))


def smooth(e0, e1, x):
    t = min(max((x - e0) / (e1 - e0), 0.0), 1.0)
    return t * t * (3 - 2 * t)


# TOOL-GAP: skin_tints paints radial patches only; per-vertex tints from a shade map (the hair cap's grooves, the ear's
# bowl, the iris rings) need this color ratio, which agent-meshes does not export.
def tint_of(color, base):
    """The vertex tint that turns material color `base` into `color` (glTF multiplies COLOR_0 by the base color)."""
    return tuple(min(1.0, a / b) for a, b in zip(linear_color(color), linear_color(base)))


def shade(name):
    """The skin paint color for a concept shade: the skin material darkened as the concept darkens its skin."""
    return tuple(c * t for c, t in zip(linear_color(C['skin']), tint_of(SHADES[name], CONCEPT_SKIN)))


WHITE = (1.0, 1.0, 1.0)

# ------------------------------------------------------------------ proportions
EYE_R = .023                       # big kid eyes (concept eye white r 13 units)
# Concept eye centers at x 77 / 123, y 106, set forward so the lids sit at the skin: an eye deep behind the face needs
# eye_hole's socket dip to pull the skin 15 mm in, which left a crater with a kink at brow height.
EYE_L = (X(123), -.058, Z(106))
EYE_R_C = (-EYE_L[0], EYE_L[1], EYE_L[2])
IRIS, PUPIL = 42, 18               # half-angles: concept iris r 9.2, pupil 4.3 (units)
# A big, round, open eye (half-width yaw, upper edge, lower edge). Squint leaves 30% open, the lower lid doing half of
# it (a lower share folds the lid rim), so happy lifts the lower lid into a smiling eye and angry narrows it visibly.
EYE_OPTIONS = dict(opening=(46, 38, 34), meet=4, overlap=12, squint=.3, squint_upper_share=.5, wide=(12, 4))
MOUTH_Z, MOUTH_HW = Z(143), .024
ORIGIN = (0.0, -.022, .172)        # the head field is star-shaped around this point
NOSE_TIP, NOSE_SIZE = (0.0, .1505), (.0088, .0082, .0085)   # a small button nose, about half the gap between the eyes
CHEEK = (X(129), Z(128))


# ------------------------------------------------------------------ the head: one smooth field, sampled by sdf_blank
def head_sdf(p):
    d = ellipsoid_sdf(p, (0, .012, .19), (.098, .1, .098))                          # cranium
    d = smooth_min(d, ellipsoid_sdf(p, (0, -.015, .128), (.088, .075, .066)), .025)  # round jowls, full to the chin
    d = smooth_min(d, ellipsoid_sdf(p, (0, -.05, .097), (.028, .024, .018)), .02)   # small chin
    # A low, soft bridge between the eyes: a kid's face is flat across the eyes, so the skin by each inner corner lies
    # near the lids instead of standing far in front of them (eye_hole's socket dip then has little to pull in).
    d = smooth_max(d, -ellipsoid_sdf(p, (0, -.1, .172), (.034, .022, .032)), .016)
    return d


# Round kid cheeks grown on the blank (smooth union, refined where they are).
CHEEKS = [((sx * .05, -.06, .137), (.032, .03, .028), .02) for sx in (1, -1)]


# ------------------------------------------------------------------ paint
FRECKLES = [(-6, -2, 1.1), (-1, -4, 1.2), (4, -1.5, 1), (-3, 2, 1), (2.5, 2.5, .9), (7, 1, .8)]
SPOTS = [(sg * (CHEEK[0] + dx * S), CHEEK[1] - dy * S, .0007 + .0004 * rr) for sg in (1, -1) for dx, dy, rr in FRECKLES]


def skin_paint(rest, front):
    lip_y = front(0, MOUTH_Z)
    patches = [
        # blush on the round of each cheek
        *({'center': (sx * CHEEK[0], front(sx * CHEEK[0], CHEEK[1]), CHEEK[1]), 'radius': (.02, .016, .014),
           'color': shade('blush'), 'strength': .55} for sx in (1, -1)),
        # a warm nose tip
        {'center': (0, front(*NOSE_TIP), NOSE_TIP[1]), 'radius': (.011, .012, .01), 'color': shade('blush'), 'strength': .3},
        # rosy lips, fuller below
        {'center': (0, lip_y, MOUTH_Z - .002), 'radius': (.026, .014, .0075), 'color': shade('lip'), 'strength': .85},
        {'center': (0, lip_y, MOUTH_Z + .002), 'radius': (.024, .014, .005), 'color': shade('lip'), 'strength': .5},
        # the lip line and its corners
        {'center': (0, lip_y, MOUTH_Z), 'radius': (.023, .02, .0013), 'color': shade('ink'), 'strength': .35},
        *({'center': (sx * MOUTH_HW, front(sx * MOUTH_HW, MOUTH_Z), MOUTH_Z), 'radius': .0035, 'color': shade('crease'),
           'strength': .5} for sx in (1, -1)),
        # a light shadow in each socket, and under the chin toward the neck
        *({'center': eye, 'radius': .031, 'color': shade('skinSh'), 'strength': .35} for eye in (EYE_L, EYE_R_C)),
        {'center': (0, -.02, .075), 'radius': (.08, .07, .035), 'color': shade('skinSh'), 'strength': .4},
    ]
    return skin_tints(rest, base=C['skin'], patches=patches)


def paint_eyeball(obj, center):
    """Iris shading: light by the pupil, the concept teal, a dark limbal ring at the edge (on split iris borders)."""
    iris_verts = set()
    for poly in obj.data.polygons:
        if poly.material_index == 1: iris_verts.update(poly.vertices)
    tints = []
    for v in obj.data.vertices:
        d = tuple(v.co[k] - center[k] for k in range(3))
        n = math.sqrt(sum(c * c for c in d)) or 1
        angle = math.degrees(math.acos(max(-1, min(1, -d[1] / n))))
        if v.index in iris_verts:
            t = (angle - PUPIL) / (IRIS - PUPIL)
            color = mix(WHITE, tint_of(C['iris'], C['irisLt']), smooth(0, .55, t))
            color = mix(color, tint_of(C['irisDk'], C['irisLt']), smooth(.6, 1.0, t))
            if d[2] < 0 and .2 < t < .8: color = mix(color, WHITE, .35 * min(1, -d[2] / (n * .4)))
            tints.append(color)
        else:
            tints.append(WHITE)
    paint_vertices(obj, tints)


# ------------------------------------------------------------------ hair: a sculpted cap with a scalloped fringe
# TOOL-GAP: agent-meshes has no hair-cap builder (a cap that follows a hairline with locks, grooves and a lip); the
# kid fixture's is a cut ellipsoid. This one, and the skull ray it lays the cap on, are Pip's until one lands.
LOCK_TIPS = [X(76), X(96), X(115), X(131)]     # the fringe's four locks (concept, asymmetric)
LOCK_JOINS = [X(66), X(86), X(106), X(124)]


def _on_skull(direction, outer=.17, step=.002):
    """The head field's outermost zero along the ray from ORIGIN (the skull the hair cap lies on)."""
    point = lambda r: tuple(ORIGIN[k] + direction[k] * r for k in range(3))
    high = outer
    while high > step and head_sdf(point(high - step)) > 0: high -= step
    low = max(0.0, high - step)
    for _ in range(22):
        mid = (low + high) / 2
        if head_sdf(point(mid)) < 0: low = mid
        else: high = mid
    return point((low + high) / 2)


def hairline_z(p):
    x, y, _ = p
    az = abs(math.atan2(x, -y))
    locks = max(math.sqrt(max(0.0, 1 - ((x - t) / .0112) ** 2)) for t in LOCK_TIPS)   # rounded lock ends
    fringe = .2505 - .0095 * locks
    z = fringe + (.188 - fringe) * smooth(.62, 1.3, az)
    return z + (.128 - z) * smooth(1.95, 2.75, az)


def _meridian(az, el): return (math.cos(el) * math.sin(az), -math.cos(el) * math.cos(az), math.sin(el))


def hair_geometry(columns=136, rings=28):
    """A hair cap over the skull from the hairline to the crown: its rim follows the hairline exactly, tucks under the
    skin, rises into a rounded lip and swells to the crown, with grooves between locks; plus the two-prong cowlick."""
    vertices, shade = [], []
    for i in range(columns):
        v = 2 * i / columns - 1
        az = math.pi * (.45 * v + .55 * v ** 3)                     # denser at the front, where the fringe is
        low, high = -.9, 1.5
        for _ in range(30):                                          # where this meridian meets the hairline
            mid = (low + high) / 2
            p = _on_skull(_meridian(az, mid))
            if p[2] < hairline_z(p): low = mid
            else: high = mid
        el0 = (low + high) / 2
        for k in range(rings):
            t = (k / rings) ** 1.8
            el = el0 + (math.pi / 2 - el0) * t
            d = _meridian(az, el)
            p = _on_skull(d)
            arc = (el - el0) * .1                                     # meters from the rim, roughly
            lip = smooth(0, .0026, arc) ** .7
            x, y, z = p
            thick = .0068 + .006 * smooth(.23, .29, z) + .0022 * smooth(0, -.07, y) * smooth(.21, .25, z)
            front = 1 - smooth(.5, .8, abs(az))
            joins = max(math.exp(-((x - j) / .0022) ** 2) for j in LOCK_JOINS) * smooth(0, .012, arc) * (1 - smooth(.012, .03, arc))
            flow = (.5 + .5 * math.cos(26 * az)) ** 3 * (1 - smooth(.55, .9, t)) * smooth(.004, .014, arc)
            groove = front * max(joins, .6 * flow) + (1 - front) * flow
            off = -.0012 + (thick * (1 - .28 * groove) + .0012) * lip
            vertices.append(tuple(p[n] + d[n] * off for n in range(3)))
            shade.append(max(groove, .5 * (1 - lip)))
    top = _on_skull((0.0, 0.0, 1.0))
    vertices.append((top[0], top[1], top[2] + .0128))
    shade.append(0.0)
    faces = []
    at = lambda i, k: (i % columns) * rings + k
    for i in range(columns):
        for k in range(rings - 1):
            faces.append((at(i, k), at(i + 1, k), at(i + 1, k + 1), at(i, k + 1)))
        faces.append((at(i, rings - 1), at(i + 1, rings - 1), len(vertices) - 1))
    a, b, c = (vertices[n] for n in faces[0][:3])
    normal = ((b[1] - a[1]) * (c[2] - a[2]) - (b[2] - a[2]) * (c[1] - a[1]), (b[2] - a[2]) * (c[0] - a[0]) - (b[0] - a[0]) * (c[2] - a[2]),
              (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]))
    if sum(normal[n] * (a[n] - ORIGIN[n]) for n in range(3)) < 0: faces = [tuple(reversed(f)) for f in faces]
    # The cowlick: two tapered prongs rising from the crown (concept tuft at x 97-131, y 13-46).
    prongs = [
        [(X(99), .002, Z(49)), (X(93), .003, Z(36)), (X(95), .005, Z(24)), (X(102), .007, Z(16.5)), (X(111), .01, Z(13.5))],
        [(X(106), .0, Z(47)), (X(111), .002, Z(35)), (X(118), .005, Z(27.5)), (X(125), .007, Z(24)), (X(131), .01, Z(24.5))],
    ]
    for centers in prongs:
        n = len(centers)
        radii = [(.0052 * (1 - .82 * i / (n - 1)), .0105 * (1 - .9 * i / (n - 1))) for i in range(n)]
        pv, pf = sweep_mesh(centers, radii, radial_segments=16, initial_normal=(0, -1, 0))
        base = len(vertices)
        vertices += list(pv)
        faces += [tuple(i + base for i in f) for f in pf]
        shade += [.25] * len(pv)
    return {'vertices': vertices, 'faces': faces}, shade


# ------------------------------------------------------------------ ears, neck, shirt
# TOOL-GAP: agent-meshes has no ear builder (a cupped ear seated on the side of the head); Pip's is a dished ellipsoid.
def ear_geometry(side):
    g = ellipsoid_geometry((0, 0, 0), (.007, .016, .023), rings=18, segments=28)
    sg = 1 if side == 'L' else -1
    vertices, bowl = [], []
    yaw = math.radians(34)
    for x, y, z in g['vertices']:
        cup = max(0.0, 1 - (y / .0115) ** 2 - ((z + .001) / .0175) ** 2)
        if x > 0: x -= .0085 * cup ** .7
        bowl.append(cup if x > -.001 else 0.0)
        xr, yr = x * math.cos(yaw) + y * math.sin(yaw), -x * math.sin(yaw) + y * math.cos(yaw)
        vertices.append((sg * (xr + .095), yr + .004, z + Z(114)))
    faces = g['faces'] if sg > 0 else [tuple(reversed(f)) for f in g['faces']]
    return {'vertices': vertices, 'faces': faces}, bowl


# TOOL-GAP: agent-meshes has no neck/shirt/collar bust builder; Pip's is a swept neck, a cut ellipsoid and a collar tube.
def body_geometry():
    neck_v, neck_f = sweep_mesh([(0, .012, .028), (0, .012, .08), (0, .012, .128)], [(.029, .026)] * 3,
                                radial_segments=32, initial_normal=(1, 0, 0))
    shirt = ellipsoid_geometry((0, .016, .0), (.126, .075, .058), rings=20, segments=44)
    sv = shirt['vertices']
    keep = [f for f in shirt['faces'] if sum(sv[i][2] for i in f) / len(f) > -.004]
    used = sorted({i for f in keep for i in f})
    index = {o: n for n, o in enumerate(used)}
    shirt_v, shirt_f = [sv[i] for i in used], [tuple(index[i] for i in f) for f in keep]
    path = []
    for k in range(25):
        t = math.radians(-128 + 256 * k / 24)
        front = max(0.0, math.cos(t)) ** 2
        path.append((.035 * math.sin(t), .012 - .031 * math.cos(t), .054 - .02 * front))
    collar_v, collar_f = sweep_mesh(path, [(.0055, .0034)] * len(path), radial_segments=12, initial_normal=(0, 0, 1))
    torso = {'vertices': shirt_v + list(collar_v), 'faces': shirt_f + [tuple(i + len(shirt_v) for i in f) for f in collar_f],
             'material_indices': [0] * len(shirt_f) + [1] * len(collar_f)}
    return {'vertices': list(neck_v), 'faces': list(neck_f)}, torso


# ------------------------------------------------------------------ emotions (TH.PRESETS, tuned for Pip)
EMOTIONS = {
    'neutral': {},
    # Cheeks lift into the lower lids and the eyes smile.
    'happy': {'mouthSmileLeft': .9, 'mouthSmileRight': .9, 'jawOpen': .22, 'cheekSquintLeft': .9, 'cheekSquintRight': .9,
              'eyeSquintLeft': .4, 'eyeSquintRight': .4, 'browOuterUpLeft': .3, 'browOuterUpRight': .3},
    'sad': {'browInnerUp': .9, 'mouthFrownLeft': .85, 'mouthFrownRight': .85, 'eyeBlinkLeft': .25, 'eyeBlinkRight': .25,
            'eyeLookDownLeft': .4, 'eyeLookDownRight': .4},
    # Brows pinch and drop, a visible squint, the nostril wings sneer, the mouth pressed tight and pulled down.
    'angry': {'browDownLeft': 1, 'browDownRight': 1, 'eyeSquintLeft': .75, 'eyeSquintRight': .75, 'noseSneerLeft': .9,
              'noseSneerRight': .9, 'cheekSquintLeft': .3, 'cheekSquintRight': .3, 'mouthFrownLeft': .6,
              'mouthFrownRight': .6, 'mouthStretchLeft': .55, 'mouthStretchRight': .55, 'jawOpen': .05},
    'surprised': {'eyeWideLeft': 1, 'eyeWideRight': 1, 'browInnerUp': .9, 'browOuterUpLeft': 1, 'browOuterUpRight': 1,
                  'jawOpen': .6, 'mouthFunnel': .85},
    'scared': {'eyeWideLeft': 1, 'eyeWideRight': 1, 'browInnerUp': 1, 'browDownLeft': .25, 'browDownRight': .25,
               'mouthStretchLeft': .9, 'mouthStretchRight': .9, 'mouthFrownLeft': .3, 'mouthFrownRight': .3, 'jawOpen': .3},
}


def build():
    skin = use_vertex_colors(material('skin', C['skin'], roughness=.55))
    nostril = material('nostril', C['nostril'], roughness=.8)
    rig = face_skeleton(head=(0, .0, MOUTH_Z), eye_left=EYE_L, eye_right=EYE_R_C, name='Face rig')

    # One continuous head: the field's blank, round cheeks, mirrored eye holes, lips with a lip line, a button nose.
    blank = sdf_blank(head_sdf, ORIGIN, rings=68, segments=92)
    cheeks = sculpt_skin(blank['vertices'], blank['faces'], CHEEKS, max_edge=.0055)
    # TOOL-GAP: eye_hole's socket dip jumps (up to (push + blend) - depth, 3 mm here) where it meets the mound when
    # `blend` exceeds about 0.45 eyeball radii, which cut a jagged line under each eye; the default blend is kept.
    # Its refined skin also shades with faint radial streaks round the eye; max_edge .0035 (0.15 radii) softens them.
    cut = eye_holes(cheeks['vertices'], cheeks['faces'], EYE_L, EYE_R, style='shells', max_edge=.0035, **EYE_OPTIONS)
    holes = {'L': cut['L'], 'R': cut['R']}
    # TOOL-GAP: sculpt_lips streaks/corner folds (fix in progress in agent-meshes). On this sdf_blank head, angry and
    # scared + jawOpen 1 folded two triangles below each corner; mouthStretch spreads wider and gentler to pass verify.
    lips = sculpt_lips(cut['vertices'], cut['faces'], MOUTH_Z, MOUTH_HW, fullness=.0024, crease=.0017, height=.0105, max_edge=.0024)
    nose = nose_geometry(lips['vertices'], lips['faces'], NOSE_TIP, NOSE_SIZE)
    vertices, faces = nose['vertices'], nose['faces']
    front = front_surface(vertices, faces)
    jaw = JawHinge.ear(vertices, MOUTH_Z, MOUTH_HW, band=.045, lip_round=1.1)
    head = mesh_from_geometry('head_skin', {'vertices': vertices, 'faces': faces, 'material_indices': nose['material_indices']},
                              [skin, nostril])
    slit_mouth(head, MOUTH_Z, MOUTH_HW)
    rest = [tuple(v.co) for v in head.data.vertices]
    paint_vertices(head, skin_paint(rest, front))
    still = eye_hole_mask(*holes.values())

    corner = (MOUTH_HW, front(MOUTH_HW, MOUTH_Z), MOUTH_Z)
    cheek = (CHEEK[0], front(*CHEEK), CHEEK[1])
    pairs = {
        'cheekSquint': (cheek, .026, (0, -.003, .0075)),
        'mouthSmile': (corner, .018, (.004, .002, .0088)),
        'mouthFrown': (corner, .02, (-.0006, -.0005, -.0075)),
        'mouthStretch': (corner, .03, (.0055, .001, -.0018)),
    }
    for name, (center, radius, offset) in pairs.items():
        left, right = symmetric_offsets(rest, center, radius, offset, mask=still)
        shape_key(head, f'{name}Left', left)
        shape_key(head, f'{name}Right', right)
    left, right = symmetric_offsets(rest, *nose['sneer'])
    shape_key(head, 'noseSneerLeft', left)
    shape_key(head, 'noseSneerRight', right)
    # The skin between and above the brows follows them a little: a knit furrow for browDown, a lift for browInnerUp.
    left, right = symmetric_offsets(rest, (.019, front(.019, .214), .214), .016, (-.002, .0006, -.0045), mask=still)
    shape_key(head, 'browDownLeft', left)
    shape_key(head, 'browDownRight', right)
    shape_key(head, 'browInnerUp', soft_offset(rest, (0, front(0, .215), .215), (.03, .02, .016), (0, 0, .0038), mask=still))
    # mouthFunnel: the lips push forward and the corners draw in (an "oo").
    forward = soft_offset(rest, (0, front(0, MOUTH_Z), MOUTH_Z), (.032, .022, .016), (0, -.0065, 0))
    left_in, right_in = symmetric_offsets(rest, corner, .014, (-.0075, -.001, 0))
    funnel = [tuple(f[k] + (a[k] - r[k]) + (b[k] - r[k]) for k in range(3)) for f, a, b, r in zip(forward, left_in, right_in, rest)]
    shape_key(head, 'mouthFunnel', funnel)
    add_jaw_open(head, jaw, min_chin_drop=.1)

    # Freckles: small flat dots seated on the cheeks that ride the skin's morphs (cheekSquint lifts them).
    dots = [attach_to_skin(ellipsoid_geometry((fx, front(fx, fz), fz), (fr, .0005, fr), rings=6, segments=10), head, depth=.0002)
            for fx, fz, fr in SPOTS]
    fgeo = join_geometry(dots)
    freckles = mesh_from_geometry('freckles', fgeo, [material('freckle', C['freckle'], roughness=.6)])
    for name, targets in fgeo['morphs'].items(): shape_key(freckles, name, targets)

    # Mouth interior.
    dark = material('mouth_cavity', C['mouth'], roughness=.85)
    dark.use_backface_culling = False
    fy = front(0, MOUTH_Z)
    cavity = mesh_from_geometry('mouth_cavity', mouth_cavity_geometry((0, fy, MOUTH_Z - .001), width=2 * MOUTH_HW + .008,
                                height=.034, depth=.05, surface=front), [dark])
    add_jaw_open(cavity, jaw)
    upper = mesh_from_geometry('teeth_upper', teeth_row_geometry('rounded', (0, fy + .0075, MOUTH_Z + .003), .02, .013, 6, .0075,
                                                                 row='upper'), [material('teeth_upper', C['teeth'], roughness=.25)])
    lower = mesh_from_geometry('teeth_lower', teeth_row_geometry('rounded', (0, fy + .0085, MOUTH_Z - .003), .0175, .012, 6, .0065,
                                                                 row='lower'), [material('teeth_lower', C['teeth'], roughness=.25)])
    add_jaw_open(lower, jaw, rigid=True)
    buck = mesh_from_geometry('buck_teeth', exposed_teeth_geometry(front, [-.0042, .0042], MOUTH_Z, length=.0062, width=.0078,
                                                                     style='rounded'), [material('teeth_exposed', C['teeth'], roughness=.2)])
    tongue = mesh_from_geometry('tongue', tongue_geometry((0, fy + .02, MOUTH_Z - .011), length=.03, width=.028, thickness=.0075),
                                [material('tongue', C['tongue'], roughness=.4)])
    add_jaw_open(tongue, jaw, rigid=True)
    parts = [head, cavity, upper, lower, buck, tongue, freckles]
    for side in 'LR':
        g, bowl = ear_geometry(side)
        g = attach_to_skin(g, head)            # the ears ride the skin where the jaw hinge stretches it
        ear = mesh_from_geometry(f'ear_{side}', g, [skin])
        for name, targets in g['morphs'].items(): shape_key(ear, name, targets)
        paint_vertices(ear, [mix(WHITE, tint_of(SHADES['crease'], CONCEPT_SKIN), .5 * b) for b in bowl])
        parts.append(ear)

    # Brows laid on the skin in every pose (the head's own brow furrow and lift included); browDown pinches and drops.
    brow_mat = material('brow', C['brow'], roughness=.7)
    # TOOL-GAP: skin_brow_geometry folds brow faces (verify: inversion) when a pose slides it over skin whose normals
    # turn quickly, as over an eye hole's socket dip; the eyes sit forward (EYE_L) so the forehead above them is smooth.
    brows = [skin_brow_geometry(head, side, inner=(.016, .221), outer=(.062, .219), height=.0068, thickness=.0026,
                                arch=.0045, down=.011, pinch=.0045, inner_up=.0105, outer_up=.009, hole=holes[side]) for side in 'LR']
    bgeo = join_geometry(brows)
    brow = mesh_from_geometry('brows', bgeo, [brow_mat])
    for name, targets in bgeo['morphs'].items(): shape_key(brow, name, targets)
    parts.append(brow)

    eye_mats = [material('eye_white', C['sclera'], roughness=.15),
                use_vertex_colors(material('eye_iris', C['irisLt'], roughness=.2)),
                material('eye_pupil', C['pupil'], roughness=.1)]
    eyeballs = []
    for side, center in (('L', EYE_L), ('R', EYE_R_C)):
        eye = build_eye(rig, side, center, EYE_R, lid_material=skin, style='lid', hole=holes[side], eye_materials=eye_mats,
                        iris=IRIS, pupil=PUPIL, split_borders=True, lash=True, lash_width=6)
        paint_eyeball(eye['eyeball'], center)
        eyeballs.append(eye['eyeball'])
        parts.append(eye['lids'])

    # One morph-bearing mesh (Unreal keeps morph names only when no name repeats across meshes); paint rides along.
    face = join_face_parts(parts, 'face', rig=rig)

    hair_geo, shade = hair_geometry()
    hair_mat = use_vertex_colors(material('hair', C['hairHi'], roughness=.45))
    hair = mesh_from_geometry('hair', hair_geo, [hair_mat])
    paint_vertices(hair, [mix(tint_of(C['hair'], C['hairHi']), tint_of(C['hairSh'], C['hairHi']), .75 * g) for g in shade])
    bind_rigid(hair, rig, 'head')
    neck_geo, torso_geo = body_geometry()
    neck = mesh_from_geometry('neck', neck_geo, [material('body_skin', C['neck'], roughness=.55)])
    bind_rigid(neck, rig, 'head')
    torso = mesh_from_geometry('torso', torso_geo, [material('body_shirt', C['shirt'], roughness=.8),
                                                    material('body_collar', C['collar'], roughness=.7)])
    bind_rigid(torso, rig, 'head')

    objects = [rig, face, hair, neck, torso] + eyeballs
    gaze = recommended_gaze(EYE_OPTIONS['opening'], iris=IRIS)
    face_contract(rig, objects, yaw_max=min(gaze['yawMax'], 30), pitch_max=min(gaze['pitchMax'], 18),
                  emotions=EMOTIONS, exposed_teeth=['teeth_exposed'])
    return objects
