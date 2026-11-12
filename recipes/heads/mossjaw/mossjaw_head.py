"""Mossjaw: a friendly swamp creature (arkit-face/1).

Only Mossjaw's character lives here: proportions, colors, parameters and emotion tuning. The rig logic (eye holes,
lids, the ear-hinged puppet jaw, teeth rows, the mouth cavity, the contract extras) comes from agent-meshes' face-rig
helpers. Target: a 2D concept sheet, whose 200-unit drawing
maps onto the head at SHEET_UNIT meters per unit. Local stand-ins for capabilities agent-meshes lacks are marked
`TOOL-GAP`.

Blender coordinates: Z up, meters, the face looks down -Y, the character's left is +X.
"""
import math
import random

from agent_meshes_author import (
    JawHinge, add_jaw_open, build_eye, chin_drop, ellipsoid_geometry, ellipsoid_sdf, exposed_teeth_geometry, eye_hole_mask, eye_holes,
    face_contract, face_skeleton, front_surface, join_face_parts, material, mesh_from_geometry, mouth_cavity_geometry,
    paint_vertices, sdf_blank, shape_key, skin_tints, slit_mouth, smooth_max, smooth_min, soft_offset, sweep_mesh,
    symmetric_offsets, teeth_row_geometry, tongue_geometry, attach_to_skin, use_vertex_colors, linear_color,
)

# ---------------------------------------------------------------- proportions (from the concept sheet)
SHEET_UNIT = .002          # meters per concept-sheet unit
CHIN_Z = .05               # the chin (sheet y = 158)


def sheet(sx, sy):
    """A concept-sheet point (x right, y down, 200 units) as Blender (x, z)."""
    return ((sx - 100) * SHEET_UNIT, CHIN_Z + (158 - sy) * SHEET_UNIT)


HEAD_CENTER = (0, .006, .146)
HEAD_RADII = (.164, .118, .096)           # a wide, flat-topped bog-frog head: 164 x 96 sheet units
EYE_RADIUS = .034
EYE_L = (sheet(132, 0)[0], -.064, sheet(0, 79)[1])   # set into the skin, which eye_hole domes over each eye
EYE_R = (-EYE_L[0], EYE_L[1], EYE_L[2])
DOME = (.05, .004)                       # the eye domes: radius round each eye and how far behind its center they sit
LIDS = dict(opening=(56, 32, 40), corner=1.6, overlap=8, wide=(15, 5), max_edge=.24 * .034, columns=40, rows=12)   # big round lantern eyes: most of the ball shows
IRIS, PUPIL, SLIT = 44, 30, .27           # a large yellow iris round a tall slit pupil
# Gaze limits well inside the opening: recommended_gaze allows 52 degrees of yaw for this wide opening, where the big iris
# slides behind the lid corner and the eyes read walleyed; the sheet's irises travel about a third of the eye.
GAZE = dict(yawMax=32, pitchMax=22)
MOUTH_Z, MOUTH_HW = sheet(0, 132)[1], 48 * SHEET_UNIT
# The puppet jaw: hinged at the back of the head but low (`lift` below the mouth line, level with the top of the chest),
# so as it turns the lower jaw swings down and a little forward: the throat under it lengthens along the diagonal
# instead of being crushed straight down onto the still chest. Almost no straight `drop` (it would only shorten the
# throat). `lip_round` 1 lets the lower
# lip's opening fade to its corners at a finite slope (0.75 fell infinitely steeply at the corners: a hard line ran down the cheek from
# each mouth corner as the jaw opened) and the wider `band` spreads the cheek's stretch beyond them. The 17 degree turn
# drops the chin by 14% of the head (the contract's puppet-jaw check wants 10%) with the throat's sharpest crease near 21 degrees.
JAW = dict(angle=17.0, drop=.0014, lift=-.12, inset=.046, lip_round=1.0, band=.049)
NOSTRIL = (7 * SHEET_UNIT, sheet(0, 111)[1])

# The brow ridge (sheet: a thick arc hugging the top of each eye dome, from the inner to the outer corner). Angles are
# round each eye's gaze axis: `roll` 0 is the outer side, 90 the top, 180 the inner side (toward the nose); `polar` is
# the angle from the gaze axis. Each brow shape rolls the arc round the eye (so angry makes a V and sad slants the
# inner end up), drops it over the eye (browDown) or swells it up and forward off the dome (the lifts).
BROW = dict(roll=(152, 26), polar=(75, 67), height=26, thickness=.015, sink=.0045,
            down_roll=32, down_polar=12, inner_roll=50, outer_roll=16, outer_polar=17, lift=.004, grow=.15)

# ---------------------------------------------------------------- emotions
# The concept sheet's canonical emotion presets, tuned for Mossjaw: the brow ridge
# carries sad and angry, and surprised (brows arched high, a tall open mouth) is kept apart from scared (brows knit
# and worried, a wide stretched grimace). Sad keeps the eyes open and pleading (a light lid, a small downward look).
BOTH = lambda name, v: {f'{name}Left': v, f'{name}Right': v}
EMOTIONS = {
    'neutral': {},
    'happy': {**BOTH('mouthSmile', 1), 'jawOpen': .22, **BOTH('cheekSquint', .8), **BOTH('eyeSquint', .25), **BOTH('browOuterUp', .35)},
    'sad': {'browInnerUp': 1, **BOTH('mouthFrown', 1), **BOTH('eyeBlink', .12), **BOTH('eyeLookDown', .2)},
    'angry': {**BOTH('browDown', 1), **BOTH('eyeSquint', .45), **BOTH('noseSneer', .8), **BOTH('mouthFrown', .4),
              **BOTH('mouthStretch', .5), 'jawOpen': .12},
    'surprised': {**BOTH('eyeWide', 1), 'browInnerUp': 1, **BOTH('browOuterUp', 1), 'jawOpen': .72, 'mouthFunnel': .9},
    'scared': {**BOTH('eyeWide', 1), 'browInnerUp': 1, **BOTH('browDown', .3), **BOTH('mouthStretch', 1),
               **BOTH('mouthFrown', .45), 'jawOpen': .26},
}

# ---------------------------------------------------------------- colors
# The sheet's colors (mossjaw.js C) darkened for the viewer's room light, which lifts flat 2D colors: skin tones to
# 52% of their linear value, enamel and the eye white to 90%.
C = {
    'skin': '#5d813a', 'spot': '#395c23', 'belly': '#cdd794', 'lid': '#4d7231', 'brow': '#1f3710', 'crease': '#182812',
    'frill': '#397467', 'rib': '#275a4f', 'sclera': '#e9e5c6', 'iris': '#e2b635', 'pupil': '#14160f', 'mouth': '#2a0f17',
    'tongue': '#9a4252', 'teeth': '#ece6d2', 'horn': '#d1c7a5', 'nostril': '#132310', 'chest': '#bec789',
}


