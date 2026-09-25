"""Soft lips on a wide frog mouth: the P1a round-6 critic's "Mudjaw", written from the README, as a fixture.

A wide squat head with lemon eyes in mounded eye holes, heavy brow ridges laid on the skin, soft lips on a 68 mm
half-width mouth that turns round the sides of the head (`sculpt_lips`), bead nostrils riding noseSneer, saw teeth,
fangs and fin ears. Round 6 found `sculpt_lips` put a comb of short vertical streaks along the whole crease of this
mouth; the lips are now a regular grid wrapped round the head. The skin is the dark bog green with a pale belly and
jaw painted over it (`skin_tints(..., lighten=True)`, which picks the material color).
Blender coords: Z up, -Y forward, +X character left.
"""
from agent_meshes_author import (
    JawHinge, add_jaw_open, attach_to_skin, brow_ridge_geometry, build_eye, ellipsoid_geometry, exposed_teeth_geometry,
    eye_holes, eye_hole_mask, face_contract, face_skeleton, front_surface, join_face_parts, join_geometry, material,
    mesh_from_geometry, mouth_cavity_geometry, recommended_gaze, shape_key, slit_mouth, soft_offset, symmetric_offsets,
    teeth_row_geometry, tongue_geometry, sculpt_lips, skin_tints, paint_vertices, use_vertex_colors,
)

C, RADII = (0, 0, .115), (.125, .09, .095)
EYE_RADIUS = .023
EYE_L = (.05, -.042, .176)
MOUTH_Z, MOUTH_HW = .083, .068
OPENING = (50, 40, 30)
NOSTRIL = (.013, .126)
SKIN = (.36, .6, .2)  # the bog green; the pale belly is painted over it (lighten=True)
BELLY = (.62, .7, .38)


