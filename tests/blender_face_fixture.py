"""Real-Blender checks of the face-rig wrappers; run through authorGLB (tests/face-rig-blender.test.ts).

build() asserts wrapper behavior inside Blender, then returns a small joined face for export.
"""
import json
from agent_meshes_author import (
    EXTRAS_PROPERTY, SEAM_ATTRIBUTE, JawHinge, add_jaw_open, chin_drop, build_eye, ellipsoid_geometry, face_contract_extras, face_skeleton,
    join_face_parts, material, mesh_from_geometry, set_face_contract, shape_key, slit_mouth, ARKIT_REQUIRED,
)


def rejects(call, text):
    try:
        call()
    except ValueError as error:
        assert text.lower() in str(error).lower(), str(error)
    else:
        raise AssertionError(f'Expected a rejection mentioning {text!r}')


def build():
    rig = face_skeleton((0, 0, .09), (.03, -.07, .14), (-.03, -.07, .14), name='Face rig')
    assert [b.name for b in rig.data.bones] == ['head', 'eye_L', 'eye_R']
    assert rig.data.bones['eye_L'].parent.name == 'head'
    rejects(lambda: face_skeleton((0, 0, 0), (-.03, 0, 0), (.03, 0, 0)), 'left')
    rejects(lambda: build_eye(rig, 'L', (.031, -.07, .14), .012), 'pivots')
    rejects(lambda: build_eye(rig, 'X', (.03, -.07, .14), .012), 'side')

    skin_material = material('skin', (.6, .4, .3))
    blank = ellipsoid_geometry((0, 0, .12), (.085, .09, .115), rings=32, segments=48)
    skin = mesh_from_geometry('skin', blank, [skin_material])
    before = len(skin.data.vertices)
    split = slit_mouth(skin, .075, .022)
    assert split > 2 and len(skin.data.vertices) > before, (split, before, len(skin.data.vertices))
    tags = [item.value for item in skin.data.attributes[SEAM_ATTRIBUTE].data]
    assert tags.count(1) >= split - 1 and tags.count(2) >= split - 1, 'both lip seams are tagged'

    # Float32 rounds .088 down: the untagged comparison used to hang the upper lip on the jaw.
    frog = mesh_from_geometry('frog', ellipsoid_geometry((0, 0, .12), (.11, .085, .10), rings=40, segments=56), [skin_material])
    slit_mouth(frog, .088, .055)
    frog_rest = [tuple(v.co) for v in frog.data.vertices]
    frog_jaw = JawHinge.ear(frog_rest, .088, .055)
    add_jaw_open(frog, frog_jaw, min_chin_drop=.1)
    frog_tags = [item.value for item in frog.data.attributes[SEAM_ATTRIBUTE].data]
    opened = frog.data.shape_keys.key_blocks['jawOpen'].data
    upper = [i for i, t in enumerate(frog_tags) if t == 2]
    lower = [i for i, t in enumerate(frog_tags) if t == 1]
    assert upper and all((opened[i].co - frog.data.vertices[i].co).length < 1e-9 for i in upper), 'the upper lip stays at mouth_z .088'
    assert lower and all(opened[i].co.z < frog.data.vertices[i].co.z - .02 for i in lower), 'the lower lip opens at mouth_z .088'
    assert chin_drop(frog_rest, [tuple(p.co) for p in opened])['ratio'] >= .1
    import bpy
    bpy.data.objects.remove(frog, do_unlink=True)

    jaw = JawHinge.ear([tuple(v.co) for v in skin.data.vertices], .075, .022)
    rejects(lambda: add_jaw_open(skin, jaw, weight=1, rigid=True), 'rigid')
    sharp = JawHinge(pivot=(0, -.005, .1), angle=18, mouth_z=.075, half_width=.022, back_band=.02)
    rejects(lambda: add_jaw_open(skin, sharp), 'folds')
    middle = JawHinge(pivot=(0, -.005, .1), angle=18, mouth_z=.075, half_width=.022, back_band=.06)
    rejects(lambda: add_jaw_open(skin, middle, min_chin_drop=.1), 'raises the lowest point')
    assert skin.data.shape_keys is None, 'a rejected jaw leaves no shape key behind'
    add_jaw_open(skin, jaw, min_chin_drop=.1)
    rest = [tuple(v.co) for v in skin.data.vertices]
    for name in ARKIT_REQUIRED:
        if name != 'jawOpen' and not name.startswith('eye'):
            shape_key(skin, name, [(x, y, z + .002) for x, y, z in rest])
    rejects(lambda: slit_mouth(skin, .075, .02), 'before adding shape keys')

    teeth = mesh_from_geometry('teeth_lower', {'vertices': [(0, -.08, .07), (.01, -.08, .07), (0, -.08, .08), (.01, -.08, .08)], 'faces': [(0, 1, 3, 2)]}, [material('teeth_lower', (.9, .9, .85))])
    add_jaw_open(teeth, jaw, rigid=True)
    eyes = [build_eye(rig, side, center, .012) for side, center in (('L', (.03, -.07, .14)), ('R', (-.03, -.07, .14)))]
    parts = [skin, teeth] + [e['lids'] for e in eyes] + [e['socket'] for e in eyes]
    counts = sum(len(p.data.vertices) for p in parts)
    face = join_face_parts(parts, 'face', rig=rig)
    assert len(face.data.vertices) == counts
    names = [k.name for k in face.data.shape_keys.key_blocks[1:]]
    assert set(ARKIT_REQUIRED) <= set(names) and len(names) == len(set(names)), names
    assert [m.name for m in face.data.materials] == ['skin', 'teeth_lower', 'lid', 'eye_socket'], [m.name for m in face.data.materials]
    assert all(k.value == 0 for k in face.data.shape_keys.key_blocks[1:])
    assert face.parent == rig and any(m.type == 'ARMATURE' for m in face.modifiers)

    extras = face_contract_extras(names, yaw_max=25, pitch_max=15)
    set_face_contract(rig, extras)
    assert json.loads(rig[EXTRAS_PROPERTY])['arkitFace']['contract'] == 'arkit-face/1'
    rejects(lambda: set_face_contract(rig, {'arkitFace': {'contract': 'nope'}}), 'contract')
    return [rig, face] + [e['eyeball'] for e in eyes]
