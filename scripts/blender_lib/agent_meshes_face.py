"""Face-rig helpers for the `arkit-face/1` contract: eyes, lids, jaw, mouth and extras.

Every geometry function here is pure Python and runs without Blender. The
Blender wrappers at the end import bpy lazily. Coordinates follow Blender:
Z up, meters, the face looks down -Y and the character's left is +X (glTF
export turns this into Y up with the face looking down +Z). Angles are degrees.

Objects built by these helpers keep identity transforms and world-space
vertices, so morph targets and skin weights line up with the rig directly.
"""
import json
import math
from numbers import Real
from pathlib import Path
import struct

__all__ = [
    'ARKIT_REQUIRED', 'ARKIT_OPTIONAL', 'ARKIT_GAZE', 'ARKIT_NAMES', 'CANONICAL_EMOTIONS', 'DEFAULT_LID_FOLLOW',
    'lid_geometry', 'shutter_geometry', 'lid_clearance', 'eyeball_geometry', 'socket_geometry', 'recommended_gaze',
    'JawHinge', 'teeth_row_geometry', 'mouth_cavity_geometry', 'tongue_geometry', 'soft_offset',
    'symmetric_offsets', 'mirror_x', 'cut_faces', 'ellipsoid_geometry', 'folded_faces', 'join_geometry', 'join_face_parts', 'face_contract_extras', 'validate_face_contract_extras',
    'merge_glb_node_extras', 'face_skeleton', 'bind_rigid', 'build_eye', 'add_jaw_open', 'slit_mouth',
    'mesh_from_geometry', 'collect_morph_names', 'set_face_contract', 'face_contract', 'EXTRAS_PROPERTY',
]

ARKIT_REQUIRED = (
    'eyeBlinkLeft', 'eyeBlinkRight', 'eyeSquintLeft', 'eyeSquintRight', 'eyeWideLeft', 'eyeWideRight',
    'jawOpen',
    'mouthSmileLeft', 'mouthSmileRight', 'mouthFrownLeft', 'mouthFrownRight', 'mouthStretchLeft', 'mouthStretchRight', 'mouthFunnel',
    'browDownLeft', 'browDownRight', 'browInnerUp', 'browOuterUpLeft', 'browOuterUpRight',
    'cheekSquintLeft', 'cheekSquintRight',
)
ARKIT_OPTIONAL = ('noseSneerLeft', 'noseSneerRight', 'mouthPucker', 'tongueOut', 'cheekPuff')
ARKIT_GAZE = tuple(f'eyeLook{d}{s}' for s in ('Left', 'Right') for d in ('Up', 'Down', 'In', 'Out'))
# The full 52-curve ARKit blend-shape vocabulary; emotion presets may only name these.
ARKIT_NAMES = tuple(sorted(set(ARKIT_REQUIRED + ARKIT_OPTIONAL + ARKIT_GAZE + (
    'jawForward', 'jawLeft', 'jawRight', 'mouthClose', 'mouthLeft', 'mouthRight', 'mouthRollLower', 'mouthRollUpper',
    'mouthShrugLower', 'mouthShrugUpper', 'mouthPressLeft', 'mouthPressRight', 'mouthLowerDownLeft', 'mouthLowerDownRight',
    'mouthUpperUpLeft', 'mouthUpperUpRight', 'mouthDimpleLeft', 'mouthDimpleRight',
))))
DEFAULT_LID_FOLLOW = {'down': .35, 'up': .25}
# Canonical starting presets from the ratified concept sheets; each head may tune its own.
CANONICAL_EMOTIONS = {
    'neutral': {},
    'happy': {'mouthSmileLeft': .9, 'mouthSmileRight': .9, 'jawOpen': .25, 'cheekSquintLeft': .6, 'cheekSquintRight': .6,
              'eyeSquintLeft': .2, 'eyeSquintRight': .2, 'browOuterUpLeft': .3, 'browOuterUpRight': .3},
    'sad': {'browInnerUp': .9, 'mouthFrownLeft': .85, 'mouthFrownRight': .85, 'eyeBlinkLeft': .25, 'eyeBlinkRight': .25,
            'eyeLookDownLeft': .4, 'eyeLookDownRight': .4},
    'angry': {'browDownLeft': 1, 'browDownRight': 1, 'eyeSquintLeft': .45, 'eyeSquintRight': .45, 'noseSneerLeft': .7,
              'noseSneerRight': .7, 'mouthFrownLeft': .35, 'mouthFrownRight': .35, 'mouthStretchLeft': .5,
              'mouthStretchRight': .5, 'jawOpen': .12},
    'surprised': {'eyeWideLeft': 1, 'eyeWideRight': 1, 'browInnerUp': .9, 'browOuterUpLeft': 1, 'browOuterUpRight': 1,
                  'jawOpen': .6, 'mouthFunnel': .85},
    'scared': {'eyeWideLeft': 1, 'eyeWideRight': 1, 'browInnerUp': 1, 'browDownLeft': .25, 'browDownRight': .25,
               'mouthStretchLeft': .9, 'mouthStretchRight': .9, 'mouthFrownLeft': .3, 'mouthFrownRight': .3, 'jawOpen': .3},
}
_SIDES = {'L': 'Left', 'R': 'Right'}


# ---------------------------------------------------------------- validation and vectors

def _number(value, label, low=None, high=None, low_open=False):
    if isinstance(value, bool) or not isinstance(value, Real) or not math.isfinite(value):
        raise ValueError(f'{label} must be a finite number')
    value = float(value)
    if low is not None and (value < low or (low_open and value == low)):
        raise ValueError(f'{label} must be {"greater than" if low_open else "at least"} {low}')
    if high is not None and value > high:
        raise ValueError(f'{label} must be at most {high}')
    return value


def _vector(value, size, label):
    try:
        values = tuple(value)
    except TypeError as exc:
        raise ValueError(f'{label} must contain {size} numbers') from exc
    if len(values) != size:
        raise ValueError(f'{label} must contain {size} numbers')
    return tuple(_number(v, label) for v in values)


def _count(value, label, low):
    if isinstance(value, bool) or not isinstance(value, int) or value < low:
        raise ValueError(f'{label} must be an integer of at least {low}')
    return value


def _add(a, b): return tuple(x + y for x, y in zip(a, b))
def _sub(a, b): return tuple(x - y for x, y in zip(a, b))
def _mul(a, s): return tuple(x * s for x in a)
def _dot(a, b): return sum(x * y for x, y in zip(a, b))
def _cross(a, b): return (a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0])
def _smoothstep(edge0, edge1, x):
    if edge0 == edge1: return 1.0 if x >= edge1 else 0.0
    t = min(1.0, max(0.0, (x - edge0) / (edge1 - edge0)))
    return t * t * (3 - 2 * t)


def mirror_x(point):
    """Reflect a point or offset across the character's midline (x -> -x)."""
    return (-point[0], point[1], point[2])


def _signed_volume(vertices, faces):
    volume = 0.0
    for face in faces:
        a = vertices[face[0]]
        for i in range(1, len(face) - 1):
            volume += _dot(a, _cross(vertices[face[i]], vertices[face[i + 1]])) / 6
    return volume


def _outward(vertices, faces):
    """Reverse every face of a closed shell whose winding encloses negative volume."""
    return faces if _signed_volume(vertices, faces) >= 0 else [tuple(reversed(face)) for face in faces]


def _sphere_point(center, radius, yaw, elevation):
    """A point on a sphere around an eye: yaw toward +X, elevation toward +Z, 0/0 looks down -Y."""
    y, e = math.radians(yaw), math.radians(elevation)
    return (center[0] + radius * math.cos(e) * math.sin(y), center[1] - radius * math.cos(e) * math.cos(y), center[2] + radius * math.sin(e))