# ---------------------------------------------------------------- the head blank
# The body (sheet y 156-214: a broad mound under the head with rounded shoulders that runs off the bottom of the frame)
# is part of the head's own field: a thick throat under the skull's middle that flows out of the underside and back of
# the skull, swelling into sloped shoulders. One surface, so there is no collar, cap or seam anywhere.
THROAT = dict(center=(0, .022, .035), radii=(.08, .095, .095), blend=.07)
CHEST = dict(center=(0, .036, -.1), radii=(.16, .1, .12), blend=.06)
SHOULDERS = dict(center=(.1, .036, -.045), radii=(.085, .08, .06), blend=.05)   # rounded shoulders (and mirrored)
BODY_BOTTOM = -.16           # the body's rounded lower edge, far below the frame
# How the neck holds still while the jaw drops: the throat's front wall stretches like a frog's dewlap from the jaw (it
# moves with it) down to the chest (it stays), and its back stays on the skull. Heights of the stretch at the front and
# the back of the throat.
NECK_FRONT, NECK_BACK = (.052, -.035), (.106, .058)
NECK_Y = (THROAT['center'][1] - THROAT['radii'][1], THROAT['center'][1] + THROAT['radii'][1])


def head_sdf(p):
    """The head as a field: a wide bog-frog skull, jowls either side of the mouth, a low snout, two eye domes, and the
    throat and shoulders it sits on."""
    d = ellipsoid_sdf(p, HEAD_CENTER, HEAD_RADII)
    for s in (1, -1):
        d = smooth_min(d, ellipsoid_sdf(p, (s * .12, -.03, .1), (.07, .08, .05)), .03)             # jowls
        # eye domes. TOOL-GAP: the hard V-creases running down from each eye's inner corner come from eye_hole's soft crease
        # round the hole (a wider dome blend here does not remove them); the eye_hole fix is in progress in agent-meshes.
        d = smooth_min(d, ellipsoid_sdf(p, (s * EYE_L[0], EYE_L[1] + DOME[1], EYE_L[2]), (DOME[0],) * 3), .036)
    d = smooth_min(d, ellipsoid_sdf(p, (0, -.074, sheet(0, 113)[1]), (.09, .046, .03)), .03)   # the broad, flat snout
    if p[2] > .2: return d                   # (speed) the body is far below: it cannot reach the blend
    body = ellipsoid_sdf(p, THROAT['center'], THROAT['radii'])
    if p[2] < .12:
        body = smooth_min(body, ellipsoid_sdf(p, CHEST['center'], CHEST['radii']), CHEST['blend'])
        sx, sy, sz = SHOULDERS['center']
        for s in (1, -1): body = smooth_min(body, ellipsoid_sdf(p, (s * sx, sy, sz), SHOULDERS['radii']), SHOULDERS['blend'])
        body = smooth_max(body, BODY_BOTTOM - p[2], .03)
    return smooth_min(d, body, THROAT['blend'])


def _ramp(a, b, x):
    """0 at a, 1 at b, linear between (a > b allowed)."""
    t = (x - a) / (b - a)
    return min(1.0, max(0.0, t))


def neck_share(p):
    """How much of a point belongs to the neck and body, which stay put when the jaw drops (0 head, 1 neck)."""
    x, y, z = p
    back = _ramp(NECK_Y[0], NECK_Y[1], y)
    top = NECK_FRONT[0] + (NECK_BACK[0] - NECK_FRONT[0]) * back
    low = NECK_FRONT[1] + (NECK_BACK[1] - NECK_FRONT[1]) * back
    down = _ramp(top, low, z)
    if down == 0: return 0.0
    cx, cy, _ = THROAT['center']
    rx, ry, _ = THROAT['radii']
    q = math.hypot(x / rx, (y - cy) / ry)
    inside = 1 - _ramp(1.0, 1.4, q)            # under the throat, not under the jowls
    shoulders = _ramp(.05, -.025, z)            # the shoulders, whatever their width (the jowls end above)
    return down * max(inside, shoulders)


# How far down the body the jaw's motion reaches. The chest, the belly oval and the shoulders hold still (nothing below the
# neck moves when Mossjaw talks), so the jaw's motion fades out within the throat, under the jowls: 1 on the lower jaw
# (the lower lip and tongue ride it; each lower tooth turns with the lip in front of it), easing to 0 at the top of the chest. The fade is nearly linear
# (smoothed only at its ends), so the throat's skin shortens evenly along its whole height instead of folding in one
# place. Heights (top, bottom) of the fade at the front of the throat, at its sides (under the jowls, down to the
# neck's waist above the shoulders) and at the back of the neck (whose junction with the skull stays still).
CARRY_FRONT, CARRY_SIDE, CARRY_BACK = (.087, -.004), (.11, .02), (.106, .058)
CARRY_X = (.05, .12)          # the front's fade turns to the sides' between these half-widths
CARRY_Y = (0.0, NECK_Y[1])    # and to the back's behind the neck's middle
CARRY_EASE = .15              # the share of the fade's height over which each end eases in


def _ease(r, e=CARRY_EASE):
    """0 to 1 over 0..1 with a constant slope in the middle and smooth (zero-slope) ends of width e."""
    if r <= 0: return 0.0
    if r >= 1: return 1.0
    k = 1 / (1 - e)                     # the middle slope (the ends are quadratic)
    if r < e: return k * r * r / (2 * e)
    if r > 1 - e: return 1 - k * (1 - r) ** 2 / (2 * e)
    return k * (r - e / 2)


def jaw_carry(p):
    """How much of the jaw's motion a point takes (1 on the lower jaw, fading to 0 in the throat and at the neck's back)."""
    x, y, z = p
    side = _ramp(CARRY_X[0], CARRY_X[1], abs(x))
    side = side * side * (3 - 2 * side)
    back = _ramp(CARRY_Y[0], CARRY_Y[1], y)
    top, low = (CARRY_FRONT[k] + (CARRY_SIDE[k] - CARRY_FRONT[k]) * side for k in (0, 1))
    top, low = top + (CARRY_BACK[0] - top) * back, low + (CARRY_BACK[1] - low) * back
    return _ease(_ramp(low, top, z))


def make_jaw(vertices):
    """The ear-hinged puppet jaw, sized from the head alone (not the body under it)."""
    return JawHinge.ear([p for p in vertices if neck_share(p) < .02], MOUTH_Z, MOUTH_HW, mask=jaw_carry, **JAW)


# TOOL-GAP: the verifier's puppet-jaw check takes the head skin's lowest point anywhere as the chin, so on a head whose
# jowls hang lower at the sides than the chin (and whose jaw fades out in the throat) it measures a jowl, not the chin.
# body_faces hands those jowl undersides to the body_skin material; the verifier should take the chin at the midline.
def body_faces(vertices, faces):
    """Which faces belong to the body (the `body_skin` material: the verifier and the puppet-jaw check read the chin as the head skin's
    lowest point). The neck and body are the faces under the throat; the jowls' undersides either side of the chin,
    which hang lower than it, belong to the neck too, so the chin is the head skin's lowest point."""
    neck = [sum(neck_share(vertices[i]) for i in f) / len(f) > .02 for f in faces]
    chin = min(vertices[i][2] for f, n in zip(faces, neck) if not n for i in f if abs(vertices[i][0]) < .015)
    return [n or min(vertices[i][2] for i in f) < chin - 1e-4 for f, n in zip(faces, neck)]


