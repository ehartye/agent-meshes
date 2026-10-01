"""Real Blender: build_eye must keep pupil and continuous lid motion aligned."""
import math
import bpy
from agent_meshes_author import material
from agent_meshes_face import face_skeleton, build_eye, mesh_from_geometry, ellipsoid_geometry
from agent_meshes_eye_frames import oriented_eye_hole, oriented_eyeball_geometry, eye_bone_frame


def build():
    center=(.045,-.052,.182)
    forward=(.5,-math.sqrt(.75),0)
    blank=ellipsoid_geometry((0,0,.12),(.11,.085,.10),rings=56,segments=72)
    hole=oriented_eye_hole(blank['vertices'],blank['faces'],center,.02,forward=forward,opening=(48,36,28))
    rig=face_skeleton((0,0,.1),center,(-center[0],center[1],center[2]))
    from mathutils import Matrix
    bpy.context.view_layer.objects.active=rig
    bpy.ops.object.mode_set(mode='EDIT')
    bone=rig.data.edit_bones['eye_L'];length=bone.length
    bone.matrix=Matrix(eye_bone_frame(center,forward=forward));bone.length=length
    bpy.ops.object.mode_set(mode='OBJECT')
    rig['agent_meshes_extras']='{"eyeFrameFixture":true}'
    skin=mesh_from_geometry('oriented-skin',hole,[material('oriented-skin','#b79ad6')])
    eye=build_eye(rig,'L',center,.02,hole=hole,skin=skin,iris=32,pupil=15)
    expected=oriented_eyeball_geometry(center,.02,forward=forward,iris=32,pupil=15)
    error=max(math.dist(v.co,p) for v,p in zip(eye['eyeball'].data.vertices,expected['vertices']))
    assert error<1e-7, f'build_eye pupil does not follow the hole frame: {error} m'
    assert set(skin.data.shape_keys.key_blocks.keys())=={'Basis','eyeBlinkLeft','eyeSquintLeft','eyeWideLeft'}
    assert eye['lids'] is None and eye['socket'] is None
    lookup={tuple(round(c,6) for c in p):m for p,m in hole['motion']}
    checked=0
    for vertex in skin.data.vertices:
        moved=lookup.get(tuple(round(c,6) for c in vertex.co))
        if moved is None:continue
        for name,key in [('blink','eyeBlinkLeft'),('squint','eyeSquintLeft'),('wide','eyeWideLeft')]:
            assert math.dist(skin.data.shape_keys.key_blocks[key].data[vertex.index].co,moved[name])<1e-7
        checked+=1
    assert checked>=len(hole['motion'])*.98
    from agent_meshes_face import bind_rigid
    bind_rigid(skin,rig)
    return [rig,skin,eye['eyeball']]