def _segment_distance(point, a, b):
    ab = _sub(b, a)
    length = _dot(ab, ab)
    t = 0.0 if length < 1e-30 else min(1.0, max(0.0, _dot(_sub(point, a), ab) / length))
    return math.dist(point, _add(a, _mul(ab, t)))


def lid_clearance(center, eye_radius, rest, morphs):
    """Smallest distance from the eye center minus the eyeball radius, over all morph weights in [0, 1].

    Each vertex can reach the zonotope spanned by its morph deltas. The minimum is
    taken over every segment between two corners of that weight cube, which is exact
    when a vertex's deltas are coplanar with the eye center (meridian lids and
    translating shutters are) and conservative otherwise. Negative means a lid
    vertex can enter the eyeball.
    """
    center = _vector(center, 3, 'Eye center')
    eye_radius = _number(eye_radius, 'Eyeball radius', 0, low_open=True)
    morphs = [list(m) for m in morphs]
    if any(len(m) != len(rest) for m in morphs): raise ValueError('Morph topology mismatch')
    subsets = [[k for k in range(len(morphs)) if mask >> k & 1] for mask in range(1 << len(morphs))]
    worst = math.inf
    for index, base in enumerate(rest):
        deltas = [_sub(m[index], base) for m in morphs]
        corners = [base]
        for subset in subsets[1:]:
            point = base
            for k in subset: point = _add(point, deltas[k])
            corners.append(point)
        for i, a in enumerate(corners):
            worst = min(worst, math.dist(a, center))
            for b in corners[i + 1:]:
                worst = min(worst, _segment_distance(center, a, b))
    return worst - eye_radius


# ---------------------------------------------------------------- eyes

def _thick_grid(inner, outer):
    """Faces of a closed slab between two equal (rows x columns) vertex grids, outward after `_outward`."""
    rows, columns = len(inner), len(inner[0])
    index = lambda layer, i, j: layer * rows * columns + i * columns + j
    faces = []
    for i in range(rows - 1):
        for j in range(columns - 1):
            faces.append((index(1, i, j), index(1, i, j + 1), index(1, i + 1, j + 1), index(1, i + 1, j)))
            faces.append((index(0, i, j), index(0, i + 1, j), index(0, i + 1, j + 1), index(0, i, j + 1)))
    boundary = [((0, j), (0, j + 1)) for j in range(columns - 1)]
    boundary += [((rows - 1, j + 1), (rows - 1, j)) for j in range(columns - 1)]
    boundary += [((i + 1, 0), (i, 0)) for i in range(rows - 1)]
    boundary += [((i, columns - 1), (i + 1, columns - 1)) for i in range(rows - 1)]
    for a, b in boundary:
        faces.append((index(1, *b), index(1, *a), index(0, *a), index(0, *b)))
    return faces


def _lid_layers(center, inner, thickness, yaws, anchor, edges, rows):
    """Vertices of one lid for one set of edge elevations (one per yaw column)."""
    layers = []
    for radius in (inner, inner + thickness):
        for i in range(rows + 1):
            s = i / rows
            for yaw, edge in zip(yaws, edges):
                layers.append(_sphere_point(center, radius, yaw, anchor + s * (edge - anchor)))
    return layers


def lid_geometry(center, eye_radius, opening=(45, 38, 30), meet=-8, overlap=4, clearance=.0005, thickness=None,
                 squint=.45, squint_upper_share=.35, wide=(10, 4), span_margin=15, columns=24, rows=8, gap=None,
                 min_radius=None, corner=1.25):
    """Upper and lower eyelid shells with blink, squint and wide morphs that never cut the eyeball.

    `opening` is (half-width yaw, upper-edge elevation, lower-edge elevation below
    the equator) in degrees for a round, open eye. `meet` is the elevation where the
    closed lids meet; the lower lid rises to it and the upper lid passes `overlap`
    degrees beyond it, in front. Each lid is a thick spherical shell whose rows keep
    their yaw (a meridian) and slide in elevation between a fixed anchor and the lid
    edge, like a rolling curtain.

    Linear morphs move vertices on straight chords, which dip toward the eye by
    R * (1 - cos(sweep / 2)). The shell radius is therefore solved, not guessed: each
    lid sits proud of the eyeball far enough that every combination of blink, squint
    and wide weights in [0, 1] keeps every lid vertex at least `clearance` outside
    the eyeball (see `lid_clearance`). The upper lid also clears the lower lid.
    `squint` is the target open fraction of the neutral opening (0.25-0.6 as seen
    from the front); `squint_upper_share` is how much of the narrowing the upper lid
    does. `wide` is (upper lift, lower drop) in degrees at the center of the opening.

    Each edge follows (1 - (yaw / half-width)^2) ** `corner`: 0.5 is a round
    opening with lids meeting the corners vertically, larger values give softer,
    almond corners. Steep corners make the thin lid rim twist over when blink and
    squint add up past the meet line, so the helper checks every morph and morph
    combination for folded faces and rejects settings that fold; raise `corner` or
    widen the opening (the skin can hide the corners) when that happens.
    """
    center = _vector(center, 3, 'Eye center')
    eye_radius = _number(eye_radius, 'Eyeball radius', 0, low_open=True)
    width, upper, lower = _vector(opening, 3, 'Opening')
    for label, value in (('Opening half-width', width), ('Upper opening', upper), ('Lower opening', lower)):
        _number(value, label, 0, 80, low_open=True)
    meet = _number(meet, 'Meet elevation')
    if not -lower < meet < upper: raise ValueError('Meet elevation must lie inside the opening')
    overlap = _number(overlap, 'Overlap', 0, 20)
    clearance = _number(clearance, 'Clearance', 0)
    thickness = max(.0008, .1 * eye_radius) if thickness is None else _number(thickness, 'Lid thickness', 0, low_open=True)
    gap = max(.00025, .02 * eye_radius) if gap is None else _number(gap, 'Lid gap', 0)
    squint = _number(squint, 'Squint open fraction', .05, .95)
    share = _number(squint_upper_share, 'Squint upper share', 0, 1)
    wide_up, wide_down = _vector(wide, 2, 'Wide')
    span_margin = _number(span_margin, 'Span margin', 0, 60)
    corner = _number(corner, 'Corner exponent', .25, 4)
    columns, rows = _count(columns, 'Lid columns', 4), _count(rows, 'Lid rows', 1)
    if columns % 2: columns += 1
    span = min(88.0, width + span_margin)
    yaws = [-span + 2 * span * j / columns for j in range(columns + 1)]
    profile = [max(0.0, 1 - (yaw / width) ** 2) ** corner for yaw in yaws]
    travel = (1 - squint) * (upper + lower)
    states = {
        'upper': {
            'rest': [meet + (upper - meet) * p for p in profile],
            'blink': [meet - overlap for _ in profile],
            'squint': [meet + (upper - meet) * p - share * travel * p for p in profile],
            'wide': [meet + (upper - meet) * p + wide_up * p for p in profile],
        },
        'lower': {
            'rest': [meet - (lower + meet) * p for p in profile],
            'blink': [meet for _ in profile],
            'squint': [meet - (lower + meet) * p + (1 - share) * travel * p for p in profile],
            'wide': [meet - (lower + meet) * p - wide_down * p for p in profile],
        },
    }
    middle = columns // 2
    height = lambda key, state: math.sin(math.radians(states[key][state][middle]))
    squint_ratio = (height('upper', 'squint') - height('lower', 'squint')) / (height('upper', 'rest') - height('lower', 'rest'))
    if not .25 <= squint_ratio <= .6:
        raise ValueError(f'Squint leaves {squint_ratio:.2f} of the opening; the contract needs 0.25-0.6')
    anchors = {
        'upper': min(86.0, max(max(e) for e in states['upper'].values()) + 20),
        'lower': max(-86.0, min(min(e) for e in states['lower'].values()) - 20),
    }
    required = eye_radius + clearance

    def build(key, inner):
        layers = {state: _lid_layers(center, inner, thickness, yaws, anchors[key], edges, rows) for state, edges in states[key].items()}
        return layers

    def solve(key, radius):
        for _ in range(60):
            layers = build(key, radius)
            reach = lid_clearance(center, eye_radius, layers['rest'], [layers[s] for s in ('blink', 'squint', 'wide')]) + eye_radius
            if reach >= required - 1e-12: return radius, layers
            radius *= required / reach * (1 + 1e-9)
        raise ValueError('Could not find a lid radius with enough clearance')

    lower_radius, lower_layers = solve('lower', max(required, _number(min_radius, 'Minimum lid radius', 0) if min_radius is not None else 0))
    upper_radius, upper_layers = solve('upper', max(required, lower_radius + thickness + gap))
    grid = [[0] * (columns + 1) for _ in range(rows + 1)]
    faces_one = _thick_grid(grid, grid)
    offset = len(lower_layers['rest'])
    upper_faces = _outward(upper_layers['rest'], faces_one)
    lower_faces = _outward(lower_layers['rest'], faces_one)
    vertices = upper_layers['rest'] + lower_layers['rest']
    faces = upper_faces + [tuple(i + offset for i in face) for face in lower_faces]
    morphs = {state: upper_layers[state] + lower_layers[state] for state in ('blink', 'squint', 'wide')}
    minimum = lid_clearance(center, eye_radius, vertices, [morphs[s] for s in ('blink', 'squint', 'wide')])
    folded = _folded(vertices, faces, morphs)
    if folded: raise ValueError(f'Lid faces fold over at {", ".join(folded)}; raise `corner` (now {corner}) or widen the opening')
    edges = {'yaw': yaws}
    for key in ('upper', 'lower'):
        edges[key] = [{state: states[key][state][j] for state in states[key]} for j in range(columns + 1)]
    return {
        'vertices': vertices, 'faces': faces, 'morphs': morphs, 'style': 'lid',
        'upper_radius': upper_radius, 'lower_radius': lower_radius, 'thickness': thickness,
        'min_clearance': minimum, 'squint_ratio': squint_ratio, 'edges': edges,
        'opening': (width, upper, lower), 'wide': (wide_up, wide_down),
    }


