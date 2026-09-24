"""A wide, flat frog head (Mossjaw-like) authored only with the agent-meshes face helpers.

It started as the P1a round-1 critic's head, written from the docs, which exposed three gaps:
a mid-head hinge that only opened a hole at the lips, a mouth line (.088) whose float32 rounding
hung the upper lip on the jaw, and stair-stepped eye holes. It now uses the ear hinge
(`JawHinge.ear`), the tagged lip seam, `cut_hole`, a cavity fitted to the curved face, exposed
fangs in front of the closed lower lip and brow ridges on the lid domes.
Blender coordinates: Z up, meters, the face looks down -Y, character left is +X.
"""
from agent_meshes_author import (
    JawHinge, add_jaw_open, brow_ridge_geometry, build_eye, cut_hole, ellipsoid_geometry, exposed_teeth_geometry,
    face_contract, face_skeleton, front_surface, join_face_parts, material, mesh_from_geometry, mouth_cavity_geometry,
    recommended_gaze, shape_key, slit_mouth, soft_offset, symmetric_offsets, teeth_row_geometry, tongue_geometry,
)

HEAD_CENTER, HEAD_RADII = (0, 0, .12), (.11, .085, .10)
EYE_RADIUS = .02
EYE_L = (.045, -.052, .182)
EYE_R = (-EYE_L[0], EYE_L[1], EYE_L[2])
# .088 is stored as float32 just below .088: the tagged seam keeps the upper lip in place anyway.
MOUTH_Z, MOUTH_HW = .088, .055
OPENING = (48, 36, 28)


def build():
    skin = material('frog_skin', (.22, .45, .12), roughness=.6)
    rig = face_skeleton(head=(0, 0, .1), eye_left=EYE_L, eye_right=EYE_R, name='Face rig')

    blank = ellipsoid_geometry(HEAD_CENTER, HEAD_RADII, rings=56, segments=72)
    vertices, faces = blank['vertices'], blank['faces']
    for eye in (EYE_L, EYE_R):
        cut = cut_hole(vertices, faces, eye, EYE_RADIUS * 1.3)
        vertices, faces = cut['vertices'], cut['faces']
    front = front_surface(vertices, faces)
    jaw = JawHinge.ear(vertices, MOUTH_Z, MOUTH_HW)
    head = mesh_from_geometry('head_skin', {'vertices': vertices, 'faces': faces}, [skin])
    slit_mouth(head, MOUTH_Z, MOUTH_HW)
    rest = [tuple(v.co) for v in head.data.vertices]

    my = front(0, MOUTH_Z)
    pairs = {
        'cheekSquint': ((.06, -.07, .12), .025, (0, -.002, .005)),
        'mouthSmile': ((MOUTH_HW, front(MOUTH_HW, MOUTH_Z), MOUTH_Z), .02, (.004, .001, .006)),
        'mouthFrown': ((MOUTH_HW, front(MOUTH_HW, MOUTH_Z), MOUTH_Z), .02, (0, 0, -.006)),
        'mouthStretch': ((MOUTH_HW, front(MOUTH_HW, MOUTH_Z), MOUTH_Z), .02, (.006, 0, -.001)),
        'noseSneer': ((.012, -.084, .135), .012, (0, -.001, .003)),
    }
    for name, (center, radius, offset) in pairs.items():
        left, right = symmetric_offsets(rest, center, radius, offset)
        shape_key(head, f'{name}Left', left)
        shape_key(head, f'{name}Right', right)
    shape_key(head, 'mouthFunnel', soft_offset(rest, (0, my, MOUTH_Z), (.04, .02, .02), (0, -.005, 0)))
    add_jaw_open(head, jaw, min_chin_drop=.1)

    dark = material('mouth_cavity', (.03, .005, .01), roughness=.9)
    dark.use_backface_culling = False
    cavity_geometry = mouth_cavity_geometry((0, my, MOUTH_Z - .002), width=MOUTH_HW * 2 - .004, height=.04, depth=.06, surface=front)
    cavity = mesh_from_geometry('mouth_cavity', cavity_geometry, [dark])
    add_jaw_open(cavity, jaw)

    enamel_u = material('teeth_upper', (.95, .93, .82), roughness=.3)
    enamel_l = material('teeth_lower', (.93, .9, .8), roughness=.3)
    upper = mesh_from_geometry('teeth_upper', teeth_row_geometry('saw', (0, my + .005, MOUTH_Z + .002), .048, .03, 14, .006, row='upper'), [enamel_u])
    lower = mesh_from_geometry('teeth_lower', teeth_row_geometry('saw', (0, my + .007, MOUTH_Z - .002), .046, .03, 14, .005, row='lower'), [enamel_l])
    add_jaw_open(lower, jaw, rigid=True)
    # Mossjaw's two exposed fangs hang in front of the closed lower lip.
    fangs = mesh_from_geometry('fangs_teeth_upper', exposed_teeth_geometry(front, (-.02, .02), MOUTH_Z, length=.011, width=.007), [enamel_u])
    tongue = mesh_from_geometry('tongue', tongue_geometry((0, my + .03, MOUTH_Z - .014), length=.04, width=.05, thickness=.008), [material('tongue', (.6, .15, .18), roughness=.5)])
    add_jaw_open(tongue, jaw, rigid=True)

    lemon = material('eye_white', (.95, .8, .1), roughness=.25)
    iris = material('eye_iris', (.9, .55, .05), roughness=.3)
    pupil = material('eye_pupil', (.01, .01, .01), roughness=.2)
    parts, eyeballs = [head, cavity, upper, lower, fangs, tongue], []
    for side, center in (('L', EYE_L), ('R', EYE_R)):
        eye = build_eye(rig, side, center, EYE_RADIUS, style='lid', lid_material=skin, eye_materials=[lemon, iris, pupil],
                        iris=30, pupil=10, opening=OPENING)
        eyeballs.append(eye['eyeball'])
        parts += [eye['lids'], eye['socket']]
        # The heavy brow ridge rides the lid dome: browDown drops its inner end over the eye.
        dome = eye['geometry']['upper_radius'] + eye['geometry']['thickness']
        ridge = brow_ridge_geometry(center, dome, side, elevation=OPENING[1] + 22)
        brow = mesh_from_geometry(f'brow_{side}', ridge, [skin])
        for name, targets in ridge['morphs'].items(): shape_key(brow, name, targets)
        parts.append(brow)

    face = join_face_parts(parts, 'face', rig=rig)
    objects = [rig, face] + eyeballs
    gaze = recommended_gaze(OPENING, iris=30)
    face_contract(rig, objects, yaw_max=gaze['yawMax'], pitch_max=gaze['pitchMax'], exposed_teeth=['fangs'])
    return objects
