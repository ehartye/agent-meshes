"""Replacing a curved interior retains exterior skin, UV, old keys and NLA."""
import bpy
import numpy as np
import agent_meshes_sculpt_face as sculpt
from agent_meshes_author import make_mesh,material,shape_key,bind_skin
from agent_meshes_face import mark_face_region

EXPORT_ANIMATION_MODE='NLA_TRACKS'

def build():
    assert hasattr(sculpt,'replace_sculpt_mouth_pocket'),'Shared curved pocket replacement is missing'
    data=bpy.data.armatures.new('rig');rig=bpy.data.objects.new('rig',data);bpy.context.collection.objects.link(rig)
    bpy.context.view_layer.objects.active=rig;rig.select_set(True);bpy.ops.object.mode_set(mode='EDIT')
    head=data.edit_bones.new('head');head.head=(0,0,0);head.tail=(0,0,.2)
    bpy.ops.object.mode_set(mode='OBJECT')
    rim=np.array([[.02,.004,.1],[.01,0,.103],[0,-.002,.104],[-.01,.001,.103],[-.02,.004,.1],[0,-.0016,.098]])
    outer=(rim-[0,0,.1])*[1.5,1,2]+[0,0,.1]
    v=np.concatenate([rim,outer,[[0,.02,.1]]])
    exterior=[(i,(i+1)%6,(i+1)%6+6,i+6) for i in range(6)]
    pocket=[(i,12,(i+1)%6) for i in range(6)]
    body=make_mesh('body',v,exterior+pocket,material('skin','#986b52'))
    # This authored wire is unrelated to the selected patch and must survive.
    import bmesh
    bm=bmesh.new();bm.from_mesh(body.data);bm.verts.ensure_lookup_table()
    bm.edges.new((bm.verts[0],bm.verts[2]));bm.to_mesh(body.data);bm.free()
    bind_skin(body,rig,[{'head':1.} for _ in v]);mark_face_region(body,range(len(v)))
    uv=body.data.uv_layers.new(name='authored-uv')
    for i,p in enumerate(uv.data):p.uv=(i/60,(i%3)/3)
    uv_before=np.array([p.uv[:] for p in uv.data[:24]])
    old=v.copy();old[2,2]+=.0001
    shape_key(body,'mouthSmileLeft',old)
    key=body.data.shape_keys.key_blocks['mouthSmileLeft'];key.value=0;key.keyframe_insert('value',frame=1);key.keyframe_insert('value',frame=10)
    animation=body.data.shape_keys.animation_data;action=animation.action
    track=animation.nla_tracks.new();track.name='idle';track.strips.new('idle',1,action);animation.action=None
    rest=np.array([p.co[:] for p in body.data.vertices]);old=np.array([p.co[:] for p in key.data])
    jaw=rest.copy();jaw[5,2]-=.006
    rows=[{body.vertex_groups[g.group].name:g.weight for g in p.groups} for p in body.data.vertices]
    kwargs=dict(upper_arc=[0,1,2,3,4],lower_arc=[0,5,4],cavity_faces=list(range(6,12)),
                rings=[(.006,.85,.002),(.012,.7,.004)],jaw_targets=jaw)
    try:sculpt.replace_sculpt_mouth_pocket(body,**{**kwargs,'cavity_faces':[0]})
    except ValueError:pass
    else:raise AssertionError('Wrong patch accepted')
    assert len(body.data.vertices)==13 and 'jawOpen' not in body.data.shape_keys.key_blocks
    body.data.shape_keys.key_blocks[0].name='Reference'
    try:sculpt.replace_sculpt_mouth_pocket(body,**kwargs)
    except ValueError:pass
    else:raise AssertionError('Unsupported reference key name accepted')
    body.data.shape_keys.key_blocks[0].name='Basis'
    # A pocket-only vertex attached to external wire geometry is not unused.
    bm=bmesh.new();bm.from_mesh(body.data);bm.verts.ensure_lookup_table()
    bm.edges.new((bm.verts[12],bm.verts[8]));bm.to_mesh(body.data);bm.free()
    before_materials=len(body.data.materials)
    try:sculpt.replace_sculpt_mouth_pocket(body,**kwargs)
    except ValueError:pass
    else:raise AssertionError('Interior owning external wire accepted')
    assert len(body.data.vertices)==13 and len(body.data.materials)==before_materials
    assert 'jawOpen' not in body.data.shape_keys.key_blocks
    bm=bmesh.new();bm.from_mesh(body.data);bm.verts.ensure_lookup_table()
    e=next(e for e in bm.edges if {v.index for v in e.verts}=={12,8})
    bmesh.ops.delete(bm,geom=[e],context='EDGES');bm.to_mesh(body.data);bm.free()
    result=sculpt.replace_sculpt_mouth_pocket(body,**kwargs)
    assert any(set(e.vertices)=={0,2} and e.is_loose for e in body.data.edges)
    # Old pocket center is removed; original exterior indices remain in order.
    assert len(body.data.vertices)==25 and len(body.data.polygons)==24
    np.testing.assert_array_equal([p.co[:] for p in body.data.shape_keys.key_blocks['Basis'].data[:12]],rest[:12])
    np.testing.assert_array_equal([p.co[:] for p in body.data.shape_keys.key_blocks['mouthSmileLeft'].data[:12]],old[:12])
    np.testing.assert_array_equal([p.co[:] for p in body.data.shape_keys.key_blocks['jawOpen'].data[:12]],jaw[:12].astype(np.float32).astype(float))
    np.testing.assert_array_equal([p.uv[:] for p in body.data.uv_layers['authored-uv'].data[:24]],uv_before)
    assert [{body.vertex_groups[g.group].name:g.weight for g in p.groups} for p in body.data.vertices[:12]]==rows[:12]
    assert all(p.value==1 for p in body.data.attributes['_FACE_REGION'].data)
    assert body.data.shape_keys.animation_data.nla_tracks[0].strips[0].action==action
    assert len(body.modifiers)==1 and body.modifiers[0].object==rig
    assert result['removedPocketFaces']==6 and result['addedPocketFaces']==18
    assert result['fullFaceContractClaim']==False
    # Deleted vertices can be in the middle of the original mesh. BMesh may
    # reuse their storage slots; preservation is through returned correspondence.
    permutation=np.array([0,1,12,2,3,4,5,6,7,8,9,10,11]);inverse=np.argsort(permutation)
    probe=make_mesh('interleaved-pocket',rest[permutation],
                    [inverse[list(f)].tolist() for f in exterior+pocket],material('probe-skin','#986b52'))
    bind_skin(probe,rig,[{'head':1.} for _ in rest]);mark_face_region(probe,range(len(rest)))
    shape_key(probe,'mouthSmileLeft',old[permutation])
    correspondence=sculpt.replace_sculpt_mouth_pocket(probe,
        **{**kwargs,'upper_arc':inverse[kwargs['upper_arc']].tolist(),
           'lower_arc':inverse[kwargs['lower_arc']].tolist(),'jaw_targets':jaw[permutation]})
    mapping=correspondence['originalVertexMap'];assert mapping[2]==-1
    for i,j in enumerate(mapping):
        if j>=0:
            np.testing.assert_array_equal(probe.data.shape_keys.key_blocks['Basis'].data[j].co[:],rest[permutation[i]])
            np.testing.assert_array_equal(probe.data.shape_keys.key_blocks['mouthSmileLeft'].data[j].co[:],old[permutation[i]])
    for i,j in enumerate(correspondence['originalPolygonMap']):
        if j>=0:assert list(probe.data.polygons[j].vertices)==[mapping[inverse[v]] for v in exterior[i]]
    bpy.data.objects.remove(probe,do_unlink=True)
    return [body,rig]