def _triangle_normals(vertices, faces):
    """Normals of each face's fan triangles; quads contribute both diagonals, since an exporter may pick either."""
    result = []
    for face in faces:
        corners = [(0, 1, 2), (0, 2, 3), (0, 1, 3), (1, 2, 3)] if len(face) == 4 else [(0, i, i + 1) for i in range(1, len(face) - 1)]
        for i, j, k in corners:
            a = vertices[face[i]]
            result.append(_cross(_sub(vertices[face[j]], a), _sub(vertices[face[k]], a)))
    return result


def _folded(vertices, faces, morphs):
    """Names of morph weight combinations (singles at .5 and 1, all sums at 1) that flip a triangle."""
    names = list(morphs)
    rest = _triangle_normals(vertices, faces)
    combos = [({name: w}, f'{name}={w}') for name in names for w in (.5, 1)]
    for mask in range(1, 1 << len(names)):
        chosen = [n for k, n in enumerate(names) if mask >> k & 1]
        if len(chosen) > 1: combos.append(({n: 1 for n in chosen}, '+'.join(chosen)))
    found = []
    for weights, label in combos:
        moved = [tuple(v[k] + sum(w * (morphs[n][i][k] - v[k]) for n, w in weights.items()) for k in range(3)) for i, v in enumerate(vertices)]
        for before, after in zip(rest, _triangle_normals(moved, faces)):
            if _dot(before, before) > 1e-30 and _dot(before, after) <= 0:
                found.append(label); break
    return found


def folded_faces(rest, target, faces):
    """Indices of faces whose orientation flips (or collapses to nothing) between rest and target positions."""
    rest, target = list(rest), list(target)
    if len(rest) != len(target): raise ValueError('Morph topology mismatch')
    found = []
    for index, face in enumerate(faces):
        before, after = _triangle_normals(rest, [face]), _triangle_normals(target, [face])
        if any(_dot(b, b) > 1e-30 and _dot(b, a) <= 1e-6 * _dot(b, b) for b, a in zip(before, after)): found.append(index)
    return found


def _box(x0, x1, y0, y1, z0, z1):
    vertices = [(x, y, z) for z in (z0, z1) for y in (y0, y1) for x in (x0, x1)]
    faces = [(0, 2, 3, 1), (4, 5, 7, 6), (0, 1, 5, 4), (2, 6, 7, 3), (0, 4, 6, 2), (1, 3, 7, 5)]
    return vertices, _outward(vertices, faces)


def shutter_geometry(center, eye_radius, aperture=None, opening=(.7, .55), meet=0, overlap=None, clearance=.0005,
                     thickness=None, blade_height=None, squint=.45, squint_upper_share=.35, wide=(.2, .1), gap=None):
    """Robot shutter blades that slide vertically in planes in front of the eye.

    Both blades are flat plates perpendicular to the gaze axis. The lower blade's
    back face sits `clearance` in front of the eyeball; the upper blade slides in
    front of it. Their morphs are pure translations, so every blink, squint and wide
    weight keeps the whole blade at least that far from the eye center. Heights are
    fractions of the eyeball radius above (+) and below (-) the eye center:
    `opening` = (upper edge, lower edge depth) at rest, `meet` where they close.
    """
    center = _vector(center, 3, 'Eye center')
    r = _number(eye_radius, 'Eyeball radius', 0, low_open=True)
    upper, lower = _vector(opening, 2, 'Opening')
    _number(upper, 'Upper opening', 0, 2, low_open=True); _number(lower, 'Lower opening', 0, 2, low_open=True)
    meet = _number(meet, 'Meet height')
    if not -lower < meet < upper: raise ValueError('Meet height must lie inside the opening')
    half = 1.1 * r if aperture is None else _number(aperture, 'Aperture half-width', 0, low_open=True)
    overlap = .08 * r if overlap is None else _number(overlap, 'Overlap', 0)
    clearance = _number(clearance, 'Clearance', 0)
    thickness = max(.0006, .06 * r) if thickness is None else _number(thickness, 'Blade thickness', 0, low_open=True)
    gap = max(.0002, .02 * r) if gap is None else _number(gap, 'Blade gap', 0)
    blade = 1.3 * r if blade_height is None else _number(blade_height, 'Blade height', 0, low_open=True)
    squint = _number(squint, 'Squint open fraction', .05, .95)
    share = _number(squint_upper_share, 'Squint upper share', 0, 1)
    wide_up, wide_down = _vector(wide, 2, 'Wide')
    travel = (1 - squint) * (upper + lower) * r
    edges = {
        'upper': {'rest': upper * r, 'blink': meet * r - overlap, 'squint': upper * r - share * travel, 'wide': (upper + wide_up) * r},
        'lower': {'rest': -lower * r, 'blink': meet * r, 'squint': -lower * r + (1 - share) * travel, 'wide': -(lower + wide_down) * r},
    }
    squint_ratio = (edges['upper']['squint'] - edges['lower']['squint']) / (edges['upper']['rest'] - edges['lower']['rest'])
    if not .25 <= squint_ratio <= .6:
        raise ValueError(f'Squint leaves {squint_ratio:.2f} of the opening; the contract needs 0.25-0.6')
    lower_plane = r + clearance
    upper_plane = lower_plane + thickness + gap
    cx, cy, cz = center

    def blade_vertices(key, state):
        edge = edges[key][state]
        plane = upper_plane if key == 'upper' else lower_plane
        z0, z1 = (edge, edge + blade) if key == 'upper' else (edge - blade, edge)
        return _box(cx - half, cx + half, cy - plane - thickness, cy - plane, cz + z0, cz + z1)

    vertices, faces, morphs = [], [], {'blink': [], 'squint': [], 'wide': []}
    for key in ('upper', 'lower'):
        rest, blade_faces = blade_vertices(key, 'rest')
        faces += [tuple(i + len(vertices) for i in face) for face in blade_faces]
        vertices += rest
        for state in morphs: morphs[state] += blade_vertices(key, state)[0]
    return {
        'vertices': vertices, 'faces': faces, 'morphs': morphs, 'style': 'shutter', 'edges': edges,
        'upper_plane': upper_plane, 'lower_plane': lower_plane, 'thickness': thickness, 'squint_ratio': squint_ratio,
        'min_clearance': lid_clearance(center, r, vertices, [morphs[s] for s in ('blink', 'squint', 'wide')]),
    }


