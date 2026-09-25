"""Tin-can robot for the arkit-face/1 fixtures (Bolt's design), authored only with the agent-meshes face helpers.

Recessed shutter eyes behind a flat face plate (each hole sealed by `shutter_hole`: a tube back from the plate and a
cap behind the eye, so no view through it finds the head's inside), rigid brow plates, a skull and a hinged chin
plate with thick edges, grille teeth, and a rubber mouth edge that carries the smile, frown, stretch and funnel shapes.
Blender coordinates: Z up, meters, the face looks down -Y, character left is +X.
"""
from agent_meshes_author import (
    JawHinge, add_jaw_open, brow_plate_geometry, build_eye, ellipsoid_geometry, face_contract, face_skeleton,
    front_surface, join_face_parts, material, mesh_from_geometry, mouth_cavity_geometry, rubber_mouth_geometry, shape_key,
    shutter_hole, split_plates, symmetric_offsets, teeth_row_geometry,
)

CENTER, HALF = (0, 0, .13), (.075, .065, .10)   # a tin can 150 x 130 x 200 mm with rounded edges
EYE_RADIUS = .016
EYE_L = (.032, -.0415, .16)                      # recessed behind the face plate, so the shutters slide behind it
EYE_R = (-EYE_L[0], EYE_L[1], EYE_L[2])
MOUTH_Z, MOUTH_HALF_WIDTH = .085, .04
GUM_Z = MOUTH_Z + .006                           # the upper grille teeth hang from here


def build():
    tin = material('tin', (.55, .58, .62), metalness=.8, roughness=.35)
    dark_tin = material('brow_plate', (.3, .32, .35), metalness=.8, roughness=.4)
    rubber = material('rubber', (.08, .08, .09), roughness=.8)
    rig = face_skeleton(head=(0, 0, .09), eye_left=EYE_L, eye_right=EYE_R, name='Face rig')

    blank = ellipsoid_geometry(CENTER, HALF, rings=48, segments=64, exponent=6)
    vertices, faces = blank['vertices'], blank['faces']
    holes = {}
    for side, eye in (('L', EYE_L), ('R', EYE_R)):
        # surface=None: shutter_hole checks the blades against the holed face itself.
        holes[side] = shutter_hole(vertices, faces, eye, EYE_RADIUS, hole_radius=.018, aperture=.021)
        vertices, faces = holes[side]['vertices'], holes[side]['faces']
    front = front_surface(vertices, faces)
    jaw = JawHinge.ear(vertices, MOUTH_Z, MOUTH_HALF_WIDTH, angle=14, drop=.012)

    # The chin plate is the whole head below the mouth line: a rigid part with thick edges, its rim below the gums.
    plates = split_plates(vertices, faces, MOUTH_Z, .003, gum_z=GUM_Z)
    skull = mesh_from_geometry('skull', plates['skull'], [tin])
    plate = mesh_from_geometry('chin_plate', plates['plate'], [tin])
    add_jaw_open(plate, jaw, rigid=True, min_chin_drop=.1)
    rest = [tuple(v.co) for v in skull.data.vertices]
    left, right = symmetric_offsets(rest, (.035, -.064, .128), .016, (0, -.001, .004))   # cheek vents lift
    shape_key(skull, 'cheekSquintLeft', left)
    shape_key(skull, 'cheekSquintRight', right)

    # The rubber mouth edge flexes for the mouth shapes while both plates stay rigid.
    mouth = rubber_mouth_geometry(front, MOUTH_Z, MOUTH_HALF_WIDTH, jaw=jaw)
    edge = mesh_from_geometry('mouth_edge', mouth, [rubber])
    for name, targets in mouth['morphs'].items(): shape_key(edge, name, targets)

    brows = []
    for side, x in (('L', EYE_L[0]), ('R', EYE_R[0])):
        geometry = brow_plate_geometry((x, 0, .192), (.04, .005, .008), side, surface=front)
        brow = mesh_from_geometry(f'brow_{side}', geometry, [dark_tin], smooth=False)
        for name, targets in geometry['morphs'].items(): shape_key(brow, name, targets)
        brows.append(brow)

    dark = material('mouth_cavity', (.02, .02, .025), roughness=.9)
    dark.use_backface_culling = False
    cavity = mesh_from_geometry('mouth_cavity', mouth_cavity_geometry((0, front(0, MOUTH_Z), MOUTH_Z), width=.09, height=.05, depth=.06, surface=front), [dark])
    add_jaw_open(cavity, jaw)
    upper = mesh_from_geometry('teeth_upper', teeth_row_geometry('grille', (0, -.058, GUM_Z), .032, .01, 8, .014, row='upper'),
                               [material('teeth_upper', (.85, .85, .8), metalness=.5, roughness=.3)])
    lower = mesh_from_geometry('teeth_lower', teeth_row_geometry('grille', (0, -.056, MOUTH_Z), .03, .01, 8, .007, row='lower'),
                               [material('teeth_lower', (.85, .85, .8), metalness=.5, roughness=.3)])
    add_jaw_open(lower, jaw, rigid=True)

    parts, eyeballs = [skull, plate, edge, cavity, upper, lower] + brows, []
    for side, center in (('L', EYE_L), ('R', EYE_R)):
        # The blades shutter_hole built (and checked against the face plate), in a housing inside the sealed tube.
        eye = build_eye(rig, side, center, EYE_RADIUS, style='shutter', lid_material=dark_tin, hole=holes[side])
        eyeballs.append(eye['eyeball'])
        parts += [eye['lids'], eye['socket']]

    face = join_face_parts(parts, 'face', rig=rig)
    objects = [rig, face] + eyeballs
    face_contract(rig, objects, yaw_max=20, pitch_max=12, exposed_teeth=[])
    return objects