# TOOL-GAP: sdf_blank casts every vertex's ray from one center, so a body far below it gets grazing rays: its vertices
# bunch and spread and its long thin faces shade in streaks. `relax_on_field` evens them out (umbrella smoothing, each
# step pulled back onto the field); agent-meshes' sdf_blank should offer it (or a second center) for fused bodies.
def relax_on_field(vertices, faces, sdf, weight, rounds=8):
    """Even out the vertices where `weight(p)` > 0 by `rounds` of umbrella smoothing, each projected back onto the
    zero set of `sdf`. Symmetric meshes stay symmetric."""
    neighbors = [set() for _ in vertices]
    for f in faces:
        for a, b in zip(f, tuple(f[1:]) + tuple(f[:1])): neighbors[a].add(b); neighbors[b].add(a)
    v = [tuple(p) for p in vertices]
    moving = [(i, weight(p)) for i, p in enumerate(v) if weight(p) > 0]
    # The midline stays on x = 0 exactly: the triangulation's diagonals are not mirror images, so its umbrella is lopsided,
    # and a midline vertex pulled a fraction of a millimeter off it made eye_holes' midline clip add near-duplicate
    # points beside it (sliver triangles that shaded as white specks down the throat).
    midline = {i for i, p in enumerate(v) if abs(p[0]) < 1e-9}
    h = 1e-5
    for _ in range(rounds):
        new = list(v)
        for i, w in moving:
            avg = tuple(sum(v[j][k] for j in neighbors[i]) / len(neighbors[i]) for k in range(3))
            p = tuple(v[i][k] + .6 * w * (avg[k] - v[i][k]) for k in range(3))
            for _ in range(2):
                d = sdf(p)
                g = [(sdf(tuple(p[q] + (h if q == k else 0) for q in range(3))) - sdf(tuple(p[q] - (h if q == k else 0) for q in range(3)))) / (2 * h)
                     for k in range(3)]
                n2 = sum(x * x for x in g) or 1.0
                p = tuple(p[k] - d * g[k] / n2 for k in range(3))
            new[i] = (0.0, p[1], p[2]) if i in midline else p
        v = new
    return v


# TOOL-GAP: sdf_blank spaces its rings for a head (crowded at the face, sparse toward the poles) and crowds every ring's
# columns toward the face, so a body fused under the head gets a few long rings of hair-thin strips down the chest
# that shade in streaks. `body_blank` is sdf_blank with the same rays, topology and symmetry down to the chin, then rings
# spaced by length along the surface and columns spread evenly round the body. agent-meshes' sdf_blank should take a
# ring spacing and a per-ring column crowding.
def body_blank(sdf, center, rings=64, segments=104, front=.6, band=.45, outer=.4, split=math.radians(125), step=.008,
               spread=math.radians(55)):
    from agent_meshes_face import ellipsoid_geometry, _outward

    def surface(direction):
        at = lambda r: tuple(center[k] + direction[k] * r for k in range(3))
        dr = outer / 100
        high = outer
        while high > dr and sdf(at(high - dr)) > 0: high -= dr
        low = max(0.0, high - dr)
        for _ in range(24):
            mid = (low + high) / 2
            if sdf(at(mid)) < 0: low = mid
            else: high = mid
        return at((low + high) / 2)
    ray = lambda polar, a: (math.sin(polar) * math.cos(a), math.sin(polar) * math.sin(a), math.cos(polar))
    polars = []
    for k in range(1, rings):
        t = k / rings
        p = math.pi * (t + band * math.sin(2 * math.pi * t) / (2 * math.pi))
        if p >= split: break
        polars.append(p)
    # below the chin: rings every `step` meters along the surface (the mean of the front, side and back meridians)
    start = polars[-1]
    samples = [start + (math.pi - start) * i / 160 for i in range(161)]
    arc = [0.0]
    for p0, p1 in zip(samples, samples[1:]):
        # (a ray that jumps across a hollow counts as a short step, so the rings are not all spent on the jump)
        arc.append(arc[-1] + sum(min(.012, math.dist(surface(ray(p0, a)), surface(ray(p1, a)))) for a in (-math.pi / 2, 0, math.pi / 2)) / 3)
    count = max(2, round(arc[-1] / step))
    for i in range(1, count):
        goal = arc[-1] * i / count
        j = min(len(arc) - 2, max(n for n in range(len(arc)) if arc[n] <= goal))
        t = (goal - arc[j]) / max(1e-12, arc[j + 1] - arc[j])
        polars.append(samples[j] + (samples[j + 1] - samples[j]) * t)
    directions = [(0.0, 0.0, 1.0)]
    for p in polars:
        crowd = front * (1 - _ramp(split, split + spread, p))
        for j in range(segments):
            v = 2 * j / segments - 1
            directions.append(ray(p, -math.pi / 2 + math.pi * ((1 - crowd) * v + crowd * v ** 3)))
    directions.append((0.0, 0.0, -1.0))
    vertices = [surface(d) for d in directions]
    template = ellipsoid_geometry((0, 0, 0), (1, 1, 1), rings=len(polars) + 1, segments=segments)
    faces = []
    for f in template['faces']:
        if len(f) == 4 and math.dist(vertices[f[1]], vertices[f[3]]) < math.dist(vertices[f[0]], vertices[f[2]]):
            faces += [(f[0], f[1], f[3]), (f[1], f[2], f[3])]
        elif len(f) == 4: faces += [(f[0], f[1], f[2]), (f[0], f[2], f[3])]
        else: faces.append(tuple(f))
    return {'vertices': vertices, 'faces': _outward(vertices, faces)}


def head_blank():
    blank = body_blank(head_sdf, HEAD_CENTER)
    v = relax_on_field(blank['vertices'], blank['faces'], head_sdf, lambda p: _ramp(.07, .035, p[2]))
    # An upper lip that overhangs the lower one, so the closed mouth reads as a line.
    for center, radius, offset in (((0, -.12, MOUTH_Z + .006), (MOUTH_HW + .01, .03, .007), (0, -.003, 0)),
                                   ((0, -.12, MOUTH_Z - .006), (MOUTH_HW + .01, .03, .006), (0, .002, 0))):
        v = soft_offset(v, center, radius, offset)
    return v, blank['faces']


# ---------------------------------------------------------------- skin paint
# The pale belly is lighter than the green skin, so the skin material takes the pale color and the green is painted as a
# tint of it (skin_tints(lighten=True) does the same, but its patches fade out over their whole radius: a blurry glow
# rather than the concept's crisp pale shapes). Each belly patch is flat pale inside and turns green over only the outer
# `edge` of its radius.
def skin_paint(vertices, base, belly, spots=()):
    """Skin-paint tints (relative to the material color `base`, the lightest tone): green mottled skin, darker spots
    and the pale belly (`belly`: (center, radii, edge, strength) ellipsoid patches, unioned)."""
    green = skin_tints(vertices, base=C['skin'], patches=spots, mottle={'scale': .014, 'amount': .12, 'seed': 3})
    skin, pale, top = linear_color(C['skin']), linear_color(C['belly']), linear_color(base)
    out = []
    for p, g in zip(vertices, green):
        w = 0.0
        for center, radii, edge, strength in belly:
            q = math.sqrt(sum(((p[k] - center[k]) / radii[k]) ** 2 for k in range(3)))
            r = _ramp(1 - edge, 1, q)
            w = max(w, strength * (1 - r * r * (3 - 2 * r)))
        out.append(tuple(min(1.0, (skin[k] * g[k] * (1 - w) + pale[k] * w) / top[k]) for k in range(3)))
    return out


