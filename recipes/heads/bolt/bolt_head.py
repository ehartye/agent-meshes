"""Bolt: a riveted tin-can robot head (arkit-face/1), modelled from a 2D concept sheet.

Only Bolt's character lives here: proportions, colors, parameters and emotion tuning. The rig comes from the
agent-meshes face helpers (agent_meshes_author / agent_meshes_face):
- camera-lens eyes recessed in sealed `shutter_hole` wells, closed by tinted shutter blades (blink, squint, wide);
- rigid brow plates (`brow_plate_geometry`) with rivets that ride them;
- the skull is the whole tin can, sides and back included, with a rolled lid seam round its sides and back and a lap
  seam down the back. The face plate's outline is a rolled rim. The chin plate is its own part from the front: darker,
  brushed tin, a dark band along its top edge (the mouth line runs on across it), a dark seam round its sides and bottom,
  a rivet in each corner, framed by the jaw box's dark rolled rim. It is the front of a separate jaw box (a
  rolled U wall for cheeks and floor, and a back plate) that jawOpen drops straight down out of the can (`JawHinge`
  with no turn); the box's walls reach back up inside the can at every opening, so from the side, back and below the
  jaw is closed metal. It hangs on telescoping side links (sleeve, middle tube, rod), each stage rigid, pinned to
  brackets on the can and on the jaw. Behind the plate the can's front is squared off, so the plate slides down a
  flat face;
- the mouth is ONE deformable rubber aperture between rigid metal. A fixed window is cut in the can's front around the
  mouth line; a static tin frame fills its outer part flush with the can, and a dark rubber mouth panel fills the rest
  (PANEL_HALF to each side, PANEL_UP above the mouth line; below the line, the cheeks beside the mouth corners). The
  slit between the rubber panel's lower edge and the chin plate's top edge is the mouth; a second rubber panel below
  the slit, behind the plate's top edge, rides the jaw and is the lower lip's skin. Every mouth shape is one
  displacement field of the rest face plane that fades to zero at the rubber panel's border, applied alike to the
  rubber panels, the rubber lip loop and the grilles, so the rubber always borders the dark opening and the metal
  (can, tin frame, chin plate and its band) never moves under a mouth shape (invariant 8): mouthSmile lifts the
  corners into a U, mouthFrown lifts the middle into an arch whose ends stay on the plate's edge, mouthStretch widens
  the slit and parts it into a flat grimace, and mouthFunnel pulls the corners in and lifts the middle into an O with
  a thicker rubber rim. No mouth shape moves a lip below its rest line, so nothing slides over the plate. The plate
  moves rigidly under jawOpen only. A dark box behind the window (its floor rides the jaw) is all the opening can show
  besides the teeth;
- the upper grille hangs from the skull behind the insert; the lower grille is bolted to the chin plate and moves
  exactly with it under jawOpen (invariant 8). Both hide behind the closed plate and insert at rest. The upper row
  shows its UPPER_SHOW bite below the upper lip as soon as the jaw drops; the lower row stands LOWER_SHOW above the
  plate's rim and comes out below it once the drop passes both;
- a ribbed neck collar under the can (material `body_collar`, so chin measurements can ignore it);
- static trim (rims, seams, rivets, ears, antenna, the links' hangers and sleeves) is its own mesh, bound to the head,
  so it carries no morph data.
Blender coordinates: Z up, meters, the face looks down -Y, the character's left is +X.
Concept-sheet units (a 200 x 200 drawing) map to meters with U; `cx`/`cz` convert a drawing point.
"""
import math
from agent_meshes_author import (
    CANONICAL_EMOTIONS, JawHinge, add_jaw_open, bind_rigid, brow_plate_geometry, build_eye, ellipsoid_geometry,
    face_contract, face_skeleton, folded_faces, front_surface, join_face_parts, join_geometry, material,
    mesh_from_geometry, shape_key, shutter_hole, sweep_mesh, teeth_row_geometry,
)
# TOOL-GAP: agent-meshes has no public cut for an arbitrary level function (cut_hole only cuts ellipsoids). Bolt needs
# rounded-rectangle cuts (the mouth window in the can, the plate's rounded corners), so it imports the private helper
# cut_hole and shutter_hole are built on. agent-meshes should export it as a public `clip_mesh(vertices, faces, level)`
# (or a rounded-rectangle cut).
from agent_meshes_face import _clip

U = .0017                                        # meters per concept-sheet unit
cx = lambda x: (x - 100) * U                     # drawing x -> X (character's left is screen right, +X)
cz = lambda y: .15 - (y - 95) * U                # drawing y -> Z

# The tin can: housing 120 x 122 units with rounded edges, 160 mm deep.
CENTER, HALF, ROUND = (0, 0, .15), (60 * U, .08, 61 * U), 7
FRONT_Y = CENTER[1] - HALF[1]
# Camera-lens eyes: sockets at (76, 84) and (124, 84), lens barrel 11.4 units; recessed so the blades slide behind the plate.
EYE_RADIUS = .018
EYE_L = (cx(124), -.052, cz(84))
EYE_R = (-EYE_L[0], EYE_L[1], EYE_L[2])
HOLE_RADIUS = 1.45 * EYE_RADIUS                  # the dark lens well around each lens
SHUTTERS = dict(
    aperture=HOLE_RADIUS + .003,                 # blades wider than the well: their sides hide behind the plate
    opening=(.7, 1.0),                           # a strip of upper shutter across the lens top at rest, lower one just below it
    meet=0, squint=.38, squint_upper_share=.43,  # squint closes them partway from top and bottom
    wide=(.5, .1),                               # eyeWide retracts them to bare the whole lens
    blade_height=.0425,                          # tall enough that a blink fills the whole well
)
LENS = dict(iris=50, pupil=19)                   # glass disk .77 of the barrel, aperture .33
MOUTH_Z, MOUTH_HALF_WIDTH = cz(120), 28 * U      # the chin plate's rim is the mouth line
JAW_DROP = 30 * U                                # the concept drops the chin plate 30 units at jawOpen = 1

# The chin plate: a front plate 2 * PLATE_HALF wide from the mouth line down to PLATE_BOTTOM (4 units below the can, as
# drawn), PLATE_THICK thick and PLATE_PROUD proud of the can's front, with rounded bottom corners.
PLATE_HALF, PLATE_BOTTOM, PLATE_THICK, PLATE_PROUD = 50.5 * U, cz(160), .003, .0005
PLATE_CORNERS = (.001, 8 * U)                    # top, bottom corner radii
# The plate reads as its own part from the front (concept cells 01, 13, 14): a darker brushed finish (chin_tin), a dark
# top-edge band PLATE_EDGE tall (the mouth line runs on across the whole plate at rest, and it is the lip the lower
# grille stands on when the jaw drops), a dark seam round its sides and bottom and a rivet in each corner.
PLATE_EDGE, PLATE_SEAM = .0016, .0008
# The jaw housing: the chin plate is the front of a box that drops out of the can. A HOUSING_WALL thick U-shaped wall
# (both cheeks and the floor) wraps the plate's sides and bottom with a rolled front and back edge; a back plate closes it
# HOUSING_BACK. The cheeks run up to HOUSING_TOP, high enough that at a full drop their tops are still inside the can,
# so from the side, back and below the jaw is one closed box and never a card. The cheeks' rolled front edges run up
# past the mouth line under the side links (the rods ride them); the top stays below the upper grille's root, since
# nothing jawOpen moves may rise above the upper gum line (rig contract).
HOUSING_WALL, HOUSING_BACK, HOUSING_TOP = .003, -.045, MOUTH_Z + .011
# The face plate's rolled rim: a bead of FACE_RIM radius along its outline.
FACE_RIM = .0018
# The telescoping side links, over the housing's rolled front edges: a sleeve hung from a bracket on the can, a middle
# tube following LINK_SHARE of the drop and a rod bolted to the jaw. Each stage's [bottom, top] at rest; the moving
# stages top out at the housing's top (below the gum line), and at a full drop each stage still overlaps the next.
LINK_SHARE = .45
LINK_STAGES = ((.090, MOUTH_Z + .0195), (.088, HOUSING_TOP - .0021), (.0815, HOUSING_TOP - .0005))   # capsule ends included
LINK_RADII = (.0022, .0017, .0012)
LINK_HANGER_Z, LINK_FOOT_Z = MOUTH_Z + .0145, .0815