def eyeball_geometry(center, radius, iris=26, pupil=12, rings=16, segments=32):
    """A sphere whose poles lie on the gaze axis, with rings on the iris and pupil borders.

    Returns vertices, faces, `material_indices` (0 white, 1 iris, 2 pupil) and the
    matching `materials` slot names. `iris` and `pupil` are half-angles in degrees
    from the gaze axis (-Y).
    """
    center = _vector(center, 3, 'Eye center')
    radius = _number(radius, 'Eyeball radius', 0, low_open=True)
    iris = _number(iris, 'Iris half-angle', 1, 80)
    pupil = _number(pupil, 'Pupil half-angle', .5, iris)
    if pupil >= iris: raise ValueError('The pupil must be smaller than the iris')
    rings, segments = _count(rings, 'Eyeball rings', 8), _count(segments, 'Eyeball segments', 8)
    white = rings - 4
    angles = [pupil / 2, pupil, pupil + (iris - pupil) / 2, iris] + [iris + (180 - iris) * k / (white + 1) for k in range(1, white + 1)]
    forward, side, up = (0.0, -1.0, 0.0), (1.0, 0.0, 0.0), (0.0, 0.0, 1.0)

    def point(polar, azimuth):
        p, a = math.radians(polar), math.radians(azimuth)
        direction = _add(_mul(forward, math.cos(p)), _add(_mul(side, math.sin(p) * math.cos(a)), _mul(up, math.sin(p) * math.sin(a))))
        return _add(center, _mul(direction, radius))

    vertices = [point(0, 0)]
    for polar in angles:
        vertices += [point(polar, 360 * j / segments) for j in range(segments)]
    vertices.append(point(180, 0))
    ring = lambda k, j: 1 + k * segments + j % segments
    bands = [0.0] + angles + [180.0]
    faces, slots = [], []
    slot = lambda far: 2 if far <= pupil + 1e-9 else 1 if far <= iris + 1e-9 else 0
    for j in range(segments):
        faces.append((0, ring(0, j + 1), ring(0, j))); slots.append(slot(bands[1]))
    for k in range(len(angles) - 1):
        for j in range(segments):
            faces.append((ring(k, j), ring(k, j + 1), ring(k + 1, j + 1), ring(k + 1, j))); slots.append(slot(bands[k + 2]))
    last = len(vertices) - 1
    for j in range(segments):
        faces.append((ring(len(angles) - 1, j), ring(len(angles) - 1, j + 1), last)); slots.append(0)
    faces = _outward(vertices, faces)
    return {'vertices': vertices, 'faces': faces, 'material_indices': slots, 'materials': ['eye_white', 'eye_iris', 'eye_pupil']}


def socket_geometry(center, eye_radius, radius=None, hole=60, rings=10, segments=32):
    """A dark spherical cup behind the eyeball, open toward the front, that hides the head's interior.

    `hole` is the half-angle in degrees of the front opening, measured from the gaze
    axis. Place `radius` between the eyeball and the lids. Normals face the eye.
    """
    center = _vector(center, 3, 'Eye center')
    eye_radius = _number(eye_radius, 'Eyeball radius', 0, low_open=True)
    radius = eye_radius * 1.06 if radius is None else _number(radius, 'Socket radius', eye_radius, low_open=True)
    hole = _number(hole, 'Socket hole', 5, 175)
    rings, segments = _count(rings, 'Socket rings', 2), _count(segments, 'Socket segments', 8)
    vertices = []
    for k in range(rings):
        polar = math.radians(hole + (180 - hole) * k / rings)
        for j in range(segments):
            a = math.tau * j / segments
            vertices.append((center[0] + radius * math.sin(polar) * math.cos(a), center[1] - radius * math.cos(polar), center[2] + radius * math.sin(polar) * math.sin(a)))
    vertices.append((center[0], center[1] + radius, center[2]))
    faces = [(k * segments + j, (k + 1) * segments + j, (k + 1) * segments + (j + 1) % segments, k * segments + (j + 1) % segments)
             for k in range(rings - 1) for j in range(segments)]
    last = len(vertices) - 1
    faces += [((rings - 1) * segments + j, last, (rings - 1) * segments + (j + 1) % segments) for j in range(segments)]
    a, b, c = (vertices[i] for i in faces[-1])
    if _dot(_cross(_sub(b, a), _sub(c, a)), _sub(center, a)) < 0: faces = [tuple(reversed(f)) for f in faces]
    return {'vertices': vertices, 'faces': faces, 'radius': radius}


def recommended_gaze(opening=(45, 38, 30), iris=26, margin=4):
    """Gaze limits (degrees) that keep the iris center inside a lid opening of the given size."""
    width, upper, lower = _vector(opening, 3, 'Opening')
    _number(iris, 'Iris half-angle', 1, 80)
    margin = _number(margin, 'Margin', 0)
    return {'yawMax': round(max(1.0, width - margin), 3), 'pitchMax': round(max(1.0, min(upper, lower) - margin), 3)}


# ---------------------------------------------------------------- jaw and mouth

