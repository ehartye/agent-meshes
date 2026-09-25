"""Soft lips on a shaped kid head: the P1a round-6 critic's "Pix", written from the README, as a fixture.

An sdf_blank head (cheeks and a chin smooth-unioned onto an ellipsoid), mirrored eye holes with lash lines, soft lips
with a lip line (`sculpt_lips`, 21 mm half-width), a fused button nose, skin brows, paint and buck teeth. Round 6 found
`sculpt_lips` streaked the crease and, on this sdf_blank head, left slivers at the mouth corners that folded (the build
was refused at a 21 mm half-width; at 20 mm happy/angry/scared + jawOpen flipped 2/2/8 skin triangles). The lips are now
a regular grid wrapped round the mouth with a row on the mouth line; this fixture builds and must verify clean.
Blender coordinates: Z up, meters, the face looks down -Y, character left is +X.
"""
from agent_meshes_author import (
    JawHinge, add_jaw_open, build_eye, cut_faces, ellipsoid_geometry, ellipsoid_sdf, smooth_min, sdf_blank,
    exposed_teeth_geometry, eye_holes, eye_hole_mask, face_contract, face_skeleton, front_surface, join_face_parts,
    join_geometry, material, mesh_from_geometry, mouth_cavity_geometry, recommended_gaze, shape_key, skin_brow_geometry,
    slit_mouth, soft_offset, symmetric_offsets, teeth_row_geometry, tongue_geometry, sculpt_lips, nose_geometry,
    skin_tints, paint_vertices, use_vertex_colors, attach_to_skin,
)

C = (0, 0, .13)
EYE_RADIUS = .0165
EYE_L = (.033, -.064, .150)
MOUTH_Z, MOUTH_HW = .088, .021
SMILE = 1
OPENING = (46, 40, 30)
NOSE = (0, .117)
SKIN = (.78, .42, .26)


def head_sdf(p):
    d = ellipsoid_sdf(p, C, (.088, .085, .112))
    for sx in (1, -1):  # chubby cheeks
        d = smooth_min(d, ellipsoid_sdf(p, (sx * .040, -.050, .110), (.036, .034, .030)), .018)
    d = smooth_min(d, ellipsoid_sdf(p, (0, -.050, .062), (.038, .032, .024)), .02)  # chin
    return d