# ---- the deformable mouth aperture
# The window in the can's front: WINDOW_HALF to each side, WINDOW_UP above the mouth line, down past the plate's rim at
# full drop. It is filled flush, INSERT_INSET behind the can's front and INSERT_MARGIN under the window's edges (so no
# seam opens), by a static tin frame and, inside it, the rubber mouth panel: PANEL_HALF to each side and PANEL_UP above
# the mouth line (clear of the cheek vents), and below the line the cheeks beside the corners down to the window's foot.
WINDOW_HALF, WINDOW_UP = .074, .026
WINDOW_BOTTOM = MOUTH_Z - .068
INSERT_MARGIN, INSERT_INSET = .002, .00015
PANEL_HALF, PANEL_UP = .060, .019
# The mouth-shape fields move rubber only. Across the face: each corner's field is flat CORNER_FLAT past the corner and
# fades out linearly by FIELD_EDGE, the rubber panel's side edge (so the tin frame never moves). Up and down: full at the
# mouth line, fading out linearly through the rubber panel above it (UPPER_FADE, to its top edge) and through the lower
# rubber panel below it (LOWER_FADE, hidden behind the plate's top edge).
CORNER_FLAT = .002
FIELD_EDGE = PANEL_HALF
UPPER_FADE = (MOUTH_Z + .003, MOUTH_Z + PANEL_UP)
LOWER_FADE = (MOUTH_Z - .002, MOUTH_Z - .022)
LOWER_PANEL_BOTTOM = MOUTH_Z - .024                    # the lower rubber panel's foot, hidden behind the plate
# Per side, at weight 1: the corner moves out by `out` and up by `lift`; the middle of the slit parts by `upper` (the
# upper lip up) and `lower` (the lower lip down) over the slit's profile (round: 1 - t^2, flat: 1 - t^4). No field moves
# a lip below its rest line: the lips lie in front of the chin plate's edge, which stays straight (the concept).
SHAPES = {
    'mouthSmile': dict(out=.0035, lift=.011, upper=.0009, lower=0.0, profile=2),     # the concept's U grin
    'mouthStretch': dict(out=.008, lift=0.0, upper=.0012, lower=0.0, profile=4),     # a wide, flat grimace
}
# mouthFrown: the middle of the slit rises into the concept's arch by FROWN_ARCH (both sides together); the corners stay
# on the plate's edge. Each side carries the arch on its own half, the two blending across the middle.
FROWN_ARCH = .009
# mouthFunnel: the corners come in by `pinch` and the middle parts by `upper`/`lower` over 1 - t^2, an O.
FUNNEL = dict(pinch=.026, upper=.007, lower=0.0)
FUNNEL_TEETH = .25                               # the grilles take only this share of the pinch: the O frames whole teeth
LIP_RADIUS = .0025                               # the rubber lip loop (the concept's gasket stroke)
FUNNEL_THICKEN = .7                              # mouthFunnel thickens the rubber loop into the O's rim by this share

# The grilles, bold like the concept's. The upper row hangs behind the insert from UPPER_TOP to its bite UPPER_SHOW below
# the mouth line; the lower row stands on the plate LOWER_SHOW above the plate's rim, set back behind the upper row.
# Both follow the corner fields of smile, frown and stretch (the teeth curve with the grin), not the lips' parting.
TEETH_HALF_WIDTH = .042
# teeth_row_geometry spaces teeth by arch angle; a flat grille takes a 20 degree arch, wide enough to be ~straight, so the
# eight teeth are evenly spaced (on a wide arch the end teeth crowd together). TEETH_ARCH is that arch's half-width.
TEETH_WIDTH, TEETH_SPAN = .0082, 20
TEETH_ARCH = (TEETH_HALF_WIDTH - TEETH_WIDTH / 2) / math.sin(math.radians(TEETH_SPAN / 2) * 7 / 8)
UPPER_TOP, UPPER_SHOW = MOUTH_Z + .012, .015
LOWER_ROOT, LOWER_SHOW = MOUTH_Z - .012, .007
UPPER_DEPTH, LOWER_DEPTH, TEETH_THICK = .003, .0068, .0025   # each row's front face, behind the can's front
TEETH_BEVEL = .0008                              # the chamfer round each block's front face
# Each block's sides draw in by TEETH_DRAFT from the bevel to the back face (a stamping draft). Without it the sides lie
# along the front camera's rays, and a multisampled render rasterizes those edge-on slivers with depths far in front of
# the block, so the hidden grille shows through the closed lip, slot and plate as thin light lines.
TEETH_DRAFT = .0006
# The dark lining behind the window, open to the front just behind the insert. Above the mouth line it is only
# CAVITY_ROOF deep: the eyes' shutter blades hang down behind the insert to the mouth line, CAVITY_ROOF + .0005 back.
# Below the line it runs CAVITY_DEPTH back, and its floor, CAVITY_FLOOR at rest, rides the jaw.
CAVITY_FRONT, CAVITY_ROOF, CAVITY_DEPTH, CAVITY_FLOOR = .0004, .006, .028, MOUTH_Z - .012

EMOTIONS = {name: dict(curves) for name, curves in CANONICAL_EMOTIONS.items()}
# Happy is the concept's U grin: the concept's small drop (.25) bares the upper grille in a narrow U; the lower row stays
# hidden behind it (a sliver of both rows reads as a checkered grid).
EMOTIONS['happy'].update(jawOpen=.25)
# The concept's surprised mouth is a tall O with both grille rows showing: a little more drop than the canonical .6.
EMOTIONS['surprised'].update(jawOpen=.7)
# Scared bares the upper grille in a wide, clenched grimace (a little under the concept's .3, so the lower lip covers
# the upper row's tips): the lower row stays behind the upper one and never interleaves with it into a grid.
EMOTIONS['scared'].update(mouthStretchLeft=1, mouthStretchRight=1, jawOpen=.25)


def smooth(a, b, x):
    t = min(1.0, max(0.0, (x - a) / (b - a)))
    return t * t * (3 - 2 * t)


def srgb(hex_color):
    """A concept-sheet color (#rrggbb, sRGB) as linear RGB for material().

    TOOL-GAP: agent-meshes material() takes linear RGB only; it should accept an sRGB hex color.
    """
    def lin(c):
        c /= 255
        return c / 12.92 if c <= .04045 else ((c + .055) / 1.055) ** 2.4
    return tuple(lin(int(hex_color[i:i + 2], 16)) for i in (1, 3, 5))


def glow(mat, hex_color, strength):
    # TOOL-GAP: agent-meshes material() has no emission (or clearcoat) input; a lens glass / bulb material belongs there.
    shader = mat.node_tree.nodes.get('Principled BSDF')
    shader.inputs['Emission Color'].default_value = (*srgb(hex_color), 1)
    shader.inputs['Emission Strength'].default_value = strength
    return mat


def on_surface(surface, x, z, lift=0.0):
    """The point of a front_surface at (x, z), `lift` in front of it.

    TOOL-GAP: front_surface should offer this (a surface point with an offset along the view axis).
    """
    y = surface(x, z)
    if y is None: raise ValueError(f'No face surface at ({x:.3f}, {z:.3f})')
    return (x, y - lift, z)


def as_part(geometry, materials=None):
    """A sweep_mesh (vertices, faces) tuple or geometry dict as a join_geometry part."""
    part = {'vertices': geometry[0], 'faces': geometry[1]} if isinstance(geometry, tuple) else dict(geometry)
    if materials is not None: part['materials'] = materials
    return part


def joined(*geometries):
    return join_geometry([as_part(g) for g in geometries])


def mesh(name, geometry, mats, smooth=True):
    return mesh_from_geometry(name, as_part(geometry), mats, smooth=smooth)


def ring_tube(points, radius, radial_segments=10):
    """A closed tube (a torus-like loop) through `points`, with no cap or seam where it closes.

    TOOL-GAP: sweep_mesh only sweeps open paths with capped ends; agent-meshes should offer a closed-loop sweep.
    """
    vertices, _ = sweep_mesh(list(points) + [points[0]], [(radius, radius)] * (len(points) + 1), radial_segments=radial_segments)
    n, s = len(points), radial_segments
    vertices = vertices[:n * s]                  # the last ring repeats the first: weld it
    faces = [(i * s + j, i * s + (j + 1) % s, (i + 1) % n * s + (j + 1) % s, (i + 1) % n * s + j) for i in range(n) for j in range(s)]
    return {'vertices': vertices, 'faces': faces}


def rigid_follow(rest, moved, points):
    """Carry `points` with a part whose morph turns it rigidly in the face plane (XZ) and moves it.

    `rest`/`moved` are the part's vertices before and after the morph.
    TOOL-GAP: brow_plate_geometry should accept attachments (rivets) or return the transform of each morph.
    """
    a = rest[0]
    b = max(rest, key=lambda p: math.hypot(p[0] - a[0], p[2] - a[2]))
    ia, ib = rest.index(a), rest.index(b)
    turn = (math.atan2(moved[ib][2] - moved[ia][2], moved[ib][0] - moved[ia][0])
            - math.atan2(b[2] - a[2], b[0] - a[0]))
    c, s = math.cos(turn), math.sin(turn)
    out = []
    for p in points:
        dx, dz = p[0] - a[0], p[2] - a[2]
        out.append((moved[ia][0] + c * dx - s * dz, p[1] + moved[ia][1] - a[1], moved[ia][2] + s * dx + c * dz))
    return out


def rivet(surface, x, z, radius=2 * U):
    # TOOL-GAP: agent-meshes should provide surface-aligned rivets/bolts; these domes are axis-aligned, so they sit
    # only on the flat of the plates.
    return ellipsoid_geometry(on_surface(surface, x, z, -.0009), (radius, .45 * radius + .0009, radius), rings=6, segments=10)


def line_on(surface, points, radius, lift=0.0):
    # TOOL-GAP: agent-meshes should provide panel lines / seams that follow a surface (a groove or inlaid line helper).
    return sweep_mesh([on_surface(surface, x, z, lift) for x, z in points], [(radius, radius)] * len(points), radial_segments=6)


