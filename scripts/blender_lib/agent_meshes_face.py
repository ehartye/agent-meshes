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
    'lid_geometry', 'shutter_geometry', 'lid_clearance', 'COVERAGE_STATES', 'eye_coverage', 'eye_coverage_problems', 'eyeball_geometry', 'socket_geometry', 'recommended_gaze',
    'eye_window', 'eye_hole', 'eye_hole_mask', 'shutter_hole', 'EYE_MATERIALS', 'EXPOSED_TEETH_MATERIAL', 'skin_brow_geometry',
    'JawHinge', 'SEAM_TOLERANCE', 'chin_drop', 'front_surface', 'cut_hole', 'exposed_teeth_geometry', 'brow_ridge_geometry', 'brow_plate_geometry', 'split_plates', 'rubber_mouth_geometry', 'teeth_row_geometry', 'mouth_cavity_geometry', 'tongue_geometry', 'soft_offset',
    'symmetric_offsets', 'nose_geometry', 'sculpt_skin', 'sculpt_lips', 'ATTACH_TOLERANCE', 'attach_to_skin', 'skin_contact', 'mirror_x', 'cut_faces', 'ellipsoid_geometry', 'folded_faces', 'join_geometry', 'join_face_parts', 'face_contract_extras', 'validate_face_contract_extras',
    'merge_glb_node_extras', 'prune_glb_morphs', 'MORPH_POSITION_EPSILON', 'MORPH_NORMAL_EPSILON', 'face_skeleton', 'bind_rigid', 'build_eye', 'add_jaw_open', 'slit_mouth',
    'mesh_from_geometry', 'collect_morph_names', 'SEAM_ATTRIBUTE', 'set_face_contract', 'face_contract', 'EXTRAS_PROPERTY',
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
# The contract's fallback is {down: .35, up: .25}; the helpers write up .8, so eyeLookUp = 1 lifts the default lids'
# edge (wide 10 degrees) by 1.7-2.8 mm on 12-20 mm eyes: E2 needs a lift you can see at 512 px (the verifier: >= 1.5 mm).
DEFAULT_LID_FOLLOW = {'down': .35, 'up': .8}
# The ID render and the verifier find eyeballs by these material names; overrides must keep them.
EYE_MATERIALS = ('eye_white', 'eye_iris', 'eye_pupil')
# Teeth that show with the mouth closed (buck teeth, fangs) get their own material, declared in exposedTeeth.
EXPOSED_TEETH_MATERIAL = 'teeth_exposed'
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
# A vertex this close to the mouth line counts as on it (float32 stores ~1e-8 m of rounding at head scale).
SEAM_TOLERANCE = 1e-6


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


BEAD_ROWS = 3


def _lid_layers(center, inner, thickness, yaws, anchor, edges, rows, shape=None):
    """Vertices of one lid for one set of edge elevations (one per yaw column).

    Rows run from the anchor to a thickness short of the edge; then BEAD_ROWS rows turn
    the outer layer down over a quarter round onto the inner one, so the lid ends in a
    rounded rim instead of a square slab end. The inner layer runs on to the edge at the
    lid's inner radius, so the lids cover the eyeball exactly as far as before.
    """
    # `shape` gives the rest edges every state's bead is sized from, so the bead keeps its width as the lid moves.
    arc = math.degrees(thickness / (inner + thickness / 2))
    shape = edges if shape is None else shape
    steep = [max(abs(shape[j] - shape[k]) for k in (j - 1, j + 1) if 0 <= k < len(shape)) for j in range(len(shape))]
    # Wider where the edge runs steeply across the columns (an almond corner), so no bead row makes a sliver that folds
    # when blink and squint add up.
    arcs = [min(max(arc, 2 * steep[j]), abs(shape[j] - anchor) / 3) for j in range(len(shape))]
    layers = []
    for layer in (0, 1):
        for i in range(rows + 1):
            s = i / rows
            for yaw, edge, width in zip(yaws, edges, arcs):
                toward = 1 if edge >= anchor else -1
                stop = edge - toward * width
                layers.append(_sphere_point(center, inner + thickness * layer, yaw, anchor + s * (stop - anchor)))
        for k in range(1, BEAD_ROWS + 1):
            theta = math.radians(70 * k / BEAD_ROWS)
            for yaw, edge, width in zip(yaws, edges, arcs):
                toward = 1 if edge >= anchor else -1
                elevation = edge - toward * width * (1 - math.sin(theta))
                layers.append(_sphere_point(center, inner + thickness * math.cos(theta) * layer, yaw, elevation))
    return layers