# The pale belly (sheet: the lower-jaw band, ellipse cx 100 cy 162 rx 66 ry 26 under the mouth, and the chest patch,
# cx 100 cy 208 rx 27 ry 30, both crisp-edged): the band across the lower jaw and the chest oval, with the green throat
# between them.
BELLY = [((0, -.075, sheet(0, 149)[1]), (.14, .08, .03), .32, 1.0),       # the lower-jaw band, just under the lower lip
         ((0, -.06, -.058), (.056, .07, .06), .32, 1.0)]                   # the chest oval (the sheet's size, set a little lower)


def surface_point(z, angle, y0=.03):
    """The body's surface at height z, straight out from the neck's axis at `angle` (0 = the character's left, pi/2 back)."""
    d = (math.cos(angle), math.sin(angle))
    lo, hi = 0.0, .3
    for _ in range(40):
        mid = (lo + hi) / 2
        if head_sdf((d[0] * mid, y0 + d[1] * mid, z)) < 0: lo = mid
        else: hi = mid
    return (d[0] * lo, y0 + d[1] * lo, z)


def head_spots(front):
    rnd = random.Random(7)
    spots = []
    for sx, sy, rx, ry in ((44, 100, 6, 4.5), (34, 116, 3.5, 2.8), (56, 110, 3, 2.4), (100, 70, 4, 3), (90, 82, 2.4, 2),
                           (111, 84, 2.8, 2.2), (80, 96, 2.2, 1.8), (62, 124, 2.4, 2), (40, 128, 3, 2.2), (72, 64, 2.6, 2)):
        for mx in ((sx, 200 - sx) if sx != 100 else (sx,)):
            x, z = sheet(mx + rnd.uniform(-1.5, 1.5) * (mx != 100), sy)
            y = front(x, z)
            if y is None: continue
            spots.append({'center': (x, y, z), 'radius': (rx * SHEET_UNIT * 1.6, .012, ry * SHEET_UNIT * 1.6), 'color': C['spot'], 'strength': .75})
    for _ in range(34):   # the crown, temples and back, for the three-quarter view
        a, b = rnd.uniform(-2.9, 2.9), rnd.uniform(-.25, 1.1)
        p = (HEAD_RADII[0] * math.sin(a) * math.cos(b), HEAD_CENTER[1] - HEAD_RADII[1] * math.cos(a) * math.cos(b),
             HEAD_CENTER[2] + HEAD_RADII[2] * math.sin(b))
        if p[1] < -.07 and abs(p[0]) < .11: continue
        r = rnd.uniform(.007, .014)
        spots.append({'center': p, 'radius': (r, r, r * .8), 'color': C['spot'], 'strength': .7})
    for _ in range(30):   # the back of the neck and the shoulders
        angle, z = rnd.uniform(-.35, math.pi + .35), rnd.uniform(-.075, .07)
        r = rnd.uniform(.008, .016)
        spots.append({'center': surface_point(z, angle), 'radius': (r, r, r * .8), 'color': C['spot'], 'strength': .7})
    return spots


def mouth_crease(head, rest):
    """The closed mouth's dark line, painted as a soft crease along the upper lip rather than a band of faces. It is laid
    along the seam resampled every half millimeter (not one blob per seam vertex, which left barbs where the seam's
    vertices spread out) and thins to nothing before each corner."""
    from agent_meshes_face import SEAM_ATTRIBUTE
    seam = sorted({(round(p[0], 5), p[1], p[2]) for p, item in zip(rest, head.data.attributes[SEAM_ATTRIBUTE].data) if item.value == 2})
    patches = []
    for (x0, y0, z0), (x1, y1, z1) in zip(seam, seam[1:]):
        steps = max(1, int(abs(x1 - x0) / .0005))
        for k in range(steps):
            t = k / steps
            x = x0 + (x1 - x0) * t
            fade = 1 - _ramp(.72, .97, abs(x) / MOUTH_HW)
            if fade <= 0: continue
            fade = fade * fade * (3 - 2 * fade)
            patches.append({'center': (x, y0 + (y1 - y0) * t, z0 + (z1 - z0) * t + .0006),
                            'radius': (.0026, .004, .0008 + .0014 * fade), 'color': C['crease'], 'strength': .95 * fade})
    return skin_tints(rest, base=C['skin'], patches=patches)


# ---------------------------------------------------------------- small parts
# TOOL-GAP: agent-meshes should provide a fin/frill (an outlined fan with a fleshy root and ribs) for creature ears, and
# export its face-winding fix (`_outward` is private); `outward` below re-winds the fin's faces outward.
FRILL_PATH = [((26, 94), (4, 84)), ((4, 84), (14, 97), (2, 106)), ((2, 106), (15, 111), (5, 124)), ((5, 124), (18, 124), (26, 134))]
FRILL_SPIKES = ((4, 84), (2, 106), (5, 124))