def rounded_rect(half_x, bottom, top, corner_top, corner_bottom):
    """A level function of a point, >= 0 inside a rounded rectangle in the face plane (XZ) centred on x = 0.

    TOOL-GAP: agent-meshes has no 2D outline / rounded-rectangle level helper for cutting plates and openings.
    """
    mid, half_z = (bottom + top) / 2, (top - bottom) / 2

    def level(p):
        r = corner_top if p[2] > mid else corner_bottom
        qx, qz = abs(p[0]) - half_x + r, abs(p[2] - mid) - half_z + r
        return -(math.hypot(max(qx, 0), max(qz, 0)) + min(max(qx, qz), 0) - r)
    return level


def face_grid(xs, zs, depth):
    """A front-facing (-Y) grid patch over the XZ samples, at y = depth(x)."""
    n = len(xs)
    vertices = [(x, depth(x), z) for z in zs for x in xs]
    faces = [(j * n + i, j * n + i + 1, (j + 1) * n + i + 1, (j + 1) * n + i) for j in range(len(zs) - 1) for i in range(n - 1)]
    return vertices, faces


def samples(low, high, step, extra=()):
    count = max(1, math.ceil((high - low) / step))
    extra = {round(e, 7) for e in extra if low < e < high}
    regular = [round(low + (high - low) * k / count, 7) for k in range(count + 1)]
    # A regular sample within a third of a step of an extra one would leave a sliver: the extra one replaces it.
    regular = [v for k, v in enumerate(regular) if k in (0, count) or all(abs(v - e) > step / 3 for e in extra)]
    return sorted(set(regular) | extra)


def boundary_edges(faces):
    """The open edges of a patch, each directed as its face runs it."""
    directed = {}
    for face in faces:
        for a, b in zip(face, face[1:] + face[:1]): directed[(a, b)] = True
    return [(a, b) for (a, b) in directed if (b, a) not in directed]


def slab(vertices, faces, shift):
    """Close a front patch into a solid plate: a back copy moved by `shift` and walls along its open edges.

    TOOL-GAP: agent-meshes can thicken a head split by a plane (split_plates) but not an arbitrary cut patch.
    """
    n = len(vertices)
    back = [(x + shift[0], y + shift[1], z + shift[2]) for x, y, z in vertices]
    walls = [(b, a, a + n, b + n) for a, b in boundary_edges(faces)]
    return {'vertices': list(vertices) + back, 'faces': list(faces) + [tuple(i + n for i in reversed(f)) for f in faces] + walls}


def mouth_line_front(vertices, faces):
    """The can's front at the mouth line as a function of x (sampled from the mesh, interpolated)."""
    front = front_surface(vertices, faces)
    xs = [HALF[0] * (k / 100 - 1) for k in range(201)]
    ys = [front(x, MOUTH_Z) for x in xs]

    def depth(x):
        t = (x + HALF[0]) / (2 * HALF[0]) * 200
        k = min(199, max(0, int(t)))
        a, b = ys[k], ys[k + 1]
        if a is None or b is None: return None
        return a + (b - a) * (t - k)
    return depth


def square_chin(vertices, depth):
    """Square off the can's front below the mouth line, behind the chin plate: the mouth-line section runs straight down.

    The plate drops down this flat face, so the links and the plate lie on it at every opening; the can keeps its
    rounded silhouette in a front view (only y moves). Front-facing points move all the way; the bottom face stays.
    TOOL-GAP: agent-meshes has no way to flatten or extrude a region of a head blank.
    """
    n = ROUND
    out = []
    for x, y, z in vertices:
        if z >= MOUTH_Z or y >= CENTER[1]:
            out.append((x, y, z)); continue
        target = depth(x)
        gx, gy, gz = ((abs(p - c) / h) ** (n - 1) / h for p, c, h in zip((x, y, z), CENTER, HALF))
        facing = gy / math.sqrt(gx * gx + gy * gy + gz * gz)
        w = smooth(.1, .35, facing) * (1 - smooth(PLATE_HALF + .002, PLATE_HALF + .012, abs(x)))
        out.append((x, y + (target - y) * w, z) if target is not None and target < y else (x, y, z))
    return out


# ---------------------------------------------------------------- the deformable mouth aperture
# TOOL-GAP: agent-meshes should provide this deformable-aperture mouth for rigid-plate heads (robots, puppets with a
# chin plate): a fixed window in the head filled by an insert whose slit is the mouth, one displacement field per mouth
# shape applied alike to the insert, the jaw plate's top band, a rubber lip loop that borders the slit, the teeth rows and
# the cavity, so the opening's outline, its rim and what shows through it can never come apart. Today only
# rubber_mouth_geometry exists, which bends a lip tube over a fixed opening. The helpers below are that tool, head-local.

def _lin(z, full, zero):
    """1 at `full`, 0 at `zero`, linear between (either order)."""
    return min(1.0, max(0.0, (z - zero) / (full - zero)))


def _corner(u):
    """(move, lift) weights of a corner's field at u = the distance from the middle toward that corner.

    Linear (move) and quadratic (lift, so the slit curves into a U or an arch) to the corner, flat CORNER_FLAT past it,
    then fading out linearly by FIELD_EDGE: the cheeks beside the corner compress or stretch, never fold.
    """
    if u <= 0: return 0.0, 0.0
    if u <= MOUTH_HALF_WIDTH:
        t = u / MOUTH_HALF_WIDTH
        return t, t * t
    fade = _lin(u, MOUTH_HALF_WIDTH + CORNER_FLAT, FIELD_EDGE)
    return fade, fade


def lip_field(name, x):
    """A mouth shape at the mouth line at x: (dx, dz, upper, lower) at weight 1.

    dx, dz move both edges of the slit and whatever lies at the line (the corners, the teeth); `upper` lifts only the
    upper lip and `lower` lowers only the lower lip (the parting), both zero at and beyond the corners so the slit's
    ends stay closed. Every field is linear in its weight, like the morphs.
    """
    a = abs(x)
    t = min(1.0, a / MOUTH_HALF_WIDTH)
    inside = a < MOUTH_HALF_WIDTH
    if name == 'mouthFunnel':
        move, _ = _corner(a)
        o = 1 - t * t if inside else 0.0
        return -math.copysign(FUNNEL['pinch'] * move, x), 0.0, FUNNEL['upper'] * o, FUNNEL['lower'] * o
    base, side = (name[:-4], 1) if name.endswith('Left') else (name[:-5], -1)
    if base == 'mouthFrown':
        share = min(1.0, max(0.0, .5 + side * x / MOUTH_HALF_WIDTH))
        return 0.0, (FROWN_ARCH * (1 - t * t) * share if inside else 0.0), 0.0, 0.0
    shape = SHAPES[base]
    move, lift = _corner(side * x)
    p = 1 - t ** shape['profile'] if inside else 0.0
    return side * shape['out'] * move, shape['lift'] * lift, shape['upper'] * p, shape['lower'] * p


MOUTH_SHAPES = [f'{base}{side}' for base in ('mouthSmile', 'mouthFrown', 'mouthStretch') for side in ('Left', 'Right')] + ['mouthFunnel']


def aperture_targets(points, name, part):
    """Morph targets of `name` for the rest `points` of one part of the aperture.

    part: 'insert' (the rubber panel. Above the line: the upper lip's skin, fading up; below it: the cheeks, whose side
    edges are the corners, so they move across in one piece and fade only up and down), 'lower' (the lower rubber
    panel, the lower lip's skin, fading down), 'teeth' (the corner fields only, at full weight).
    """
    out = []
    for x, y, z in points:
        dx, dz, up, low = lip_field(name, x)
        if part == 'teeth':
            out.append((x + dx * (FUNNEL_TEETH if name == 'mouthFunnel' else 1.0), y, z + dz))
        elif part == 'lower':
            out.append((x + dx, y, z + (dz + low) * _lin(z, *LOWER_FADE)))
        elif z >= MOUTH_Z - 1e-9:
            w = _lin(z, *UPPER_FADE)
            out.append((x + dx * w, y, z + (dz + up) * w))
        else:
            out.append((x + dx, y, z + dz * _lin(z, *LOWER_FADE)))
    return out


def add_aperture_shapes(obj, part):
    rest = [tuple(v.co) for v in obj.data.vertices]
    faces = [tuple(p.vertices) for p in obj.data.polygons]
    for name in MOUTH_SHAPES:
        targets = aperture_targets(rest, name, part)
        folded = folded_faces(rest, targets, faces)
        if folded: raise ValueError(f'{name} folds {len(folded)} faces of {obj.name}')
        shape_key(obj, name, targets)