class JawHinge:
    """The `jawOpen` hinge shared by every mesh the jaw carries.

    A vertex's morph target is its position rotated by `angle * weight` degrees
    about `axis` through `pivot` (positive opens: the chin swings down and back).
    `weight(p)` is 1 below the mouth line inside the mouth slit (so the lower lip
    moves rigidly with the teeth), fades in over `band` below the line beyond the
    mouth corners (spread over `corner_falloff` sideways), and fades out over
    `back_band` behind the pivot so the back of the head stays put. Rigid parts
    (lower teeth, tongue, a robot chin plate) pass `weight=1`.
    Morphs are linear, so a hinge shortens chords by 1 - cos(angle / 2): keep the
    angle at 30 degrees or less (12-25 reads well). A short `back_band` folds the skin
    under the chin (the jaw swings it back faster than the falloff lets neighbors
    follow); `add_jaw_open` rejects morphs that flip faces.
    """

    def __init__(self, pivot, angle=18, mouth_z=0.0, half_width=.02, corner_falloff=.02, band=.03, back_band=.06, axis=(1, 0, 0)):
        self.pivot = _vector(pivot, 3, 'Jaw pivot')
        self.angle = _number(angle, 'Jaw angle', 0, 30, low_open=True)
        self.mouth_z = _number(mouth_z, 'Mouth line')
        self.half_width = _number(half_width, 'Mouth half-width', 0, low_open=True)
        self.corner_falloff = _number(corner_falloff, 'Corner falloff', 0, low_open=True)
        self.band = _number(band, 'Falloff band', 0)
        self.back_band = _number(back_band, 'Back falloff', 0)
        axis = _vector(axis, 3, 'Jaw axis')
        length = math.hypot(*axis)
        if length < 1e-9: raise ValueError('Jaw axis must not be zero')
        self.axis = _mul(axis, 1 / length)

    def weight(self, point):
        x, y, z = point
        below = self.mouth_z - z
        if below <= 0: return 0.0
        beyond = max(0.0, abs(x - self.pivot[0]) - self.half_width)
        band = self.band * _smoothstep(0, self.corner_falloff, beyond)
        vertical = 1.0 if band <= 0 else _smoothstep(0, band, below)
        behind = y - self.pivot[1]
        back = (1.0 if behind <= 0 else 0.0) if self.back_band <= 0 else 1.0 - _smoothstep(0, self.back_band, behind)
        return vertical * back

    def rotate(self, point, weight=1.0):
        theta = math.radians(self.angle * weight)
        if theta == 0: return tuple(point)
        v, k = _sub(point, self.pivot), self.axis
        c, s = math.cos(theta), math.sin(theta)
        rotated = _add(_add(_mul(v, c), _mul(_cross(k, v), s)), _mul(k, _dot(k, v) * (1 - c)))
        return _add(self.pivot, rotated)

    def targets(self, vertices, weight=None):
        """Morph targets for `vertices`: weight None uses `self.weight`; a number, callable or per-vertex list overrides it."""
        vertices = [_vector(v, 3, 'Vertex') for v in vertices]
        if weight is None: weights = [self.weight(v) for v in vertices]
        elif callable(weight): weights = [_number(weight(v), 'Jaw weight', 0, 1) for v in vertices]
        elif isinstance(weight, Real) and not isinstance(weight, bool): weights = [_number(weight, 'Jaw weight', 0, 1)] * len(vertices)
        else:
            weights = [_number(w, 'Jaw weight', 0, 1) for w in weight]
            if len(weights) != len(vertices): raise ValueError('Jaw weights need one value per vertex')
        return [self.rotate(v, w) if w > 0 else v for v, w in zip(vertices, weights)]


def _superellipsoid(half, height, exponent, rings=6, segments=12):
    vertices, faces = [(0.0, 0.0, 0.0)], []
    power = lambda value: math.copysign(abs(value) ** exponent, value)
    for k in range(1, rings):
        polar = math.pi * k / rings
        for j in range(segments):
            a = math.tau * j / segments
            vertices.append((half[0] * power(math.sin(polar) * math.cos(a)),
                             half[1] * power(math.sin(polar) * math.sin(a)),
                             height / 2 - height / 2 * power(math.cos(polar))))
    vertices.append((0.0, 0.0, height))
    ring = lambda k, j: 1 + k * segments + j % segments
    faces += [(0, ring(0, j), ring(0, j + 1)) for j in range(segments)]
    faces += [(ring(k, j), ring(k + 1, j), ring(k + 1, j + 1), ring(k, j + 1)) for k in range(rings - 2) for j in range(segments)]
    last = len(vertices) - 1
    faces += [(ring(rings - 2, j), last, ring(rings - 2, j + 1)) for j in range(segments)]
    return vertices, faces


def _tooth(style, width, thickness, height):
    """A tooth in local (along-arch, outward, bite) coordinates with its root at bite = 0."""
    if style == 'grille':
        return _box(-width / 2, width / 2, -thickness / 2, thickness / 2, 0, height)
    if style == 'saw':
        vertices = [(-width / 2, -thickness / 2, 0), (width / 2, -thickness / 2, 0), (width / 2, thickness / 2, 0), (-width / 2, thickness / 2, 0), (0, 0, height)]
        return vertices, [(0, 3, 2, 1), (0, 1, 4), (1, 2, 4), (2, 3, 4), (3, 0, 4)]
    return _superellipsoid((width / 2, thickness / 2), height, .55)


def teeth_row_geometry(style, center, half_width, depth, count, height, row='upper', width=None, thickness=None,
                       sizes=None, span=150):
    """A row of teeth along an elliptical dental arch, hanging from (upper) or standing on (lower) the gum line.

    `center` is the front middle of the arch at the gum line; the arch curves back
    (+Y) by `depth` over `half_width` to each side, across `span` degrees. Styles:
    'rounded' (human incisors), 'saw' (pointed fangs) and 'grille' (a robot's
    rectangular blocks). `sizes` gives one (width scale, height scale) per tooth, for
    buck teeth or fangs. Name the object and its material `teeth_upper` or
    `teeth_lower`: the `arkit-face/1` verifier finds teeth by that convention.
    """
    if style not in ('rounded', 'saw', 'grille'): raise ValueError("Teeth style must be 'rounded', 'saw' or 'grille'")
    if row not in ('upper', 'lower'): raise ValueError("Teeth row must be 'upper' or 'lower'")
    cx, cy, cz = _vector(center, 3, 'Arch center')
    a = _number(half_width, 'Arch half-width', 0, low_open=True)
    b = _number(depth, 'Arch depth', 0)
    count = _count(count, 'Tooth count', 1)
    height = _number(height, 'Tooth height', 0, low_open=True)
    limit = math.radians(_number(span, 'Arch span', 1, 180)) / 2
    if sizes is None: sizes = [(1.0, 1.0)] * count
    sizes = [_vector(size, 2, 'Tooth size') for size in sizes]
    if len(sizes) != count: raise ValueError('Tooth sizes need one (width, height) pair per tooth')
    samples = [-limit + 2 * limit * i / 256 for i in range(257)]
    arch = lambda t: (cx + a * math.sin(t), cy + b * (1 - math.cos(t)))
    length = sum(math.dist(arch(s), arch(t)) for s, t in zip(samples, samples[1:]))
    base_width = length / count * .9 if width is None else _number(width, 'Tooth width', 0, low_open=True)
    base_thickness = base_width * .55 if thickness is None else _number(thickness, 'Tooth thickness', 0, low_open=True)
    bite = -1 if row == 'upper' else 1
    vertices, faces = [], []
    for i, (scale_w, scale_h) in enumerate(sizes):
        t = -limit + 2 * limit * (i + .5) / count
        x, y = arch(t)
        tangent = (a * math.cos(t), b * math.sin(t))
        norm = math.hypot(*tangent)
        u = (tangent[0] / norm, tangent[1] / norm, 0.0)
        v = (u[1], -u[0], 0.0)
        local, local_faces = _tooth(style, base_width * scale_w, base_thickness, height * scale_h)
        world = [(x + p[0] * u[0] + p[1] * v[0], y + p[0] * u[1] + p[1] * v[1], cz + bite * p[2]) for p in local]
        local_faces = _outward(world, local_faces)
        faces += [tuple(k + len(vertices) for k in face) for face in local_faces]
        vertices += world
    return {'vertices': vertices, 'faces': faces, 'count': count, 'row': row, 'style': style}