def build():
    skin = material('skin', SKIN, roughness=.55)
    nostril = material('nostril', (.25, .07, .05), roughness=.8)
    rig = face_skeleton(head=(0, 0, .1), eye_left=EYE_L, eye_right=(-EYE_L[0], EYE_L[1], EYE_L[2]), name='Face rig')

    blank = sdf_blank(head_sdf, C)
    vertices, faces = blank['vertices'], blank['faces']
    holes = eye_holes(vertices, faces, EYE_L, EYE_RADIUS, opening=OPENING)
    vertices, faces = holes['vertices'], holes['faces']
    lips = sculpt_lips(vertices, faces, MOUTH_Z, MOUTH_HW)
    nose = nose_geometry(lips['vertices'], lips['faces'], NOSE, (.0105, .0095, .009))
    vertices, faces = nose['vertices'], nose['faces']
    front = front_surface(vertices, faces)
    jaw = JawHinge.ear(vertices, MOUTH_Z, MOUTH_HW)
    head = mesh_from_geometry('head_skin', {'vertices': vertices, 'faces': faces, 'material_indices': nose['material_indices']},
                              [skin, nostril])
    slit_mouth(head, MOUTH_Z, MOUTH_HW)
    rest = [tuple(v.co) for v in head.data.vertices]

    still = eye_hole_mask(holes['L'], holes['R'])
    mc = (MOUTH_HW, front(MOUTH_HW, MOUTH_Z), MOUTH_Z)
    my = front(0, MOUTH_Z)
    pairs = {
        'browDown': ((.03, front(.03, .180), .180), .018, (0, -.001, -.004)),
        'browOuterUp': ((.048, front(.048, .180), .180), .016, (0, 0, .004)),
        'cheekSquint': ((.042, front(.042, .116), .116), .02, (0, -.001, .004)),
        'mouthSmile': (mc, .016, tuple(SMILE * c for c in (.003, .001, .004))),
        'mouthFrown': (mc, .016, (0, 0, -.004)),
        'mouthStretch': (mc, .016, (.004, 0, -.001)),
    }
    for name, (center, radius, offset) in pairs.items():
        left, right = symmetric_offsets(rest, center, radius, offset, mask=still)
        shape_key(head, f'{name}Left', left)
        shape_key(head, f'{name}Right', right)
    left, right = symmetric_offsets(rest, *nose['sneer'])
    shape_key(head, 'noseSneerLeft', left); shape_key(head, 'noseSneerRight', right)
    shape_key(head, 'browInnerUp', soft_offset(rest, (0, front(0, .178), .178), (.03, .02, .016), (0, 0, .004), mask=still))
    shape_key(head, 'mouthFunnel', soft_offset(rest, (0, my, MOUTH_Z), (.026, .02, .016), (0, -.004, 0)))
    add_jaw_open(head, jaw, min_chin_drop=.1)

    # Paint: blush on the cheeks, freckles across the nose bridge/cheeks, lip tint, gentle mottle.
    patches = []
    for sx in (1, -1):
        patches.append({'center': (sx * .042, front(sx * .042, .112), .112), 'radius': (.015, .01, .01), 'color': (.78, .30, .22), 'strength': .7})
        for fx, fz in ((.030, .124), (.037, .120), (.044, .125), (.034, .113), (.041, .115), (.021, .122)):
            patches.append({'center': (sx * fx, front(sx * fx, fz), fz), 'radius': .0014, 'color': (.45, .18, .09), 'strength': .9})
    patches.append({'center': (0, my, MOUTH_Z - .002), 'radius': (.022, .01, .006), 'color': (.70, .28, .22), 'strength': .6})
    paint_vertices(head, skin_tints(rest, base=SKIN, patches=patches, mottle={'scale': .006, 'amount': .04, 'seed': 3}))
    use_vertex_colors(skin)

    dark = material('mouth_cavity', (.03, .005, .01), roughness=.9)
    dark.use_backface_culling = False
    cavity = mesh_from_geometry('mouth_cavity', mouth_cavity_geometry((0, my, MOUTH_Z - .001), width=.038, height=.03, depth=.05, surface=front), [dark])
    add_jaw_open(cavity, jaw)
    upper = mesh_from_geometry('teeth_upper', teeth_row_geometry('rounded', (0, my + .005, MOUTH_Z + .0015), .017, .011, 6, .005, row='upper'),
                               [material('teeth_upper', (.93, .91, .84), roughness=.3)])
    lower = mesh_from_geometry('teeth_lower', teeth_row_geometry('rounded', (0, my + .006, MOUTH_Z - .0015), .016, .011, 6, .0045, row='lower'),
                               [material('teeth_lower', (.9, .88, .8), roughness=.3)])
    add_jaw_open(lower, jaw, rigid=True)
    buck = mesh_from_geometry('teeth_exposed', exposed_teeth_geometry(front, (-.0033, .0033), MOUTH_Z, length=.0055, width=.0058, style='rounded'),
                              [material('teeth_exposed', (.96, .95, .9), roughness=.25)])
    tongue = mesh_from_geometry('tongue', tongue_geometry((0, my + .025, MOUTH_Z - .012), length=.028, width=.024, thickness=.007),
                                [material('tongue', (.62, .16, .2), roughness=.5)])
    add_jaw_open(tongue, jaw, rigid=True)

    hair_mat = material('hair', (.14, .05, .02), roughness=.7)
    brows = [skin_brow_geometry(head, side, inner=(.012, .176), outer=(.049, .180), hole=holes[side]) for side in 'LR']
    bgeo = join_geometry(brows)
    brow_obj = mesh_from_geometry('brows', bgeo, [hair_mat])
    for name, targets in bgeo['morphs'].items(): shape_key(brow_obj, name, targets)

    cap = ellipsoid_geometry((0, .004, .136), (.093, .089, .114), rings=40, segments=56)
    hv, hf, _ = cut_faces(cap['vertices'], cap['faces'], lambda c: (c[2] < .196 and c[1] < -.01) or c[2] < .12)
    hair = mesh_from_geometry('hair_cap', {'vertices': hv, 'faces': hf}, [hair_mat])

    eye_mats = [material('eye_white', (.9, .9, .87), roughness=.2), material('eye_iris', (.03, .3, .33), roughness=.3),
                material('eye_pupil', (.01, .01, .01), roughness=.2)]
    parts, eyeballs = [head, cavity, upper, lower, buck, tongue, brow_obj, hair], []
    for side in 'LR':
        center = EYE_L if side == 'L' else (-EYE_L[0], EYE_L[1], EYE_L[2])
        eye = build_eye(rig, side, center, EYE_RADIUS, lid_material=skin, hole=holes[side], eye_materials=eye_mats, lash=True)
        eyeballs.append(eye['eyeball'])
        parts.append(eye['lids'])
    face = join_face_parts(parts, 'face', rig=rig)
    objects = [rig, face] + eyeballs
    gaze = recommended_gaze(OPENING)
    face_contract(rig, objects, yaw_max=gaze['yawMax'], pitch_max=gaze['pitchMax'], exposed_teeth=['teeth_exposed'])
    return objects