def frill_geometry(side, columns=54, rows=9):
    """A fin-frill ear (the concept's three-spined fan, path `FRILL_PATH`): a fin that grows out of the side of the head.

    Its root follows the head's side and is sunk into the skin; it is thick and skin-colored there (a fleshy base),
    thins to a membrane outward and turns frill-teal, and each spine is a raised, darker rib running from the root to
    its tip. Returns the geometry and one linear-RGB paint color per vertex."""
    s = 1 if side == 'L' else -1
    sweep, root_y = .5, .022              # the fin leans back by `sweep` meters per meter out
    out_dir = (s / math.hypot(1, sweep), sweep / math.hypot(1, sweep), 0.0)
    normal = (-sweep / math.hypot(1, sweep), s / math.hypot(1, sweep), 0.0)

    def bezier(seg, t):
        if len(seg) == 2: return tuple(seg[0][k] + (seg[1][k] - seg[0][k]) * t for k in range(2))
        a, c, b = seg
        return tuple((1 - t) ** 2 * a[k] + 2 * (1 - t) * t * c[k] + t * t * b[k] for k in range(2))
    # the outline, sampled evenly by length (open at both ends, where it meets the root line)
    dense = [bezier(seg, j / 60) for seg in FRILL_PATH for j in range(60)] + [FRILL_PATH[-1][-1]]
    length = [0.0]
    for p, q in zip(dense, dense[1:]): length.append(length[-1] + math.dist(p, q))
    outline = []
    for i in range(columns):
        goal = length[-1] * (i + .5) / columns
        j = max(k for k in range(len(length)) if length[k] <= goal)
        j = min(j, len(dense) - 2)
        t = (goal - length[j]) / max(1e-9, length[j + 1] - length[j])
        outline.append(tuple(dense[j][k] + (dense[j + 1][k] - dense[j][k]) * t for k in range(2)))
    spikes = [min(range(columns), key=lambda i: math.dist(outline[i], tip)) for tip in FRILL_SPIKES]
    z_of = lambda sy: sheet(0, 112 + (sy - 112) * 1.15)[1]

    def side_x(z):
        lo, hi = 0.0, .3
        for _ in range(40):
            mid = (lo + hi) / 2
            if head_sdf((s * mid, root_y, z)) < 0: lo = mid
            else: hi = mid
        return lo
    skin, frill, rib = linear_color(C['skin']), linear_color(C['frill']), linear_color(C['rib'])
    vertices, colors, grid, roots = [], [], {}, []
    for i, (px, py) in enumerate(outline):
        root_sy = 94 + 34 * (i + .5) / columns   # the root ends above the mouth line (the jaw moves the skin below it)
        rz = z_of(root_sy)
        surface = (s * side_x(rz), root_y, rz)
        root = tuple(surface[k] - out_dir[k] * .007 for k in range(3))          # sunk into the skin
        out = (26 - px) * SHEET_UNIT * 1.45
        tip = (surface[0] + out_dir[0] * out, root_y + out_dir[1] * out, max(z_of(py), MOUTH_Z + .004))   # all above the mouth line
        ribness = max(math.exp(-((i - k) / 1.7) ** 2) for k in spikes)
        for v in range(rows + 1):
            t = v / rows
            p = tuple(root[k] + (tip[k] - root[k]) * t for k in range(3))
            half = .0011 + .0075 * (1 - t) ** 2.2 + .0021 * ribness * (1 - .65 * t)
            teal = _ramp(.1, .42, t)
            teal = teal * teal * (3 - 2 * teal)
            base = tuple(skin[k] + (frill[k] - skin[k]) * teal for k in range(3))
            shade = .85 * ribness * _ramp(.12, .3, t)
            color = tuple(base[k] + (rib[k] - base[k]) * shade for k in range(3))
            for face_side in (1, -1):
                grid[i, v, face_side] = len(vertices)
                vertices.append(tuple(p[k] + normal[k] * half * face_side for k in range(3)))
                colors.append(color)
                roots.append(surface)
    faces = []
    for i in range(columns - 1):
        for v in range(rows):
            faces.append((grid[i, v, 1], grid[i + 1, v, 1], grid[i + 1, v + 1, 1], grid[i, v + 1, 1]))
            faces.append((grid[i, v, -1], grid[i, v + 1, -1], grid[i + 1, v + 1, -1], grid[i + 1, v, -1]))
    # the rim: round the grid's boundary, front to back
    loop = [(i, rows) for i in range(columns)] + [(columns - 1, v) for v in range(rows - 1, -1, -1)] +            [(i, 0) for i in range(columns - 2, -1, -1)] + [(0, v) for v in range(1, rows)]
    for a, b in zip(loop, loop[1:] + loop[:1]):
        faces.append((grid[a[0], a[1], 1], grid[a[0], a[1], -1], grid[b[0], b[1], -1], grid[b[0], b[1], 1]))
    return {'vertices': vertices, 'faces': faces, 'roots': roots}, colors


# TOOL-GAP: attach_to_skin gives each vertex its own nearest skin point and rejects parts that stand more than 30 mm off
# the skin, so a fin (or any long appendage) cannot ride the skin as a whole; agent-meshes should let a part name the
# skin point each vertex rides (its root).
def ride_skin(part, skin_obj):
    """Shape key targets that move each vertex of `part` by the skin's delta at its root (`part['roots']`, points on
    the skin), for every skin shape key that moves the skin there."""
    from mathutils import kdtree
    rest = [v.co.copy() for v in skin_obj.data.vertices]
    tree = kdtree.KDTree(len(rest))
    for i, co in enumerate(rest): tree.insert(co, i)
    tree.balance()
    near = [tree.find_n(r, 4) for r in part['roots']]
    morphs = {}
    for key in skin_obj.data.shape_keys.key_blocks[1:]:
        targets, moved = [], False
        for v, hits, root in zip(part['vertices'], near, part['roots']):
            wsum, d = 0.0, [0.0, 0.0, 0.0]
            for co, i, dist in hits:
                w = 1 / (dist + 1e-5)
                delta = key.data[i].co - rest[i]
                wsum += w
                for k in range(3): d[k] += w * delta[k]
            d = [x / wsum for x in d]
            if key.name == 'jawOpen':   # the face above the mouth stays on the skull: only the fin's low end rides the jaw
                fade = _ramp(MOUTH_Z - .002, MOUTH_Z - .012, v[2])
                d = [x * fade for x in d]
            moved = moved or max(abs(x) for x in d) > 1e-6
            targets.append(tuple(v[k] + d[k] for k in range(3)))
        if moved: morphs[key.name] = targets
    return morphs


def outward(obj):
    """TOOL-GAP (see frill_geometry): recalculate a mesh object's face normals to point outward."""
    import bmesh
    bm = bmesh.new()
    bm.from_mesh(obj.data)
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    bm.to_mesh(obj.data)
    bm.free()
    obj.data.update()


def horn_geometry(side, skin):
    """A prominent horn rooted on the crown just behind the outer corner of the brow, curving out and up to a point
    (sheet: base 46-55 at y 60-66, tip 38,42: it stands well clear of the head's outline). It stands behind the eye
    domes, so the verifier judges it as an appendage rooted on the head."""
    s = 1 if side == 'L' else -1
    x, y = s * .108, .006
    top = max(p[2] for p in skin['vertices'] if abs(p[0] - x) < .008 and abs(p[1] - y) < .008)
    base = (x, y, top - .012)
    pts = []
    for t in (0, .2, .4, .6, .8, 1):
        pts.append((base[0] + s * (.003 + .026 * t + .016 * t * t), base[1] + .004 * t, base[2] + .088 * t - .014 * t * t))
    radii = [(r, r) for r in (.022, .0195, .015, .0105, .006, .0014)]
    v, f = sweep_mesh(pts, radii, radial_segments=20, initial_normal=(0, -1, 0))
    return {'vertices': v, 'faces': f}