def mouth_cavity_geometry(center, width, height, depth, rings=8, segments=32):
    """A dark half-ellipsoid bag behind the lips, open to the front, so an open mouth never sees through the head.

    `center` is the middle of the front rim. The bag reaches `depth` back (+Y). Its
    faces point into the bag; give it a dark, double-sided material and tuck the rim
    just behind the lips. `rim` lists the front-rim vertex indices.
    """
    cx, cy, cz = _vector(center, 3, 'Cavity center')
    w = _number(width, 'Cavity width', 0, low_open=True) / 2
    h = _number(height, 'Cavity height', 0, low_open=True) / 2
    d = _number(depth, 'Cavity depth', 0, low_open=True)
    rings, segments = _count(rings, 'Cavity rings', 2), _count(segments, 'Cavity segments', 8)
    vertices = []
    for k in range(rings):
        polar = math.pi / 2 * k / rings
        for j in range(segments):
            a = math.tau * j / segments
            vertices.append((cx + w * math.cos(polar) * math.cos(a), cy + d * math.sin(polar), cz + h * math.cos(polar) * math.sin(a)))
    vertices.append((cx, cy + d, cz))
    faces = [(k * segments + j, k * segments + (j + 1) % segments, (k + 1) * segments + (j + 1) % segments, (k + 1) * segments + j)
             for k in range(rings - 1) for j in range(segments)]
    last = len(vertices) - 1
    faces += [((rings - 1) * segments + j, (rings - 1) * segments + (j + 1) % segments, last) for j in range(segments)]
    a, b, c = (vertices[i] for i in faces[-1])
    if _dot(_cross(_sub(b, a), _sub(c, a)), _sub((cx, cy, cz), a)) < 0: faces = [tuple(reversed(f)) for f in faces]
    return {'vertices': vertices, 'faces': faces, 'rim': list(range(segments))}


def tongue_geometry(center, length, width, thickness, rings=6, segments=16):
    """A closed, flat-bottomed tongue dome lying on the mouth floor, centered at `center`."""
    cx, cy, cz = _vector(center, 3, 'Tongue center')
    half_l = _number(length, 'Tongue length', 0, low_open=True) / 2
    half_w = _number(width, 'Tongue width', 0, low_open=True) / 2
    top = _number(thickness, 'Tongue thickness', 0, low_open=True)
    rings, segments = _count(rings, 'Tongue rings', 2), _count(segments, 'Tongue segments', 6)
    vertices = [(cx, cy, cz + top)]
    for k in range(1, rings + 1):
        polar = math.pi / 2 * k / rings
        for j in range(segments):
            a = math.tau * j / segments
            vertices.append((cx + half_w * math.sin(polar) * math.cos(a), cy + half_l * math.sin(polar) * math.sin(a), cz + top * math.cos(polar)))
    vertices.append((cx, cy, cz))
    ring = lambda k, j: 1 + k * segments + j % segments
    faces = [(0, ring(0, j), ring(0, j + 1)) for j in range(segments)]
    faces += [(ring(k, j), ring(k + 1, j), ring(k + 1, j + 1), ring(k, j + 1)) for k in range(rings - 1) for j in range(segments)]
    last = len(vertices) - 1
    faces += [(ring(rings - 1, j), last, ring(rings - 1, j + 1)) for j in range(segments)]
    return {'vertices': vertices, 'faces': _outward(vertices, faces)}


# ---------------------------------------------------------------- skin regions

def soft_offset(vertices, center, radius, offset, mask=None):
    """Morph targets that push the skin near `center` by `offset`, fading smoothly to zero at `radius`.

    `radius` is one distance or an (x, y, z) triple for an ellipsoidal region. `mask`
    optionally scales each vertex's weight (a callable of the vertex, or a list).
    Brows, cheeks and mouth shapes are usually one or two of these per side.
    """
    center = _vector(center, 3, 'Region center')
    radii = (radius,) * 3 if isinstance(radius, Real) and not isinstance(radius, bool) else radius
    radii = _vector(radii, 3, 'Region radius')
    if min(radii) <= 0: raise ValueError('Region radius must be positive')
    offset = _vector(offset, 3, 'Region offset')
    vertices = [_vector(v, 3, 'Vertex') for v in vertices]
    if mask is not None and not callable(mask):
        mask = list(mask)
        if len(mask) != len(vertices): raise ValueError('Mask needs one value per vertex')
    result = []
    for index, vertex in enumerate(vertices):
        q = math.sqrt(sum(((vertex[k] - center[k]) / radii[k]) ** 2 for k in range(3)))
        weight = 1 - _smoothstep(0, 1, q)
        if mask is not None: weight *= mask(vertex) if callable(mask) else mask[index]
        result.append(vertex if weight == 0 else tuple(vertex[k] + offset[k] * weight for k in range(3)))
    return result


def symmetric_offsets(vertices, center, radius, offset, mask=None):
    """(Left, Right) targets: the region as given for the character's left, mirrored across x = 0 for the right."""
    return soft_offset(vertices, center, radius, offset, mask), soft_offset(vertices, mirror_x(center), radius, mirror_x(offset), mask)


def ellipsoid_geometry(center, radii, rings=24, segments=32):
    """A closed, outward-wound UV ellipsoid with poles on the Z axis: a head blank to cut and morph."""
    cx, cy, cz = _vector(center, 3, 'Ellipsoid center')
    rx, ry, rz = _vector(radii, 3, 'Ellipsoid radii')
    if min(rx, ry, rz) <= 0: raise ValueError('Ellipsoid radii must be positive')
    rings, segments = _count(rings, 'Ellipsoid rings', 3), _count(segments, 'Ellipsoid segments', 3)
    vertices = [(cx, cy, cz + rz)]
    for k in range(1, rings):
        polar = math.pi * k / rings
        for j in range(segments):
            a = math.tau * j / segments
            vertices.append((cx + rx * math.sin(polar) * math.cos(a), cy + ry * math.sin(polar) * math.sin(a), cz + rz * math.cos(polar)))
    vertices.append((cx, cy, cz - rz))
    ring = lambda k, j: 1 + k * segments + j % segments
    faces = [(0, ring(0, j), ring(0, j + 1)) for j in range(segments)]
    faces += [(ring(k, j), ring(k + 1, j), ring(k + 1, j + 1), ring(k, j + 1)) for k in range(rings - 2) for j in range(segments)]
    last = len(vertices) - 1
    faces += [(ring(rings - 2, j), last, ring(rings - 2, j + 1)) for j in range(segments)]
    return {'vertices': vertices, 'faces': _outward(vertices, faces)}


def join_geometry(parts):
    """Join geometry parts into one mesh whose morphs are the union of the parts' morph names.

    Each part is a dict with vertices, faces, materials (slot names or material
    objects), optional material_indices (one per face, default 0) and optional
    morphs {name: targets}. A part without a morph keeps its rest positions in that
    morph. Materials are merged by identity (equal names or the same object).
    """
    vertices, faces, indices, materials, morph_names = [], [], [], [], []
    for part in parts:
        for name in part.get('morphs', {}):
            if name not in morph_names: morph_names.append(name)
    morphs = {name: [] for name in morph_names}
    for part in parts:
        rest = [_vector(v, 3, 'Vertex') for v in part['vertices']]
        slots = list(part.get('materials') or [None])
        mapping = []
        for slot in slots:
            if slot not in materials: materials.append(slot)
            mapping.append(materials.index(slot))
        part_indices = part.get('material_indices') or [0] * len(part['faces'])
        if len(part_indices) != len(part['faces']): raise ValueError('Material indices need one value per face')
        faces += [tuple(i + len(vertices) for i in face) for face in part['faces']]
        indices += [mapping[i] for i in part_indices]
        for name in morph_names:
            targets = part.get('morphs', {}).get(name)
            if targets is not None and len(targets) != len(rest): raise ValueError(f'Morph {name} does not match its part topology')
            morphs[name] += rest if targets is None else [_vector(v, 3, 'Morph vertex') for v in targets]
        vertices += rest
    return {'vertices': vertices, 'faces': faces, 'material_indices': indices, 'materials': materials, 'morphs': morphs}