def mouth_insert(surface, fallback):
    """What fills the window: a grid on the can's front with the mouth cut out under the line, split into the static
    tin frame (outside the rubber panel's rectangle) and the rubber mouth panel: (frame, panel) geometries.

    Above the mouth line it spans the whole window; below it only the cheeks beside the corners, so the slit between
    the panel's lower edge and the plate's top edge (from corner to corner) is the mouth, and the cheeks' side edges are
    the opening's sides when the jaw drops. The frame and the panel share their border's positions exactly.
    """
    edge = WINDOW_HALF + INSERT_MARGIN
    xs = samples(-edge, edge, .0025, (-MOUTH_HALF_WIDTH, MOUTH_HALF_WIDTH, -PANEL_HALF, PANEL_HALF))
    zs = samples(WINDOW_BOTTOM - INSERT_MARGIN, MOUTH_Z + WINDOW_UP + INSERT_MARGIN, .003, (MOUTH_Z, MOUTH_Z + PANEL_UP))
    n = len(xs)
    grid = []
    for z in zs:
        for x in xs:
            # below the mouth line the cheeks stay on the squared-off chin's plane, even past the can's rounded bottom rim
            y = fallback(x) if z < MOUTH_Z - .002 else surface(x, z)
            if y is None: y = fallback(x)
            grid.append((x, y + INSERT_INSET, z))
    cells = []
    for j in range(len(zs) - 1):
        for i in range(n - 1):
            if abs((xs[i] + xs[i + 1]) / 2) < MOUTH_HALF_WIDTH and (zs[j] + zs[j + 1]) / 2 < MOUTH_Z: continue
            rubber = abs((xs[i] + xs[i + 1]) / 2) < PANEL_HALF and (zs[j] + zs[j + 1]) / 2 < MOUTH_Z + PANEL_UP
            cells.append((rubber, (j * n + i, j * n + i + 1, (j + 1) * n + i + 1, (j + 1) * n + i)))

    def part(rubber):
        chosen = [c for r, c in cells if r == rubber]
        used = sorted({k for c in chosen for k in c})
        index = {k: i for i, k in enumerate(used)}
        return {'vertices': [grid[k] for k in used], 'faces': [tuple(index[k] for k in c) for c in chosen]}
    return part(False), part(True)


def lower_panel(surface, fallback):
    """The lower lip's rubber skin: a strip under the slit, flush with the rubber panel's cheeks (it spans the slit from
    corner to corner and meets their side edges at rest) and behind the chin plate's top edge, riding the jaw rigidly.
    The mouth shapes lift its top edge (the slit's lower edge) above the plate's edge, fading out toward its foot,
    which stays hidden behind the plate; across the face it moves with the cheeks' side edges."""
    xs = samples(-MOUTH_HALF_WIDTH, MOUTH_HALF_WIDTH, .0025)
    zs = samples(LOWER_PANEL_BOTTOM, MOUTH_Z, .002, LOWER_FADE)
    n = len(xs)
    depth = lambda x, z: (fallback(x) if z < MOUTH_Z - .002 else surface(x, z)) or fallback(x)   # as mouth_insert's
    vertices = [(x, depth(x, z) + INSERT_INSET, z) for z in zs for x in xs]
    faces = [(j * n + i, j * n + i + 1, (j + 1) * n + i + 1, (j + 1) * n + i) for j in range(len(zs) - 1) for i in range(n - 1)]
    return {'vertices': vertices, 'faces': faces}


def insert_returns(fallback):
    """The mouth insert's side returns: below the can's front rim the window's cut runs round the rounded bottom edge,
    back from the insert's flat face, so a wall at each side of the insert closes that wedge back to the cut's depth.
    Static (the aperture fields fade out before the window's edge)."""
    vertices, faces = [], []
    zs = samples(WINDOW_BOTTOM - INSERT_MARGIN, MOUTH_Z - .03, .004)
    for side in (1, -1):
        x = side * (WINDOW_HALF + INSERT_MARGIN)
        base = len(vertices)
        for z in zs: vertices += [(x, fallback(x) + INSERT_INSET, z), (x, HOUSING_BACK - .005, z)]
        for k in range(len(zs) - 1):
            a, b, c, d = base + 2 * k, base + 2 * k + 1, base + 2 * k + 3, base + 2 * k + 2
            faces.append((a, b, c, d) if side > 0 else (d, c, b, a))
    return {'vertices': vertices, 'faces': faces}


def capsule(points, radius, radial_segments=10, cap_rings=3):
    """A rubber tube through the open path `points` with rounded ends: (vertices, faces, rings).

    `rings` gives, for each ring of `radial_segments` vertices, (path index, offset of the ring's centre from that path
    point): the end caps' rings hang off the end points. TOOL-GAP: sweep_mesh caps its ends flat; agent-meshes should
    offer round (capsule) ends.
    """
    def unit(v):
        length = math.hypot(*v)
        return tuple(c / length for c in v)
    head = unit(tuple(a - b for a, b in zip(points[0], points[1])))
    tail = unit(tuple(a - b for a, b in zip(points[-1], points[-2])))
    angles = [math.pi / 2 * k / (cap_rings + 1) for k in range(cap_rings, 0, -1)]
    centers, radii, rings = [], [], []
    for a in angles:
        off = tuple(c * radius * math.sin(a) for c in head)
        centers.append(tuple(p + o for p, o in zip(points[0], off))); radii.append(radius * math.cos(a)); rings.append((0, off))
    for k, p in enumerate(points):
        centers.append(tuple(p)); radii.append(radius); rings.append((k, (0.0, 0.0, 0.0)))
    for a in reversed(angles):
        off = tuple(c * radius * math.sin(a) for c in tail)
        centers.append(tuple(p + o for p, o in zip(points[-1], off))); radii.append(radius * math.cos(a)); rings.append((len(points) - 1, off))
    vertices, faces = sweep_mesh(centers, [(r, r) for r in radii], radial_segments=radial_segments, initial_normal=(0, -1, 0))
    return vertices, faces, rings, centers


def tube_targets(tube, points, moved, thicken=1.0, radial_segments=10):
    """Carry a capsule with its path: each ring follows its path point, turned in the face plane with the path's tangent.

    `moved` is the path at the morph's weight 1; `thicken` scales every ring about its centre (mouthFunnel's thick rim).
    """
    vertices, _, rings, centers = tube
    n = len(points)

    def turn(k):
        a, b = max(0, k - 1), min(n - 1, k + 1)
        before = math.atan2(points[b][2] - points[a][2], points[b][0] - points[a][0])
        after = math.atan2(moved[b][2] - moved[a][2], moved[b][0] - moved[a][0])
        return after - before

    out = []
    for r, (k, off) in enumerate(rings):
        phi = turn(k) if n > 1 else 0.0
        c, s = math.cos(phi), math.sin(phi)
        rot = lambda v: (c * v[0] - s * v[2], v[1], s * v[0] + c * v[2])
        center = tuple(m + o for m, o in zip(moved[k], rot(off)))
        for j in range(radial_segments):
            v = vertices[r * radial_segments + j]
            rel = rot(tuple(a - b for a, b in zip(v, centers[r])))
            out.append(tuple(cc + thicken * q for cc, q in zip(center, rel)))
    return out


def lip_path_targets(points, name, lip, rise=0.0):
    """A lip's path under a mouth shape: the corner fields plus that lip's parting ('upper', 'lower' or 'side'), and
    `rise` more (mouthFunnel lifts the lower lip and the corner posts by as much as it thickens them, so their lower
    edge stays where it rests on the plate's edge)."""
    out = []
    for x, y, z in points:
        dx, dz, up, low = lip_field(name, x)
        out.append((x + dx, y, z + dz + rise + (up if lip == 'upper' else low if lip == 'lower' else 0.0)))
    return out


def rubber_lips(upper_surface, lower_surface, rubber, jaw):
    """The rubber loop around the slit: an upper lip on the insert's edge, a lower lip on the plate's rim and a short
    post at each corner on the cheek's edge, which stretches down with the jaw. All ride the aperture's fields."""
    r, gap = LIP_RADIUS, .5 * LIP_RADIUS            # each tube reaches half its radius past the edge it borders
    reach = MOUTH_HALF_WIDTH + gap
    xs = samples(-reach, reach, .0025)             # evenly spaced: rings bunched at the corners would cross
    objects = []
    for lip, z0, surface in (('upper', MOUTH_Z + gap, upper_surface), ('lower', MOUTH_Z - gap, lower_surface)):
        path = [(x, surface(x) - .4 * r, z0) for x in xs]
        tube = capsule(path, r)
        obj = mesh(f'lip_{lip}', {'vertices': tube[0], 'faces': tube[1]}, [rubber])
        if lip == 'lower': add_jaw_open(obj, jaw, rigid=True)
        for name in MOUTH_SHAPES:
            funnel = name == 'mouthFunnel'
            rise = FUNNEL_THICKEN * r if funnel and lip == 'lower' else 0.0
            shape_key(obj, name, tube_targets(tube, path, lip_path_targets(path, name, lip, rise), 1 + FUNNEL_THICKEN if funnel else 1.0))
        objects.append(obj)
    top, bottom = MOUTH_Z + gap, MOUTH_Z - gap
    for side in (1, -1):
        x = side * reach
        path = [(x, upper_surface(x) - .4 * r, top + (bottom - top) * k / 4) for k in range(5)]
        tube = capsule(path, .9 * r)
        obj = mesh(f'lip_corner_{"L" if side > 0 else "R"}', {'vertices': tube[0], 'faces': tube[1]}, [rubber])
        # The post runs from the upper lip's end (weight 0) to the lower lip's end (weight 1, riding the jaw).
        add_jaw_open(obj, jaw, weight=lambda v: _lin(v[2], bottom, top))
        for name in MOUTH_SHAPES:
            funnel = name == 'mouthFunnel'
            rise = FUNNEL_THICKEN * .9 * r if funnel else 0.0
            shape_key(obj, name, tube_targets(tube, path, lip_path_targets(path, name, 'side', rise), 1 + FUNNEL_THICKEN if funnel else 1.0))
        objects.append(obj)
    return objects