# TOOL-GAP: agent-meshes' brow_ridge_geometry places a dome ridge by yaw and elevation, so its brow shapes slide the
# ridge back over the crown and tilt it only ~10 degrees in the front view. This lays the ridge by roll round
# the gaze axis instead, so browDown/browInnerUp/browOuterUp roll it into a V or a worried slant, and the lifts swell it
# up and forward off the dome. It should become an option of brow_ridge_geometry.
def dome_brow_geometry(center, hole, skin, side, roll, polar, height, thickness, sink, down_roll, down_polar, inner_roll,
                       outer_roll, outer_polar, lift, grow, columns=20, sides=16):
    """A heavy brow ridge arcing over an eye dome from the inner to the outer corner, laid on the skin.

    `roll` is (inner end, outer end) in degrees round the gaze axis (0 the outer side, 90 the top), `polar` the angle
    from the gaze axis at the ends and at the top, `height` the ridge's width in degrees across the dome, `thickness`
    how proud it stands, `sink` how deep its edges and underside sink into the skin. The shapes roll it by
    `down_roll`/`inner_roll`/`outer_roll` degrees, drop it `down_polar` degrees over the eye, and push it `lift` meters
    off the dome with its crest `grow` times taller. Every point's base is found on
    the skin along its direction from the eye center; inside the eye's window (a lowered brow) it rests on the upper
    lid. Returns vertices, faces, morphs, `crest` (0..1 per vertex, 1 on the top of the ridge) and `contact`."""
    from agent_meshes_face import _SkinIndex, _outward, skin_contact, ATTACH_TOLERANCE
    sign, suffix = (1, 'Left') if side == 'L' else (-1, 'Right')
    lids, level = hole['lids'], hole['window']['level']
    floor = lids['upper_radius'] + lids['thickness'] + .0002
    index = _SkinIndex(skin['vertices'], skin['faces'], near=lambda p: math.dist(p, center) < 3 * EYE_RADIUS)

    def direction(r, p):
        r, p = math.radians(r), math.radians(p)
        return (sign * math.sin(p) * math.cos(r), -math.cos(p), math.sin(p) * math.sin(r))

    def base(d):
        """The skin's distance from the eye center along `d` (the lid's, inside the window), and how far to sink there:
        the full `sink` away from the eye's rim, fading to none at it, so the ridge meets the lid it may rest on."""
        t, found = hole['mound'], False
        for _ in range(16):
            hit = index.nearest(tuple(center[k] + d[k] * t for k in range(3)), limit=.02)
            if hit is None: break
            facing = sum(d[k] * index.normal(hit[2])[k] for k in range(3))
            if facing < .2: break
            step = hit[0] / facing
            t -= step
            if abs(step) < 1e-8: found = True; break
        outside = level(tuple(center[k] + d[k] * t for k in range(3))) if found else 0.0
        if outside < 1: return floor, 0.0
        near_rim = min(1.0, (outside - 1) / 8)     # the rim's bevel and wall are no base: blend from the lid onto the skin
        # Where the skin runs off nearly along the ray (the dome's flank into the forehead between the eyes) the ridge
        # goes under it rather than following it outward: it knots into the forehead there.
        t = min(max(t, floor), hole['mound'] + .005)
        return floor + (t - floor) * near_rim, sink * near_rim

    def layout(shift):
        points, crest = [], []
        for j in range(columns + 1):
            s = j / columns
            d_roll, d_polar, d_lift, d_thick = shift(s)
            r0 = roll[0] + (roll[1] - roll[0]) * s
            r = r0 + d_roll
            p = polar[0] + (polar[1] - polar[0]) * max(0.0, math.sin(math.radians(r0))) + d_polar
            taper = .45 + .55 * math.sin(math.pi * s) ** .5
            middle, _ = base(direction(r, p))
            for k in range(sides):
                phi = math.tau * k / sides
                d = direction(r, p + height / 2 * taper * math.cos(phi))
                t, sunk = base(d)
                t = min(max(t, middle - .004), middle + .003)   # no jumps round a cross-section where the skin turns away
                up = math.sin(phi)
                # The upper arc is the ridge you see (it grows with `d_thick`); the lower arc lies inside the skin.
                rise = thickness * taper * (up * (1 + d_thick) if up >= 0 else .35 * up) + d_lift
                points.append(tuple(center[q] + d[q] * (t + rise - sunk) for q in range(3)))
                crest.append(max(0.0, up) * (.6 + .4 * taper))
        for j, k in ((0, 1), (columns, columns - 1)):   # each end is capped by a point just past its ring's middle
            mid, nxt = (tuple(sum(p[q] for p in points[i * sides:(i + 1) * sides]) / sides for q in range(3)) for i in (j, k))
            out = tuple(mid[q] - nxt[q] for q in range(3))
            norm = math.sqrt(sum(x * x for x in out)) or 1.0
            points.append(tuple(mid[q] + out[q] / norm * .25 * thickness for q in range(3)))
            crest.append(0.0)
        return points, crest

    # browDown rolls the inner end down round the eye (the angry V) and drops the ridge forward over the upper lid;
    # browInnerUp rolls it the other way, inner end up (the worried slant), and browOuterUp lifts the outer end; the lifts swell the ridge up and forward off the dome.
    shifts = {
        f'browDown{suffix}': lambda s: (down_roll * (1 - .45 * s), -down_polar * (.5 + .5 * math.sin(math.pi * s)), 0.0, 0.0),
        'browInnerUp': lambda s: (-inner_roll * (1 - .6 * s), 9 * (1 - .5 * s), lift * (1 - .6 * s), grow * (1.3 - .6 * s)),
        # browOuterUp raises the whole ridge up the dome (most at the outer end), so with browInnerUp (surprised) the
        # brows arch high over the eyes, while sad (browInnerUp alone) keeps its worried slant.
        f'browOuterUp{suffix}': lambda s: (outer_roll * (.35 + .65 * s), outer_polar * (.55 + .45 * s), lift * (.8 + .3 * s), grow * (.9 + .4 * s)),
    }
    vertices, crest = layout(lambda s: (0.0, 0.0, 0.0, 0.0))
    ring = lambda j, k: j * sides + k % sides
    faces = [(ring(j, k), ring(j, k + 1), ring(j + 1, k + 1), ring(j + 1, k)) for j in range(columns) for k in range(sides)]
    start, end = len(vertices) - 2, len(vertices) - 1
    faces += [(start, ring(0, k + 1), ring(0, k)) for k in range(sides)]
    faces += [(end, ring(columns, k), ring(columns, k + 1)) for k in range(sides)]
    faces = _outward(vertices, faces)
    result = {'vertices': vertices, 'faces': faces, 'crest': crest, 'morphs': {name: layout(shift)[0] for name, shift in shifts.items()}}
    offset = len(skin['vertices'])
    surface = {'vertices': list(skin['vertices']) + list(lids['vertices']),
               'faces': list(skin['faces']) + [tuple(i + offset for i in f) for f in lids['faces']]}
    contact = skin_contact(result, surface)
    worst = max([('rest', contact['gap'])] + [(n, pose['gap']) for n, pose in contact['poses'].items()], key=lambda item: item[1])
    if worst[1] > ATTACH_TOLERANCE: raise ValueError(f'The brow ridge floats {worst[1] * 1000:.2f} mm off the skin at {worst[0]}')
    result['contact'] = contact
    return result