def cut_faces(vertices, faces, remove):
    """Drop faces whose centroid satisfies `remove(centroid)` and any vertices left unused.

    Returns (vertices, faces, mapping) where mapping[old] is the new index or None.
    Use it to open eye holes or a mouth in a head skin before adding morphs.
    """
    vertices = [_vector(v, 3, 'Vertex') for v in vertices]
    kept = [tuple(face) for face in faces if not remove(_mul(tuple(map(sum, zip(*(vertices[i] for i in face)))), 1 / len(face)))]
    used = sorted({i for face in kept for i in face})
    mapping = [None] * len(vertices)
    for new, old in enumerate(used): mapping[old] = new
    return [vertices[i] for i in used], [tuple(mapping[i] for i in face) for face in kept], mapping


# ---------------------------------------------------------------- contract extras

def face_contract_extras(morphs, yaw_max, pitch_max, lid_follow=None, emotions=None, exposed_teeth=(), drop_missing=True):
    """Build the root-node `extras` for `arkit-face/1`: {'arkitFace': {...}}.

    `morphs` lists the morph names the GLB carries and must include all 21 required
    names. `emotions` defaults to the canonical concept-sheet presets; with
    `drop_missing` a preset's morph curves the head lacks are removed (gaze curves
    always stay, since they drive eye bones). `exposed_teeth` names the teeth that
    show at rest (an empty list when none do).
    """
    morphs = list(dict.fromkeys(morphs))
    missing = [name for name in ARKIT_REQUIRED if name not in morphs]
    if missing: raise ValueError(f'Missing required morphs: {", ".join(missing)}')
    presets = CANONICAL_EMOTIONS if emotions is None else emotions
    result = {}
    for name, curves in presets.items():
        result[name] = {curve: float(value) for curve, value in curves.items()
                        if not drop_missing or curve in morphs or curve in ARKIT_GAZE}
    extras = {'arkitFace': {
        'contract': 'arkit-face/1',
        'morphs': morphs,
        'gaze': {'yawMax': _number(yaw_max, 'yawMax', 0, 90, low_open=True), 'pitchMax': _number(pitch_max, 'pitchMax', 0, 90, low_open=True)},
        'lidFollow': dict(DEFAULT_LID_FOLLOW if lid_follow is None else lid_follow),
        'emotions': result,
        'exposedTeeth': list(exposed_teeth),
    }}
    errors = validate_face_contract_extras(extras, morphs)
    if errors: raise ValueError('; '.join(errors))
    return extras


def validate_face_contract_extras(extras, morphs=None):
    """Return a list of problems with an `extras` object against the `arkit-face/1` schema (empty when valid)."""
    errors = []
    face = extras.get('arkitFace') if isinstance(extras, dict) else None
    if not isinstance(face, dict): return ['extras.arkitFace is missing or not an object']
    real = lambda value: isinstance(value, Real) and not isinstance(value, bool) and math.isfinite(value)
    if face.get('contract') != 'arkit-face/1': errors.append(f'extras.arkitFace.contract must be "arkit-face/1", got {face.get("contract")!r}')
    listed = face.get('morphs')
    if not isinstance(listed, list) or not all(isinstance(n, str) for n in listed):
        errors.append('extras.arkitFace.morphs must be a list of morph names')
    else:
        missing = [n for n in ARKIT_REQUIRED if n not in listed]
        if missing: errors.append(f'extras.arkitFace.morphs lacks required morphs: {", ".join(missing)}')
        if morphs is not None and set(listed) != set(morphs):
            errors.append(f'extras.arkitFace.morphs does not match the file: listed only {sorted(set(listed) - set(morphs))}, unlisted {sorted(set(morphs) - set(listed))}')
    gaze = face.get('gaze')
    for key in ('yawMax', 'pitchMax'):
        value = gaze.get(key) if isinstance(gaze, dict) else None
        if not real(value) or not 0 < value <= 90: errors.append(f'extras.arkitFace.gaze.{key} must be a number of degrees in (0, 90]')
    follow = face.get('lidFollow')
    for key in ('down', 'up'):
        value = follow.get(key) if isinstance(follow, dict) else None
        if not real(value) or not 0 <= value <= 1: errors.append(f'extras.arkitFace.lidFollow.{key} must be a number in [0, 1]')
    emotions = face.get('emotions')
    if not isinstance(emotions, dict): errors.append('extras.arkitFace.emotions must be an object')
    else:
        for name in CANONICAL_EMOTIONS:
            if not isinstance(emotions.get(name), dict): errors.append(f'extras.arkitFace.emotions.{name} is missing')
        for name, curves in emotions.items():
            if not isinstance(curves, dict): continue
            for curve, value in curves.items():
                if curve not in ARKIT_NAMES: errors.append(f'extras.arkitFace.emotions.{name}.{curve} is not an ARKit curve')
                elif not real(value) or not 0 <= value <= 1: errors.append(f'extras.arkitFace.emotions.{name}.{curve} must be in [0, 1]')
    teeth = face.get('exposedTeeth')
    if not isinstance(teeth, list) or not all(isinstance(t, str) and t for t in teeth):
        errors.append('extras.arkitFace.exposedTeeth must be a list of names (empty when no teeth show at rest)')
    return errors


def merge_glb_node_extras(path, extras_by_node):
    """Merge JSON extras into named nodes of a GLB file in place, leaving the binary chunk untouched."""
    path = Path(path)
    data = path.read_bytes()
    magic, version, length = struct.unpack_from('<4sII', data)
    if magic != b'glTF' or version != 2 or length != len(data): raise ValueError('Not a glTF 2.0 binary file')
    chunks, offset = [], 12
    while offset < len(data):
        size, kind = struct.unpack_from('<I4s', data, offset)
        chunks.append([kind, data[offset + 8:offset + 8 + size]])
        offset += 8 + size
    if not chunks or chunks[0][0] != b'JSON': raise ValueError('GLB has no leading JSON chunk')
    document = json.loads(chunks[0][1].decode('utf-8'))
    nodes = document.get('nodes', [])
    for name, extras in extras_by_node.items():
        matches = [node for node in nodes if node.get('name') == name]
        if len(matches) != 1: raise ValueError(f'Expected one node named {name!r}, found {len(matches)}')
        merged = matches[0].get('extras') if isinstance(matches[0].get('extras'), dict) else {}
        merged.update(json.loads(json.dumps(extras)))
        matches[0]['extras'] = merged
    text = json.dumps(document, separators=(',', ':'), ensure_ascii=False).encode('utf-8')
    chunks[0][1] = text + b' ' * (-len(text) % 4)
    body = b''.join(struct.pack('<I4s', len(chunk), kind) + chunk for kind, chunk in chunks)
    temporary = path.with_name(path.name + '.extras.tmp')
    temporary.write_bytes(struct.pack('<4sII', b'glTF', 2, 12 + len(body)) + body)
    temporary.replace(path)


# ---------------------------------------------------------------- Blender wrappers

EXTRAS_PROPERTY = 'agent_meshes_extras'


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
    for label, position in (('eye_L', eye_left), ('eye_R', eye_right)):
        bone = data.edit_bones.new(label); bone.head = position; bone.tail = _add(position, (0, 0, length)); bone.roll = 0
        bone.parent = root; bone.use_connect = False
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