def cavity_box(front_depth, material_):
    """The dark lining behind the window, open at the front just behind the insert; its floor rides the jaw.

    A stepped profile swept across the window: a shallow roof above the mouth line (in front of the eyes' shutter
    blades, behind the upper grille) and a deep mouth below it, closed by side walls.
    TOOL-GAP: mouth_cavity_geometry is an ellipsoid bag sized to a lip slit; agent-meshes should offer a cavity that
    lines an arbitrary window (a swept profile or extruded outline) with a jaw-riding floor.
    """
    half = WINDOW_HALF + INSERT_MARGIN - .001          # inside the insert's side returns
    top = MOUTH_Z + WINDOW_UP + INSERT_MARGIN + .002
    step = MOUTH_Z - .001
    xs = samples(-half, half, .012)
    # (depth behind the can's front at the mouth line, z) from the roof's front edge round to the floor's front edge
    profile = [(CAVITY_FRONT, top), (CAVITY_ROOF, top), (CAVITY_ROOF, step), (CAVITY_DEPTH, step),
               (CAVITY_DEPTH, CAVITY_FLOOR), (CAVITY_FRONT, CAVITY_FLOOR)]
    n = len(profile)
    vertices = [(x, front_depth(x) + d, z) for x in xs for d, z in profile]
    faces = [(i * n + k, i * n + k + 1, (i + 1) * n + k + 1, (i + 1) * n + k) for i in range(len(xs) - 1) for k in range(n - 1)]
    for i in (0, len(xs) - 1):                    # the side walls: the profile's outline, split into quads
        faces += [(i * n + 0, i * n + 1, i * n + 2, i * n + 5), (i * n + 2, i * n + 3, i * n + 4, i * n + 5)]
    return mesh('mouth_cavity', {'vertices': vertices, 'faces': faces}, [material_], smooth=False)


def beveled_teeth(row, bevel=TEETH_BEVEL, draft=TEETH_DRAFT):
    """A grille row's blocks with their front edges chamfered by `bevel`, for flat shading: each tooth reads as a
    stamped enamel block with a lit bevel instead of a flat white sticker. The sides draw in by `draft` toward the back
    face, so no side lies edge-on to a front view. Same layout and front extents as the row.

    TOOL-GAP: teeth_row_geometry's 'grille' style is a plain box; agent-meshes should offer a beveled grille tooth.
    """
    vertices, faces = [], []
    points = row['vertices']
    for k in range(0, len(points), 8):
        box = points[k:k + 8]
        y0, y1 = min(p[1] for p in box), max(p[1] for p in box)
        x0, x1 = min(p[0] for p in box), max(p[0] for p in box)
        z0, z1 = min(p[2] for p in box), max(p[2] for p in box)
        corners = [(x0, z0), (x1, z0), (x1, z1), (x0, z1)]
        inset = [(x0 + bevel, z0 + bevel), (x1 - bevel, z0 + bevel), (x1 - bevel, z1 - bevel), (x0 + bevel, z1 - bevel)]
        base = len(vertices)
        back = [(x0 + draft, z0 + draft), (x1 - draft, z0 + draft), (x1 - draft, z1 - draft), (x0 + draft, z1 - draft)]
        vertices += [(x, y0, z) for x, z in inset] + [(x, y0 + bevel, z) for x, z in corners] + [(x, y1, z) for x, z in back]
        f, r, b = base, base + 4, base + 8
        tooth = [(f, f + 1, f + 2, f + 3), (b + 3, b + 2, b + 1, b)]
        for i in range(4):
            j = (i + 1) % 4
            tooth += [(r + i, r + j, f + j, f + i), (b + i, b + j, r + j, r + i)]
        center = tuple(sum(v[c] for v in vertices[base:]) / 12 for c in range(3))
        for face in tooth:                               # wind each face outward (the block is convex)
            a, bb, c = (vertices[i] for i in face[:3])
            n = cross3(sub3(bb, a), sub3(c, a))
            mid = tuple(sum(vertices[i][q] for i in face) / len(face) for q in range(3))
            faces.append(face if sum(n[q] * (mid[q] - center[q]) for q in range(3)) > 0 else tuple(reversed(face)))
    return {'vertices': vertices, 'faces': faces}


def sub3(a, b): return tuple(x - y for x, y in zip(a, b))
def cross3(a, b): return (a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0])


def rolled_u_wall(path, front, back, thick, arc_steps=4):
    """A U-shaped wall `thick` thick swept along `path`, its front and back edges fully rolled (half-round).

    `path` is a list of (x, z, nx, nz) stations on the wall's inner face, (nx, nz) the outward normal in the face plane;
    `front(x, z)` and `back` give the wall's extent in y at each station. The ends are capped.
    TOOL-GAP: agent-meshes has no swept profile with a varying cross-section (a rolled-edge wall or channel along a path);
    sweep_mesh sweeps an ellipse only.
    """
    r = thick / 2
    ring = []                                           # (o, dy) around the section: o outward, then the y extent
    for k in range(arc_steps + 1):                      # the front roll: from the inner face over the front to the outer
        a = math.pi + math.pi * k / arc_steps
        ring.append((r + r * math.cos(a), 'f', r + r * math.sin(a)))
    for k in range(arc_steps + 1):                      # the back roll: from the outer face over the back to the inner
        a = math.pi * k / arc_steps
        ring.append((r + r * math.cos(a), 'b', -r + r * math.sin(a)))
    m = len(ring)
    vertices = []
    for x, z, nx, nz in path:
        yf = front(x, z)
        for o, end, dy in ring:
            vertices.append((x + nx * o, (yf if end == 'f' else back) + dy, z + nz * o))
    faces = [(i * m + k, i * m + (k + 1) % m, (i + 1) * m + (k + 1) % m, (i + 1) * m + k)
             for i in range(len(path) - 1) for k in range(m)]
    for i, flip in ((0, True), (len(path) - 1, False)):  # the end caps: a fan about each end section's centre
        c = len(vertices)
        vertices.append(tuple(sum(vertices[i * m + k][j] for k in range(m)) / m for j in range(3)))
        for k in range(m):
            a, b = i * m + k, i * m + (k + 1) % m
            faces.append((c, b, a) if flip else (c, a, b))
    return {'vertices': vertices, 'faces': faces}


def jaw_housing(front_y, rim_y):
    """The box the chin plate fronts: a rolled U wall round the plate's sides and bottom and a back plate.

    The wall's inner face is the plate's outline and its front edge is flush with the plate's front, so the plate reads
    as the face of a solid box with a turned edge. Moves rigidly with the jaw like the plate.
    """
    h, bottom, radius, t = PLATE_HALF, PLATE_BOTTOM, PLATE_CORNERS[1], HOUSING_WALL
    path = []
    side_zs = samples(bottom + radius, HOUSING_TOP, .008)
    path += [(-h, z, -1, 0) for z in reversed(side_zs)]
    for k in range(1, 8):                               # bottom-left corner
        a = math.pi + math.pi / 2 * k / 8
        path.append((-h + radius + radius * math.cos(a), bottom + radius + radius * math.sin(a), math.cos(a), math.sin(a)))
    path += [(x, bottom, 0, -1) for x in samples(-h + radius, h - radius, .012)]
    for k in range(1, 8):                               # bottom-right corner
        a = 1.5 * math.pi + math.pi / 2 * k / 8
        path.append((h - radius + radius * math.cos(a), bottom + radius + radius * math.sin(a), math.cos(a), math.sin(a)))
    path += [(h, z, 1, 0) for z in side_zs]

    # the rim's front: the plate's front along the bottom, easing round the corners onto the cheeks' `rim_y` (the can's
    # front where the cheeks run, so the side links lie on both)
    rim = lambda x, z: front_y(x) + (rim_y - front_y(h)) * smooth(h - radius, h, abs(x))
    wall = rolled_u_wall(path, rim, HOUSING_BACK, t)
    # the back plate, set half a millimetre inside the wall's rolled back edge
    y0 = HOUSING_BACK - t - .0005
    patch = face_grid(samples(-h - t / 2, h + t / 2, .012), samples(bottom - t / 2, HOUSING_TOP, .012), lambda x: y0)
    patch = _clip(*patch, rounded_rect(h + t / 2, bottom - t / 2, HOUSING_TOP, .001, radius + t / 2), snap=.1)
    back = slab(patch['vertices'], patch['faces'], (0, t, 0))
    return joined(wall, back)


def can_point(u, z, lift=0.0):
    """The can's surface at height z, `u` radians round from the front (-Y) toward +X, `lift` out along its normal:
    (point, normal). The superellipsoid itself: the sides and back are untouched by square_chin.

    TOOL-GAP: agent-meshes should offer surface sampling and normals for its superellipsoid blanks (and lay-on-surface
    beads and rivets for any blank), so heads do not re-derive them.
    """
    n = ROUND
    q = max(1 - abs((z - CENTER[2]) / HALF[2]) ** n, 1e-9)
    c, s = math.sin(u), -math.cos(u)
    x = HALF[0] * q ** (1 / n) * math.copysign(abs(c) ** (2 / n), c)
    y = HALF[1] * q ** (1 / n) * math.copysign(abs(s) ** (2 / n), s)
    g = [math.copysign(abs(v) ** (n - 1) / h ** n, v) for v, h in ((x, HALF[0]), (y, HALF[1]), (z - CENTER[2], HALF[2]))]
    length = math.sqrt(sum(v * v for v in g))
    normal = tuple(v / length for v in g)
    return (CENTER[0] + x + normal[0] * lift, CENTER[1] + y + normal[1] * lift, z + normal[2] * lift), normal


