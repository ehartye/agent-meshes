"""A round-faced kid head (Pip-like) authored only with the agent-meshes face helpers.

It is the P1a round-5 critic's "Pim", written from the docs, with the two gaps it found closed: the brows come from
`skin_brow_geometry(head, side, ..., hole=...)`, which lays each brow on the skin along its normal in every pose (the
round-5 brow stood 0.76 mm off the skin), and the nose is `nose_geometry`, a smooth-union ball with nostril dimples
fused into the skin that rides noseSneer (a soft_offset sculpt at this resolution came out as a spike). Its mouth has
soft lips and a lip line (`sculpt_lips`), and `slit_mouth` leaves no sliver row to shade as a seam across the face.
Build: node scripts/agent-meshes.mjs build <a build.json whose blender.script is this file>
Blender coordinates: Z up, meters, the face looks down -Y, character left is +X.
"""
from agent_meshes_author import (
    JawHinge, add_jaw_open, attach_to_skin, build_eye, cut_faces, ellipsoid_geometry, exposed_teeth_geometry, eye_hole,
    eye_hole_mask, face_contract, face_skeleton, front_surface, join_face_parts, join_geometry, material, mesh_from_geometry,
    mouth_cavity_geometry, nose_geometry, sculpt_lips, recommended_gaze, shape_key, skin_brow_geometry, slit_mouth, soft_offset,
    symmetric_offsets, teeth_row_geometry, tongue_geometry,
)

HEAD_CENTER, HEAD_RADII = (0, 0, .13), (.088, .085, .11)
EYE_RADIUS = .017
EYE_L = (.034, -.066, .152)
EYE_R = (-EYE_L[0], EYE_L[1], EYE_L[2])
MOUTH_Z, MOUTH_HW = .088, .021
OPENING = (46, 40, 30)
NOSE_TIP, NOSE_SIZE = (0, .118), (.0105, .0095, .009)