def build_eye(rig, side, center, radius, style='lid', lid_material=None, socket_material=None, eye_materials=None,
              iris=26, pupil=12, socket=True, **options):
    """Build one eye: an eyeball bound to `eye_L`/`eye_R`, lids (or shutters) with morphs, and a socket cup.

    `style='lid'` uses `lid_geometry`, `style='shutter'` uses `shutter_geometry`;
    extra keyword options go to that function. The lids object gets
    `eyeBlink<Side>`, `eyeSquint<Side>` and `eyeWide<Side>` and is bound to `head`
    with the socket. The eyeball has three material slots named eye_white,
    eye_iris and eye_pupil (pass `eye_materials` to override). Returns a dict with
    the objects and the lid geometry report (radii, clearance, squint ratio).
    """
    from agent_meshes_author import shape_key
    if side not in _SIDES: raise ValueError("Eye side must be 'L' or 'R'")
    suffix = _SIDES[side]
    center = _vector(center, 3, 'Eye center')
    bone = rig.data.bones.get(f'eye_{side}')
    if bone is None: raise ValueError(f'Rig has no eye_{side} bone; build it with face_skeleton')
    pivot = rig.matrix_world @ bone.head_local
    if math.dist(tuple(pivot), center) > 1e-5: raise ValueError(f'eye_{side} pivots at {tuple(pivot)}, not at the eyeball center {center}')
    if style == 'lid': lids = lid_geometry(center, radius, **options)
    elif style == 'shutter': lids = shutter_geometry(center, radius, **options)
    else: raise ValueError("Eye style must be 'lid' or 'shutter'")
    materials = eye_materials or [
        _material(None, 'eye_white', (.9, .88, .84), roughness=.25),
        _material(None, 'eye_iris', (.05, .35, .45), roughness=.3),
        _material(None, 'eye_pupil', (.01, .01, .012), roughness=.2),
    ]
    eyeball = mesh_from_geometry(f'eyeball_{side}', eyeball_geometry(center, radius, iris, pupil), materials)
    bind_rigid(eyeball, rig, f'eye_{side}')
    lid_mat = _material(lid_material, 'lid', (.6, .36, .25), roughness=.55)
    lid_obj = mesh_from_geometry(f'lids_{side}', lids, [lid_mat], smooth=style == 'lid')
    for key, morph in (('blink', 'eyeBlink'), ('squint', 'eyeSquint'), ('wide', 'eyeWide')):
        shape_key(lid_obj, f'{morph}{suffix}', lids['morphs'][key])
    bind_rigid(lid_obj, rig, 'head')
    result = {'eyeball': eyeball, 'lids': lid_obj, 'socket': None, 'geometry': lids}
    if socket:
        if style == 'lid':
            radius_s = (radius + lids['lower_radius']) / 2
            reach = max(lids['opening'][0], lids['opening'][1] + lids['wide'][0], lids['opening'][2] + lids['wide'][1])
            hole = math.degrees(math.asin(min(1.0, lids['lower_radius'] / radius_s * math.sin(math.radians(min(89.0, reach)))))) + 2
        else:
            radius_s = radius * 1.02
            hole = 80
        cup = mesh_from_geometry(f'eye_socket_{side}', socket_geometry(center, radius, radius_s, min(170.0, hole)),
                                 [_material(socket_material, 'eye_socket', (.03, .015, .015), roughness=.9, double_sided=True)])
        bind_rigid(cup, rig, 'head')
        result['socket'] = cup
    return result


def add_jaw_open(obj, jaw, weight=None, name='jawOpen', rigid=False):
    """Add the `jawOpen` shape key to `obj` from a `JawHinge` (weight as in `JawHinge.targets`).

    `rigid=True` is the rigid-plate mode: the whole object turns with the hinge as
    one body (lower teeth, tongue, a robot chin plate). Rejects morphs that fold faces.
    """
    if rigid:
        if weight is not None: raise ValueError('Pass either rigid=True or a weight, not both')
        weight = 1.0
    from agent_meshes_author import shape_key
    world = obj.matrix_world
    inverse = world.inverted()
    points = [tuple(world @ v.co) for v in obj.data.vertices]
    targets = jaw.targets(points, weight)
    folded = folded_faces(points, targets, [tuple(p.vertices) for p in obj.data.polygons])
    if folded:
        raise ValueError(f'jawOpen folds {len(folded)} faces of {obj.name}; widen JawHinge band/back_band, move the pivot or lower the angle')
    from mathutils import Vector
    return shape_key(obj, name, [tuple(inverse @ Vector(p)) for p in targets])


def slit_mouth(obj, mouth_z, half_width, center_x=0.0, front_y=None, seam=2e-5):
    """Cut a closed mouth slit into a skin mesh along z = mouth_z for |x - center_x| < half_width on the front.

    Bisects the mesh at the mouth line, splits the edges on that line so the lips
    can part, and nudges the lower lip's seam vertices down by `seam` (0.02 mm) so
    `JawHinge.weight` carries them. The corners stay joined. Call it before shape
    keys and skinning. Returns the number of split edges.
    """
    import bmesh
    mouth_z, half_width = _number(mouth_z, 'Mouth line'), _number(half_width, 'Mouth half-width', 0, low_open=True)
    if obj.data.shape_keys: raise ValueError('Cut the mouth before adding shape keys')
    bm = bmesh.new()
    bm.from_mesh(obj.data)
    if front_y is None: front_y = sum(v.co.y for v in bm.verts) / max(1, len(bm.verts))
    bmesh.ops.bisect_plane(bm, geom=bm.verts[:] + bm.edges[:] + bm.faces[:], dist=1e-7, plane_co=(0, 0, mouth_z), plane_no=(0, 0, 1))
    on_line = lambda v: abs(v.co.z - mouth_z) < 1e-6 and abs(v.co.x - center_x) < half_width - 1e-9 and v.co.y < front_y
    edges = [e for e in bm.edges if all(on_line(v) for v in e.verts)]
    bmesh.ops.split_edges(bm, edges=edges)
    bm.verts.ensure_lookup_table()
    for vertex in bm.verts:
        if abs(vertex.co.z - mouth_z) < 1e-6 and vertex.link_faces and all(sum(v.co.z for v in f.verts) / len(f.verts) < mouth_z for f in vertex.link_faces):
            if abs(vertex.co.x - center_x) < half_width - 1e-9 and vertex.co.y < front_y: vertex.co.z -= seam
    bm.to_mesh(obj.data)
    bm.free()
    obj.data.update()
    return len(edges)


def join_face_parts(parts, name='face', rig=None, bone='head'):
    """Join every morph-bearing face part (skin, lids, teeth, tongue, cavity) into ONE mesh object.

    Unreal discards all morph names in a file when a name repeats across glTF
    meshes, so a face whose skin and lower teeth both carry `jawOpen` must be one
    mesh: this exports as one glTF mesh with one primitive per material, every
    primitive carrying the same morph names. Reads each part's world-space rest
    positions, polygons, material slots, smooth flags and shape keys; parts lacking
    a key keep their rest shape in it. The parts are removed (keep the source
    recipe, not the objects); UV maps are not carried. With `rig`, the result is
    bound 100% to `bone`. Eyeballs stay separate: they move with their eye bones.
    """
    import bpy
    geometry, smooth = [], []
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
    joined = join_geometry(geometry)
    for part in parts: bpy.data.objects.remove(part, do_unlink=True)
    from agent_meshes_author import shape_key
    obj = mesh_from_geometry(name, joined, joined['materials'])
    for polygon, flag in zip(obj.data.polygons, smooth): polygon.use_smooth = flag
    for morph, targets in joined['morphs'].items(): shape_key(obj, morph, targets)
    if rig is not None: bind_rigid(obj, rig, bone)
    return obj


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