def can_seams(radius=.0014, rivet_r=.0021):
    """The can's lid seam: a rolled bead round the sides and back at the face plate's top, meeting its rim at the front
    corners, and a lap seam down the middle of the back, with rivets along both. Static; they lie half sunk in the can."""
    def resample(points, step):
        out, carry = [points[0]], 0.0
        for a, b in zip(points, points[1:]):
            d = math.dist(a, b)
            t = step - carry
            while t < d:
                out.append(tuple(p + (q - p) * t / d for p, q in zip(a, b))); t += step
            carry = d - (t - step)
        return out
    top = cz(46)
    start = next(u for u in (k / 2000 * math.pi for k in range(2000)) if can_point(u, top)[0][1] > -.071)
    dense = [can_point(start + (2 * math.pi - 2 * start) * k / 800, top, radius - .001)[0] for k in range(801)]
    band = resample(dense, .004)
    back = [can_point(math.pi, z, radius - .001)[0] for z in samples(.075, top - .004, .004)][::-1]
    beads = [capsule(band, radius, radial_segments=8), capsule(back, radius, radial_segments=8)]
    rivets = []
    for k in range(1, 8):                                  # along the lid seam, sides and back
        u = start + (math.pi - start) * k / 4 if k < 4 else math.pi + (math.pi - start) * (k - 4) / 4
        if abs(u - math.pi) < .05: continue
        rivets.append(can_point(u, top - .0075, .0002)[0])
    rivets += [can_point(math.pi + .09 * side, z, .0002)[0] for z in (.1, .15, .2) for side in (1, -1)]   # beside the lap seam
    domes = [ellipsoid_geometry(p, (rivet_r, rivet_r, rivet_r), rings=6, segments=10) for p in rivets]
    return joined(*[{'vertices': b[0], 'faces': b[1]} for b in beads]), joined(*domes)


def outline_path(side, top, corner, bottom_z):
    """The face plate's outline in the face plane: up one side, round the top corners, down the other side."""
    path = [(-side, bottom_z)] + [(-side, z) for z in (.14, .18, top - corner)]
    path += [(-side + corner - corner * math.cos(a), top - corner + corner * math.sin(a)) for a in (math.pi / 2 * k / 6 for k in range(1, 6))]
    path += [(x, top) for x in (-side + corner, -.03, 0, .03, side - corner)]
    path += [(side - corner + corner * math.cos(a), top - corner + corner * math.sin(a)) for a in (math.pi / 2 * k / 6 for k in range(5, 0, -1))]
    path += [(side, z) for z in (top - corner, .18, .14, bottom_z)]
    return path