def build():
    skin = material('bog_skin', SKIN, roughness=.65)
    rig = face_skeleton(head=(0, 0, .1), eye_left=EYE_L, eye_right=(-EYE_L[0], EYE_L[1], EYE_L[2]), name='Face rig')
    blank = ellipsoid_geometry(C, RADII, rings=60, segments=80)
    cut = eye_holes(blank['vertices'], blank['faces'], EYE_L, EYE_RADIUS, opening=OPENING)
    vertices, faces, holes = cut['vertices'], cut['faces'], {'L': cut['L'], 'R': cut['R']}
    lips = sculpt_lips(vertices, faces, MOUTH_Z, MOUTH_HW)
    vertices, faces = lips['vertices'], lips['faces']
    skin_surface = {'vertices': vertices, 'faces': faces}
    front = front_surface(vertices, faces)
    jaw = JawHinge.ear(vertices, MOUTH_Z, MOUTH_HW, angle=9)
    head = mesh_from_geometry('head_skin', {'vertices': vertices, 'faces': faces}, [skin])
    slit_mouth(head, MOUTH_Z, MOUTH_HW)
    rest = [tuple(v.co) for v in head.data.vertices]

    my = front(0, MOUTH_Z)
    mc = (MOUTH_HW, front(MOUTH_HW, MOUTH_Z), MOUTH_Z)
    still = eye_hole_mask(holes['L'], holes['R'])
    pairs = {
        'cheekSquint': ((.07, -.065, .125), .03, (0, -.002, .006)),
        'mouthSmile': (mc, .024, (.004, .001, .008)),
        'mouthFrown': (mc, .024, (0, 0, -.008)),
        'mouthStretch': (mc, .024, (.007, 0, -.001)),
        'noseSneer': ((NOSTRIL[0], front(*NOSTRIL), NOSTRIL[1]), .014, (.001, -.001, .004)),
    }
    for name, (center, radius, offset) in pairs.items():
        left, right = symmetric_offsets(rest, center, radius, offset, mask=still)
        shape_key(head, f'{name}Left', left); shape_key(head, f'{name}Right', right)
    shape_key(head, 'mouthFunnel', soft_offset(rest, (0, my, MOUTH_Z), (.05, .02, .022), (0, -.006, 0)))
    add_jaw_open(head, jaw, min_chin_drop=.1)
    paint = skin_tints(rest, base=SKIN, mottle={'scale': .01, 'amount': .12, 'seed': 5}, lighten=True, patches=[
        {'center': (0, -.02, .04), 'radius': (.16, .12, .06), 'color': BELLY, 'strength': 1},
        {'center': (0, my, MOUTH_Z), 'radius': (.07, .01, .006), 'color': (.2, .3, .1), 'strength': .7}])
    paint_vertices(head, paint['tints'])
    use_vertex_colors(skin, paint['material'])

    dark = material('mouth_cavity', (.03, .005, .01), roughness=.9)
    dark.use_backface_culling = False
    cavity = mesh_from_geometry('mouth_cavity', mouth_cavity_geometry((0, my, MOUTH_Z - .002), width=MOUTH_HW * 2 - .004, height=.045, depth=.065, surface=front), [dark])
    add_jaw_open(cavity, jaw)
    upper = mesh_from_geometry('teeth_upper', teeth_row_geometry('saw', (0, my + .005, MOUTH_Z + .002), .06, .035, 18, .007, row='upper'),
                               [material('teeth_upper', (.92, .9, .75), roughness=.3)])
    lower = mesh_from_geometry('teeth_lower', teeth_row_geometry('saw', (0, my + .007, MOUTH_Z - .002), .058, .035, 18, .006, row='lower'),
                               [material('teeth_lower', (.9, .87, .72), roughness=.3)])
    add_jaw_open(lower, jaw, rigid=True)
    fangs = mesh_from_geometry('fangs', exposed_teeth_geometry(front, (-.03, .03), MOUTH_Z, length=.012, width=.007),
                               [material('teeth_exposed', (.95, .93, .8), roughness=.3)])
    tongue = mesh_from_geometry('tongue', tongue_geometry((0, my + .032, MOUTH_Z - .015), length=.045, width=.06, thickness=.009),
                                [material('tongue', (.55, .12, .16), roughness=.5)])
    add_jaw_open(tongue, jaw, rigid=True)

    beads = []
    for sx in (1, -1):
        x, z = sx * NOSTRIL[0], NOSTRIL[1]
        beads.append(attach_to_skin(ellipsoid_geometry((x, front(x, z) + .0012, z), (.0035, .002, .0022), rings=8, segments=12), head, depth=.0006))
    ngeo = join_geometry(beads)
    nose = mesh_from_geometry('nostrils', ngeo, [material('nostril', (.02, .04, .01), roughness=.8)])
    for name, targets in ngeo['morphs'].items(): shape_key(nose, name, targets)

    fins = [ellipsoid_geometry((sx * .128, .01, .125), (.022, .006, .034), rings=12, segments=16) for sx in (1, -1)]
    fins = [attach_to_skin(f, head, depth=.004) for f in fins]
    fgeo = join_geometry(fins)
    fin = mesh_from_geometry('fins', fgeo, [material('fin', (.1, .35, .3), roughness=.5)])
    for name, targets in (fgeo.get('morphs') or {}).items(): shape_key(fin, name, targets)

    eye_mats = [material('eye_white', (.95, .82, .12), roughness=.25), material('eye_iris', (.85, .45, .04), roughness=.3),
                material('eye_pupil', (.01, .01, .01), roughness=.2)]
    parts, eyeballs = [head, cavity, upper, lower, fangs, tongue, nose, fin], []
    for side in 'LR':
        center = EYE_L if side == 'L' else (-EYE_L[0], EYE_L[1], EYE_L[2])
        eye = build_eye(rig, side, center, EYE_RADIUS, lid_material=skin, eye_materials=eye_mats, iris=32, pupil=10, hole=holes[side])
        eyeballs.append(eye['eyeball'])
        parts.append(eye['lids'])
        mound = holes[side]['mound']
        ridge = brow_ridge_geometry(center, mound, side, inner=15, outer=70, elevation=OPENING[1] + 20, height=24, arch=6,
                                    thickness=.35 * mound, skin=skin_surface, hole=holes[side])
        ridge = attach_to_skin(ridge, head)
        brow = mesh_from_geometry(f'brow_{side}', ridge, [skin])
        for name, targets in ridge['morphs'].items(): shape_key(brow, name, targets)
        parts.append(brow)

    face = join_face_parts(parts, 'face', rig=rig)
    objects = [rig, face] + eyeballs
    gaze = recommended_gaze(OPENING, iris=32)
    face_contract(rig, objects, yaw_max=gaze['yawMax'], pitch_max=gaze['pitchMax'], exposed_teeth=['teeth_exposed'])
    return objects