def lid_geometry(center, eye_radius, opening=(45, 38, 30), meet=-8, overlap=6, clearance=.0005, thickness=None,
                 squint=.45, squint_upper_share=.35, wide=(10, 4), span_margin=15, columns=24, rows=8, gap=None,
                 min_radius=None, corner=1.25, tuck=4):
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

    Toward the corners the lower lid's edge rises up to `tuck` degrees past the meet
    line, behind the upper lid, so where the lids meet they overlap instead of
    abutting on different radii: no oblique view finds a slit between them.
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
    tuck = _number(tuck, 'Corner tuck', 0, 20)
    span_margin = _number(span_margin, 'Span margin', 0, 60)
    corner = _number(corner, 'Corner exponent', .25, 4)
    columns, rows = _count(columns, 'Lid columns', 4), _count(rows, 'Lid rows', 1)
    if columns % 2: columns += 1
    span = min(88.0, width + span_margin)
    yaws = [-span + 2 * span * j / columns for j in range(columns + 1)]
    profile = [max(0.0, 1 - (yaw / width) ** 2) ** corner for yaw in yaws]
    travel = (1 - squint) * (upper + lower)
    aperture = eye_radius * math.sin(math.radians(width))
    required = eye_radius + clearance
    grid = [[0] * (columns + 1) for _ in range(rows + 1 + BEAD_ROWS)]
    faces_one = _thick_grid(grid, grid)

    def attempt(rise):
        # Linear morphs add, so blink 1 + wide 1 (surprised plus an idle blink) parts the closed lids by the wide travel.
        # Behind the upper lid, the closed lower lid can rise past the meet line by `rise` times that travel (less half
        # the overlap) to keep them overlapping. Near the corners, where the wide travel is small, it stays on the line.
        states = {
            'upper': {
                'rest': [meet + (upper - meet) * p for p in profile],
                'blink': [meet - overlap for _ in profile],
                'squint': [meet + (upper - meet) * p - share * travel * p for p in profile],
                'wide': [meet + (upper - meet) * p + wide_up * p for p in profile],
            },
            'lower': {
                'rest': [meet + tuck * (1 - p) - (lower + meet) * p for p in profile],
                'blink': [meet + tuck * (1 - p) + rise * max(0.0, (wide_up + wide_down) * p - overlap / 2) for p in profile],
                'squint': [meet + tuck * (1 - p) - (lower + meet) * p + (1 - share) * travel * p for p in profile],
                'wide': [meet + tuck * (1 - p) - (lower + meet) * p - wide_down * p for p in profile],
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

        def solve(key, radius):
            for _ in range(60):
                layers = {state: _lid_layers(center, radius, thickness, yaws, anchors[key], edges, rows, states[key]['rest']) for state, edges in states[key].items()}
                reach = lid_clearance(center, eye_radius, layers['rest'], [layers[s] for s in ('blink', 'squint', 'wide')]) + eye_radius
                if reach >= required - 1e-12: return radius, layers
                radius *= required / reach * (1 + 1e-9)
            raise ValueError('Could not find a lid radius with enough clearance')

        lower_radius, lower_layers = solve('lower', max(required, _number(min_radius, 'Minimum lid radius', 0) if min_radius is not None else 0))
        upper_radius, upper_layers = solve('upper', max(required, lower_radius + thickness + gap))
        offset = len(lower_layers['rest'])
        vertices = upper_layers['rest'] + lower_layers['rest']
        faces = _outward(upper_layers['rest'], faces_one) + [tuple(i + offset for i in face) for face in _outward(lower_layers['rest'], faces_one)]
        morphs = {state: upper_layers[state] + lower_layers[state] for state in ('blink', 'squint', 'wide')}
        folded = _folded(vertices, faces, morphs)
        if folded: return None, f'Lid faces fold over at {", ".join(folded)}; raise `corner` (now {corner}) or widen the opening'
        # Above the upper lid's anchor and below the lower lid's the eyeball is the skin's to hide.
        band = (lower_radius * math.sin(math.radians(anchors['lower'])), upper_radius * math.sin(math.radians(anchors['upper'])))
        uncovered = eye_coverage_problems(center, eye_radius, {'vertices': vertices, 'faces': faces, 'morphs': morphs, 'aperture': aperture, 'band': band})
        if uncovered: return None, f'The lids leave the eyeball uncovered: {uncovered[0]}; raise `overlap`, lower `wide` or raise `corner`'
        return (states, vertices, faces, morphs, upper_radius, lower_radius, squint_ratio, rise, band, anchors), None

    # The least lower-lid rise that keeps blink + wide closed: every extra degree adds to blink + squint's sweep.
    problems = []
    for rise in (0, .25, .5, .75, 1):
        built, problem = attempt(rise)
        if built: break
        if problem not in problems: problems.append(problem)
    else: raise ValueError('; '.join(problems))
    states, vertices, faces, morphs, upper_radius, lower_radius, squint_ratio, rise, band, anchors = built
    minimum = lid_clearance(center, eye_radius, vertices, [morphs[s] for s in ('blink', 'squint', 'wide')])
    edges = {'yaw': yaws}
    for key in ('upper', 'lower'):
        edges[key] = [{state: states[key][state][j] for state in states[key]} for j in range(columns + 1)]
    return {
        'vertices': vertices, 'faces': faces, 'morphs': morphs, 'style': 'lid',
        'upper_radius': upper_radius, 'lower_radius': lower_radius, 'thickness': thickness,
        'min_clearance': minimum, 'squint_ratio': squint_ratio, 'edges': edges, 'aperture': aperture, 'band': band,
        'opening': (width, upper, lower), 'wide': (wide_up, wide_down), 'lower_rise': rise,
        'center': center, 'eye_radius': eye_radius, 'meet': meet, 'anchors': (anchors['lower'], anchors['upper']),
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
                     thickness=None, blade_height=None, squint=.45, squint_upper_share=.35, wide=(.2, .1), gap=None,
                     surface=None, skin_clearance=.0005):
    """Robot shutter blades that slide vertically in planes in front of the eye.

    Both blades are flat plates perpendicular to the gaze axis. The lower blade's
    back face sits `clearance` in front of the eyeball; the upper blade slides in
    front of it. Their morphs are pure translations, so every blink, squint and wide
    weight keeps the whole blade at least that far from the eye center. Heights are
    fractions of the eyeball radius above (+) and below (-) the eye center:
    `opening` = (upper edge, lower edge depth) at rest, `meet` where they close.
    `aperture` is the blades' half-width in meters (default 1.1 radii).

    Morphs add linearly, so blink 1 + squint 1 pushes each blade past the meet line
    by the squint travel too, and blink 1 + wide 1 pulls the blades apart by the wide
    travel. The blades are sized for every blink/squint/wide combination in [0, 1]^3:
    `blade_height` (default: the least that works plus 5% of the radius) keeps the
    upper blade's top above the eyeball and the lower blade's bottom below it, and
    `overlap` (default: the wide travel plus 8% of the radius) keeps a full blink
    closed while the eyes are wide. Explicit values that cannot do this are rejected.

    Blades that tall stick out past the eye, so they must slide behind the skin: pass
    the head's `surface` (`front_surface(...)` of the skin with its eye holes cut)
    and the helper rejects blades that poke `skin_clearance` short of the skin in
    front of the eye anywhere they travel. Flat blades suit a flat face with the
    eyes recessed behind it (a tin can, `ellipsoid_geometry(exponent=6)`); on a
    round head they poke through the forehead.
    """
    center = _vector(center, 3, 'Eye center')
    r = _number(eye_radius, 'Eyeball radius', 0, low_open=True)
    upper, lower = _vector(opening, 2, 'Opening')
    _number(upper, 'Upper opening', 0, 2, low_open=True); _number(lower, 'Lower opening', 0, 2, low_open=True)
    meet = _number(meet, 'Meet height')
    if not -lower < meet < upper: raise ValueError('Meet height must lie inside the opening')
    half = 1.1 * r if aperture is None else _number(aperture, 'Aperture half-width', 0, low_open=True)
    wide_up, wide_down = _vector(wide, 2, 'Wide')
    _number(wide_up, 'Wide lift', 0); _number(wide_down, 'Wide drop', 0)
    wide_travel = (wide_up + wide_down) * r
    if overlap is None: overlap = wide_travel + .08 * r
    else:
        overlap = _number(overlap, 'Overlap', 0)
        if overlap <= wide_travel:
            raise ValueError(f'Overlap {overlap * 1000:.2f} mm opens the shutters at blink 1 + wide 1: it must exceed '
                             f'the wide travel ({wide_travel * 1000:.2f} mm)')
    clearance = _number(clearance, 'Clearance', 0)
    thickness = max(.0006, .06 * r) if thickness is None else _number(thickness, 'Blade thickness', 0, low_open=True)
    gap = max(.0002, .02 * r) if gap is None else _number(gap, 'Blade gap', 0)
    squint = _number(squint, 'Squint open fraction', .05, .95)
    share = _number(squint_upper_share, 'Squint upper share', 0, 1)
    travel = (1 - squint) * (upper + lower) * r
    edges = {
        'upper': {'rest': upper * r, 'blink': meet * r - overlap, 'squint': upper * r - share * travel, 'wide': (upper + wide_up) * r},
        'lower': {'rest': -lower * r, 'blink': meet * r, 'squint': -lower * r + (1 - share) * travel, 'wide': -(lower + wide_down) * r},
    }
    squint_ratio = (edges['upper']['squint'] - edges['lower']['squint']) / (edges['upper']['rest'] - edges['lower']['rest'])
    if not .25 <= squint_ratio <= .6:
        raise ValueError(f'Squint leaves {squint_ratio:.2f} of the opening; the contract needs 0.25-0.6')
    # Each edge is linear in the weights, so its extremes over [0, 1]^3 lie at the corners of the weight cube.
    corners = [(b, s, w) for b in (0, 1) for s in (0, 1) for w in (0, 1)]
    names = ('blink', 'squint', 'wide')

    def at(key, weights):
        return edges[key]['rest'] + sum(k * (edges[key][state] - edges[key]['rest']) for k, state in zip(weights, names))

    upper_low = min(corners, key=lambda c: at('upper', c))
    lower_high = max(corners, key=lambda c: at('lower', c))
    need_upper, need_lower = r - at('upper', upper_low), r + at('lower', lower_high)
    need = max(need_upper, need_lower)
    worst = upper_low if need_upper >= need_lower else lower_high
    label = ' + '.join(f'{n} 1' for n, k in zip(names, worst) if k) or 'rest'
    if blade_height is None: blade = need + .05 * r
    else:
        blade = _number(blade_height, 'Blade height', 0, low_open=True)
        if blade < need - 1e-12:
            raise ValueError(f'Blade height {blade * 1000:.2f} mm leaves the eyeball uncovered at {label}: '
                             f'the blades must be at least {need * 1000:.2f} mm ({need / r:.3f} eyeball radii) tall')
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
    skin_gap = None
    if surface is not None:
        if not callable(surface): raise ValueError('surface must be a function (x, z) -> y, such as front_surface(...)')
        # Each blade slides vertically, so over [0, 1]^3 it sweeps the band between its lowest and highest corner poses.
        worst, where = math.inf, None
        for key in ('upper', 'lower'):
            plane = upper_plane if key == 'upper' else lower_plane
            lows = [at(key, c) - (0 if key == 'upper' else blade) for c in corners]
            z0, z1 = min(lows), max(lows) + blade
            y = cy - plane - thickness
            for i in range(13):
                x = cx - half + 2 * half * i / 12
                for k in range(25):
                    z = cz + z0 + (z1 - z0) * k / 24
                    skin = surface(x, z)
                    # Only skin in front of the eye counts: through the eye hole a ray finds the back of the head.
                    if skin is None or skin >= cy: continue
                    if y - skin < worst: worst, where = y - skin, (key, x - cx, z - cz)
        if where is not None:
            skin_gap = worst
            if worst < skin_clearance - 1e-12:
                raise ValueError(f'The {where[0]} shutter blade would poke {max(0.0, -worst) * 1000:.1f} mm out of the skin '
                                 f'({where[1] / r:+.2f}, {where[2] / r:+.2f} eyeball radii from the eye): recess the eye behind a '
                                 f'flatter face, narrow the aperture or shrink the opening')
    result = {
        'vertices': vertices, 'faces': faces, 'morphs': morphs, 'style': 'shutter', 'edges': edges, 'aperture': half,
        'center': center, 'eye_radius': r,
        'skin_clearance': skin_gap,
        'upper_plane': upper_plane, 'lower_plane': lower_plane, 'thickness': thickness, 'squint_ratio': squint_ratio,
        'blade_height': blade, 'overlap': overlap,
        'min_clearance': lid_clearance(center, r, vertices, [morphs[s] for s in names]),
    }
    uncovered = eye_coverage_problems(center, r, result)
    if uncovered: raise ValueError(f'The shutters leave the eyeball uncovered: {uncovered[0]}')
    return result


def _state(label, kind, blink=0, squint=0, wide=0):
    return {'label': label, 'kind': kind, 'weights': {'blink': blink, 'squint': squint, 'wide': wide}}


# Rig-contract invariant 1 (blink .25/.5/.75/1, alone and with squint 1) plus squint, wide, and blink with wide
# (surprised plus an idle blink). A 'closed' state hides the whole eyeball; a 'narrow' one shows only what neutral shows.
COVERAGE_STATES = tuple(
    [_state(f'blink {b:g}', 'narrow', b) for b in (.25, .5, .75)]
    + [_state(f'blink {b:g} + squint 1', 'narrow', b, 1) for b in (.25, .5, .75)]
    + [_state('squint 1', 'narrow', squint=1), _state('wide 1', 'wide', wide=1)]
    + [_state('blink 1', 'closed', 1), _state('blink 1 + squint 1', 'closed', 1, 1),
       _state('blink 1 + wide 1', 'closed', 1, wide=1), _state('blink 1 + squint 1 + wide 1', 'closed', 1, 1, 1)]
)


def eye_coverage(center, radius, geometry, weights=None, samples=81, aperture=None):
    """Which front-view rays across the eyeball's disk reach the eyeball before any lid geometry.

    Rays run along +Y (the face looks down -Y) on a `samples` x `samples` grid over
    the disk of `radius` around `center`, limited to |x - cx| <= `aperture` (default:
    the geometry's `aperture`, the lids' or blades' half-width) and to heights
    dz in the geometry's `band` (the lids' anchors), if any: the skin hides the rest. `geometry` has vertices, faces and morphs {'blink', 'squint', 'wide'};
    `weights` mixes them linearly, as engines do. Returns {'visible': grid cells
    (i, j) whose ray reaches the eyeball, 'samples': rays cast, 'step': grid spacing,
    'lowest' / 'highest': the visible rays' extreme heights in eyeball radii}.
    """
    cx, cy, cz = _vector(center, 3, 'Eye center')
    r = _number(radius, 'Eyeball radius', 0, low_open=True)
    samples = _count(samples, 'Coverage samples', 5)
    half = geometry.get('aperture') if aperture is None else aperture
    half = r if half is None else min(r, _number(half, 'Aperture'))
    low, high = geometry.get('band') or (-r, r)
    rest = geometry['vertices']
    moved = [list(v) for v in rest]
    for name, w in (weights or {}).items():
        if not w: continue
        for i, (a, b) in enumerate(zip(rest, geometry['morphs'][name])):
            for k in range(3): moved[i][k] += w * (b[k] - a[k])
    step = 2 * r / (samples - 1)
    x0, z0 = cx - r, cz - r
    limit = (r * .999) ** 2
    eye_y, covered = {}, set()
    for i in range(samples):
        dx = x0 + i * step - cx
        if abs(dx) > half + 1e-12: continue
        for j in range(samples):
            dz = z0 + j * step - cz
            if dx * dx + dz * dz < limit and low <= dz <= high: eye_y[(i, j)] = cy - math.sqrt(r * r - dx * dx - dz * dz)
    for face in geometry['faces']:
        for t in range(1, len(face) - 1):
            a, b, c = moved[face[0]], moved[face[t]], moved[face[t + 1]]
            d = (b[2] - c[2]) * (a[0] - c[0]) + (c[0] - b[0]) * (a[2] - c[2])
            if abs(d) < 1e-18: continue
            i0 = max(0, math.ceil((min(a[0], b[0], c[0]) - x0) / step - 1e-9))
            i1 = min(samples - 1, math.floor((max(a[0], b[0], c[0]) - x0) / step + 1e-9))
            j0 = max(0, math.ceil((min(a[2], b[2], c[2]) - z0) / step - 1e-9))
            j1 = min(samples - 1, math.floor((max(a[2], b[2], c[2]) - z0) / step + 1e-9))
            for i in range(i0, i1 + 1):
                x = x0 + i * step
                for j in range(j0, j1 + 1):
                    key = (i, j)
                    if key in covered or key not in eye_y: continue
                    z = z0 + j * step
                    u = ((b[2] - c[2]) * (x - c[0]) + (c[0] - b[0]) * (z - c[2])) / d
                    v = ((c[2] - a[2]) * (x - c[0]) + (a[0] - c[0]) * (z - c[2])) / d
                    if u < -1e-9 or v < -1e-9 or 1 - u - v < -1e-9: continue
                    if u * a[1] + v * b[1] + (1 - u - v) * c[1] < eye_y[key] - 1e-9: covered.add(key)
    visible = sorted(k for k in eye_y if k not in covered)
    heights = [(z0 + j * step - cz) / r for _, j in visible]
    return {'visible': visible, 'samples': len(eye_y), 'step': step,
            'lowest': min(heights) if heights else None, 'highest': max(heights) if heights else None}


def eye_coverage_problems(center, radius, geometry, samples=81, aperture=None):
    """Front-view coverage problems of lids or shutters across `COVERAGE_STATES` (empty when the eye stays covered).

    A closed state (blink 1, alone or with squint and wide) must hide every ray over
    the eyeball within the aperture; a closing state (mid-blink, squint) may show
    only rays the neutral opening shows, so no eyeball appears over a lid. The
    `arkit-face/1` verifier runs the same states on the whole exported head.
    """
    def look(weights): return eye_coverage(center, radius, geometry, weights, samples, aperture)
    neutral = set(look({})['visible'])
    problems = []
    for state in COVERAGE_STATES:
        if state['kind'] == 'wide': continue
        seen = look(state['weights'])
        if state['kind'] == 'closed' and seen['visible']:
            problems.append(f"{state['label']}: {len(seen['visible'])} of {seen['samples']} front rays reach the eyeball "
                            f"(heights {seen['lowest']:+.3f} to {seen['highest']:+.3f} eyeball radii); a full blink must cover it")
        elif state['kind'] == 'narrow':
            extra = [k for k in seen['visible'] if k not in neutral]
            if extra: problems.append(f"{state['label']}: {len(extra)} front rays see the eyeball outside the neutral opening")
    return problems


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


def eye_window(lids, margin=6, corner_margin=2):
    """The directions from a lid eye's center that its skin hole must leave open: the lid opening plus every edge's travel.

    `lids` is a `lid_geometry(...)` result. In (yaw, elevation) degrees seen from the
    eye center, the lids' envelope is where the eye can open in any blink, squint or
    wide state: between the lower lid's lowest edge and the upper lid's highest edge.
    The window is every direction within `margin` degrees of that envelope, so it
    has round ends instead of the almond's sharp tips. The lids cover every direction
    inside it that the opening does not, in every state, and reach past it (their
    anchors and span), so a skin hole cut along it meets lids all the way round.
    At the corners, where the lids meet and barely move, the window reaches only
    `corner_margin` degrees past the envelope's tips (it widens to `margin` over the
    last 15 degrees of yaw), so its ends hug the lids instead of opening a pointed
    pocket onto the wall and lining beside the inner corner.
    Returns {'center', 'margin', 'envelope' (the outline's (yaw, elevation) points),
    'polar_max' (the window's widest angle from the gaze axis), 'level'}:
    `level(point)` is the direction's angular distance outside the window (negative
    inside), in degrees.
    """
    if not isinstance(lids, dict) or lids.get('style') != 'lid':
        raise ValueError('eye_window needs a lid_geometry(...) result: shutters slide behind a flat face, so cut their hole with cut_hole')
    margin = _number(margin, 'Window margin', 0, 30)
    corner_margin = _number(corner_margin, 'Corner margin', 0, margin)
    center = _vector(lids['center'], 3, 'Eye center')
    edges, yaws = lids['edges'], list(lids['edges']['yaw'])
    high = [max(edge.values()) for edge in edges['upper']]
    low = [min(edge.values()) for edge in edges['lower']]
    open_ = [k for k in range(len(yaws)) if high[k] > low[k]]
    if not open_: raise ValueError('The lids never open')
    first, last = open_[0], open_[-1]

    def crossing(k, step):
        # Where the envelope closes between column k and its closed neighbour.
        j = k + step
        if j < 0 or j >= len(yaws): return (yaws[k], (high[k] + low[k]) / 2)
        g0, g1 = high[k] - low[k], high[j] - low[j]
        t = g0 / (g0 - g1)
        return (yaws[k] + t * (yaws[j] - yaws[k]), low[k] + t * (low[j] - low[k]))
    outline = [crossing(first, -1)] + [(yaws[k], high[k]) for k in range(first, last + 1)] + [crossing(last, 1)]
    outline += [(yaws[k], low[k]) for k in range(last, first - 1, -1)]
    segments = list(zip(outline, outline[1:] + outline[:1]))
    y_min, y_max = outline[0][0], outline[last - first + 2][0]
    low_anchor, high_anchor = lids['anchors']
    if max(abs(y_min), abs(y_max)) + margin >= yaws[-1]:
        raise ValueError(f"The window reaches the lids' ends (+-{yaws[-1]:g} degrees of yaw): raise span_margin or lower margin")
    if max(high) + margin >= high_anchor or min(low) - margin <= low_anchor:
        raise ValueError("The window reaches past the lids' anchors: lower margin")

    def table(values, yaw):
        step = yaws[1] - yaws[0]
        k = min(len(yaws) - 2, max(0, int((yaw - yaws[0]) / step)))
        t = (yaw - yaws[k]) / step
        return values[k] + t * (values[k + 1] - values[k])

    def distance(yaw, elevation):
        best = math.inf
        for (y0, e0), (y1, e1) in segments:
            dy, de = y1 - y0, e1 - e0
            length = dy * dy + de * de
            t = 0.0 if length < 1e-12 else min(1.0, max(0.0, ((yaw - y0) * dy + (elevation - e0) * de) / length))
            best = min(best, math.hypot(yaw - y0 - t * dy, elevation - e0 - t * de))
        inside = y_min <= yaw <= y_max and table(low, yaw) <= elevation <= table(high, yaw)
        return -best if inside else best

    def reach(yaw):
        """The window's margin at this yaw: `corner_margin` at and past the tips, `margin` 15 degrees inside them."""
        return corner_margin + (margin - corner_margin) * _smoothstep(0, 15, min(yaw - y_min, y_max - yaw))

    def level(point):
        d = _sub(point, center)
        r = math.hypot(*d)
        if r < 1e-12: return -1.0
        yaw = math.degrees(math.atan2(d[0], -d[1]))
        elevation = math.degrees(math.asin(max(-1.0, min(1.0, d[2] / r))))
        return distance(yaw, elevation) - reach(yaw)

    polar = 0.0
    for i in range(-120, 121):
        for j in range(-90, 91):
            yaw, elevation = float(i), float(j)
            if distance(yaw, elevation) <= reach(yaw):
                polar = max(polar, math.degrees(math.acos(math.cos(math.radians(elevation)) * math.cos(math.radians(yaw)))))
    return {'center': center, 'margin': margin, 'envelope': outline, 'polar_max': polar, 'level': level}


def _refine(vertices, faces, near, max_edge, rounds=12):
    """Split every edge longer than `max_edge` with an end where `near(point)` holds, by longest-edge bisection.

    Faces touching a split edge become triangles; a triangle is only ever split
    across its longest edge first (the neighbours' longest edges are marked until
    that holds), so repeated rounds keep the triangles well shaped. Orientation is kept.
    """
    vertices, faces = [tuple(v) for v in vertices], [tuple(f) for f in faces]
    key = lambda a, b: (a, b) if a < b else (b, a)
    length = lambda e: math.dist(vertices[e[0]], vertices[e[1]])
    edges_of = lambda face: [key(a, b) for a, b in zip(face, face[1:] + face[:1])]
    for _ in range(rounds):
        marked = set()
        for face in faces:
            for e in edges_of(face):
                if e not in marked and length(e) > max_edge and (near(vertices[e[0]]) or near(vertices[e[1]])
                                                                  or near(_mul(_add(vertices[e[0]], vertices[e[1]]), .5))): marked.add(e)
        if not marked: break
        while True:
            # Polygons touching a marked edge become triangles (quads along their shorter diagonal).
            split_faces = []
            for face in faces:
                if len(face) > 3 and any(e in marked for e in edges_of(face)):
                    if len(face) == 4 and math.dist(vertices[face[1]], vertices[face[3]]) < math.dist(vertices[face[0]], vertices[face[2]]):
                        split_faces += [(face[0], face[1], face[3]), (face[1], face[2], face[3])]
                    else:
                        split_faces += [(face[0], face[k], face[k + 1]) for k in range(1, len(face) - 1)]
                else: split_faces.append(face)
            faces = split_faces
            # Conformity: a triangle with any marked edge has its longest edge marked too.
            grown = False
            for face in faces:
                if len(face) != 3: continue
                edges = edges_of(face)
                if any(e in marked for e in edges):
                    longest = max(edges, key=length)
                    if longest not in marked: marked.add(longest); grown = True
            if not grown: break
        middle = {}
        for e in marked:
            middle[e] = len(vertices)
            vertices.append(_mul(_add(vertices[e[0]], vertices[e[1]]), .5))
        refined = []
        for face in faces:
            if len(face) != 3 or not any(e in marked for e in edges_of(face)):
                refined.append(face); continue
            # Rotate so the longest edge runs a -> b.
            edges = edges_of(face)
            k = edges.index(max(edges, key=length))
            a, b, c = face[k], face[(k + 1) % 3], face[(k + 2) % 3]
            m = middle[key(a, b)]
            n, q = middle.get(key(b, c)), middle.get(key(c, a))
            if n is None and q is None: refined += [(a, m, c), (m, b, c)]
            elif q is None: refined += [(a, m, c), (m, b, n), (m, n, c)]
            elif n is None: refined += [(m, b, c), (a, m, q), (m, c, q)]
            else: refined += [(a, m, q), (m, b, n), (q, n, c), (m, n, q)]
        faces = refined
    return vertices, faces


def _quality(vertices, face):
    """Twice a triangle's area over its longest edge squared (0 for a sliver, 0.87 equilateral)."""
    a, b, c = (vertices[i] for i in face)
    longest = max(math.dist(a, b), math.dist(b, c), math.dist(c, a))
    return 0.0 if longest < 1e-15 else math.hypot(*_cross(_sub(b, a), _sub(c, a))) / longest ** 2


def _tidy(vertices, faces, touched, rounds=4):
    """Triangulate the faces that touch `touched` vertices without slivers, flipping any sliver across its longest edge."""
    touched = set(touched)
    result = []
    for face in faces:
        face = tuple(face)
        if len(face) == 3 or not touched.intersection(face): result.append(face); continue
        ring = list(face)
        while len(ring) > 3:
            # Clip the ear whose triangle is best shaped.
            k = max(range(len(ring)), key=lambda j: _quality(vertices, (ring[j - 1], ring[j], ring[(j + 1) % len(ring)])))
            result.append((ring[k - 1], ring[k], ring[(k + 1) % len(ring)]))
            del ring[k]
        result.append(tuple(ring))
    for _ in range(rounds):
        owner = {}
        for index, face in enumerate(result):
            if len(face) == 3:
                for a, b in zip(face, face[1:] + face[:1]): owner[(a, b)] = index
        flipped = False
        for index, face in enumerate(result):
            if len(face) != 3 or not touched.intersection(face) or _quality(vertices, face) > 1e-3: continue
            k = max(range(3), key=lambda j: math.dist(vertices[face[j]], vertices[face[(j + 1) % 3]]))
            a, b, c = face[k], face[(k + 1) % 3], face[(k + 2) % 3]
            other = owner.get((b, a))
            if other is None or len(result[other]) != 3: continue
            d = next(v for v in result[other] if v not in (a, b))
            one, two = (a, d, c), (d, b, c)
            if min(_quality(vertices, one), _quality(vertices, two)) <= _quality(vertices, face): continue
            result[index], result[other] = one, two
            flipped = True
            owner = {}
            for j, f in enumerate(result):
                if len(f) == 3:
                    for p, q in zip(f, f[1:] + f[:1]): owner[(p, q)] = j
        if not flipped: break
    return result


def eye_hole(vertices, faces, center, eye_radius, margin=6, clearance=.0005, blend=None, max_edge=None, socket=25, lining_gap=.0001,
             lining_rings=5, corner_margin=2, bevel=.5, **lid_options):
    """Open a skin's eye hole that meets the lids all the way round, so no view looks past the lids into the head.

    Pass the same `lid_options` (opening, meet, wide, ...) as to `build_eye`: this
    builds the same `lid_geometry` and shapes the skin around it, in three steps.

    1. Socket: the skin around the eye is reshaped along each direction from the
       eye center so that, at the window's edge, it lies just outside the lids (at
       their outer radius plus `clearance`). Skin nearer the center is pushed out (a
       mound, blended over `blend`, default 0.2 eyeball radii), so the lids never poke
       out of the skin and their ends stay hidden; skin farther out is drawn in over
       `socket` degrees around the window (a socket dip, fading out by 3.2 eyeball
       radii from the center), so the hole's rim hugs the lids instead of opening a
       deep funnel where the face lies far in front of the eye (beside the nose).
       Edges near the eye are first split to at most `max_edge` (default 0.2
       eyeball radii) so the surface stays smooth; smaller values smooth it more
       but every vertex costs a delta in every morph target (file size, E8).
    2. Window: the skin is clipped (exactly, like `cut_hole`) along the cone of
       directions `eye_window(lids, margin, corner_margin)`: the lid opening plus every
       edge's travel, `margin` degrees wider (`corner_margin` at the corners, so no
       pocket opens beside the inner corner). The lids cover every other direction inside it.
    3. Wall and lining: from every rim vertex, a skin wall runs straight toward the
       eye center, through the lids (which slide through it), to just inside the
       nearest any lid vertex ever comes (`lining_gap` under the upper lid above the
       meet line, under the lower lid below it). There it turns into a lining that
       wraps the eyeball, under the lids, to a pole behind it. The lining seals the
       gap between the lids and the eyeball, so a ray that enters the window meets
       only lids, eyeball, wall or lining, never the head's inside; and because it
       stays just under the lids, a front view still sees the eyeball up to the
       lids' edges, however wide they open. The wall and lining share the rim's
       vertices, so skin morphs (brows, cheeks) move them with the skin and no crack
       can open. No dark socket cup is needed: `build_eye(..., hole=...)` leaves it out.
       A `bevel` ring (a fraction of the way down to the lids, at most 0.06 eyeball
       radii at the default 0.5) leaves each rim vertex half way between the skin's
       slope and the wall's, so the rim turns into the wall over two gentle folds and
       `join_face_parts` marks no hard seam round the eye (0 gives the right angle).

    Call it once per eye on the head blank, before `slit_mouth` and any shape keys,
    and pass the result to `build_eye` as `hole`. Skin shapes near the eyes (brows,
    cheeks) must leave the rim, wall and lining still: pass
    `mask=eye_hole_mask(*holes)` to their `soft_offset`/`symmetric_offsets` (the
    arkit-face/1 verifier's inversion and oblique checks fail a brow that drags the
    rim over its wall). Returns {'vertices', 'faces',
    'lids' (the lid geometry build_eye reuses), 'window', 'rim' (rim vertex indices),
    'wall' (wall and lining face indices), 'pushed' (vertices moved out),
    'rim_radius' (nearest and farthest rim vertex from the eye center), 'lining'
    (the lining's radii under the lower and upper lid), 'mound' (the rim's radius
    where the skin was reshaped), 'bevel' (the bevel ring's vertex indices)}.
    """
    center = _vector(center, 3, 'Eye center')
    eye_radius = _number(eye_radius, 'Eyeball radius', 0, low_open=True)
    lids = lid_geometry(center, eye_radius, **lid_options)
    window = eye_window(lids, margin, corner_margin)
    bevel = _number(bevel, 'Bevel', 0, 1)
    clearance = _number(clearance, 'Clearance', 0)
    blend = .2 * eye_radius if blend is None else _number(blend, 'Mound blend', 0, low_open=True)
    max_edge = .2 * eye_radius if max_edge is None else _number(max_edge, 'Maximum edge', 0, low_open=True)
    socket = _number(socket, 'Socket band', 0, 90)
    outer = lids['upper_radius'] + lids['thickness']
    push = outer + clearance
    reach, far, depth = push + blend + 2 * max_edge, 3.2 * eye_radius, 1.25 * (push + blend / 4)
    level = window['level']
    near = lambda p: math.dist(p, center) < reach or (math.dist(p, center) < far and level(p) < socket)
    points, polygons = _refine(vertices, faces, near, max_edge)
    pushed = 0
    for i, point in enumerate(points):
        d = _sub(point, center)
        r = math.hypot(*d)
        if r < 1e-12: continue
        target = r
        if r < push + blend:
            # A smooth maximum of r and the mound radius: unchanged beyond the blend, never inside the lids.
            h = max(blend - abs(r - push), 0.0) / blend
            target = max(r, push) + h * h * blend / 4
        elif socket > 0 and depth < r < far:
            # Draw far skin in toward `depth` near the window, fading out with angle and distance: the rim stays
            # within a quarter of the mound radius beyond it, and skin already that close is left alone.
            pull = (1 - _smoothstep(0, socket, max(0.0, level(point)))) * (1 - _smoothstep(.75 * far, far, r))
            target = r - (r - depth) * pull
        if target != r:
            points[i] = _add(center, _mul(d, target / r))
            pushed += 1
    # Pushing skin that ran inside the lids out onto the mound stretches its edges: split them again, and keep each
    # new midpoint (on a chord of the shaped skin) out of the lids.
    for _ in range(6):
        count = len(points)
        points, polygons = _refine(points, polygons, near, max_edge, rounds=1)
        if len(points) == count: break
        for i in range(count, len(points)):
            d = _sub(points[i], center)
            r = math.hypot(*d)
            if 1e-12 < r < push: points[i] = _add(center, _mul(d, push / r))
    cut = _clip(points, polygons, window['level'], snap=.15)
    result = list(cut['vertices'])
    rim = set(cut['boundary'])
    kept = _tidy(result, cut['faces'], rim)
    directed = {}
    for face in kept:
        for a, b in zip(face, face[1:] + face[:1]): directed[(a, b)] = directed.get((a, b), 0) + 1
    edges = [(a, b) for (a, b), n in directed.items() if n == 1 and (b, a) not in directed and a in rim and b in rim]
    if len(edges) < 8: raise ValueError('The skin does not surround this eye: place the eye center behind the skin')
    radii = [math.dist(result[i], center) for i in rim]
    if min(radii) < outer + clearance / 2:
        raise ValueError(f'The skin rim comes within {min(radii) * 1000:.2f} mm of the eye center, inside the lids ({outer * 1000:.2f} mm): lower max_edge')
    # The lining runs just inside the nearest a lid vertex comes outside the window, over every blink, squint and wide
    # mix (the weight cube's corners and points along every edge and diagonal between them).
    gap = _number(lining_gap, 'Lining gap', 0)
    rings = _count(lining_rings, 'Lining rings', 2)
    half = len(lids['vertices']) // 2
    corners = [(b, q, w) for b in (0, 1) for q in (0, 1) for w in (0, 1)]
    mixes = list(corners) + [tuple(a[k] + t * (c[k] - a[k]) for k in range(3)) for i, a in enumerate(corners) for c in corners[i + 1:] for t in (.25, .5, .75)]
    morphs = [lids['morphs'][m] for m in ('blink', 'squint', 'wide')]
    reach = {'upper': math.inf, 'lower': math.inf}
    for index, rest in enumerate(lids['vertices']):
        key = 'upper' if index < half else 'lower'
        deltas = [_sub(m[index], rest) for m in morphs]
        for weights in mixes:
            point = rest
            for w, delta in zip(weights, deltas):
                if w: point = _add(point, _mul(delta, w))
            if window['level'](point) >= 0: reach[key] = min(reach[key], math.dist(point, center))
    floor = eye_radius + clearance / 2
    reach = {key: value if math.isfinite(value) else outer for key, value in reach.items()}
    lining = {key: max(floor, value - gap) for key, value in reach.items()}
    meet = lids['meet']

    def radius_at(direction):
        elevation = math.degrees(math.asin(max(-1.0, min(1.0, direction[2]))))
        # The lower lid never rises above the meet line outside the window; the upper lid covers everything above it.
        return lining['lower'] + (lining['upper'] - lining['lower']) * _smoothstep(meet, meet + 6, elevation)

    back = (0.0, 1.0, 0.0)
    ladders = {}
    # Each rim vertex's skin neighbours (off the rim): the bevel continues the skin's slope half way into the wall.
    neighbours = {}
    for face in kept:
        for a, b in zip(face, face[1:] + face[:1]):
            if a in rim and b not in rim: neighbours.setdefault(a, set()).add(b)
            if b in rim and a not in rim: neighbours.setdefault(b, set()).add(a)
    along = {}
    for a, b in edges:
        along[a] = along.get(a, ()) + (b,)
        along[b] = along.get(b, ()) + (a,)
    bevels = []

    def ladder(i):
        """Rim vertex i's bevel, its wall end, then its lining rings toward the pole behind the eye."""
        if i not in ladders:
            d = _sub(result[i], center)
            r = math.hypot(*d)
            d = _mul(d, 1 / r)
            # The bevel rounds the rim into the wall: it leaves the rim half way between the skin's slope and the wall's
            # (straight at the eye center), so the skin turns into the wall over two gentle folds, not one right angle.
            size = bevel * min(max(0.0, r - outer), .12 * eye_radius)
            slope = (0.0, 0.0, 0.0)
            for j in (i,) + along.get(i, ()):
                around = [result[k] for k in neighbours.get(j, ())]
                if around:
                    step = _sub(result[j], _mul(tuple(map(sum, zip(*around))), 1 / len(around)))
                    slope = _add(slope, _mul(step, 1 / (math.hypot(*step) or 1)))
            slope = _mul(slope, 1 / math.hypot(*slope)) if math.hypot(*slope) > 1e-12 else _mul(d, -1)
            way = _sub(slope, d)
            way = _mul(way, 1 / (math.hypot(*way) or 1))
            steps = []
            if size > 1e-9:
                point = _add(result[i], _mul(way, size))
                if math.dist(point, center) < outer: point = _add(center, _mul(_sub(point, center), outer / math.dist(point, center)))
                bevels.append(len(result))
                steps.append(len(result))
                result.append(point)
            for k in range(rings):
                t = k / rings
                direction = _add(_mul(d, 1 - t), _mul(back, t))
                direction = _mul(direction, 1 / math.hypot(*direction))
                steps.append(len(result))
                result.append(_add(center, _mul(direction, radius_at(direction))))
            ladders[i] = steps
        return ladders[i]

    pole = len(result)
    result.append(_add(center, _mul(back, radius_at(back))))
    wall = []
    for a, b in edges:
        steps_a, steps_b = ladder(a), ladder(b)
        wall.append(len(kept)); kept.append((b, a, steps_a[0], steps_b[0]))
        for k in range(min(len(steps_a), len(steps_b)) - 1):
            wall.append(len(kept)); kept.append((steps_b[k], steps_a[k], steps_a[k + 1], steps_b[k + 1]))
        wall.append(len(kept)); kept.append((steps_b[-1], steps_a[-1], pole))
    return {'vertices': result, 'faces': kept, 'lids': lids, 'window': window, 'rim': sorted(rim), 'wall': wall,
            'pushed': pushed, 'rim_radius': (min(radii), max(radii)), 'lining': (lining['lower'], lining['upper']),
            'mound': push + blend / 4, 'socket': socket, 'bevel': bevels}


def shutter_hole(vertices, faces, center, eye_radius, hole_radius=None, max_edge=None, cap_rings=5, **shutter_options):
    """Open a robot's eye hole in a face plate and seal it: a tube straight back from the rim, capped behind the eye.

    For shutter eyes recessed behind a flat face (`shutter_geometry`): the skin in
    front of the eye center within `hole_radius` of the gaze axis (default: the
    blades' half-width, capped at 1.12 eyeball radii) is clipped away exactly, the
    rim runs straight back along the gaze axis to the eye center's depth (a tube in
    the face's material, which the blades slide through), and a cap of that radius
    closes it behind the eyeball. The skin stays one closed surface, so no view
    through the hole finds the head's inside (the round-3 Bolt's single-layer tin
    showed it below the shutters). Then it builds `shutter_geometry(center,
    eye_radius, surface=...)` against the holed face, which rejects blades that
    would slide out through the plate. Pass `shutter_options` as you would to
    `build_eye(style='shutter')`, and the result to `build_eye(..., style='shutter',
    hole=...)`. Returns {'vertices', 'faces', 'lids' (the shutter geometry),
    'rim', 'wall' (tube and cap face indices), 'radius'}.
    """
    center = _vector(center, 3, 'Eye center')
    eye_radius = _number(eye_radius, 'Eyeball radius', 0, low_open=True)
    cx, cy, cz = center
    aperture = shutter_options.get('aperture')
    half = 1.1 * eye_radius if aperture is None else _number(aperture, 'Aperture half-width', 0, low_open=True)
    radius = min(half, 1.12 * eye_radius) if hole_radius is None else _number(hole_radius, 'Hole radius', 0, low_open=True)
    if radius <= eye_radius: raise ValueError('The hole must be wider than the eyeball')
    max_edge = .2 * eye_radius if max_edge is None else _number(max_edge, 'Maximum edge', 0, low_open=True)
    cap_rings = _count(cap_rings, 'Cap rings', 2)
    level = lambda p: max(math.hypot(p[0] - cx, p[2] - cz) - radius, p[1] - cy)
    near = lambda p: p[1] < cy and abs(math.hypot(p[0] - cx, p[2] - cz) - radius) < radius
    points, polygons = _refine(vertices, faces, near, max_edge)
    cut = _clip(points, polygons, level, snap=.15)
    result = list(cut['vertices'])
    rim = set(cut['boundary'])
    kept = _tidy(result, cut['faces'], rim)
    directed = {}
    for face in kept:
        for a, b in zip(face, face[1:] + face[:1]): directed[(a, b)] = directed.get((a, b), 0) + 1
    edges = [(a, b) for (a, b), n in directed.items() if n == 1 and (b, a) not in directed and a in rim and b in rim]
    if len(edges) < 8: raise ValueError('The skin does not cover this eye: place the eye center behind the face plate')
    if max(result[i][1] for i in rim) > cy - eye_radius:
        raise ValueError('The face plate must stand at least one eyeball radius in front of the eye center: recess the eye')
    back = (0.0, 1.0, 0.0)
    ladders = {}

    def ladder(i):
        """Rim vertex i's tube end at the eye center's depth, then its cap rings toward the pole behind the eye."""
        if i not in ladders:
            x, _, z = result[i]
            d = (x - cx, 0.0, z - cz)
            r = math.hypot(*d)
            d = _mul(d, 1 / r)
            steps = []
            for k in range(cap_rings):
                t = k / cap_rings
                direction = _add(_mul(d, 1 - t), _mul(back, t))
                steps.append(len(result))
                result.append(_add(center, _mul(direction, r / math.hypot(*direction))))
            ladders[i] = steps
        return ladders[i]

    pole = len(result)
    result.append(_add(center, _mul(back, radius)))
    wall = []
    for a, b in edges:
        steps_a, steps_b = ladder(a), ladder(b)
        wall.append(len(kept)); kept.append((b, a, steps_a[0], steps_b[0]))
        for k in range(cap_rings - 1):
            wall.append(len(kept)); kept.append((steps_b[k], steps_a[k], steps_a[k + 1], steps_b[k + 1]))
        wall.append(len(kept)); kept.append((steps_b[-1], steps_a[-1], pole))
    options = dict(shutter_options)
    options.setdefault('surface', front_surface(result, kept))
    blades = shutter_geometry(center, eye_radius, **options)
    return {'vertices': result, 'faces': kept, 'lids': blades, 'rim': sorted(rim), 'wall': wall, 'radius': radius}


def eye_hole_mask(*holes, band=None):
    """A `soft_offset` mask that keeps every `eye_hole` rim, wall and lining still and fades in away from them.

    For each hole the weight is 0 on the rim and inside the skin (the wall and
    lining lie inside the mound radius), and rises smoothly to 1 over `band` degrees
    (default: the hole's socket band) outside its window and over half an eyeball
    radius beyond the mound. The mask is the product over all holes. Pass it as
    `symmetric_offsets(..., mask=eye_hole_mask(*holes))` for brows, cheeks and any
    skin shape that reaches an eye.
    """
    parts = []
    for hole in holes:
        level, center = hole['window']['level'], _vector(hole['lids']['center'], 3, 'Eye center')
        mound, reach = hole['mound'], hole['socket'] if band is None else _number(band, 'Mask band', 0, low_open=True)
        radius = hole['lids']['eye_radius']
        parts.append((level, center, mound, max(reach, 1.0), .5 * radius))

    def mask(vertex):
        weight = 1.0
        for level, center, mound, reach, blend in parts:
            # Zero within 2 degrees of the window, where the rim and its wall lie (the clip snaps them up to that far out).
            weight *= _smoothstep(2, reach, level(vertex)) * _smoothstep(mound - 1e-6, mound + blend, math.dist(vertex, center))
            if weight == 0: break
        return weight
    return mask


# ---------------------------------------------------------------- jaw and mouth

class JawHinge:
    """The `jawOpen` motion shared by every mesh the jaw carries: a puppet jaw hinged by the ears.

    A vertex's morph target is its position turned by `angle * weight` degrees about
    `axis` through `pivot`, then lowered by `drop * weight` (positive opens: the chin
    swings down). Put the pivot where a puppet's jaw hinges: at the back of the head,
    level with the mouth line (by the ears). `JawHinge.ear` places it from the head
    mesh. A hinge in the middle of the head swings the chin back and up and only
    opens a hole at the lips; the chin has to be well in front of the pivot to drop.

    Morphs are linear, so a turn alone opens the lips about twice as far as it drops
    the chin (the lips are twice as far from an ear hinge). `drop` adds a straight
    downward slide of the whole jaw, which lowers the chin as much as the lips. It
    fades to zero over `drop_reach` in front of the pivot (None: no fade), so the
    back of the head stays near the hinge. Rigid parts always take the full drop.

    `weight(p)` is 0 on and above the mouth line and reaches 1 `band` below it, so
    the chin and lower face move as one. On the lower lip itself it follows the
    mouth's shape, (1 - (x / half_width)^2) ** `lip_round` (1 at the middle, 0 at the
    corners), so the lips part in a rounded D instead of a box, and beyond the
    corners it fades in over the band: the cheeks stretch smoothly.
    `slit_back` (a y) ends the slit toward the back: behind it the lip shape fades
    out over the band and the weight fades in over the band like beyond the corners, so the back of the head, which has no
    slit, stretches smoothly instead of creasing along the mouth line.
    A vertex within `SEAM_TOLERANCE` of the line counts as on it, so float32 rounding
    of the seam never decides which lip opens: `slit_mouth` tags the lower-lip seam
    explicitly and `add_jaw_open` passes those tags as `lower_lip`. `back_band` (0 is
    off) fades the weight out behind the pivot for heads that continue behind the
    hinge. `mask(p)` optionally scales the weight (for a neck that must stay put).
    Rigid parts (lower teeth, tongue, a robot chin plate) pass `weight=1`.
    """

    def __init__(self, pivot, angle=8, mouth_z=0.0, half_width=.02, lip_round=.75, band=.03, back_band=0, drop=0.0,
                 drop_reach=None, slit_back=None, axis=(1, 0, 0), mask=None):
        self.pivot = _vector(pivot, 3, 'Jaw pivot')
        self.angle = _number(angle, 'Jaw angle', 0, 30)
        self.drop = _number(drop, 'Jaw drop', 0)
        if self.angle == 0 and self.drop == 0: raise ValueError('The jaw needs an angle or a drop')
        self.drop_reach = None if drop_reach is None else _number(drop_reach, 'Drop reach', 0, low_open=True)
        self.slit_back = None if slit_back is None else _number(slit_back, 'Slit back')
        self.mouth_z = _number(mouth_z, 'Mouth line')
        self.half_width = _number(half_width, 'Mouth half-width', 0, low_open=True)
        self.lip_round = _number(lip_round, 'Lip roundness', 0, 4)
        self.band = _number(band, 'Falloff band', 0)
        self.back_band = _number(back_band, 'Back falloff', 0)
        if mask is not None and not callable(mask): raise ValueError('Jaw mask must be a function of the vertex')
        self.mask = mask
        axis = _vector(axis, 3, 'Jaw axis')
        length = math.hypot(*axis)
        if length < 1e-9: raise ValueError('Jaw axis must not be zero')
        self.axis = _mul(axis, 1 / length)

    @classmethod
    def ear(cls, vertices, mouth_z, half_width, center_x=0.0, angle=8, drop=None, drop_reach=None, inset=None, lift=0.0, **options):
        """A puppet jaw hinged at the back of the head, level with the mouth line, sized from the head's vertices.

        The pivot sits `inset` (default 10% of the head depth at the mouth line) in
        front of the back of the head, `lift` above the mouth line. `drop` defaults to
        9% of the head height, which with the default 8 degree turn lowers the chin by
        10-15% of the head height; `drop_reach` defaults to half the way from the
        pivot to the face, and `slit_back` to the middle of the head (where `slit_mouth`
        ends the slit by default). Other options go to `JawHinge`.
        """
        vertices = [_vector(v, 3, 'Vertex') for v in vertices]
        if not vertices: raise ValueError('JawHinge.ear needs the head vertices')
        mouth_z = _number(mouth_z, 'Mouth line')
        zs = [v[2] for v in vertices]
        height = max(zs) - min(zs)
        xs = [v[0] for v in vertices]
        width = max(xs) - min(xs)
        near = [v for v in vertices if abs(v[2] - mouth_z) <= .06 * height and abs(v[0] - center_x) <= .15 * width]
        if not near: raise ValueError('No head vertices near the mouth line')
        back, front = max(v[1] for v in near), min(v[1] for v in near)
        depth = back - front
        inset = .1 * depth if inset is None else _number(inset, 'Hinge inset', 0)
        pivot = (center_x, back - inset, mouth_z + _number(lift, 'Hinge lift'))
        drop = .09 * height if drop is None else drop
        drop_reach = .5 * (pivot[1] - front) if drop_reach is None else drop_reach
        options.setdefault('slit_back', (front + back) / 2)
        return cls(pivot, angle=angle, mouth_z=mouth_z, half_width=half_width, drop=drop, drop_reach=drop_reach, **options)

    def weight(self, point, lower_lip=False):
        x, y, z = point
        below = self.mouth_z - z
        if lower_lip: below = max(below, 2 * SEAM_TOLERANCE)
        elif below <= SEAM_TOLERANCE: return 0.0
        across = (x - self.pivot[0]) / self.half_width
        lip = (1 - across * across) ** self.lip_round if abs(across) < 1 else 0.0
        if self.slit_back is not None and y > self.slit_back:
            lip *= 0.0 if self.band <= 0 else 1 - _smoothstep(0, self.band, y - self.slit_back)
        fade = 1.0 if self.band <= 0 else _smoothstep(0, self.band, below)
        vertical = 1 - (1 - lip) * (1 - fade)
        behind = y - self.pivot[1]
        back = 1.0 if self.back_band <= 0 else 1.0 - _smoothstep(0, self.back_band, behind)
        result = vertical * back
        if self.mask is not None and result > 0: result *= _number(self.mask(point), 'Jaw mask', 0, 1)
        return result

    def rotate(self, point, weight=1.0):
        """`point` turned by `angle * weight` degrees about the hinge (no drop)."""
        theta = math.radians(self.angle * weight)
        if theta == 0: return tuple(point)
        v, k = _sub(point, self.pivot), self.axis
        c, s = math.cos(theta), math.sin(theta)
        rotated = _add(_add(_mul(v, c), _mul(_cross(k, v), s)), _mul(k, _dot(k, v) * (1 - c)))
        return _add(self.pivot, rotated)

    def move(self, point, weight=1.0, rigid=False):
        """`point` at jawOpen = 1 for jaw weight `weight`: turned about the hinge, then lowered by the drop."""
        moved = self.rotate(point, weight)
        if self.drop:
            reach = 1.0 if rigid or self.drop_reach is None else _smoothstep(0, self.drop_reach, self.pivot[1] - point[1])
            moved = (moved[0], moved[1], moved[2] - self.drop * weight * reach)
        return moved

    def targets(self, vertices, weight=None, lower_lip=()):
        """Morph targets for `vertices`.

        weight None uses `self.weight`, with the vertex indices in `lower_lip` (the
        tagged lower-lip seam) counted below the mouth line; a number (1 for rigid
        parts), callable or per-vertex list overrides it.
        """
        vertices = [_vector(v, 3, 'Vertex') for v in vertices]
        rigid = False
        if weight is None:
            tagged = set(lower_lip)
            weights = [self.weight(v, i in tagged) for i, v in enumerate(vertices)]
        elif callable(weight): weights = [_number(weight(v), 'Jaw weight', 0, 1) for v in vertices]
        elif isinstance(weight, Real) and not isinstance(weight, bool):
            weights = [_number(weight, 'Jaw weight', 0, 1)] * len(vertices)
            rigid = True
        else:
            weights = [_number(w, 'Jaw weight', 0, 1) for w in weight]
            if len(weights) != len(vertices): raise ValueError('Jaw weights need one value per vertex')
        return [self.move(v, w, rigid) if w > 0 else v for v, w in zip(vertices, weights)]


def chin_drop(rest, targets):
    """How far the lowest point (the chin) drops between rest and target positions: {'drop', 'height', 'ratio'}.

    `height` is the rest height (lowest to highest point) and `ratio` = drop / height;
    the talking-heads bar wants a puppet jaw's chin to drop by at least 0.1 of the
    head. A negative drop means the lowest point rises.
    """
    rest, targets = list(rest), list(targets)
    if len(rest) != len(targets) or not rest: raise ValueError('Morph topology mismatch')
    low, high = min(v[2] for v in rest), max(v[2] for v in rest)
    drop = low - min(v[2] for v in targets)
    height = high - low
    return {'drop': round(drop, 9), 'height': round(height, 9), 'ratio': round(drop / height, 9) if height > 0 else 0.0}


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


def mouth_cavity_geometry(center, width, height, depth, rings=8, segments=32, surface=None, inset=.004):
    """A dark half-ellipsoid bag behind the lips, open to the front, so an open mouth never sees through the head.

    `center` is the middle of the front rim. The bag reaches `depth` back (+Y). Its
    faces point into the bag; give it a dark, double-sided material and tuck the rim
    just behind the lips. `rim` lists the front-rim vertex indices.

    On a curved face a flat rim behind the middle of the mouth pokes out through the
    cheeks at the corners. Pass `surface`, the skin's front as a function (x, z) -> y
    (`front_surface(skin_vertices, skin_faces)`), and the rim follows the skin `inset`
    behind it; every other vertex is kept at least `inset` behind the skin too. The
    bag's back is then `depth` behind `center`.
    """
    cx, cy, cz = _vector(center, 3, 'Cavity center')
    w = _number(width, 'Cavity width', 0, low_open=True) / 2
    h = _number(height, 'Cavity height', 0, low_open=True) / 2
    d = _number(depth, 'Cavity depth', 0, low_open=True)
    rings, segments = _count(rings, 'Cavity rings', 2), _count(segments, 'Cavity segments', 8)
    if surface is not None and not callable(surface): raise ValueError('surface must be a function (x, z) -> y, such as front_surface(...)')
    inset = _number(inset, 'Cavity inset', 0)
    back = cy + d
    vertices = []
    for k in range(rings):
        polar = math.pi / 2 * k / rings
        for j in range(segments):
            a = math.tau * j / segments
            x, z = cx + w * math.cos(polar) * math.cos(a), cz + h * math.cos(polar) * math.sin(a)
            front = cy
            if surface is not None:
                rim_x, rim_z = cx + w * math.cos(a), cz + h * math.sin(a)
                skin = surface(rim_x, rim_z)
                front = cy if skin is None else skin + inset
            # Near the rim the walls lean forward instead of running edge-on to the view, so renderers do not leak
            # MSAA samples of the dark bag through the skin in front of it.
            y = front + (back - front) * math.sin(polar) ** 2
            if surface is not None:
                skin = surface(x, z)
                if skin is not None: y = max(y, skin + inset)
            vertices.append((x, y, z))
    vertices.append((cx, back, cz))
    if surface is not None and any(v[1] >= back for v in vertices[:-1]): raise ValueError('The cavity is too shallow for this face: raise depth')
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


# ---------------------------------------------------------------- parts attached to the skin

# A part joined to the face touches the skin when every slice across its length comes this close (the verifier's
# `attached-parts` check uses the same tolerance).
ATTACH_TOLERANCE = .0005


def _closest_on_triangle(p, a, b, c):
    """The point of triangle abc nearest to p and its barycentric weights (wa, wb, wc)."""
    ab, ac, ap = _sub(b, a), _sub(c, a), _sub(p, a)
    d1, d2 = _dot(ab, ap), _dot(ac, ap)
    if d1 <= 0 and d2 <= 0: return a, (1.0, 0.0, 0.0)
    bp = _sub(p, b)
    d3, d4 = _dot(ab, bp), _dot(ac, bp)
    if d3 >= 0 and d4 <= d3: return b, (0.0, 1.0, 0.0)
    vc = d1 * d4 - d3 * d2
    if vc <= 0 and d1 >= 0 and d3 <= 0:
        v = d1 / (d1 - d3)
        return _add(a, _mul(ab, v)), (1 - v, v, 0.0)
    cp = _sub(p, c)
    d5, d6 = _dot(ab, cp), _dot(ac, cp)
    if d6 >= 0 and d5 <= d6: return c, (0.0, 0.0, 1.0)
    vb = d5 * d2 - d1 * d6
    if vb <= 0 and d2 >= 0 and d6 <= 0:
        w = d2 / (d2 - d6)
        return _add(a, _mul(ac, w)), (1 - w, 0.0, w)
    va = d3 * d6 - d5 * d4
    if va <= 0 and d4 - d3 >= 0 and d5 - d6 >= 0:
        w = (d4 - d3) / ((d4 - d3) + (d5 - d6))
        return _add(b, _mul(_sub(c, b), w)), (0.0, 1 - w, w)
    denominator = 1 / (va + vb + vc)
    v, w = vb * denominator, vc * denominator
    return _add(a, _add(_mul(ab, v), _mul(ac, w))), (1 - v - w, v, w)


class _SkinIndex:
    """Nearest-point queries on a skin's triangles through a uniform grid (outward normals give the sign)."""

    def __init__(self, vertices, faces, near=None, cell=.003):
        self.vertices = [tuple(v) for v in vertices]
        self.cell = cell
        self.triangles, self.normals, self.grid = [], [], {}
        for face in faces:
            for k in range(1, len(face) - 1):
                tri = (face[0], face[k], face[k + 1])
                points = [self.vertices[i] for i in tri]
                if near is not None and not any(near(p) for p in points): continue
                normal = _cross(_sub(points[1], points[0]), _sub(points[2], points[0]))
                length = math.hypot(*normal)
                if length < 1e-18: continue
                index = len(self.triangles)
                self.triangles.append(tri)
                self.normals.append(_mul(normal, 1 / length))
                lo = [math.floor(min(p[k] for p in points) / cell) for k in range(3)]
                hi = [math.floor(max(p[k] for p in points) / cell) for k in range(3)]
                for i in range(lo[0], hi[0] + 1):
                    for j in range(lo[1], hi[1] + 1):
                        for k in range(lo[2], hi[2] + 1): self.grid.setdefault((i, j, k), []).append(index)

    def nearest(self, point, limit=.012):
        """(signed distance, nearest point, triangle, barycentric weights), or None beyond `limit`."""
        vertices = self.vertices
        c = [math.floor(point[k] / self.cell) for k in range(3)]
        best, seen = None, set()
        for ring in range(int(limit / self.cell) + 2):
            if best is not None and best[0] <= (ring - 1) * self.cell: break
            for i in range(c[0] - ring, c[0] + ring + 1):
                for j in range(c[1] - ring, c[1] + ring + 1):
                    edge = abs(i - c[0]) == ring or abs(j - c[1]) == ring
                    for k in (range(c[2] - ring, c[2] + ring + 1) if edge else (c[2] - ring, c[2] + ring)):
                        for index in self.grid.get((i, j, k), ()):
                            if index in seen: continue
                            seen.add(index)
                            a, b, cc = (vertices[v] for v in self.triangles[index])
                            q, weights = _closest_on_triangle(point, a, b, cc)
                            d = math.dist(point, q)
                            if best is None or d < best[0]: best = (d, q, index, weights)
        if best is None or best[0] > limit: return None
        d, q, index, weights = best
        return (-d if _dot(_sub(point, q), self.normals[index]) < 0 else d), q, index, weights

    def normal(self, index): return self.normals[index]


def _skin_data(skin):
    """(vertices, faces, morphs) from a geometry dict or a Blender mesh object (world space, shape keys as targets)."""
    if isinstance(skin, dict):
        return [_vector(v, 3, 'Skin vertex') for v in skin['vertices']], [tuple(f) for f in skin['faces']], dict(skin.get('morphs') or {})
    data = getattr(skin, 'data', None)
    if data is None or not hasattr(data, 'vertices'): raise ValueError('skin must be a geometry dict (vertices, faces, morphs) or a Blender mesh object')
    world = skin.matrix_world
    vertices = [tuple(world @ v.co) for v in data.vertices]
    faces = [tuple(p.vertices) for p in data.polygons]
    keys = data.shape_keys
    morphs = {block.name: [tuple(world @ point.co) for point in block.data] for block in keys.key_blocks[1:]} if keys else {}
    return vertices, faces, morphs


def _near_box(points, margin):
    lo = [min(p[k] for p in points) - margin for k in range(3)]
    hi = [max(p[k] for p in points) + margin for k in range(3)]
    return lambda p: all(lo[k] <= p[k] <= hi[k] for k in range(3))


def skin_contact(part, skin, tolerance=ATTACH_TOLERANCE, slices=None):
    """How a part sits on a skin, at rest and at each morph at weight 1, as the arkit-face/1 verifier judges it.

    `part` is a geometry dict (vertices, faces, optional morphs); `skin` a geometry
    dict (vertices, faces, optional morphs) or a Blender mesh object with its shape
    keys. The part's vertices and face centers are cut into `slices` (default one per
    1.5 mm, at most 32) across its longest axis, each placed by its footprint (its
    nearest skin point), so a thick ridge's top shares a slice with its base; each slice's gap is the smallest
    signed distance from its points to the skin (negative inside). The part touches
    when every slice comes within `tolerance`. `visible` is the share of its points
    outside the skin; a morph that leaves much less than at rest buries the part.
    Poses: rest, the part's own morphs and every skin morph that moves the skin near
    it. Returns {'gap', 'floating', 'slices', 'visible', 'poses': {name: {'gap',
    'floating', 'visible'}}}, gaps in meters.
    """
    vertices = [_vector(v, 3, 'Part vertex') for v in part['vertices']]
    faces = [tuple(f) for f in part['faces']]
    own = dict(part.get('morphs') or {})
    skin_vertices, skin_faces, skin_morphs = _skin_data(skin)
    near = _near_box(vertices, .03)
    index = _SkinIndex(skin_vertices, skin_faces, near=near)
    # Sample points: every vertex and the center of every fan triangle, as barycentric (a, b, c, wa, wb, wc).
    samples = [(i, i, i, 1.0, 0.0, 0.0) for i in range(len(vertices))]
    for face in faces:
        for k in range(1, len(face) - 1): samples.append((face[0], face[k], face[k + 1], 1 / 3, 1 / 3, 1 / 3))
    at = lambda points, s: tuple(s[3] * points[s[0]][k] + s[4] * points[s[1]][k] + s[5] * points[s[2]][k] for k in range(3))
    rest = [at(vertices, s) for s in samples]
    # Slice by footprint (each sample's nearest skin point), as the verifier does: the top of a thick ridge curved round
    # a dome then shares its slice with the base under it.
    hits = [index.nearest(p) for p in rest]
    rest = [p if hit is None else hit[1] for p, hit in zip(rest, hits)]
    mean = tuple(sum(p[k] for p in rest) / len(rest) for k in range(3))
    cov = [[sum((p[r] - mean[r]) * (p[c] - mean[c]) for p in rest) for c in range(3)] for r in range(3)]
    axis = (1.0, 1.0, 1.0)
    for _ in range(50):
        nxt = tuple(sum(cov[r][c] * axis[c] for c in range(3)) for r in range(3))
        length = math.hypot(*nxt) or 1.0
        axis = _mul(nxt, 1 / length)
    along = [_dot(_sub(p, mean), axis) for p in rest]
    start, span = min(along), max(along) - min(along)
    count = _count(slices, 'Slices', 1) if slices is not None else min(32, max(1, math.ceil(span / .0015)))
    slice_of = [min(count - 1, int((t - start) / (span or 1) * count)) for t in along]

    def measure(points, index):
        low = [math.inf] * count
        outside = 0
        for n, s in enumerate(samples):
            hit = index.nearest(at(points, s))
            d = .012 if hit is None else hit[0]
            low[slice_of[n]] = min(low[slice_of[n]], d)
            outside += d > 0
        filled = [d for d in low if d < math.inf]
        return {'gap': max(0.0, max(filled)), 'floating': sum(d > tolerance for d in filled), 'visible': outside / len(samples)}

    result = measure(vertices, index)
    result.update(slices=count, poses={})
    moved_skin = lambda name: any(near(p) and math.dist(p, q) > 1e-7 for p, q in zip(skin_vertices, skin_morphs[name]))
    for name in list(own) + [n for n in skin_morphs if n not in own]:
        if name not in own and not moved_skin(name): continue
        points = [_vector(v, 3, 'Morph vertex') for v in own[name]] if name in own else vertices
        posed = _SkinIndex(skin_morphs[name], skin_faces, near=near) if name in skin_morphs else index
        result['poses'][name] = measure(points, posed)
    return result


def attach_to_skin(part, skin, depth=None, tolerance=ATTACH_TOLERANCE):
    """Seat a small part on the skin and make it follow the skin's morphs: nostrils, freckles, warts, horns, fins.

    `part` is a geometry dict (vertices, faces, optional morphs and materials) and
    `skin` the head skin: a geometry dict with its morphs, or the Blender mesh object
    after its shape keys are added (`slit_mouth`, `symmetric_offsets`, `add_jaw_open`).
    With `depth`, the part first moves along the skin's normal under its center so the
    center sits `depth` meters inside the skin (0 sinks half of a ball, a positive
    depth more; None keeps it where it is). Then every vertex takes the skin point
    nearest it at rest as its footprint, and for every skin morph that moves the skin
    there the part gets a target that moves each vertex by the skin's own delta at its
    footprint (interpolated across the skin triangle), on top of the part's own morph
    of the same name: a nostril rides noseSneer, a chin wart rides jawOpen. Returns a
    new geometry dict with `morphs` and `contact` (`skin_contact` of the result).
    Build the part, attach it, then `mesh_from_geometry` it and add its morphs with
    `shape_key` before `join_face_parts`.
    """
    vertices = [_vector(v, 3, 'Part vertex') for v in part['vertices']]
    if not vertices: raise ValueError('The part has no vertices')
    own = {name: [_vector(v, 3, 'Morph vertex') for v in targets] for name, targets in (part.get('morphs') or {}).items()}
    skin_vertices, skin_faces, skin_morphs = _skin_data(skin)
    index = _SkinIndex(skin_vertices, skin_faces, near=_near_box(vertices, .03))
    if depth is not None:
        depth = _number(depth, 'Depth')
        center = tuple(sum(v[k] for v in vertices) / len(vertices) for k in range(3))
        hit = index.nearest(center, limit=.03)
        if hit is None: raise ValueError('No skin within 30 mm of the part: place it on the head first')
        signed, _, triangle, _ = hit
        shift = _mul(index.normal(triangle), -depth - signed)
        vertices = [_add(v, shift) for v in vertices]
        own = {name: [_add(v, shift) for v in targets] for name, targets in own.items()}
    feet = []
    for v in vertices:
        hit = index.nearest(v, limit=.03)
        if hit is None: raise ValueError('A part vertex lies more than 30 mm from the skin: attach parts that sit on it')
        feet.append((index.triangles[hit[2]], hit[3]))
    morphs = dict(own)
    # A part laid on the skin in each skin pose already (skin_brow_geometry) lists those names in `laid`.
    laid = set(part.get('laid') or ())
    for name, targets in skin_morphs.items():
        if name in laid: continue
        deltas = [tuple(sum(w * (targets[i][k] - skin_vertices[i][k]) for i, w in zip(tri, weights)) for k in range(3)) for tri, weights in feet]
        if max(math.hypot(*d) for d in deltas) < 1e-6: continue
        base = own.get(name, vertices)
        morphs[name] = [_add(p, d) for p, d in zip(base, deltas)]
    result = dict(part, vertices=vertices, morphs=morphs)
    result['contact'] = skin_contact(result, skin, tolerance)
    return result


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


def _ellipsoid_distance(point, center, radii):
    """Approximate signed distance from a point to an axis-aligned ellipsoid (exact for a sphere; positive outside)."""
    d = _sub(point, center)
    k0 = math.hypot(*(d[k] / radii[k] for k in range(3)))
    k1 = math.hypot(*(d[k] / radii[k] ** 2 for k in range(3)))
    return -min(radii) if k1 < 1e-12 else k0 * (k0 - 1) / k1


def _shapes(shapes):
    result = []
    for shape in shapes:
        if isinstance(shape, dict): center, radii, blend = shape.get('center'), shape.get('radii'), shape.get('blend')
        else: (center, radii), blend = shape[:2], (shape[2] if len(shape) > 2 else None)
        center = _vector(center, 3, 'Shape center')
        radii = _vector((radii,) * 3 if isinstance(radii, Real) else radii, 3, 'Shape radii')
        if min(radii) <= 0: raise ValueError('Shape radii must be positive')
        blend = .5 * min(radii) if blend is None else _number(blend, 'Shape blend', 0)
        result.append((center, radii, blend))
    if not result: raise ValueError('sculpt_skin needs at least one shape')
    return result


def _union_height(point, direction, shapes):
    """How far along `direction` the smooth union of the skin (the plane through `point`) and the shapes lies."""
    def field(t):
        q = _add(point, _mul(direction, t))
        value = t
        for center, radii, blend in shapes:
            e = _ellipsoid_distance(q, center, radii)
            if blend <= 0: value = min(value, e); continue
            h = max(blend - abs(value - e), 0.0) / blend
            value = min(value, e) - h * h * blend / 4
        return value
    top = max(2 * max(radii) + blend for _, radii, blend in shapes) + max(math.dist(point, c) for c, _, _ in shapes)
    step = min(min(radii) for _, radii, _ in shapes) / 8
    # The outermost crossing: walk in from outside, then bisect.
    hi, lo = top, top
    while lo > 0:
        lo = max(0.0, hi - step)
        if field(lo) <= 0: break
        hi = lo
    else:
        return 0.0
    for _ in range(40):
        mid = (lo + hi) / 2
        if field(mid) <= 0: lo = mid
        else: hi = mid
    return lo


def sculpt_skin(vertices, faces, shapes, max_edge=None):
    """Grow soft forms out of a head blank: the smooth union of the skin and ellipsoids, sampled densely where they are.

    `shapes` is a list of (center, radii) or (center, radii, blend) tuples, or dicts
    with those keys: ellipsoids (radii one number or an (x, y, z) triple, Blender
    axes) that the skin swells over, joined to it with a rounded fillet about `blend`
    meters wide (default half the smallest radius), the way an SDF smooth union joins
    two shapes: cheeks, a chin, a brow bump, a snout, a nose ball (`nose_geometry`
    builds on it). The skin is first refined where the shapes are (edges at most
    `max_edge`, default a sixth of the smallest radius), so a form never comes out as
    one vertex pulled into a spike; then every vertex near a shape moves out along the
    skin's normal onto the union's surface. Vertices elsewhere keep their positions
    and indices (new ones are appended), so run it on the blank before `eye_hole`,
    `slit_mouth` and the shape keys. Returns vertices and faces (triangles near the
    shapes).
    """
    shapes = _shapes(shapes)
    vertices = [_vector(v, 3, 'Vertex') for v in vertices]
    max_edge = min(min(r) for _, r, _ in shapes) / 6 if max_edge is None else _number(max_edge, 'Max edge', 0, low_open=True)
    near = lambda v: any(math.hypot(*((v[k] - c[k]) / (r[k] + b) for k in range(3))) < 1.25 for c, r, b in shapes)
    vertices, faces = _refine(vertices, faces, near, max_edge)
    normals = _vertex_normals(vertices, faces)
    moved = [_add(v, _mul(n, _union_height(v, n, shapes))) if near(v) else v for v, n in zip(vertices, normals)]
    return {'vertices': moved, 'faces': faces}


def sculpt_lips(vertices, faces, mouth_z, half_width, center_x=0.0, fullness=None, crease=None, height=None, max_edge=None):
    """Shape soft lips with a lip line into a skin face at rest: the upper and a fuller lower lip either side of a crease.

    For skin faces (kids, creatures) whose closed mouth would otherwise be a flat
    surface with a slit. The lips span |x - center_x| < `half_width` (the slit's),
    thinning to nothing just past the corners; each is a soft bulge `fullness` proud
    along the skin's normal (default 9% of the half width; the lower lip 1.3 times
    that), `height` tall (default 45% of the half width), and a crease `crease` deep
    (default 60% of the fullness) runs along the mouth line between them, deepest in
    the middle. The skin is refined around the mouth first (edges at most `max_edge`,
    default a sixth of the height), so the lips are smooth. Run it on the blank
    (before `mesh_from_geometry`, `slit_mouth` and the shape keys, after `eye_hole`
    or `nose_geometry`), then take `front_surface` of the result for the cavity and
    teeth. Returns vertices and faces; far vertices keep their indices.
    """
    vertices = [_vector(v, 3, 'Vertex') for v in vertices]
    mouth_z, half_width = _number(mouth_z, 'Mouth line'), _number(half_width, 'Mouth half-width', 0, low_open=True)
    center_x = _number(center_x, 'Mouth center')
    fullness = .09 * half_width if fullness is None else _number(fullness, 'Lip fullness', 0)
    crease = .6 * fullness if crease is None else _number(crease, 'Lip crease', 0)
    height = .45 * half_width if height is None else _number(height, 'Lip height', 0, low_open=True)
    max_edge = height / 6 if max_edge is None else _number(max_edge, 'Max edge', 0, low_open=True)
    front = front_surface(vertices, faces)
    y = front(center_x, mouth_z)
    if y is None: raise ValueError(f'No skin at the mouth ({center_x:.4f}, {mouth_z:.4f}): put the mouth line on the face skin')
    depth = abs(y - sum(v[1] for v in vertices) / len(vertices))
    near = lambda v: abs(v[0] - center_x) < 1.4 * half_width and abs(v[2] - mouth_z) < 2.2 * height and v[1] < y + .5 * depth
    vertices, faces = _refine(vertices, faces, near, max_edge)
    normals = _vertex_normals(vertices, faces)
    bump = lambda d, r: (1 - (d / r) ** 2) ** 3 if abs(d) < r else 0.0

    def lift(v):
        u = (v[0] - center_x) / (1.2 * half_width)
        if abs(u) >= 1: return 0.0
        across = (1 - u * u) ** 1.5
        dz = v[2] - mouth_z
        lips = fullness * (bump(dz - .4 * height, .7 * height) + 1.3 * bump(dz + .45 * height, .8 * height))
        return across * (lips - crease * bump(dz, .3 * height))
    moved = [_add(v, _mul(n, lift(v))) if near(v) else v for v, n in zip(vertices, normals)]
    return {'vertices': moved, 'faces': faces}


def nose_geometry(vertices, faces, tip, size, nostrils=True, nostril_radius=None, nostril_depth=None, nostril_spacing=None,
                  max_edge=None):
    """Sculpt a round button nose with two nostril dimples into a skin, dense enough that it stays smooth.

    For kids and other soft faces (Pip). `tip` is the (x, z) of the nose's middle on
    the face, `size` its (half width, half height, projection) in meters: a ball that
    stands `projection` proud of the skin along its normal, joined to it by a smooth
    union with a rounded fillet (`sculpt_skin`), so it reads as part of the face with
    no seam. The skin is refined around the nose first (edges at most `max_edge`,
    default a fifth of the smaller radius, finer at the nostrils): a `soft_offset`
    sculpt on a blank's 6-8 mm faces pulls one vertex into a spike. With `nostrils`,
    two soft dimples are pressed up and into the bulb's lower slope, `nostril_spacing`
    either side of the middle (default 42% of the half width), `nostril_radius`
    across (default 34%) and `nostril_depth` deep (default 20% of the projection);
    their faces get material index 1, so give the mesh a dark nostril material
    second: `mesh_from_geometry('head_skin', nose, [skin, nostril])`. Every other face
    gets index 0. Call it on the head blank before `mesh_from_geometry`, before or
    after `eye_hole` (it only refines near the nose).

    Returns vertices, faces, material_indices, `tip` (the bulb's front point),
    `nostrils` (the two dimples' deepest points, left first) and `sneer`, the
    (center, radius, offset) of the left wing's lift: after `slit_mouth`, add
    `left, right = symmetric_offsets(rest, *nose['sneer'])` as noseSneerLeft and
    noseSneerRight, and the fused nose, dimples and all, rides them with no part to
    attach.
    """
    vertices = [_vector(v, 3, 'Vertex') for v in vertices]
    faces = [tuple(f) for f in faces]
    x, z = _vector(tip, 2, 'Nose tip')
    rx, rz, projection = _vector(size, 3, 'Nose size')
    if min(rx, rz, projection) <= 0: raise ValueError('Nose size (half width, half height, projection) must be positive')
    spacing = .42 * rx if nostril_spacing is None else _number(nostril_spacing, 'Nostril spacing', 0)
    radius = .34 * rx if nostril_radius is None else _number(nostril_radius, 'Nostril radius', 0, low_open=True)
    depth = .2 * projection if nostril_depth is None else _number(nostril_depth, 'Nostril depth', 0)
    max_edge = min(rx, rz) / 5 if max_edge is None else _number(max_edge, 'Max edge', 0, low_open=True)
    front = front_surface(vertices, faces)
    y = front(x, z)
    if y is None: raise ValueError(f'No skin at the nose tip ({x:.4f}, {z:.4f}): place the nose on the face skin')
    step = .25 * min(rx, rz)
    slopes = []
    for dx, dz in ((step, 0), (0, step)):
        ahead, behind = front(x + dx, z + dz), front(x - dx, z - dz)
        if ahead is None or behind is None: raise ValueError('The nose runs off the face skin: move it onto the face or make it smaller')
        slopes.append((ahead - behind) / (2 * step))
    base = (x, y, z)
    normal = _mul((slopes[0], -1.0, slopes[1]), 1 / math.hypot(slopes[0], 1.0, slopes[1]))
    ex = _sub((1.0, 0.0, 0.0), _mul(normal, normal[0]))
    ex = _mul(ex, 1 / math.hypot(*ex))
    ez = _cross(normal, ex)
    if ez[2] < 0: ez = _mul(ez, -1)
    frame = lambda v: (_dot(_sub(v, base), ex), _dot(_sub(v, base), ez), _dot(_sub(v, base), normal))
    reach = max(rx, rz)
    around = lambda v, scale: (lambda u, w, h: (u / rx) ** 2 + (w / rz) ** 2 < scale ** 2 and abs(h) < reach)(*frame(v))
    holes = [(side * spacing, -.55 * rz) for side in (1, -1)] if nostrils else []
    by_hole = lambda v: (lambda u, w, h: min((((u - hu) / radius) ** 2 + ((w - hw) / (.7 * radius)) ** 2 for hu, hw in holes), default=math.inf))(*frame(v))
    vertices, faces_out = _refine(vertices, faces, lambda v: around(v, 1.6), max_edge)
    if holes: vertices, faces_out = _refine(vertices, faces_out, lambda v: by_hole(v) < 2.2, min(max_edge, radius / 4))
    # The bulb: a ball `projection` proud of the skin, joined to it by a smooth union (sculpt_skin's fillet).
    depth_radius = max(rx, rz, projection)
    ball = [(_add(base, _mul(normal, projection - depth_radius)), (rx, depth_radius, rz), .5 * min(rx, rz))]
    dent = _mul(_add(_mul(normal, -1.0), _mul(ez, .6)), 1 / math.hypot(1.0, .6))
    moved, weight = [], []
    for v in vertices:
        u, w, h = frame(v)
        if abs(h) >= reach: moved.append(v); weight.append(0.0); continue
        p = _add(v, _mul(normal, _union_height(v, normal, ball))) if around(v, 1.6) else v
        d2 = by_hole(v)
        wd = (1 - d2) ** 2 if d2 < 1 else 0.0
        moved.append(_add(p, _mul(dent, depth * wd)))
        weight.append(wd)
    indices_out = [0] * len(faces_out)
    if holes:
        indices_out = [1 if sum(weight[i] for i in face) / len(face) > .3 else m for face, m in zip(faces_out, indices_out)]
    deepest = [max(range(len(moved)), key=lambda i: (weight[i] if (frame(vertices[i])[0] > 0) == (hu > 0) else -1)) for hu, _ in holes]
    wing = _add(_add(base, _mul(ex, spacing)), _mul(ez, -.55 * rz))
    wing = _add(wing, _mul(normal, _union_height(wing, normal, ball)))
    sneer = (wing, reach, _add(_add(_mul(ez, .35 * rz), _mul(ex, .1 * rx)), _mul(normal, .1 * projection)))
    return {'vertices': moved, 'faces': faces_out, 'material_indices': indices_out, 'tip': _add(base, _mul(normal, projection)),
            'nostrils': [moved[i] for i in deepest], 'sneer': sneer}


def ellipsoid_geometry(center, radii, rings=24, segments=32, exponent=2):
    """A closed, outward-wound UV ellipsoid with poles on the Z axis: a head blank to cut and morph.

    `exponent` above 2 makes a superellipsoid, |x/rx|^p + |y/ry|^p + |z/rz|^p = 1: a
    tin can with rounded edges at 6 (Bolt), boxier as it grows. Flat faces keep a
    robot's recessed shutters and plates behind the skin.
    """
    cx, cy, cz = _vector(center, 3, 'Ellipsoid center')
    rx, ry, rz = _vector(radii, 3, 'Ellipsoid radii')
    if min(rx, ry, rz) <= 0: raise ValueError('Ellipsoid radii must be positive')
    rings, segments = _count(rings, 'Ellipsoid rings', 3), _count(segments, 'Ellipsoid segments', 3)
    power = _number(exponent, 'Ellipsoid exponent', 2, 40)

    def point(sx, sy, sz):
        norm = (abs(sx) ** power + abs(sy) ** power + abs(sz) ** power) ** (1 / power)
        return (cx + rx * sx / norm, cy + ry * sy / norm, cz + rz * sz / norm)

    vertices = [(cx, cy, cz + rz)]
    for k in range(1, rings):
        polar = math.pi * k / rings
        for j in range(segments):
            a = math.tau * j / segments
            vertices.append(point(math.sin(polar) * math.cos(a), math.sin(polar) * math.sin(a), math.cos(polar)))
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


def front_surface(vertices, faces):
    """A function (x, z) -> y of the frontmost skin point on the line through (x, z) along Y, or None when it misses.

    The face looks down -Y, so frontmost is the smallest y. Use it to fit parts to a
    curved face: `mouth_cavity_geometry(surface=...)`, `exposed_teeth_geometry`.
    """
    vertices = [_vector(v, 3, 'Vertex') for v in vertices]
    triangles = []
    for face in faces:
        for i in range(1, len(face) - 1):
            a, b, c = vertices[face[0]], vertices[face[i]], vertices[face[i + 1]]
            triangles.append((a, b, c, min(a[0], b[0], c[0]), max(a[0], b[0], c[0]), min(a[2], b[2], c[2]), max(a[2], b[2], c[2])))

    def surface(x, z):
        best = None
        for a, b, c, x0, x1, z0, z1 in triangles:
            if x < x0 or x > x1 or z < z0 or z > z1: continue
            d = (b[2] - c[2]) * (a[0] - c[0]) + (c[0] - b[0]) * (a[2] - c[2])
            if abs(d) < 1e-18: continue
            u = ((b[2] - c[2]) * (x - c[0]) + (c[0] - b[0]) * (z - c[2])) / d
            v = ((c[2] - a[2]) * (x - c[0]) + (a[0] - c[0]) * (z - c[2])) / d
            w = 1 - u - v
            if min(u, v, w) < -1e-9: continue
            y = u * a[1] + v * b[1] + w * c[1]
            if best is None or y < best: best = y
        return best
    return surface


def cut_hole(vertices, faces, center, radius):
    """Cut a smooth round (or elliptical) hole, for an eye or a mouth, into a skin mesh.

    Every face the sphere around `center` (or the ellipsoid, when `radius` is
    (rx, ry, rz)) crosses is clipped exactly at it: the outside part is kept, with
    new vertices where its edges cross the sphere, so the rim lies on the circle
    instead of in the stair steps `cut_faces` leaves, stays on the original surface,
    and no vertex moves (nothing can fold). Faces wholly inside are removed. Returns
    {'vertices', 'faces', 'mapping' (old index -> new or None), 'source' (new index
    -> old, or None for a rim vertex), 'origin' (the source face of each face) and
    'boundary' (the rim vertices)}.
    """
    center = _vector(center, 3, 'Hole center')
    radii = (radius,) * 3 if isinstance(radius, Real) and not isinstance(radius, bool) else radius
    radii = _vector(radii, 3, 'Hole radius')
    if min(radii) <= 0: raise ValueError('Hole radius must be positive')
    return _clip(vertices, faces, lambda p: math.sqrt(sum(((p[k] - center[k]) / radii[k]) ** 2 for k in range(3))) - 1)


def _clip(vertices, faces, level, snap=0.0):
    """Keep the part of a mesh where `level(point) >= 0`, clipping faces exactly where it crosses zero (see `cut_hole`).

    With `snap` > 0, a crossing within that fraction of its edge from an end reuses that end as the rim vertex
    instead of adding one next to it, so the rim leaves no sliver faces (the rim then strays off the zero level
    by at most `snap` of an edge).
    """
    vertices = [_vector(v, 3, 'Vertex') for v in vertices]
    values = [level(v) for v in vertices]
    result, source, boundary, mapping, crossings = [], [], [], [None] * len(vertices), {}

    def keep(i):
        if mapping[i] is None:
            mapping[i] = len(result)
            result.append(vertices[i]); source.append(i)
            if values[i] == 0: boundary.append(mapping[i])
        return mapping[i]

    snapped = {}

    def cross(outside, inside):
        key = (outside, inside)
        if key not in crossings:
            a, b = vertices[outside], vertices[inside]
            low, high = 0.0, 1.0
            for _ in range(64):
                mid = (low + high) / 2
                if level(_add(a, _mul(_sub(b, a), mid))) >= 0: low = mid
                else: high = mid
            if low < snap:
                crossings[key] = keep(outside)
            elif low > 1 - snap:
                if inside not in snapped:
                    snapped[inside] = len(result)
                    result.append(vertices[inside]); source.append(inside)
                crossings[key] = snapped[inside]
            else:
                crossings[key] = len(result)
                result.append(_add(a, _mul(_sub(b, a), low))); source.append(None)
            boundary.append(crossings[key])
        return crossings[key]

    kept, origin = [], []
    for index, face in enumerate(faces):
        face = tuple(face)
        inside = [values[i] < 0 for i in face]
        if all(inside): continue
        polygon = []
        for k, i in enumerate(face):
            j = face[(k + 1) % len(face)]
            if not inside[k]: polygon.append(keep(i))
            if inside[k] != inside[(k + 1) % len(face)]:
                polygon.append(cross(i, j) if not inside[k] else cross(j, i))
        polygon = [v for k, v in enumerate(polygon) if v != polygon[k - 1]]
        if len(polygon) >= 3: kept.append(tuple(polygon)); origin.append(index)
    return {'vertices': result, 'faces': kept, 'mapping': mapping, 'source': source, 'origin': origin, 'boundary': sorted(set(boundary))}


def exposed_teeth_geometry(surface, xs, mouth_z, length, width, style='saw', root=None, thickness=None, clearance=.0005, sizes=None):
    """Upper teeth that show with the mouth closed (fangs, buck teeth), hanging over the lower lip.

    One tooth per x in `xs`, hanging `length` below the mouth line with its root
    `root` (default 0.35 * length) above it, tucked under the upper lip. `surface`
    is the skin's front, a function (x, z) -> y such as `front_surface(...)`: each
    tooth stands just in front of the lower lip, at least `clearance` in front of the
    skin below the mouth line, so the closed lips never cut it and the lower lip can
    drop away behind it. Styles as `teeth_row_geometry` ('saw' fangs, 'rounded' buck
    teeth, 'grille'); `sizes` gives (width, length) scales per tooth. Name the object
    and material `teeth_upper`, bind it to `head`, and declare it in `exposedTeeth`.
    Returns vertices, faces, count and the measured `clearance`.
    """
    if not callable(surface): raise ValueError('surface must be a function (x, z) -> y, such as front_surface(...)')
    if style not in ('rounded', 'saw', 'grille'): raise ValueError("Teeth style must be 'rounded', 'saw' or 'grille'")
    xs = [_number(x, 'Tooth x') for x in xs]
    if not xs: raise ValueError('Give at least one tooth position')
    mouth_z = _number(mouth_z, 'Mouth line')
    length = _number(length, 'Tooth length', 0, low_open=True)
    width = _number(width, 'Tooth width', 0, low_open=True)
    root = .35 * length if root is None else _number(root, 'Tooth root', 0)
    thickness = .55 * width if thickness is None else _number(thickness, 'Tooth thickness', 0, low_open=True)
    clearance = _number(clearance, 'Clearance', 0)
    sizes = [(1.0, 1.0)] * len(xs) if sizes is None else [_vector(s, 2, 'Tooth size') for s in sizes]
    if len(sizes) != len(xs): raise ValueError('Tooth sizes need one (width, length) pair per tooth')
    vertices, faces, measured = [], [], math.inf
    for x, (scale_w, scale_l) in zip(xs, sizes):
        w, tip = width * scale_w, mouth_z - length * scale_l
        samples = [surface(x + w * (i / 4 - .5), tip + (mouth_z - tip) * k / 8) for i in range(5) for k in range(9)]
        samples = [y for y in samples if y is not None]
        if not samples: raise ValueError(f'No skin found in front of or behind the tooth at x = {x}')
        local, local_faces = _tooth(style, w, thickness, root + length * scale_l)
        center_y = min(samples) - clearance - thickness / 2
        for _ in range(8):
            world = [(x + p[0], center_y - p[1], mouth_z + root - p[2]) for p in local]
            gaps = [surface(v[0], v[2]) - v[1] for v in world if v[2] < mouth_z and surface(v[0], v[2]) is not None]
            gap = min(gaps) if gaps else math.inf
            if gap >= clearance - 1e-12: break
            center_y -= clearance - gap + 1e-7
        measured = min(measured, gap)
        faces += [tuple(k + len(vertices) for k in face) for face in _outward(world, local_faces)]
        vertices += world
    return {'vertices': vertices, 'faces': faces, 'count': len(xs), 'style': style, 'clearance': measured}


def brow_ridge_geometry(center, radius, side, inner=20, outer=55, elevation=50, height=12, thickness=None, arch=4,
                        down=12, inner_up=10, outer_up=10, skin=None, hole=None, sink=None, clearance=.0002, columns=16, sides=16):
    """A heavy brow ridge lying on the skin over an eye in a dome, with browDown, browInnerUp and browOuterUp morphs.

    For heads whose eyes sit in domes (a frog, a creature; Mossjaw's ridge is his
    brow). The ridge runs round the eye from `inner` degrees toward the nose to
    `outer` degrees away, centered `elevation` degrees above the gaze axis (arched up
    by `arch` in the middle) and `height` degrees tall, and it lies on the actual skin:
    `skin` is the head skin with its eye holes cut ({'vertices', 'faces'}, as for
    `front_surface`), and each point of the ridge's base is found on it along its
    direction from the eye center. Its cross-section is a bump `thickness` meters
    proud (default 18% of `radius`) whose edges and underside sink `sink` meters into
    the skin (default 12% of the thickness), so it reads as a fold of the skin, not a
    part laid on top, and no view sees background under it. Pass the eye's `hole`
    (`eye_hole(...)`) so the base never enters the lids: where the ridge crosses the
    eye's window (a lowered brow) it rests on the upper lid, `clearance` outside it.
    `radius` (the hole's `mound`) is where the search for the skin starts.

    The morphs slide the ridge over the skin and lay it back on at its new place:
    `browDown<Side>` lowers the inner end by `down` degrees (the outer end a third as
    much), `browInnerUp` lifts the inner end by `inner_up`, `browOuterUp<Side>` the
    outer end by `outer_up`. Every pose is checked with `skin_contact`, and a ridge
    that cannot lie on the skin is rejected. Returns vertices, faces, morphs, the mean
    `base_radius` and `contact`; bind it to `head` and join it into the face mesh. If
    the skin under it has its own shapes (brows, cheeks), pass the ridge through
    `attach_to_skin(ridge, head)` after they are added so it rides them too.
    """
    center = _vector(center, 3, 'Eye center')
    radius = _number(radius, 'Dome radius', 0, low_open=True)
    if side not in _SIDES: raise ValueError("Brow side must be 'L' or 'R'")
    if skin is None:
        raise ValueError("brow_ridge_geometry lays the ridge on the skin: pass skin={'vertices': ..., 'faces': ...} (the head with its "
                         "eye holes cut, as for front_surface) and hole=eye_hole(...); a ridge on a sphere floats over the dome")
    suffix, sign = _SIDES[side], 1 if side == 'L' else -1
    inner, outer = _number(inner, 'Inner reach', 0, 80), _number(outer, 'Outer reach', 0, 80)
    elevation, height, arch = _number(elevation, 'Brow elevation', -80, 80), _number(height, 'Brow height', 0, 60, low_open=True), _number(arch, 'Brow arch')
    thickness = .18 * radius if thickness is None else _number(thickness, 'Brow thickness', 0, low_open=True)
    sink = .12 * thickness if sink is None else _number(sink, 'Sink', 0)
    clearance = _number(clearance, 'Clearance', 0)
    down, inner_up, outer_up = (_number(v, label, 0, 45) for v, label in ((down, 'Brow down'), (inner_up, 'Brow inner up'), (outer_up, 'Brow outer up')))
    columns, sides = _count(columns, 'Brow columns', 2), _count(sides, 'Brow sides', 6)
    skin_vertices, skin_faces, _ = _skin_data(skin)
    reach = 2.5 * radius + thickness
    index = _SkinIndex(skin_vertices, skin_faces, near=lambda p: math.dist(p, center) < reach)
    if hole is not None:
        lids = hole['lids']
        if math.dist(tuple(lids['center']), center) > 1e-9: raise ValueError('This hole belongs to another eye')
        floor, level = lids['upper_radius'] + lids['thickness'] + clearance, hole['window']['level']
    else:
        floor, level = None, None
    shifts = {
        f'browDown{suffix}': lambda s: -down * (1 - 2 / 3 * s),
        'browInnerUp': lambda s: inner_up * (1 - s),
        f'browOuterUp{suffix}': lambda s: outer_up * s,
    }

    def base(yaw, elevation_):
        """The skin's distance from the eye center along (yaw, elevation), sunk by `sink`; on the lids inside the window."""
        direction = _sub(_sphere_point(center, 1.0, yaw, elevation_), center)
        t, found = radius, False
        for _ in range(12):
            hit = index.nearest(_add(center, _mul(direction, t)), limit=.012)
            if hit is None: break
            facing = _dot(direction, index.normal(hit[2]))
            if facing < .2: break
            step = hit[0] / facing
            t -= step
            if abs(step) < 1e-8: found = True; break
        inside = level is not None and level(_add(center, _mul(direction, t))) < 1
        if not found or inside:
            if floor is None: raise ValueError(f'No skin under the brow ridge at yaw {yaw:.0f}, elevation {elevation_:.0f} degrees: pass hole=eye_hole(...) or move the ridge onto the skin')
            return floor
        t -= sink
        return t if floor is None else max(t, floor)

    def layout(delta):
        points = []
        for j in range(columns + 1):
            s = j / columns
            yaw = sign * (-inner + (inner + outer) * s)
            taper = .4 + .6 * math.sin(math.pi * s) ** .5
            middle = elevation + arch * math.sin(math.pi * s) + delta(s)
            for k in range(sides):
                phi = math.tau * k / sides
                e = middle + height / 2 * taper * math.cos(phi)
                # The upper arc is the ridge you see; the lower arc lies inside the skin.
                lift = thickness * taper * (math.sin(phi) if math.sin(phi) >= 0 else .35 * math.sin(phi))
                points.append(_sphere_point(center, base(yaw, e) + lift, yaw, e))
        for s in (0.0, 1.0):
            yaw = sign * (-inner + (inner + outer) * s)
            e = elevation + delta(s)
            points.append(_sphere_point(center, base(yaw, e), yaw, e))
        return points

    vertices = layout(lambda s: 0.0)
    ring = lambda j, k: j * sides + k % sides
    faces = [(ring(j, k), ring(j, k + 1), ring(j + 1, k + 1), ring(j + 1, k)) for j in range(columns) for k in range(sides)]
    start, end = len(vertices) - 2, len(vertices) - 1
    faces += [(start, ring(0, k + 1), ring(0, k)) for k in range(sides)]
    faces += [(end, ring(columns, k), ring(columns, k + 1)) for k in range(sides)]
    faces = _outward(vertices, faces)
    morphs = {name: layout(delta) for name, delta in shifts.items()}
    result = {'vertices': vertices, 'faces': faces, 'morphs': morphs,
              'base_radius': sum(math.dist(v, center) for v in vertices[:-2]) / (len(vertices) - 2)}
    # Judge it as the verifier does: against the skin and the lids (a lowered brow may rest on the upper lid).
    surface = {'vertices': skin_vertices, 'faces': skin_faces}
    if hole is not None:
        offset = len(skin_vertices)
        surface = {'vertices': skin_vertices + list(hole['lids']['vertices']), 'faces': skin_faces + [tuple(i + offset for i in f) for f in hole['lids']['faces']]}
    contact = skin_contact(result, surface)
    worst = max([('rest', contact['gap'])] + [(name, pose['gap']) for name, pose in contact['poses'].items()], key=lambda item: item[1])
    if worst[1] > ATTACH_TOLERANCE:
        raise ValueError(f'The brow ridge floats {worst[1] * 1000:.2f} mm off the skin at {worst[0]}: lower `elevation` onto the skin '
                         f'or raise `sink` (now {sink * 1000:.2f} mm)')
    result['contact'] = contact
    return result


def _smooth_normals(triangles, vertices):
    """Area-weighted vertex normals of the vertices these triangles use, from `vertices` (any pose of the skin)."""
    sums = {}
    for tri in triangles:
        a, b, c = (vertices[i] for i in tri)
        n = _cross(_sub(b, a), _sub(c, a))
        for i in tri:
            total = sums.setdefault(i, [0.0, 0.0, 0.0])
            for k in range(3): total[k] += n[k]
    return {i: _mul(n, 1 / (math.hypot(*n) or 1.0)) for i, n in sums.items()}


def _footprint(index, point, limit=.02):
    """(triangle, barycentric weights) of the skin point nearest `point`, or None when no skin is within `limit`."""
    hit = index.nearest(point, limit=limit)
    return None if hit is None else (index.triangles[hit[2]], hit[3])


def _on_footprint(footprint, vertices, normals):
    """The skin point and smooth normal at a footprint, in the pose `vertices` (with its `_smooth_normals`)."""
    tri, weights = footprint
    foot = tuple(sum(w * vertices[i][k] for i, w in zip(tri, weights)) for k in range(3))
    n = [sum(w * normals[i][k] for i, w in zip(tri, weights)) for k in range(3)]
    return foot, _mul(n, 1 / (math.hypot(*n) or 1.0))


def skin_brow_geometry(skin, side, inner, outer, height=.004, thickness=.0016, arch=.002, down=.004, inner_up=.004,
                       outer_up=.004, pinch=.002, sink=None, hole=None, columns=16, sides=10):
    """A brow lying on a skin face (a kid's hair-coloured brow), with browDown, browInnerUp and browOuterUp morphs.

    For round skin-faced heads, where `brow_ridge_geometry` (a ridge on an eye dome)
    and `brow_plate_geometry` (a robot's rigid bar) do not fit. `skin` is the head
    skin with its eye holes cut: a geometry dict (vertices, faces, optional morphs) or
    the Blender mesh object after its shape keys are added. `inner` and `outer` are the
    (x, z) of the left brow's ends (the character's left, +X; the inner end toward the
    nose); side 'R' mirrors them. Pass the eye's `hole` (`eye_hole(...)`) so a brow
    lowered over the eye rests on its upper lid rather than falling into the window.

    The brow is laid on the skin itself, the way `brow_ridge_geometry` lays a ridge:
    its centre line is found on the skin, and each cross-section is a bump in the
    plane of the skin's normal, `height` wide across the skin and `thickness` proud
    of it at the middle (tapering to the ends, arched up by `arch`), each point
    settled on the skin along its normal, so it follows the forehead's curve, the
    socket dip over the eye and the turn of the temple. Its edges and underside sink
    `sink` meters into the skin (default 15% of `thickness`), so no view sees daylight
    under it. The morphs move the brow over the face and lay it back on the skin at
    its new place: `browDown<Side>` lowers the inner end by `down` (the outer end a
    third as much) and pinches it `pinch` toward the nose, so an angry brow knits and
    tilts, `browInnerUp` lifts the inner end by `inner_up`, `browOuterUp<Side>`
    lifts the outer end by `outer_up` (meters). When the skin has morphs, every pose
    is laid on the skin in that pose (the brow rides the skin's own brow and cheek
    shapes), and those names are listed in `laid` so `attach_to_skin` does not add
    them again. Every pose is checked with `skin_contact` (against the skin and the
    lids), with a deeper sink retried before a brow that cannot lie on the skin is
    rejected. Returns vertices, faces, morphs, `laid` and `contact`; give it a hair
    material, bind it to `head` and join it into the face mesh.
    """
    if callable(skin) and not isinstance(skin, dict) and not hasattr(skin, 'data'):
        raise ValueError("skin_brow_geometry lays the brow on the skin itself: pass the skin geometry {'vertices', 'faces', 'morphs'} "
                         "(with its eye holes cut) or the head mesh object, not front_surface(...), and hole=eye_hole(...)")
    if side not in _SIDES: raise ValueError("Brow side must be 'L' or 'R'")
    suffix, sign = _SIDES[side], 1 if side == 'L' else -1
    (x0, z0), (x1, z1) = _vector(inner, 2, 'Inner end'), _vector(outer, 2, 'Outer end')
    height, thickness = _number(height, 'Brow height', 0, low_open=True), _number(thickness, 'Brow thickness', 0, low_open=True)
    arch = _number(arch, 'Brow arch')
    sink = .15 * thickness if sink is None else _number(sink, 'Sink', 0)
    down, inner_up, outer_up, pinch = (_number(v, label, 0) for v, label in ((down, 'Brow down'), (inner_up, 'Brow inner up'), (outer_up, 'Brow outer up'), (pinch, 'Brow pinch')))
    columns, sides = _count(columns, 'Brow columns', 2), _count(sides, 'Brow sides', 6)
    skin_vertices, skin_faces, skin_morphs = _skin_data(skin)
    # Each pose moves a point of the centre line (t = 0 inner, 1 outer) by (toward the temple, up) meters.
    shifts = {
        f'browDown{suffix}': lambda t: (-pinch * (1 - t) ** 2, -down * (1 - 2 / 3 * t)),
        'browInnerUp': lambda t: (0.0, inner_up * (1 - t)),
        f'browOuterUp{suffix}': lambda t: (0.0, outer_up * t),
    }
    if hole is not None:
        lids, level = hole['lids'], hole['window']['level']
        lid_vertices, lid_faces = [tuple(v) for v in lids['vertices']], [tuple(f) for f in lids['faces']]
    xs = sorted((sign * x0, sign * x1))
    reach = max(down, inner_up, outer_up, pinch) + height + abs(arch) + .01
    region = lambda p: xs[0] - reach <= p[0] <= xs[1] + reach and min(z0, z1) - reach <= p[2] <= max(z0, z1) + reach
    front_faces = [f for f in skin_faces if any(region(skin_vertices[i]) for i in f)]
    if not front_faces: raise ValueError(f'No skin behind the brow between x = {xs[0]:.4f} and {xs[1]:.4f} m: place it on the forehead')
    index = _SkinIndex(skin_vertices, front_faces, near=region)
    rest_normals = _smooth_normals(index.triangles, skin_vertices)
    front = front_surface(skin_vertices, front_faces)
    if hole is not None:
        lid_index = _SkinIndex(lid_vertices, lid_faces)
        lid_normals = _smooth_normals(lid_index.triangles, lid_vertices)

    def footprint(point):
        """Where on the rest skin a point settles: the skin, or the upper lid inside the eye's window."""
        found = _footprint(index, point)
        if found is None: raise ValueError(f'No skin under the brow near ({point[0]:.4f}, {point[1]:.4f}, {point[2]:.4f}): move it onto the forehead')
        if hole is not None and level(_on_footprint(found, skin_vertices, rest_normals)[0]) < 1:
            on_lid = _footprint(lid_index, point)
            if on_lid is not None: return 'lid', on_lid
        return 'skin', found

    def place(where, posed, normals):
        kind, found = where
        return _on_footprint(found, lid_vertices, lid_normals) if kind == 'lid' else _on_footprint(found, posed, normals)

    def skeleton(shift):
        """The brow's footprints on the rest skin, with each point's lift off it: the pose's shape before the skin moves."""
        spine = []
        for j in range(columns + 1):
            t = j / columns
            dx, dz = shift(t)
            x = sign * (x0 + (x1 - x0) * t + dx)
            z = z0 + (z1 - z0) * t + arch * math.sin(math.pi * t) + dz
            y = front(x, z)
            if y is None: raise ValueError(f'No skin behind the brow at x = {x:.4f}, z = {z:.4f}: move it onto the forehead')
            spine.append(footprint((x, y, z)))
        rest_spine = [place(w, skin_vertices, rest_normals) for w in spine]
        points = []
        for j, (foot, normal) in enumerate(rest_spine):
            taper = .2 + .8 * math.sin(math.pi * j / columns) ** .5
            up = _cross(normal, _sub(rest_spine[min(j + 1, columns)][0], rest_spine[max(j - 1, 0)][0]))
            up = _mul(up, (1 if up[2] >= 0 else -1) / (math.hypot(*up) or 1.0))
            for k in range(sides):
                phi = math.tau * k / sides
                # The upper arc is the brow you see; the lower arc lies inside the skin.
                lift = thickness * taper * (math.sin(phi) if math.sin(phi) >= 0 else .35 * math.sin(phi))
                points.append((footprint(_add(foot, _mul(up, height / 2 * taper * math.cos(phi)))), lift))
        return points + [(spine[0], 0.0), (spine[-1], 0.0)]

    def layout(bones, posed, sink_):
        """The brow on the skin in pose `posed`: every point rides its footprint and stands off along the skin's normal."""
        normals = rest_normals if posed is skin_vertices else _smooth_normals(index.triangles, posed)
        result = []
        for where, lift in bones:
            foot, n = place(where, posed, normals)
            result.append(_add(foot, _mul(n, lift - sink_)))
        return result

    ring = lambda j, k: j * sides + k % sides
    faces = [(ring(j, k), ring(j, k + 1), ring(j + 1, k + 1), ring(j + 1, k)) for j in range(columns) for k in range(sides)]
    start, end = (columns + 1) * sides, (columns + 1) * sides + 1
    faces += [(start, ring(0, k + 1), ring(0, k)) for k in range(sides)]
    faces += [(end, ring(columns, k), ring(columns, k + 1)) for k in range(sides)]
    # Judge it as the verifier does: against the skin and the lids (a lowered brow may rest on the upper lid).
    surface = {'vertices': skin_vertices, 'faces': skin_faces, 'morphs': skin_morphs}
    if hole is not None:
        offset = len(skin_vertices)
        surface = {'vertices': skin_vertices + lid_vertices, 'faces': skin_faces + [tuple(i + offset for i in f) for f in lid_faces],
                   'morphs': {name: list(targets) + lid_vertices for name, targets in skin_morphs.items()}}
    flat = lambda t: (0.0, 0.0)
    bones = {name: skeleton(shift) for name, shift in shifts.items()}
    bones[None] = skeleton(flat)
    moving = [n for n in skin_morphs if n not in shifts and any(region(p) and p != q for p, q in zip(skin_vertices, skin_morphs[n]))]
    for attempt, sink_ in enumerate((sink, 2 * sink + .0002, 3 * sink + .0004)):
        vertices = layout(bones[None], skin_vertices, sink_)
        morphs, laid = {}, []
        for name in list(shifts) + moving:
            target = layout(bones.get(name, bones[None]), skin_morphs.get(name, skin_vertices), sink_)
            if name not in shifts and max(math.dist(p, q) for p, q in zip(target, vertices)) < 1e-7: continue
            morphs[name] = target
            if name in skin_morphs: laid.append(name)
        if attempt == 0: faces = _outward(vertices, faces)
        result = {'vertices': vertices, 'faces': faces, 'morphs': morphs, 'laid': laid, 'sink': sink_}
        contact = skin_contact(result, surface)
        worst = max([('rest', contact['gap'])] + [(name, pose['gap']) for name, pose in contact['poses'].items()], key=lambda item: item[1])
        if worst[1] <= ATTACH_TOLERANCE: break
    else:
        raise ValueError(f'The skin brow floats {worst[1] * 1000:.2f} mm off the skin at {worst[0]} even sunk {sink_ * 1000:.2f} mm: '
                         'move `inner`/`outer` onto the forehead, away from the eye window, or pass hole=eye_hole(...)')
    result['contact'] = contact
    return result


# ---------------------------------------------------------------- robot parts (Bolt: plates, rubber mouth edge)

def _turn_y(point, pivot, degrees):
    """Turn `point` about the Y axis (the gaze axis) through `pivot`: positive lifts points on the +X side."""
    a = math.radians(degrees)
    x, z = point[0] - pivot[0], point[2] - pivot[2]
    return (pivot[0] + x * math.cos(a) - z * math.sin(a), point[1], pivot[2] + x * math.sin(a) + z * math.cos(a))


def brow_plate_geometry(center, size, side, down=12, drop=None, inner_up=10, outer_up=10, surface=None, clearance=.0005):
    """A rigid brow plate (a robot's metal brow bar) with browDown, browInnerUp and browOuterUp morphs.

    `size` is (width, depth, height) in meters and `center` the middle of the bar;
    the face looks down -Y. Each morph turns the whole bar rigidly in the face plane:
    `browDown<Side>` turns it about its outer end so the inner end (toward the nose)
    drops by `down` degrees and lowers the bar by `drop` (default 40% of its height),
    `browInnerUp` lifts the inner end by `inner_up` degrees about the outer end, and
    `browOuterUp<Side>` lifts the outer end by `outer_up` about the inner end. With
    `surface` (`front_surface(...)` of the head) the bar's back face is placed
    `clearance` in front of the face at every weight combination, so it never sinks
    into the plate it rides on. Returns vertices, faces and morphs; bind it to `head`
    and join it into the face mesh.
    """
    cx, cy, cz = _vector(center, 3, 'Brow center')
    width, depth, height = _vector(size, 3, 'Brow size')
    for label, value in (('Brow width', width), ('Brow depth', depth), ('Brow height', height)): _number(value, label, 0, low_open=True)
    if side not in _SIDES: raise ValueError("Brow side must be 'L' or 'R'")
    suffix, sign = _SIDES[side], 1 if side == 'L' else -1
    down, inner_up, outer_up = (_number(v, label, 0, 45) for v, label in ((down, 'Brow down'), (inner_up, 'Brow inner up'), (outer_up, 'Brow outer up')))
    drop = .4 * height if drop is None else _number(drop, 'Brow drop', 0)
    clearance = _number(clearance, 'Clearance', 0)
    if surface is not None and not callable(surface): raise ValueError('surface must be a function (x, z) -> y, such as front_surface(...)')
    inner, outer = (cx - sign * width / 2, cy, cz), (cx + sign * width / 2, cy, cz)
    # Positive turns lift +X; the right bar mirrors the left one.
    moves = {
        f'browDown{suffix}': lambda p: _add(_turn_y(p, outer, sign * down), (0, 0, -drop)),
        'browInnerUp': lambda p: _turn_y(p, outer, -sign * inner_up),
        f'browOuterUp{suffix}': lambda p: _turn_y(p, inner, sign * outer_up),
    }

    def bar(front):
        vertices, faces = _box(cx - width / 2, cx + width / 2, front, front + depth, cz - height / 2, cz + height / 2)
        return vertices, faces

    front = cy - depth / 2
    if surface is not None:
        # Sample the back face densely at every weight combination: the morphs only turn the bar in the face plane,
        # so its back stays at one y and must clear the most forward skin under any pose.
        names = list(moves)
        back = [(cx + width * (i / 6 - .5), cz + height * (k / 3 - .5)) for i in range(7) for k in range(4)]
        worst = math.inf
        for mask in range(1 << len(names)):
            for x, z in back:
                point = (x, 0.0, z)
                shifted = point
                for bit, name in enumerate(names):
                    if mask >> bit & 1: shifted = _add(shifted, _sub(moves[name](point), point))
                skin = surface(shifted[0], shifted[2])
                if skin is not None: worst = min(worst, skin)
        if worst == math.inf: raise ValueError('No skin found behind the brow plate')
        front = worst - clearance - depth
    vertices, faces = bar(front)
    return {'vertices': vertices, 'faces': faces, 'morphs': {name: [move(v) for v in vertices] for name, move in moves.items()},
            'inner': inner, 'outer': outer}


def _vertex_normals(vertices, faces):
    normals = [[0.0, 0.0, 0.0] for _ in vertices]
    for face in faces:
        for i in range(1, len(face) - 1):
            a, b, c = vertices[face[0]], vertices[face[i]], vertices[face[i + 1]]
            n = _cross(_sub(b, a), _sub(c, a))
            for index in (face[0], face[i], face[i + 1]):
                for k in range(3): normals[index][k] += n[k]
    result = []
    for n in normals:
        length = math.hypot(*n)
        result.append(tuple(v / length for v in n) if length > 1e-30 else (0.0, 0.0, 0.0))
    return result


def _thick_clip(vertices, normals, faces, plane_z, keep_above, thickness):
    """The part of a closed outward shell on one side of z = plane_z, as a closed shell `thickness` thick."""
    keep = (lambda z: z >= plane_z) if keep_above else (lambda z: z <= plane_z)
    out, out_normals, mapping, crossings = [], [], {}, {}

    def kept(i):
        if i not in mapping:
            mapping[i] = len(out); out.append(vertices[i]); out_normals.append(normals[i])
        return mapping[i]

    def cross(i, j):
        key = (min(i, j), max(i, j))
        if key not in crossings:
            a, b = vertices[key[0]], vertices[key[1]]
            t = (plane_z - a[2]) / (b[2] - a[2])
            point = (a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, plane_z)
            n = _add(_mul(normals[key[0]], 1 - t), _mul(normals[key[1]], t))
            crossings[key] = len(out); out.append(point); out_normals.append(n)
        return crossings[key]

    shell = []
    for face in faces:
        inside = [keep(vertices[i][2]) for i in face]
        if not any(inside): continue
        polygon = []
        for k, i in enumerate(face):
            j = face[(k + 1) % len(face)]
            if inside[k]: polygon.append(kept(i))
            if inside[k] != inside[(k + 1) % len(face)] and plane_z not in (vertices[i][2], vertices[j][2]): polygon.append(cross(i, j))
        polygon = [v for k, v in enumerate(polygon) if v != polygon[k - 1]]
        if len(polygon) >= 3: shell.append(tuple(polygon))
    used = {}
    for face in shell:
        for a, b in zip(face, face[1:] + face[:1]):
            used[(a, b)] = used.get((a, b), 0) + 1
    boundary = [(a, b) for (a, b) in used if (b, a) not in used]
    on_rim = {v for edge in boundary for v in edge}
    count = len(out)
    inner = []
    for index, (point, n) in enumerate(zip(out, out_normals)):
        if index in on_rim:
            # Rim partners stay in the cut plane, so the rim is a flat band `thickness` wide.
            n = (n[0], n[1], 0.0)
        length = math.hypot(*n) or 1.0
        p = _sub(point, _mul(n, thickness / length))
        z = max(p[2], plane_z) if keep_above else min(p[2], plane_z)
        inner.append((p[0], p[1], z))
    faces_out = list(shell) + [tuple(v + count for v in reversed(face)) for face in shell]
    faces_out += [(b, a, a + count, b + count) for a, b in boundary]
    return {'vertices': out + inner, 'faces': faces_out, 'rim': sorted((v, v + count) for v in on_rim)}


def split_plates(vertices, faces, split_z, thickness, gap=0.0, gum_z=None):
    """Split a closed head surface at z = `split_z` into a skull and a chin plate, each a closed shell with thick edges.

    The cut follows the plane exactly (no stair steps), so the chin plate's rim sits
    at `split_z - gap / 2` and the skull's at `split_z + gap / 2`. Each part gets an
    inner wall `thickness` behind its outer surface and a flat rim band joining them,
    so an opened jaw shows solid edges instead of a paper-thin open shell. Pass the
    upper teeth's gum line as `gum_z`: the chin plate moves with `jawOpen`, and the
    arkit-face/1 verifier fails any jaw-moved skin above the gum line, so a split
    that would put the plate's rim above it is rejected. Returns {'skull', 'plate'},
    each with vertices, faces and `rim` (outer, inner) vertex pairs; give the plate
    `add_jaw_open(..., rigid=True)`.
    """
    split_z = _number(split_z, 'Split height')
    thickness = _number(thickness, 'Plate thickness', 0, low_open=True)
    gap = _number(gap, 'Plate gap', 0)
    top, bottom = split_z + gap / 2, split_z - gap / 2
    if gum_z is not None and bottom > _number(gum_z, 'Gum line') + 1e-12:
        raise ValueError(f"The chin plate's rim (z {bottom:.4f}) would reach above the upper teeth's gum line (z {gum_z:.4f}), "
                         'where jawOpen may not move the skin: split lower or raise the teeth roots')
    vertices = [_vector(v, 3, 'Vertex') for v in vertices]
    faces = _outward(vertices, [tuple(f) for f in faces])
    zs = [v[2] for v in vertices]
    if not min(zs) < bottom <= top < max(zs): raise ValueError('The split must cross the head')
    normals = _vertex_normals(vertices, faces)
    return {'skull': _thick_clip(vertices, normals, faces, top, True, thickness),
            'plate': _thick_clip(vertices, normals, faces, bottom, False, thickness)}


def rubber_mouth_geometry(surface, mouth_z, half_width, jaw=None, radius=.0015, center_x=0.0, segments=24, sides=8,
                          standoff=.0003, smile=(.0015, .004), frown=.004, stretch=.004, funnel=.004, pinch=.2):
    """A robot's rubber mouth edge: an upper and a lower rubber tube along the mouth slot, carrying the mouth shapes.

    For heads whose jaw is a rigid plate (Bolt): the plates stay rigid and these
    edges flex. The tubes run from -`half_width` to +`half_width` about `center_x`,
    just above and below `mouth_z`, touching at rest so the slot is closed, and sit
    `standoff` in front of the head's front `surface` (`front_surface(...)`). Morphs:
    `mouthSmile<Side>` lifts that corner by smile[1] and pulls it out by smile[0],
    `mouthFrown<Side>` lowers it by `frown`, `mouthStretch<Side>` pulls it out by
    `stretch`, and `mouthFunnel` pinches the corners in by `pinch` of the half-width
    and rounds the lips apart by 0.3 `funnel` (it does not push them off the plates:
    every ring is laid back on the face, `standoff` in front of it, so the edge never
    floats or sinks while a mouth shape plays). With `jaw` (a
    `JawHinge`), `jawOpen` carries the lower tube rigidly with the chin plate; the
    upper tube stays on the skull. Every ring moves as a whole, so the tubes never
    twist. Returns vertices, faces, morphs, and the `upper` and `lower` vertex indices.
    """
    if not callable(surface): raise ValueError('surface must be a function (x, z) -> y, such as front_surface(...)')
    mouth_z, center_x = _number(mouth_z, 'Mouth line'), _number(center_x, 'Mouth center')
    half = _number(half_width, 'Mouth half-width', 0, low_open=True)
    radius = _number(radius, 'Rubber radius', 0, low_open=True)
    segments, sides = _count(segments, 'Rubber segments', 4), _count(sides, 'Rubber sides', 4)
    standoff = _number(standoff, 'Standoff', 0)
    smile_out, smile_up = _vector(smile, 2, 'Smile')
    frown, stretch, funnel = (_number(v, label, 0) for v, label in ((frown, 'Frown'), (stretch, 'Stretch'), (funnel, 'Funnel')))
    pinch = _number(pinch, 'Pinch', 0, .9)
    vertices, faces, rings, upper, lower, caps = [], [], {'upper': [], 'lower': []}, [], [], []
    for key, zc in (('upper', mouth_z + radius), ('lower', mouth_z - radius)):
        start = len(vertices)
        for s in range(segments + 1):
            x = center_x - half + 2 * half * s / segments
            # As close as `standoff` in front of the face, vertex by vertex round the ring (so it lies on it, not over it).
            fits = []
            for k in range(sides):
                skin = surface(x, zc + radius * math.sin(math.tau * k / sides))
                if skin is not None: fits.append(skin - radius * math.cos(math.tau * k / sides))
            if not fits: raise ValueError(f'No head surface behind the mouth edge at x = {x:.4f}')
            yc = min(fits) - standoff
            ring = []
            for k in range(sides):
                a = math.tau * k / sides
                ring.append(len(vertices))
                vertices.append((x, yc + radius * math.cos(a), zc + radius * math.sin(a)))
            rings[key].append(ring)
        grid = rings[key]
        for s in range(segments):
            for k in range(sides):
                faces.append((grid[s][k], grid[s + 1][k], grid[s + 1][(k + 1) % sides], grid[s][(k + 1) % sides]))
        for end, ring in ((0, grid[0]), (1, grid[-1])):
            cap = len(vertices)
            caps.append((cap, ring))
            vertices.append(tuple(sum(vertices[i][k] for i in ring) / sides for k in range(3)))
            for k in range(sides):
                faces.append((cap, ring[k], ring[(k + 1) % sides]) if end == 0 else (cap, ring[(k + 1) % sides], ring[k]))
        (upper if key == 'upper' else lower).extend(range(start, len(vertices)))
    faces = _outward(vertices, faces)
    for i, v in enumerate(vertices):
        skin = surface(v[0], v[2])
        if skin is not None and v[1] >= skin: raise ValueError('The mouth edge cuts into the head: raise standoff')
    along = lambda v: max(-1.0, min(1.0, (v[0] - center_x) / half))
    corner = lambda t: _smoothstep(0, 1, t) ** 1.5
    lower_set = set(lower)

    def offsets(offset_of):
        # Each ring moves over the plates and is laid back on them (standoff in front of `surface`), so the edge
        # slides over the face instead of lifting off it or sinking in (the attached-parts check).
        moved = [_add(v, offset_of(v, i)) for i, v in enumerate(vertices)]
        for ring in rings['upper'] + rings['lower']:
            before = [sum(vertices[i][k] for i in ring) / sides for k in range(3)]
            after = [sum(moved[i][k] for i in ring) / sides for k in range(3)]
            if math.dist(before, after) < 1e-9: continue
            old_skin, new_skin = surface(before[0], before[2]), surface(after[0], after[2])
            if old_skin is None or new_skin is None: continue
            # Keep the ring as far in front of the face as it stood at rest.
            shift = before[1] + new_skin - old_skin - after[1]
            for i in ring: moved[i] = (moved[i][0], moved[i][1] + shift, moved[i][2])
        for cap, ring in caps: moved[cap] = tuple(sum(moved[i][k] for i in ring) / sides for k in range(3))
        return moved

    morphs = {}
    for suffix, sign in (('Left', 1), ('Right', -1)):
        morphs[f'mouthSmile{suffix}'] = offsets(lambda v, i, s=sign: _mul((s * smile_out, 0, smile_up), corner(s * along(v))))
        morphs[f'mouthFrown{suffix}'] = offsets(lambda v, i, s=sign: _mul((0, 0, -frown), corner(s * along(v))))
        morphs[f'mouthStretch{suffix}'] = offsets(lambda v, i, s=sign: _mul((s * stretch, 0, -.25 * stretch), corner(s * along(v))))

    def funnel_offset(v, i):
        t = along(v)
        middle = 1 - t * t
        apart = (-1 if i in lower_set else 1) * .3 * funnel * middle
        return (-pinch * half * t * (1 - middle * .5) * .5, 0.0, apart)
    morphs['mouthFunnel'] = offsets(funnel_offset)
    if jaw is not None:
        moved = jaw.targets([vertices[i] for i in lower], weight=1)
        target = list(vertices)
        for i, p in zip(lower, moved): target[i] = p
        morphs['jawOpen'] = target
    return {'vertices': vertices, 'faces': faces, 'morphs': morphs, 'upper': upper, 'lower': lower}


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


# Morph deltas at or below these are float noise, not motion: Blender writes normal deltas of ~1e-7 on every vertex of
# every shape key (about 1.2 MB on a talking head). A micron of position and 1e-4 of a unit normal (0.006 degrees) are
# far below anything a renderer shows.
MORPH_POSITION_EPSILON = 1e-6
MORPH_NORMAL_EPSILON = 1e-4


def _read_glb(path):
    data = Path(path).read_bytes()
    magic, version, length = struct.unpack_from('<4sII', data)
    if magic != b'glTF' or version != 2 or length != len(data): raise ValueError('Not a glTF 2.0 binary file')
    chunks, offset = [], 12
    while offset < len(data):
        size, kind = struct.unpack_from('<I4s', data, offset)
        chunks.append([kind, data[offset + 8:offset + 8 + size]])
        offset += 8 + size
    if not chunks or chunks[0][0] != b'JSON': raise ValueError('GLB has no leading JSON chunk')
    return json.loads(chunks[0][1].decode('utf-8')), chunks


def _write_glb(path, document, chunks):
    text = json.dumps(document, separators=(',', ':'), ensure_ascii=False).encode('utf-8')
    chunks[0][1] = text + b' ' * (-len(text) % 4)
    body = b''.join(struct.pack('<I4s', len(chunk), kind) + chunk for kind, chunk in chunks)
    path = Path(path)
    temporary = path.with_name(path.name + '.glb.tmp')
    temporary.write_bytes(struct.pack('<4sII', b'glTF', 2, 12 + len(body)) + body)
    temporary.replace(path)


def prune_glb_morphs(path, position_epsilon=MORPH_POSITION_EPSILON, normal_epsilon=MORPH_NORMAL_EPSILON):
    """Drop float-noise morph deltas from a GLB in place, storing the rest as sparse accessors.

    Blender's glTF exporter writes a NORMAL delta for every vertex of every shape key,
    and on a talking head nearly all of them are float noise (at most 1.5e-7), which
    also keeps its sparse-accessor option from ever kicking in: about 1.2 MB a head
    (E8 allows 3 MB). Every morph target delta whose largest component is at most
    `position_epsilon` (POSITION, meters) or `normal_epsilon` (NORMAL and TANGENT) is
    set to zero; a target with few deltas becomes a sparse accessor (the moving
    vertices' indices and values over glTF's zero fill; an all-zero one keeps one
    explicit zero, since Unreal's importer drops a primitive whose target accessor
    has neither data nor sparse values), and a dense one keeps a plain buffer view. POSITION min and
    max are recomputed, base attributes, indices, images and animation data are
    copied untouched, and every buffer view stays 4-byte aligned. `export_glb` runs
    it after Blender's exporter. Returns {'before', 'after' (bytes), 'targets'
    (target accessors rewritten), 'values' (deltas kept), 'dropped' (non-zero
    deltas dropped)}.
    """
    position_epsilon, normal_epsilon = _number(position_epsilon, 'Position epsilon', 0), _number(normal_epsilon, 'Normal epsilon', 0)
    before = Path(path).stat().st_size
    document, chunks = _read_glb(path)
    stats = {'before': before, 'after': before, 'targets': 0, 'values': 0, 'dropped': 0}
    binary_index = next((i for i, (kind, _) in enumerate(chunks) if kind == b'BIN\x00'), None)
    buffers, views, accessors = document.get('buffers', []), document.get('bufferViews', []), document.get('accessors', [])
    # Only a single self-contained buffer, with no extension that points into buffer views, is rewritten.
    if binary_index is None or len(buffers) != 1 or 'uri' in buffers[0] or any(v.get('buffer', 0) != 0 for v in views): return stats
    if any(key in (document.get('extensionsUsed') or []) for key in ('KHR_draco_mesh_compression', 'EXT_meshopt_compression')): return stats
    binary = chunks[binary_index][1]
    epsilon = {}
    for mesh in document.get('meshes', []):
        for primitive in mesh.get('primitives', []):
            for target in primitive.get('targets', []) or []:
                for attribute, index in target.items():
                    limit = position_epsilon if attribute == 'POSITION' else normal_epsilon
                    epsilon[index] = min(limit, epsilon.get(index, limit))
    shared = {i for i, a in enumerate(accessors) if i not in epsilon}
    for i in epsilon:
        a = accessors[i]
        if a.get('componentType') != 5126 or a.get('type') != 'VEC3' or a.get('normalized'): shared.add(i)
    targets = [i for i in epsilon if i not in shared]

    def view_bytes(index):
        v = views[index]
        start = v.get('byteOffset', 0)
        return binary[start:start + v['byteLength']], v.get('byteStride')

    def read(accessor):
        count = accessor['count']
        values = [(0.0, 0.0, 0.0)] * count
        if 'bufferView' in accessor:
            data, stride = view_bytes(accessor['bufferView'])
            stride, start = stride or 12, accessor.get('byteOffset', 0)
            values = [struct.unpack_from('<3f', data, start + i * stride) for i in range(count)]
        sparse = accessor.get('sparse')
        if sparse:
            fmt = {5121: 'B', 5123: 'H', 5125: 'I'}[sparse['indices']['componentType']]
            data, _ = view_bytes(sparse['indices']['bufferView'])
            where = struct.unpack_from(f'<{sparse["count"]}{fmt}', data, sparse['indices'].get('byteOffset', 0))
            data, _ = view_bytes(sparse['values']['bufferView'])
            flat = struct.unpack_from(f'<{3 * sparse["count"]}f', data, sparse['values'].get('byteOffset', 0))
            values = list(values)
            for n, i in enumerate(where): values[i] = flat[n * 3:n * 3 + 3]
        return values

    # Buffer views still used by anything other than the rewritten targets are copied as they are.
    used = set()
    for i, a in enumerate(accessors):
        if i in targets: continue
        if 'bufferView' in a: used.add(a['bufferView'])
        if 'sparse' in a: used.update((a['sparse']['indices']['bufferView'], a['sparse']['values']['bufferView']))
    for image in document.get('images', []):
        if 'bufferView' in image: used.add(image['bufferView'])
    out, new_views, remap = bytearray(), [], {}

    def append(blob, extra=None):
        out.extend(bytes(-len(out) % 4))
        view = {'buffer': 0, 'byteOffset': len(out), 'byteLength': len(blob)}
        if extra: view.update(extra)
        out.extend(blob)
        new_views.append(view)
        return len(new_views) - 1

    for index in sorted(used):
        data, _ = view_bytes(index)
        remap[index] = append(data, {k: v for k, v in views[index].items() if k not in ('buffer', 'byteOffset', 'byteLength')})
    for i, a in enumerate(accessors):
        if i in targets: continue
        if 'bufferView' in a: a['bufferView'] = remap[a['bufferView']]
        if 'sparse' in a:
            a['sparse']['indices']['bufferView'] = remap[a['sparse']['indices']['bufferView']]
            a['sparse']['values']['bufferView'] = remap[a['sparse']['values']['bufferView']]
    for image in document.get('images', []):
        if 'bufferView' in image: image['bufferView'] = remap[image['bufferView']]
    for i in targets:
        a = accessors[i]
        values = read(a)
        kept = []
        for n, v in enumerate(values):
            if max(abs(v[0]), abs(v[1]), abs(v[2])) > epsilon[i]: kept.append((n, v))
            elif v != (0.0, 0.0, 0.0): stats['dropped'] += 1
        for key in ('bufferView', 'byteOffset', 'sparse'): a.pop(key, None)
        count = a['count']
        if len(kept) * (12 + (2 if count < 65536 else 4)) < count * 12:
            # Unreal's glTF importer drops a primitive whose target accessor has neither data nor sparse values, so an
            # all-zero target keeps one explicit zero.
            stored = kept or [(0, (0.0, 0.0, 0.0))]
            wide = count >= 65536
            indices = struct.pack(f'<{len(stored)}{"I" if wide else "H"}', *[n for n, _ in stored])
            flat = struct.pack(f'<{3 * len(stored)}f', *[c for _, v in stored for c in v])
            a['sparse'] = {'count': len(stored), 'indices': {'bufferView': append(indices), 'componentType': 5125 if wide else 5123},
                           'values': {'bufferView': append(flat)}}
        elif kept:
            dense = [(0.0, 0.0, 0.0)] * count
            for n, v in kept: dense[n] = v
            a['bufferView'] = append(struct.pack(f'<{3 * count}f', *[c for v in dense for c in v]), {'target': 34962})
        if 'min' in a or 'max' in a or any(t.get('POSITION') == i for m in document.get('meshes', []) for p in m.get('primitives', []) for t in p.get('targets', []) or []):
            points = [v for _, v in kept] + ([(0.0, 0.0, 0.0)] if len(kept) < count else [])
            a['min'] = [min(p[k] for p in points) for k in range(3)]
            a['max'] = [max(p[k] for p in points) for k in range(3)]
        stats['targets'] += 1
        stats['values'] += len(kept)
    out.extend(bytes(-len(out) % 4))
    document['bufferViews'] = new_views
    buffers[0]['byteLength'] = len(out)
    chunks[binary_index][1] = bytes(out)
    _write_glb(path, document, chunks)
    stats['after'] = Path(path).stat().st_size
    return stats


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
              iris=26, pupil=12, socket=True, margin=6, hole=None, **options):
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
    keep those names (the ID render and the verifier find eyeballs by them).
    Returns a dict with the objects and the lid geometry report (radii, clearance,
    squint ratio).
    """
    from agent_meshes_author import shape_key
    if side not in _SIDES: raise ValueError("Eye side must be 'L' or 'R'")
    suffix = _SIDES[side]
    center = _vector(center, 3, 'Eye center')
    bone = rig.data.bones.get(f'eye_{side}')
    if bone is None: raise ValueError(f'Rig has no eye_{side} bone; build it with face_skeleton')
    pivot = rig.matrix_world @ bone.head_local
    if math.dist(tuple(pivot), center) > 1e-5: raise ValueError(f'eye_{side} pivots at {tuple(pivot)}, not at the eyeball center {center}')
    if hole is not None:
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
        if len(names) != 3 or any(not str(n).startswith(want) for n, want in zip(names, EYE_MATERIALS)):
            raise ValueError(f'eye_materials must be three materials named {", ".join(EYE_MATERIALS)} (in that order), got {names}')
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
            # Behind eye_hole's wall: the cup opens wider than the window, so no ray through the window can reach it.
            radius_s = (radius + lids['lower_radius']) / 2
            hole = eye_window(lids, margin)['polar_max'] + 4
        else:
            radius_s = radius * 1.02
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
    `min_chin_drop` (a fraction, 0.1 for the talking-heads bar) rejects a jaw whose
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


def _snap_to_plane(vertices, faces, level, fraction=.25):
    """Slide each vertex that lies within `fraction` of an edge's height from the plane z = `level` along that edge onto it.

    A vertex a hair off the mouth line makes `bisect_plane` cut a sliver beside it, which shades as a seam and folds
    when the jaw opens. Each such vertex moves along its crossing edge (the one to a neighbour on the other side that
    reaches the plane soonest), so it stays on the old surface. Returns the new vertex list.
    """
    vertices = [tuple(v) for v in vertices]
    neighbours = {}
    for face in faces:
        for a, b in zip(face, tuple(face[1:]) + (face[0],)):
            neighbours.setdefault(a, set()).add(b)
            neighbours.setdefault(b, set()).add(a)
    result = list(vertices)
    for i, v in enumerate(vertices):
        d = v[2] - level
        if d == 0: continue
        best = None
        for j in neighbours.get(i, ()):
            e = vertices[j][2] - level
            if (e > 0) == (d > 0) or e == 0: continue
            t = d / (d - e)
            if t < fraction and (best is None or t < best[0]): best = (t, j)
        if best is not None:
            t, j = best
            moved = _add(v, _mul(_sub(vertices[j], v), t))
            result[i] = (moved[0], moved[1], level)
    return result


def slit_mouth(obj, mouth_z, half_width, center_x=0.0, front_y=None):
    """Cut a closed mouth slit into a skin mesh along z = mouth_z for |x - center_x| < half_width on the front.

    Bisects the mesh at the mouth line and splits the edges on that line so the lips
    can part (the corners stay joined). Vertices closer to the line than a quarter of
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
    on_line = lambda v: abs(v.co.z - mouth_z) < SEAM_TOLERANCE and abs(v.co.x - center_x) < half_width - 1e-9 and v.co.y < front_y
    edges = [e for e in bm.edges if all(on_line(v) for v in e.verts)]
    bmesh.ops.split_edges(bm, edges=edges)
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


def _sharp_edges(vertices, faces, angle):
    """Edges (vertex pairs) whose two faces turn by more than `angle` degrees: a skin's fold into an eye wall, a lid's rim."""
    normals = []
    for face in faces:
        n = (0.0, 0.0, 0.0)
        for i in range(1, len(face) - 1):
            n = _add(n, _cross(_sub(vertices[face[i]], vertices[face[0]]), _sub(vertices[face[i + 1]], vertices[face[0]])))
        length = math.hypot(*n)
        normals.append(_mul(n, 1 / length) if length > 1e-30 else n)
    owners, limit = {}, math.cos(math.radians(angle))
    for index, face in enumerate(faces):
        for a, b in zip(face, face[1:] + face[:1]): owners.setdefault((min(a, b), max(a, b)), []).append(index)
    return [edge for edge, pair in owners.items() if len(pair) == 2 and _dot(normals[pair[0]], normals[pair[1]]) < limit]


def join_face_parts(parts, name='face', rig=None, bone='head', sharp_angle=60):
    """Join every morph-bearing face part (skin, lids, teeth, tongue, cavity) into ONE mesh object.

    Unreal discards all morph names in a file when a name repeats across glTF
    meshes, so a face whose skin and lower teeth both carry `jawOpen` must be one
    mesh: this exports as one glTF mesh with one primitive per material, every
    primitive carrying the same morph names. Reads each part's world-space rest
    positions, polygons, material slots, smooth flags and shape keys; parts lacking
    a key keep their rest shape in it. The parts are removed (keep the source
    recipe, not the objects); UV maps are not carried. With `rig`, the result is
    bound 100% to `bone`. Eyeballs stay separate: they move with their eye bones.
    Edges where the surface turns by more than `sharp_angle` degrees (the fold from
    skin into an `eye_hole` wall, a lid's rim) are marked sharp, so smooth shading
    does not smear across them (None keeps every edge smooth).
    """
    import bpy
    geometry, smooth = [], []
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