def build():
    tin = material('tin', srgb('#a9b4be'), metalness=.7, roughness=.33)
    dark_tin = material('dark_tin', srgb('#5d6873'), metalness=.7, roughness=.42)
    shade_tin = material('shade_tin', srgb('#7b8894'), metalness=.6, roughness=.4)
    chin_tin = material('chin_tin', srgb('#66717c'), metalness=.6, roughness=.5)       # the jaw: its own part, darker and brushed
    chin_rim = material('chin_rim', srgb('#454f59'), metalness=.6, roughness=.5)      # the jaw box's rolled rim: the plate's dark outline
    bright = material('rivet', srgb('#dde3e8'), metalness=.85, roughness=.22)
    brow_metal = material('brow_plate', srgb('#2e353d'), metalness=.15, roughness=.6)   # darker than the concept's so the brows read in 3D
    shutter = material('shutter', srgb('#57687a'), metalness=.55, roughness=.3)        # blued steel: a closed lens, not the face
    well = material('lens_well', srgb('#11161b'), metalness=.3, roughness=.6)
    rubber = material('rubber', srgb('#23292f'), roughness=.72)
    rubber_panel = material('rubber_panel', srgb('#3a4148'), roughness=.8)          # the mouth panel: dark rubber, not tin
    ink = material('seam', srgb('#1c232b'), roughness=.6)
    collar = material('body_collar', srgb('#4f5a65'), metalness=.6, roughness=.45)
    cavity_mat = material('mouth_cavity', srgb('#161b21'), roughness=.9)
    cavity_mat.use_backface_culling = False
    enamel = srgb('#e8ecee')
    teeth_up = material('teeth_upper', enamel, metalness=.25, roughness=.3)
    teeth_lo = material('teeth_lower', enamel, metalness=.25, roughness=.3)
    bulb = glow(material('bulb', srgb('#e5563b'), roughness=.2), '#e5563b', .6)
    lens = [material('eye_white', srgb('#2a323b'), metalness=.6, roughness=.3),
            glow(material('eye_iris', srgb('#1a5671'), roughness=.05), '#5fd4f2', .35),
            material('eye_pupil', srgb('#051017'), roughness=.05)]

    rig = face_skeleton(head=(0, 0, MOUTH_Z), eye_left=EYE_L, eye_right=EYE_R, name='Face rig')
    jaw = JawHinge((0, .06, MOUTH_Z), angle=0, mouth_z=MOUTH_Z, half_width=MOUTH_HALF_WIDTH, drop=JAW_DROP)

    # ---- the can, squared off behind the chin plate, with its lens wells
    blank = ellipsoid_geometry(CENTER, HALF, rings=48, segments=64, exponent=ROUND)
    face_depth = mouth_line_front(blank['vertices'], blank['faces'])
    vertices, faces = square_chin(blank['vertices'], face_depth), blank['faces']
    holes = {}
    for side, eye in (('L', EYE_L), ('R', EYE_R)):
        holes[side] = shutter_hole(vertices, faces, eye, EYE_RADIUS, hole_radius=HOLE_RADIUS, max_edge=.28 * EYE_RADIUS, **SHUTTERS)
        vertices, faces = holes[side]['vertices'], holes[side]['faces']
    front = front_surface(vertices, faces)

    # ---- the skull: the whole can with the mouth window cut from its front (the insert fills it)
    window = rounded_rect(WINDOW_HALF, WINDOW_BOTTOM, MOUTH_Z + WINDOW_UP, .006, .004)
    # (only in front of the jaw housing's back, so the cut through the can's bottom rim stays inside the housing)
    cut = _clip(vertices, faces, lambda p: max(-window(p), p[1] - (HOUSING_BACK - .005)), snap=.02)
    skull_v, skull_f = cut['vertices'], cut['faces']

    def in_well(face):
        c = [sum(skull_v[i][k] for i in face) / len(face) for k in range(3)]
        return any(math.hypot(c[0] - e[0], c[2] - e[2]) < HOLE_RADIUS + 1e-4 and c[1] > FRONT_Y + .002 and c[1] < e[1] + HOLE_RADIUS
                   for e in (EYE_L, EYE_R))
    skull_g = {'vertices': skull_v, 'faces': skull_f, 'material_indices': [1 if in_well(f) else 0 for f in skull_f]}
    skull = mesh('skull', skull_g, [tin, well])

    # ---- the window's fill: a static tin frame and the rubber mouth panel, flush; the panel's lower edge is the upper
    # lip, its cheeks the mouth's sides. Only the rubber takes the mouth shapes.
    frame_g, panel_g = mouth_insert(front, face_depth)
    frame = mesh('window_frame', frame_g, [tin])
    insert = mesh('mouth_panel', panel_g, [rubber_panel])
    returns = mesh('insert_returns', insert_returns(face_depth), [tin])
    add_aperture_shapes(insert, 'insert')
    under = mesh('lower_panel', lower_panel(front, face_depth), [rubber_panel])

    # ---- the chin plate: a front plate from the mouth line to below the can, dropping rigidly with jawOpen and moving
    # under nothing else (the mouth shapes are all in the rubber)
    plate_front_y = lambda x: face_depth(x) - PLATE_PROUD
    zs = sorted(set(samples(PLATE_BOTTOM, LOWER_FADE[1] - .002, .0035)) | set(samples(LOWER_FADE[1] - .002, MOUTH_Z, .002, (MOUTH_Z - PLATE_EDGE,))))
    patch = face_grid(samples(-PLATE_HALF, PLATE_HALF, .0025, (-MOUTH_HALF_WIDTH, MOUTH_HALF_WIDTH, -FIELD_EDGE, FIELD_EDGE)), zs, plate_front_y)
    patch = _clip(*patch, rounded_rect(PLATE_HALF, PLATE_BOTTOM, MOUTH_Z, *PLATE_CORNERS), snap=.1)
    plate_g = slab(patch['vertices'], patch['faces'], (0, PLATE_THICK, 0))
    top_band = lambda f: sum(plate_g['vertices'][i][2] for i in f) / len(f) > MOUTH_Z - PLATE_EDGE + 1e-5
    plate_g['material_indices'] = [1 if top_band(f) else 0 for f in plate_g['faces']]
    plate = mesh('chin_plate', plate_g, [chin_tin, ink])
    add_jaw_open(plate, jaw, rigid=True, min_chin_drop=.1)
    add_jaw_open(under, jaw, rigid=True)
    add_aperture_shapes(under, 'lower')
    # the housing the plate fronts: rolled cheeks and floor, a back plate; rigid with the jaw
    rim_y = face_depth(PLATE_HALF + HOUSING_WALL / 2)       # the cheeks' rim: flush with the can's front where it runs
    housing = mesh('chin_housing', jaw_housing(plate_front_y, rim_y), [chin_rim])
    add_jaw_open(housing, jaw, rigid=True)
    plate_front = front_surface(patch['vertices'], patch['faces'])
    # The face in front: the skull's front and the plate's, for parts that lie across the mouth line.
    near = [f for f in skull_f if all(skull_v[i][1] < CENTER[1] - .05 and skull_v[i][2] < MOUTH_Z + .03 for i in f)]
    both = joined({'vertices': skull_v, 'faces': near}, patch)
    face_front_all = front_surface(both['vertices'], both['faces'])

    # ---- the rubber lip loop around the slit, and the dark box behind the window
    lips = rubber_lips(lambda x: front(x, MOUTH_Z + .001), plate_front_y, rubber, jaw)
    cavity = cavity_box(face_depth, cavity_mat)
    add_jaw_open(cavity, jaw, weight=lambda v: 1.0 if v[2] < MOUTH_Z - .005 else 0.0)

    # ---- grille teeth: the upper row hangs from the skull behind the insert, the lower row is bolted to the chin plate
    # behind the upper row. Both follow the corner fields (the grin curves them), not the lips' parting.
    fy0 = face_depth(0)
    upper = mesh('teeth_upper', beveled_teeth(teeth_row_geometry('grille', (0, fy0 + UPPER_DEPTH + TEETH_THICK / 2, UPPER_TOP), TEETH_ARCH, 0, 8,
                 UPPER_TOP - (MOUTH_Z - UPPER_SHOW), row='upper', width=TEETH_WIDTH, thickness=TEETH_THICK, span=TEETH_SPAN)), [teeth_up], smooth=False)
    lower = mesh('teeth_lower', beveled_teeth(teeth_row_geometry('grille', (0, fy0 + LOWER_DEPTH + TEETH_THICK / 2, LOWER_ROOT), TEETH_ARCH, 0, 8,
                 MOUTH_Z + LOWER_SHOW - LOWER_ROOT, row='lower', width=TEETH_WIDTH, thickness=TEETH_THICK, span=TEETH_SPAN)), [teeth_lo], smooth=False)
    add_jaw_open(lower, jaw, rigid=True)         # exactly the plate's motion (rig-contract invariant 8)
    # A dark backing just behind the upper grille, over the row's full height: while the lower row is still behind the
    # upper one (a small drop: happy, scared) it stays hidden, instead of peeking through the gaps into a checkered grid.
    # TOOL-GAP: teeth_row_geometry's 'grille' style should offer this backing (a dark web behind an open grille row).
    back_y = fy0 + UPPER_DEPTH + TEETH_THICK + .0004
    backing_g = face_grid(samples(-TEETH_HALF_WIDTH - .001, TEETH_HALF_WIDTH + .001, .003, (-MOUTH_HALF_WIDTH, MOUTH_HALF_WIDTH)),
                          samples(MOUTH_Z - UPPER_SHOW, UPPER_TOP, .004), lambda x: back_y)
    backing = mesh('grille_backing', backing_g, [cavity_mat], smooth=False)
    for obj in (upper, lower, backing): add_aperture_shapes(obj, 'teeth')

    # ---- lens-well bezels, rivets, seams, cheek vents
    parts = []
    trim = [returns, frame]                      # static parts: one mesh of their own, no morph data
    bezels = []
    for eye in (EYE_L, EYE_R):
        ring_pts = [(eye[0] + (HOLE_RADIUS + .0035) * math.cos(a), eye[2] + (HOLE_RADIUS + .0035) * math.sin(a))
                    for a in (math.tau * k / 48 for k in range(48))]
        bezels.append(ring_tube([on_surface(front, x, z, -.0012) for x, z in ring_pts], .0024, radial_segments=8))
    bezel_g = joined(*bezels)
    trim.append(mesh('bezels', bezel_g, [shade_tin]))
    face_g = joined((vertices, faces), bezel_g)
    face_front = front_surface(face_g['vertices'], face_g['faces'])

    rivets = [rivet(front, sx * x, z) for sx in (1, -1) for x, z in ((.07, .2245), (.025, .2275), (.078, .192), (.078, .152))]
    trim.append(mesh('rivets', joined(*rivets), [bright]))
    # The face plate's outline: a rolled rim (a half-sunk bead, so the plate edge has a turned thickness from every
    # side) with the dark seam line just outside it.
    top, side, corner = cz(46), .084, .018
    rim_path = [on_surface(front, x, z, FACE_RIM / 3) for x, z in outline_path(side, top, corner, MOUTH_Z + .0065)]
    rim = capsule(rim_path, FACE_RIM, radial_segments=10)
    trim.append(mesh('face_rim', {'vertices': rim[0], 'faces': rim[1]}, [tin]))
    gap = FACE_RIM + .0009
    trim.append(mesh('seams', line_on(front, outline_path(side + gap, top + gap, corner + gap, MOUTH_Z + .005), .0006, -.0002), [ink]))
    lid_seam, lid_rivets = can_seams()
    trim += [mesh('can_seams', lid_seam, [tin]), mesh('can_rivets', lid_rivets, [bright])]

    vents = []
    for sign in (1, -1):
        for y in (106, 110.6, 115.2):
            vents.append(ellipsoid_geometry(on_surface(front, sign * cx(142), cz(y) - .0022, -.0006), (6 * U, .0013, .0019), rings=6, segments=12, exponent=4))
    vent_obj = mesh('cheek_vents', joined(*vents), [well])
    vrest = [tuple(v.co) for v in vent_obj.data.vertices]
    for suffix, sign in (('Left', 1), ('Right', -1)):
        shape_key(vent_obj, f'cheekSquint{suffix}', [(x, y, z + 3.5 * U) if x * sign > 0 else (x, y, z) for x, y, z in vrest])
    parts.append(vent_obj)

    # ---- chin plate details ride the jaw rigidly; the side links hang it from brackets on the skull and stretch as it
    # drops, lying on the squared-off can front behind it
    ri = PLATE_HALF - .0065
    plate_bits = [rivet(plate_front, sx * ri, z) for sx in (1, -1) for z in (MOUTH_Z - .0075, PLATE_BOTTOM + .0065)]
    plate_detail = mesh('plate_detail', joined(*plate_bits), [bright])
    plate_lines = mesh('plate_lines', joined(*[line_on(plate_front, [(x, z) for x in (-.05, -.025, 0, .025, .05)], .0007, -.0002)
                                               for z in (.082, .0745)]), [ink])   # below the lower lip's band
    # the seam round the plate's sides and bottom, where it meets the housing's rolled rim
    h, r0, e = PLATE_HALF - PLATE_SEAM / 2, PLATE_CORNERS[1], MOUTH_Z - PLATE_EDGE
    seam_path = [(-h, z) for z in samples(PLATE_BOTTOM + r0, e, .01)][::-1]
    seam_path += [(-h + r0 - (r0 - PLATE_SEAM / 2) * math.cos(a), PLATE_BOTTOM + r0 - (r0 - PLATE_SEAM / 2) * math.sin(a)) for a in (math.pi / 2 * k / 8 for k in range(1, 8))]
    seam_path += [(x, PLATE_BOTTOM + PLATE_SEAM / 2) for x in samples(-h + r0, h - r0, .01)]
    seam_path += [(h - r0 + (r0 - PLATE_SEAM / 2) * math.cos(a), PLATE_BOTTOM + r0 - (r0 - PLATE_SEAM / 2) * math.sin(a)) for a in (math.pi / 2 * k / 8 for k in range(7, 0, -1))]
    seam_path += [(h, z) for z in samples(PLATE_BOTTOM + r0, e, .01)]
    plate_seam = mesh('plate_seam', line_on(lambda x, z: plate_front_y(x), seam_path, PLATE_SEAM, -.0003), [ink])
    for obj in (plate_detail, plate_lines, plate_seam): add_jaw_open(obj, jaw, rigid=True)
    # The side links are telescoping struts lying along the housing's rolled front edges, so every piece stays rigid as
    # the plate drops straight down: a sleeve hung from a bracket bolted to the can, a middle tube and a rod bolted to
    # the jaw. Each stage rests its back on one line: the can's front there and the housing's rim meet within .5 mm.
    # TOOL-GAP: agent-meshes has no link for a straight-drop jaw (a telescoping strut whose stages each ride their own
    # share of the drop) and no way to seat a block on a surface (bracket() below); both are head-local here.
    link_x = PLATE_HALF + HOUSING_WALL / 2
    back_y = rim_y + .0001
    link_objs = []
    for k, ((z0, z1), radius, share) in enumerate(zip(LINK_STAGES, LINK_RADII, (0.0, LINK_SHARE, 1.0))):
        tubes = [capsule([(s * link_x, back_y - radius, z) for z in (z1, (z0 + z1) / 2, z0)], radius, radial_segments=14)
                 for s in (1, -1)]
        obj = mesh(f'link_stage_{k}', joined(*[{'vertices': t[0], 'faces': t[1]} for t in tubes]), [dark_tin if k != 1 else shade_tin])
        if share: add_jaw_open(obj, jaw, weight=lambda v, share=share: share)
        link_objs.append(obj)

    def bracket(surface, x, z, height, stage):
        """A block seated on the surface (its back half follows it) standing out past the strut, and a hinge pin across
        it through the strut, lying on the surface, with a hex head on the inner side."""
        y_out = back_y - 2 * LINK_RADII[0] - .0012
        base = surface(x, z)
        depth = (base - y_out) / 2
        center = (x, y_out + depth, z)
        block = ellipsoid_geometry(center, (.0038, depth, height), rings=10, segments=16, exponent=5)
        seated = []
        for vx, vy, vz in block['vertices']:
            if vy > center[1]:
                under = surface(vx, vz)
                vy = center[1] + (vy - center[1]) / depth * (under + .0005 - center[1])
            seated.append((vx, vy, vz))
        axis_y, out = back_y - LINK_RADII[stage], math.copysign(1, x)
        pin_r = LINK_RADII[stage] + .0003                   # the pin's back dips into the surface under the strut
        # the pin ends inside the block on the outer side (the can falls away there) and shows its head on the inner side
        pin = joined(sweep_mesh([(x - out * .0045, axis_y, z), (x + out * .001, axis_y, z)], [(pin_r * .85, pin_r * .85)] * 2, radial_segments=10),
                     sweep_mesh([(x - out * .0064, axis_y, z), (x - out * .0043, axis_y, z)], [(pin_r, pin_r)] * 2, radial_segments=6))
        return {'vertices': seated, 'faces': block['faces']}, pin
    can_front = lambda x, z: front(x, z)
    rim_front = lambda x, z: plate_front_y(x) if abs(x) < PLATE_HALF else rim_y
    top_brackets = [bracket(can_front, s * link_x, LINK_HANGER_Z, .0068, 0) for s in (1, -1)]
    foot_brackets = [bracket(rim_front, s * link_x, LINK_FOOT_Z, .0052, 2) for s in (1, -1)]
    hangers = mesh('link_brackets', joined(*[b[0] for b in top_brackets]), [shade_tin])
    pivots = mesh('link_pivots', joined(*[b[1] for b in top_brackets]), [bright], smooth=False)
    feet = mesh('link_feet', joined(*[b[0] for b in foot_brackets]), [shade_tin])
    foot_pins = mesh('link_foot_pivots', joined(*[b[1] for b in foot_brackets]), [bright], smooth=False)
    for obj in (feet, foot_pins): add_jaw_open(obj, jaw, rigid=True)
    parts += [plate_detail, plate_lines, plate_seam, feet, foot_pins, housing] + link_objs[1:]
    trim += [hangers, pivots, link_objs[0]]

    # ---- ears and antenna (the bolts and the rod are rooted in the can; the rod and bulb are one piece)
    ear_z = cz(90)
    ears, bolts = [], []
    for sign in (1, -1):
        ears.append(ellipsoid_geometry((sign * (HALF[0] + .002), -.012, ear_z), (.013, .03, 19 * U), rings=12, segments=20, exponent=4))
        bolts.append(sweep_mesh([(sign * (HALF[0] - .003), -.012, ear_z), (sign * (HALF[0] + .021), -.012, ear_z)], [(.011, .011)] * 2, radial_segments=6))
    trim.append(mesh('ears', joined(*ears), [shade_tin]))
    trim.append(mesh('ear_bolts', joined(*bolts), [dark_tin], smooth=False))
    crown = CENTER[2] + HALF[2]
    trim.append(mesh('antenna_base', ellipsoid_geometry((0, -.004, crown - .002), (12 * U, 12 * U, .011), rings=10, segments=24), [tin]))
    bulb_r, bulb_z, rod_r = 6.5 * U, cz(13), .0038
    # One lathe from inside the can up through the bulb: the rod, then the bulb's profile where it is wider than the rod.
    profile = [(crown - .004, rod_r), (crown + .004, rod_r)]
    for k in range(1, 24):
        a = math.pi * k / 24                     # from the bulb's bottom pole up to its top
        z, r = bulb_z - bulb_r * math.cos(a), bulb_r * math.sin(a)
        if r >= rod_r or z > bulb_z: profile.append((z, max(r, .0006)))
    antenna = sweep_mesh([(0, -.004, z) for z, _ in profile], [(r, r) for _, r in profile], radial_segments=20)
    split_z = profile[2][0] - 1e-6
    antenna_g = {'vertices': antenna[0], 'faces': antenna[1],
                 'material_indices': [1 if min(antenna[0][i][2] for i in f) >= split_z else 0 for f in antenna[1]]}
    trim.append(mesh('antenna', antenna_g, [shade_tin, bulb]))

    # ---- brow plates, standing off the face plate and its bezels at every pose, each with two rivets riding it
    brows = []
    for side, x in (('L', EYE_L[0]), ('R', EYE_R[0])):
        g = brow_plate_geometry((x, 0, cz(59)), (36 * U, .006, 8.8 * U), side, down=14, drop=.005, inner_up=18, outer_up=16, surface=face_front)
        brow = mesh(f'brow_{side}', g, [brow_metal], smooth=False)
        for name, targets in g['morphs'].items(): shape_key(brow, name, targets)
        brows.append(brow)
        face_y = min(v[1] for v in g['vertices'])
        width = max(v[0] for v in g['vertices']) - min(v[0] for v in g['vertices'])
        studs = joined(*[ellipsoid_geometry((x + t * width, face_y + .0002, cz(59)), (.0021, .0011, .0021), rings=6, segments=12)
                         for t in (-.37, .37)])
        stud_obj = mesh(f'brow_rivets_{side}', studs, [bright])
        for name, targets in g['morphs'].items(): shape_key(stud_obj, name, rigid_follow(g['vertices'], targets, studs['vertices']))
        brows.append(stud_obj)

    # ---- eyes: lenses on the eye bones, shutters as lids; cheekSquint also pushes the lower shutter up (concept)
    eyeballs = []
    for side, center in (('L', EYE_L), ('R', EYE_R)):
        suffix = 'Left' if side == 'L' else 'Right'
        eye = build_eye(rig, side, center, EYE_RADIUS, style='shutter', lid_material=shutter, socket_material=well,
                        eye_materials=lens, hole=holes[side], socket=False, **LENS)
        lids, blades = eye['lids'], eye['geometry']
        edges = blades['edges']
        # The blades are told apart by where they rest (the upper one above the gap between them), not by vertex order.
        parting = center[2] + (edges['upper']['rest'] + edges['lower']['rest']) / 2
        lrest = [tuple(v.co) for v in lids.data.vertices]
        is_upper = [v[2] > parting for v in lrest]
        lift = .35 * SHUTTERS['opening'][1] * EYE_RADIUS
        shape_key(lids, 'cheekSquint' + suffix, [(x, y, z) if up else (x, y, z + lift) for (x, y, z), up in zip(lrest, is_upper)])
        # A rolled lip along the upper blade's leading edge: the seam where the blades meet when the shutter closes. It
        # copies the upper blade's mean vertical travel in each of the blade's morphs.
        # TOOL-GAP: shutter_geometry should build this lip (or return each blade's per-morph transform) so heads do not
        # re-derive the blade's motion from its shape keys.
        up_idx = [i for i, up in enumerate(is_upper) if up]
        edge_z = min(lrest[i][2] for i in up_idx)
        edge_y = min(lrest[i][1] for i in up_idx)
        reach = HOLE_RADIUS * .97
        lip_r = .0008
        lip = sweep_mesh([(center[0] + reach * (2 * k / 8 - 1), edge_y + .0003, edge_z + lip_r) for k in range(9)],
                         [(lip_r, lip_r)] * 9, radial_segments=10)
        lip_obj = mesh(f'shutter_lip_{side}', lip, [shutter])
        for block in lids.data.shape_keys.key_blocks[1:]:
            dz = sum(block.data[i].co.z - lrest[i][2] for i in up_idx) / len(up_idx)
            shape_key(lip_obj, block.name, [(x, y, z + dz) for x, y, z in lip[0]])
        eyeballs.append(eye['eyeball'])
        parts += [lids, lip_obj, eye['socket']]

    parts = [skull, insert, under, plate, cavity, upper, lower, backing] + lips + brows + parts
    face = join_face_parts(parts, 'face', rig=rig)

    # ---- the ribbed neck collar under the can: a static column the chin plate slides down in front of, long enough to
    # show below the plate at every opening (own material, no morphs)
    length = .13
    zs = [.066 - length * k / 50 for k in range(51)]
    radii = []
    for z in zs:
        t = (.066 - z) / length
        r = .043 + .006 * t + .0026 * sum(math.exp(-((t - c) / .022) ** 2) for c in (.24, .34, .44, .54, .64, .74, .84, .94))
        radii.append((r, .8 * r))
    neck = mesh('neck_collar', sweep_mesh([(0, .012, z) for z in zs], radii, radial_segments=32, initial_normal=(1, 0, 0)), [collar])
    bind_rigid(neck, rig, 'head')

    # The static trim (rims, seams, rivets, ears, antenna, the links' hangers and sleeves) is one mesh bound to the head:
    # joined into the face it would carry every morph's (empty) data.
    can_trim = join_face_parts(trim, 'can_trim', rig=rig)

    objects = [rig, face, can_trim, neck] + eyeballs
    face_contract(rig, objects, yaw_max=26, pitch_max=18, lid_follow={'down': .35, 'up': .35}, emotions=EMOTIONS, exposed_teeth=[])
    return objects
