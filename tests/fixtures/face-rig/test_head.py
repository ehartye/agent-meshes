"""End-to-end `arkit-face/1` test heads, authored only with the agent-meshes face helpers.

`build()` makes a round-eyed head with lids and a hinged puppet jaw; `build_face(robot=True)`
(see test_robot.py) makes a robot with shutter eyes and a rigid chin plate.
Build: node scripts/agent-meshes.mjs build tests/fixtures/face-rig/build.json
Check: node scripts/agent-meshes.mjs verify <output>/model.glb --contract arkit-face/1
Blender coordinates: Z up, meters, the face looks down -Y, character left is +X.
"""
from agent_meshes_author import (
    JawHinge, add_jaw_open, build_eye, cut_faces, cut_hole, ellipsoid_geometry, face_contract, face_skeleton, front_surface,
    join_face_parts, material, mesh_from_geometry, mouth_cavity_geometry, recommended_gaze, shape_key, slit_mouth, soft_offset,
    symmetric_offsets, teeth_row_geometry, tongue_geometry,
)

HEAD_CENTER, HEAD_RADII = (0, 0, .12), (.085, .09, .115)
EYE_RADIUS, EYE_L = .014, (.033, -.067, .145)
EYE_R = (-EYE_L[0], EYE_L[1], EYE_L[2])
MOUTH_Z, MOUTH_HALF_WIDTH = .075, .022
OPENING = (45, 38, 30)


def build():
    return build_face()


def build_face(robot=False):
    skin = material('metal' if robot else 'skin', (.55, .58, .62) if robot else (.62, .36, .24), metalness=.8 if robot else 0, roughness=.35 if robot else .55)
    rig = face_skeleton(head=(0, 0, .09), eye_left=EYE_L, eye_right=EYE_R, name='Face rig')

    # Head blank with smooth round eye holes; the lids (or shutters), sockets and eyeballs fill them.
    blank = ellipsoid_geometry(HEAD_CENTER, HEAD_RADII, rings=48, segments=64)
    vertices, faces = blank['vertices'], blank['faces']
    for eye in (EYE_L, EYE_R):
        cut = cut_hole(vertices, faces, eye, .0185)
        vertices, faces = cut['vertices'], cut['faces']
    front = front_surface(vertices, faces)
    # A puppet jaw hinged at the back of the head, level with the mouth: the chin drops with the lips.
    # The robot's rigid chin plate turns further and slides less.
    jaw = JawHinge.ear(vertices, MOUTH_Z, MOUTH_HALF_WIDTH, **(dict(angle=14, drop=.012) if robot else {}))
    extra = []
    if robot:
        # The chin plate is the whole lower head below the mouth line, one rigid part; the skull keeps the rest.
        chin = lambda c: c[2] < MOUTH_Z
        plate_vertices, plate_faces, _ = cut_faces(vertices, faces, lambda c: not chin(c))
        vertices, faces, _ = cut_faces(vertices, faces, chin)
        plate = mesh_from_geometry('chin_plate', {'vertices': plate_vertices, 'faces': plate_faces}, [skin])
        add_jaw_open(plate, jaw, rigid=True, min_chin_drop=.1)
        extra.append(plate)
    head = mesh_from_geometry('head_skin', {'vertices': vertices, 'faces': faces}, [skin])
    if not robot: slit_mouth(head, MOUTH_Z, MOUTH_HALF_WIDTH)
    rest = [tuple(v.co) for v in head.data.vertices]

    # Brows, cheeks and mouth shapes: soft offsets, mirrored for the right side.
    pairs = {
        'browDown': ((.032, -.075, .168), .02, (0, 0, -.004)),
        'browOuterUp': ((.048, -.068, .168), .02, (0, 0, .004)),
        'cheekSquint': ((.04, -.072, .108), .02, (0, -.001, .004)),
        'mouthSmile': ((.022, -.08, MOUTH_Z), .016, (.003, .001, .004)),
        'mouthFrown': ((.022, -.08, MOUTH_Z), .016, (0, 0, -.004)),
        'mouthStretch': ((.022, -.08, MOUTH_Z), .016, (.004, 0, -.001)),
    }
    for name, (center, radius, offset) in pairs.items():
        left, right = symmetric_offsets(rest, center, radius, offset)
        shape_key(head, f'{name}Left', left)
        shape_key(head, f'{name}Right', right)
    shape_key(head, 'browInnerUp', soft_offset(rest, (0, -.08, .165), .025, (0, 0, .004)))
    shape_key(head, 'mouthFunnel', soft_offset(rest, (0, -.083, MOUTH_Z), (.026, .02, .016), (0, -.004, 0)))

    if not robot: add_jaw_open(head, jaw, min_chin_drop=.1)

    # Mouth interior: a dark bag, teeth rows and a tongue carried by the same hinge.
    dark = material('mouth_cavity', (.03, .005, .01), roughness=.9)
    dark.use_backface_culling = False
    # The cavity rim hugs the curved face just behind the lips, so it never pokes through at rest.
    cavity_geometry = mouth_cavity_geometry((0, front(0, MOUTH_Z), .074), width=.042, height=.032, depth=.05, surface=front)
    cavity = mesh_from_geometry('mouth_cavity', cavity_geometry, [dark])
    add_jaw_open(cavity, jaw)
    enamel_upper = material('teeth_upper', (.9, .88, .8), roughness=.3)
    enamel_lower = material('teeth_lower', (.88, .86, .78), roughness=.3)
    style = 'grille' if robot else 'rounded'
    upper = mesh_from_geometry('teeth_upper', teeth_row_geometry(style, (0, -.0795, .0765), .02, .012, 6, .006, row='upper'), [enamel_upper])
    lower = mesh_from_geometry('teeth_lower', teeth_row_geometry(style, (0, -.0745, .0735), .018, .011, 6, .005, row='lower'), [enamel_lower])
    add_jaw_open(lower, jaw, rigid=True)
    parts, eyeballs = [head, cavity, upper, lower] + extra, []
    if not robot:
        tongue = mesh_from_geometry('tongue', tongue_geometry((0, -.06, .062), length=.03, width=.026, thickness=.007), [material('tongue', (.6, .15, .18), roughness=.5)])
        add_jaw_open(tongue, jaw, rigid=True)
        parts.append(tongue)

    for side, center in (('L', EYE_L), ('R', EYE_R)):
        options = dict(style='shutter') if robot else dict(style='lid', opening=OPENING)
        eye = build_eye(rig, side, center, EYE_RADIUS, lid_material=skin, **options)
        eyeballs.append(eye['eyeball'])
        parts += [eye['lids'], eye['socket']]

    # Unreal drops every morph name when one repeats across glTF meshes: one morph-bearing mesh.
    face = join_face_parts(parts, 'face', rig=rig)
    objects = [rig, face] + eyeballs

    gaze = recommended_gaze(OPENING)
    face_contract(rig, objects, yaw_max=gaze['yawMax'], pitch_max=gaze['pitchMax'], exposed_teeth=[])
    return objects