def build():
    skin = material('skin', (.7, .3, .16), roughness=.55)
    rig = face_skeleton(head=(0, 0, .1), eye_left=EYE_L, eye_right=EYE_R, name='Face rig')

    blank = ellipsoid_geometry(HEAD_CENTER, HEAD_RADII, rings=56, segments=72)
    vertices, faces = blank['vertices'], blank['faces']
    holes = {}
    for side, eye in (('L', EYE_L), ('R', EYE_R)):
        holes[side] = eye_hole(vertices, faces, eye, EYE_RADIUS, opening=OPENING)
        vertices, faces = holes[side]['vertices'], holes[side]['faces']
    # Soft lips with a lip line: slit_mouth cuts along the crease between them.
    lips = sculpt_lips(vertices, faces, MOUTH_Z, MOUTH_HW)
    # A button nose fused into the skin: a smooth-union ball with nostril dimples (material index 1). Both refine only
    # near their feature, so the holes' rims, walls and masks are untouched; the nose comes last to keep its indices.
    nose = nose_geometry(lips['vertices'], lips['faces'], NOSE_TIP, NOSE_SIZE)
    vertices, faces, indices = nose['vertices'], nose['faces'], nose['material_indices']
    front = front_surface(vertices, faces)
    jaw = JawHinge.ear(vertices, MOUTH_Z, MOUTH_HW)
    nostril = material('nostril', (.12, .03, .02), roughness=.8)
    head = mesh_from_geometry('head_skin', {'vertices': vertices, 'faces': faces, 'material_indices': indices}, [skin, nostril])
    slit_mouth(head, MOUTH_Z, MOUTH_HW)
    rest = [tuple(v.co) for v in head.data.vertices]

    still = eye_hole_mask(*holes.values())
    my = front(0, MOUTH_Z)
    mc = (MOUTH_HW, front(MOUTH_HW, MOUTH_Z), MOUTH_Z)
    pairs = {
        'browDown': ((.03, front(.03, .182), .182), .018, (0, -.001, -.004)),
        'browOuterUp': ((.048, front(.048, .182), .182), .016, (0, 0, .004)),
        'cheekSquint': ((.042, front(.042, .118), .118), .02, (0, -.001, .004)),
        'mouthSmile': (mc, .016, (.003, .001, .004)),
        'mouthFrown': (mc, .016, (0, 0, -.004)),
        'mouthStretch': (mc, .016, (.004, 0, -.001)),
    }
    for name, (center, radius, offset) in pairs.items():
        left, right = symmetric_offsets(rest, center, radius, offset, mask=still)
        shape_key(head, f'{name}Left', left)
        shape_key(head, f'{name}Right', right)
    # The nose's own sneer: each nostril wing lifts and flares.
    left, right = symmetric_offsets(rest, *nose['sneer'])
    shape_key(head, 'noseSneerLeft', left)
    shape_key(head, 'noseSneerRight', right)
    shape_key(head, 'browInnerUp', soft_offset(rest, (0, front(0, .18), .18), (.03, .02, .016), (0, 0, .004), mask=still))
    shape_key(head, 'mouthFunnel', soft_offset(rest, (0, my, MOUTH_Z), (.026, .02, .016), (0, -.004, 0)))
    add_jaw_open(head, jaw, min_chin_drop=.1)

    dark = material('mouth_cavity', (.03, .005, .01), roughness=.9)
    dark.use_backface_culling = False
    cavity = mesh_from_geometry('mouth_cavity', mouth_cavity_geometry((0, my, MOUTH_Z - .001), width=.04, height=.03, depth=.05, surface=front), [dark])
    add_jaw_open(cavity, jaw)
    upper = mesh_from_geometry('teeth_upper', teeth_row_geometry('rounded', (0, my + .005, MOUTH_Z + .0015), .018, .011, 6, .005, row='upper'),
                               [material('teeth_upper', (.93, .91, .84), roughness=.3)])
    lower = mesh_from_geometry('teeth_lower', teeth_row_geometry('rounded', (0, my + .006, MOUTH_Z - .0015), .017, .011, 6, .0045, row='lower'),
                               [material('teeth_lower', (.9, .88, .8), roughness=.3)])
    add_jaw_open(lower, jaw, rigid=True)
    buck = mesh_from_geometry('teeth_exposed', exposed_teeth_geometry(front, (-.0033, .0033), MOUTH_Z, length=.0055, width=.0058, style='rounded'),
                              [material('teeth_exposed', (.96, .95, .9), roughness=.25)])
    tongue = mesh_from_geometry('tongue', tongue_geometry((0, my + .025, MOUTH_Z - .012), length=.028, width=.024, thickness=.007),
                                [material('tongue', (.62, .16, .2), roughness=.5)])
    add_jaw_open(tongue, jaw, rigid=True)

    # Freckles seated on the cheeks: attach_to_skin gives them the skin's cheekSquint and smile deltas.
    freckles = []
    spots = [(.036, .124), (.043, .120), (.049, .125), (.040, .113), (.047, .114)]
    for fx, fz in spots + [(-x, z) for x, z in spots]:
        dot = ellipsoid_geometry((fx, front(fx, fz), fz), (.0012, .0006, .0012), rings=6, segments=8)
        freckles.append(attach_to_skin(dot, head, depth=.0002))
    fgeo = join_geometry(freckles)
    freck = mesh_from_geometry('freckles', fgeo, [material('freckle', (.3, .09, .04), roughness=.6)])
    for name, targets in fgeo['morphs'].items(): shape_key(freck, name, targets)

    # Brows laid on the skin in every pose (the head's own brow shapes included): no attach_to_skin needed.
    hair_mat = material('hair', (.12, .04, .015), roughness=.7)
    brows = [skin_brow_geometry(head, side, inner=(.013, .178), outer=(.05, .181), height=.0045, thickness=.002, hole=holes[side]) for side in 'LR']
    bgeo = join_geometry(brows)
    brow_obj = mesh_from_geometry('brows', bgeo, [hair_mat])
    for name, targets in bgeo['morphs'].items(): shape_key(brow_obj, name, targets)

    # Hair cap: a slightly larger shell with the face cut away (clears the brows).
    cap = ellipsoid_geometry((0, .004, .136), (.092, .088, .112), rings=40, segments=56)
    hv, hf, _ = cut_faces(cap['vertices'], cap['faces'], lambda c: (c[2] < .192 and c[1] < -.01) or c[2] < .12)
    hair = mesh_from_geometry('hair_cap', {'vertices': hv, 'faces': hf}, [hair_mat])

    # Eye materials made once: a second material('eye_white') becomes 'eye_white.001' in Blender.
    eye_mats = [material('eye_white', (.9, .9, .87), roughness=.2), material('eye_iris', (.03, .3, .33), roughness=.3),
                material('eye_pupil', (.01, .01, .01), roughness=.2)]
    parts, eyeballs = [head, cavity, upper, lower, buck, tongue, freck, brow_obj, hair], []
    for side, center in (('L', EYE_L), ('R', EYE_R)):
        eye = build_eye(rig, side, center, EYE_RADIUS, lid_material=skin, style='lid', hole=holes[side], eye_materials=eye_mats)
        eyeballs.append(eye['eyeball'])
        parts.append(eye['lids'])
    face = join_face_parts(parts, 'face', rig=rig)
    objects = [rig, face] + eyeballs
    gaze = recommended_gaze(OPENING)
    face_contract(rig, objects, yaw_max=gaze['yawMax'], pitch_max=gaze['pitchMax'], exposed_teeth=['teeth_exposed'])
    return objects