# TOOL-GAP: eye_holes' refinement splits edges it shares with faces it does not refine, leaving triangles with a
# midpoint on one side (a polygon with three vertices in a line). On the fused throat the jaw's fold check reads such
# a polygon by its first three vertices and flags it; agent-meshes should triangulate those faces itself.
def split_t_junctions(obj, tolerance=1e-4):
    """Split the polygons of `obj` that have a vertex lying on the line between its neighbors into triangles fanned
    from that vertex (so no triangle is degenerate: those shade as white specks)."""
    import bmesh
    bm = bmesh.new()
    bm.from_mesh(obj.data)
    def straight(face):
        pts = [v.co for v in face.verts]
        for i in range(len(pts)):
            a, b, c = pts[i - 1], pts[i], pts[(i + 1) % len(pts)]
            if (c - a).length > 0 and ((b - a).cross(c - a)).length < tolerance * (c - a).length ** 2: return i
        return None
    count = 0
    for face in [f for f in bm.faces if len(f.verts) > 3]:
        i = straight(face)
        if i is None: continue
        verts, material, smooth = list(face.verts), face.material_index, face.smooth
        n = len(verts)
        bm.faces.remove(face)
        for k in range(1, n - 1):
            new = bm.faces.new((verts[i], verts[(i + k) % n], verts[(i + k + 1) % n]))
            new.material_index, new.smooth = material, smooth
        count += 1
    bm.normal_update()
    bm.to_mesh(obj.data)
    bm.free()
    obj.data.update()
    return count


# TOOL-GAP: add_jaw_open(rigid=True) turns a whole teeth row through the full jaw angle, while the skin's lower lip
# opens in a rounded D (its weight falls to 0 at the mouth corners). On an ear-hinged jaw hinged low and far back, the
# jaw swings the chin forward as well as down, so the side lower teeth outran the lip and chin in front of them and
# showed through the skin past each mouth corner from jawOpen 0.75 up. agent-meshes should offer a teeth row that
# rides the lip: each tooth rigid, turned by the lip's weight at that tooth.
LOWER_TEETH_HEIGHTS = (.5, .75, .9, 1, 1, 1, 1, 1, .9, .75, .5)   # each lower tooth's height (a share of the row's), corner to corner


def tooth_weights(obj, jaw, front, per_tooth=5):
    """One jaw weight per vertex of a teeth row: each tooth (`per_tooth` vertices, as teeth_row_geometry lays a 'saw'
    tooth) turns rigidly with the lower lip in front of it, so the row follows the lip's rounded opening and every
    tooth stays behind the lip and chin at every jawOpen."""
    points = [tuple(v.co) for v in obj.data.vertices]
    if len(points) % per_tooth: raise ValueError('The teeth row is not made of whole teeth')
    weights = []
    for i in range(0, len(points), per_tooth):
        x = sum(p[0] for p in points[i:i + per_tooth]) / per_tooth
        y = front(x, MOUTH_Z - .003)
        weights += [jaw.weight((x, y, MOUTH_Z), lower_lip=True)] * per_tooth
    return weights


# ---------------------------------------------------------------- the head
def build():
    skin = use_vertex_colors(material('skin', C['belly'], roughness=.55))
    lid = material('lid', C['lid'], roughness=.5)
    brow_mat = use_vertex_colors(material('brow', C['skin'], roughness=.55))
    rig = face_skeleton(head=(0, .02, .12), eye_left=EYE_L, eye_right=EYE_R, name='Face rig')

    vertices, faces = head_blank()
    cut = eye_holes(vertices, faces, EYE_L, EYE_RADIUS, style='shells', **LIDS)
    holes = {'L': cut['L'], 'R': cut['R']}
    vertices, faces = cut['vertices'], cut['faces']
    front = front_surface(vertices, faces)
    holed = {'vertices': vertices, 'faces': faces}
    # The jaw is sized from the head alone (not the body under it); the neck's share of each point holds it still, so
    # the throat's front stretches from the dropping jaw to the chest and the body never moves.
    jaw = make_jaw(vertices)
    # The body shares the head's surface but takes its own material slot (same color and paint), so the verifier and
    # the puppet-jaw check read the head skin's lowest point as the chin.
    body_mat = use_vertex_colors(material('body_skin', C['belly'], roughness=.55))
    head = mesh_from_geometry('head_skin', {'vertices': vertices, 'faces': faces}, [skin, body_mat])
    slit_mouth(head, MOUTH_Z, MOUTH_HW, front_y=jaw.slit_back)
    split_t_junctions(head)
    rest = [tuple(v.co) for v in head.data.vertices]
    for polygon, body in zip(head.data.polygons, body_faces(rest, [tuple(p.vertices) for p in head.data.polygons])): polygon.material_index = int(body)

    my = front(0, MOUTH_Z)
    corner = (MOUTH_HW, front(MOUTH_HW, MOUTH_Z), MOUTH_Z)
    nose = (NOSTRIL[0], front(NOSTRIL[0], NOSTRIL[1]), NOSTRIL[1])
    still = eye_hole_mask(*holes.values())
    cheek = (.09, front(.09, .14), .14)

    def pair(name, *regions, mask=still, obj=None, base=None):
        """One Left/Right shape key pair from several soft regions (each given for the character's left)."""
        obj, base = obj or head, base or rest
        left, right = list(base), list(base)
        for center, radius, offset in regions:
            l, r = symmetric_offsets(base, center, radius, offset, mask=mask)
            left = [tuple(a[k] + b[k] - c[k] for k in range(3)) for a, b, c in zip(left, l, base)]
            right = [tuple(a[k] + b[k] - c[k] for k in range(3)) for a, b, c in zip(right, r, base)]
        shape_key(obj, f'{name}Left', left)
        shape_key(obj, f'{name}Right', right)

    def funnel(base):
        """mouthFunnel: the wide mouth gathers into an O: corners in, lips forward."""
        target = soft_offset(base, (0, my, MOUTH_Z), (.06, .03, .025), (0, -.006, 0))
        for s in (1, -1):
            target = soft_offset(target, (s * MOUTH_HW, corner[1], MOUTH_Z), (.05, .045, .035), (-s * .03, -.006, 0))
        return target

    mouth_shapes = {
        # happy: the corners curl up into the jowls
        'mouthSmile': [(corner, (.085, .05, .05), (.007, -.004, .019))],
        # sad: the whole mouth bows down (corners most) and the lower lip and chin sag
        'mouthFrown': [(corner, (.11, .05, .05), (-.003, 0, -.026)), ((.03, my, MOUTH_Z - .018), (.07, .05, .03), (0, -.002, -.007))],
        'mouthStretch': [(corner, (.05, .045, .035), (.012, .001, -.005))],
    }
    for name, regions in mouth_shapes.items(): pair(name, *regions)
    shape_key(head, 'mouthFunnel', funnel(rest))
    # happy: the jowls bunch up under the eyes
    pair('cheekSquint', (cheek, (.055, .05, .036), (.001, -.009, .012)))
    # the snout wrinkles up and the nostrils flare
    pair('noseSneer', (nose, (.02, .025, .02), (.0025, -.002, .01)), ((.03, front(.03, .14), .14), (.03, .03, .025), (0, -.002, .005)), mask=None)
    # The forehead between the eye domes knots down a little with browDown.
    knot = (.024, front(.024, EYE_L[2] + .012), EYE_L[2] + .012)
    pair('browDown', (knot, (.026, .03, .03), (-.003, -.002, -.006)))
    add_jaw_open(head, jaw)
    # The puppet-jaw floor (the puppet-jaw check: the chin drops >= 10% of the head), judged on the head skin without the body under it,
    # at the chin itself (the middle of the front, where the puppet-jaw check reads the chin's lowest point): the jowls either side stay
    # nearly still over the shoulders.
    face_skin = [i for i, p in enumerate(rest) if neck_share(p) < .02 and (abs(p[0]) < .02 or p[2] > MOUTH_Z)]
    opened = head.data.shape_keys.key_blocks['jawOpen'].data
    report = chin_drop([rest[i] for i in face_skin], [tuple(opened[i].co) for i in face_skin])
    if report['ratio'] < .1: raise ValueError(f'jawOpen drops the chin only {report["ratio"]:.1%} of the head height')

    # skin paint: mottled green, spots, the pale throat and the dark lip crease
    tints = skin_paint(rest, C['belly'], BELLY, head_spots(front))
    crease = mouth_crease(head, rest)
    paint_vertices(head, [tuple(a[k] * b[k] for k in range(3)) for a, b in zip(tints, crease)])

    dark = material('mouth_cavity', C['mouth'], roughness=.9)
    dark.use_backface_culling = False
    cavity = mesh_from_geometry('mouth_cavity', mouth_cavity_geometry((0, my, MOUTH_Z - .003), width=MOUTH_HW * 2 - .004, height=.05,
                                                                      depth=.075, surface=front), [dark])
    # The cavity rides the mouth shapes with the lips, so a smiling corner never uncovers it.
    cavity_rest = [tuple(v.co) for v in cavity.data.vertices]
    for name, regions in mouth_shapes.items(): pair(name, *regions, mask=None, obj=cavity, base=cavity_rest)
    shape_key(cavity, 'mouthFunnel', funnel(cavity_rest))
    add_jaw_open(cavity, jaw)

    enamel_u = material('teeth_upper', C['teeth'], roughness=.3)
    enamel_l = material('teeth_lower', C['teeth'], roughness=.3)
    upper = mesh_from_geometry('teeth_upper', teeth_row_geometry('saw', (0, my + .009, MOUTH_Z + .004), MOUTH_HW - .013, .05, 12, .0095, row='upper'), [enamel_u])
    # The lower row rides the lip (tooth_weights), so the teeth by the corners open least: they are shorter, so even
    # there the open mouth parts between the rows (below the fangs' tips).
    lower = mesh_from_geometry('teeth_lower', teeth_row_geometry('saw', (0, my + .013, MOUTH_Z - .003), MOUTH_HW - .016, .05, 11, .009, row='lower',
                                                                 sizes=[(1, h) for h in LOWER_TEETH_HEIGHTS]), [enamel_l])
    add_jaw_open(lower, jaw, weight=tooth_weights(lower, jaw, front))
    fang_enamel = material('teeth_exposed', C['teeth'], roughness=.3)
    # The fangs hang from the upper lip and follow its shapes (a frowning lip carries them down); they stay on the skull
    # for jawOpen, like the upper row.
    fang_geometry = attach_to_skin(exposed_teeth_geometry(front, (-19.5 * SHEET_UNIT, 19.5 * SHEET_UNIT), MOUTH_Z, length=.012, width=.01), head)
    fang_geometry['morphs'].pop('jawOpen', None)
    fangs = mesh_from_geometry('fangs', fang_geometry, [fang_enamel])
    for name, targets in fang_geometry['morphs'].items(): shape_key(fangs, name, targets)
    tongue = mesh_from_geometry('tongue', tongue_geometry((0, my + .05, MOUTH_Z - .02), length=.05, width=.09, thickness=.011),
                                [material('tongue', C['tongue'], roughness=.45)])
    # The tongue rides the jaw as the cavity round it does (the throat's fade reaches up into the lower jaw).
    add_jaw_open(tongue, jaw, weight=jaw_carry)

    parts = [head, cavity, upper, lower, fangs, tongue]
    # stubby nostrils sunk into the snout: noseSneer lifts and flares them with it
    nostril_mat = material('nostril', C['nostril'], roughness=.7)
    for s in (1, -1):
        x, z = s * NOSTRIL[0], NOSTRIL[1]
        y = front(x, z)
        g = ellipsoid_geometry((x, y, z), (.0044, .0022, .0026), rings=8, segments=16)
        tilt = math.radians(-s * 24)
        g['vertices'] = [(x + (p[0] - x) * math.cos(tilt) - (p[2] - z) * math.sin(tilt), p[1], z + (p[0] - x) * math.sin(tilt) + (p[2] - z) * math.cos(tilt)) for p in g['vertices']]
        g = attach_to_skin(g, head, depth=.0008)
        nostril = mesh_from_geometry(f'nostril_{"L" if s > 0 else "R"}', g, [nostril_mat])
        for name, targets in g['morphs'].items(): shape_key(nostril, name, targets)
        parts.append(nostril)

    horn_mat = material('horn', C['horn'], roughness=.45)
    frill_mat = use_vertex_colors(material('frill', '#ffffff', roughness=.5))   # painted: skin at the root, teal out, ribs
    eye_materials = [material('eye_white', C['sclera'], roughness=.12), material('eye_iris', C['iris'], roughness=.18),
                     material('eye_pupil', C['pupil'], roughness=.1)]
    eyeballs = []
    brow_shade = tuple(a / b for a, b in zip(linear_color(C['brow']), linear_color(C['skin'])))
    for side, center in (('L', EYE_L), ('R', EYE_R)):
        eye = build_eye(rig, side, center, EYE_RADIUS, style='lid', lid_material=lid, eye_materials=eye_materials,
                        iris=IRIS, pupil=PUPIL, slit=SLIT, hole=holes[side])
        eyeballs.append(eye['eyeball'])
        parts.append(eye['lids'])
        # The heavy brow ridge is the brow: skin-colored where it meets the dome, darkening to the brow green on its crest.
        ridge = attach_to_skin(dome_brow_geometry(center, holes[side], holed, side, **BROW), head)
        brow = mesh_from_geometry(f'brow_{side}', ridge, [brow_mat])
        for name, targets in ridge['morphs'].items(): shape_key(brow, name, targets)
        paint_vertices(brow, [tuple(1 + (c - 1) * w for c in brow_shade) for w in ridge['crest']])
        parts.append(brow)
        parts.append(mesh_from_geometry(f'horn_{side}', horn_geometry(side, holed), [horn_mat]))
        fin, fin_colors = frill_geometry(side)
        fin_obj = mesh_from_geometry(f'frill_{side}', fin, [frill_mat])
        outward(fin_obj)
        # The fin's root sits on the jowl's back, which jawOpen carries a little way down: the fin rides the skin.
        for name, targets in ride_skin(fin, head).items(): shape_key(fin_obj, name, targets)
        paint_vertices(fin_obj, fin_colors)
        parts.append(fin_obj)

    face = join_face_parts(parts, 'face', rig=rig, sharp_angle=None)
    objects = [rig, face] + eyeballs
    gaze = GAZE
    face_contract(rig, objects, yaw_max=gaze['yawMax'], pitch_max=gaze['pitchMax'], exposed_teeth=['teeth_exposed'],
                  emotions=EMOTIONS)
    return objects
