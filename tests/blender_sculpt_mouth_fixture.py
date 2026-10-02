"""Native mouth assembly retains a mixed body skin, UVs, old morph and NLA."""
import bpy
import numpy as np
from agent_meshes_author import make_mesh,material,bind_skin,shape_key,ellipsoid_geometry
from agent_meshes_face import JawHinge,mark_face_region
import agent_meshes_sculpt_face as sculpt

EXPORT_ANIMATION_MODE='NLA_TRACKS'

def build():
    assert hasattr(sculpt,'add_sculpt_mouth'),'Shared sculpt mouth assembly is missing'
    data=bpy.data.armatures.new('rig');rig=bpy.data.objects.new('rig',data);bpy.context.collection.objects.link(rig)
    bpy.context.view_layer.objects.active=rig;rig.select_set(True);bpy.ops.object.mode_set(mode='EDIT')
    spine=data.edit_bones.new('spine');spine.head=(0,0,0);spine.tail=(0,0,.05)
    head=data.edit_bones.new('head');head.head=(0,0,.05);head.tail=(0,0,.15);head.parent=spine
    bpy.ops.object.mode_set(mode='OBJECT')
    v=np.array([[-.01,-.08,.099],[.01,-.08,.099],[0,-.09,.12],[-.01,-.08,.102],
                [.01,-.08,.102],[0,-.09,.08],[0,-.02,.055],[0,0,0],[0,-.075,.108]])
    faces=[(0,1,2),(3,5,4),(3,4,8),(5,6,4),(6,7,5)]
    body=make_mesh('body',v,faces,material('skin','#986b52'))
    bind_skin(body,rig,[{'spine' if i==7 else 'head':1} for i in range(len(v))]);mark_face_region(body,[i for i in range(9) if i!=7])
    uv=body.data.uv_layers.new(name='authored-uv')
    for i,p in enumerate(uv.data):p.uv=(i/20,(i%3)/3)
    original_uv=np.array([p.uv[:] for p in uv.data]);old=v.copy();old[2,2]+=.001
    key=shape_key(body,'eyeBlinkLeft',old);key.value=.2;key.keyframe_insert('value',frame=1);key.value=0;key.keyframe_insert('value',frame=10)
    animation=body.data.shape_keys.animation_data;action=animation.action
    track=animation.nla_tracks.new();track.name='idle';track.strips.new('idle',1,action);animation.action=None
    bpy.context.scene.frame_set(10)
    original=np.array([p.co[:] for p in body.data.shape_keys.key_blocks['eyeBlinkLeft'].data])
    rows=[{body.vertex_groups[g.group].name:g.weight for g in p.groups} for p in body.data.vertices]
    original_face=[p.value for p in body.data.attributes['_FACE_REGION'].data]
    jaw=JawHinge((0,.03,.1),mouth_z=.1,half_width=.025,drop=.02)
    parts=[(name,ellipsoid_geometry((0,-.04,z),(.008,.003,.003),rings=4,segments=6),color,moving)
           for name,z,color,moving in [('teeth_upper',.11,'#ffffff',False),('teeth_lower',.09,'#ffffff',True),('tongue',.08,'#a44f58',True)]]
    kwargs=dict(face_vertices=[i for i in range(9) if i!=7],lower_lip=[3,4],upper_lip=[0,1],
                cavity_faces=[2],parts=parts,reach=.035,min_chin_drop=.1)
    before_materials=len(body.data.materials)
    try:sculpt.add_sculpt_mouth(body,rig,jaw,**{**kwargs,'cavity_faces':[99]})
    except ValueError:pass
    else:raise AssertionError('Invalid cavity face accepted')
    assert len(body.data.vertices)==9 and len(body.data.materials)==before_materials
    assert 'jawOpen' not in body.data.shape_keys.key_blocks
    data.bones['head'].use_deform=False
    try:sculpt.add_sculpt_mouth(body,rig,jaw,**kwargs)
    except ValueError:pass
    else:raise AssertionError('Nondeforming head accepted')
    assert len(body.data.materials)==before_materials and 'jawOpen' not in body.data.shape_keys.key_blocks
    data.bones['head'].use_deform=True
    for flag in ('hidden','hide_select','hide_viewport'):
        if flag=='hidden':body.hide_set(True)
        else:setattr(body,flag,True)
        try:sculpt.add_sculpt_mouth(body,rig,jaw,**kwargs)
        except ValueError:pass
        else:raise AssertionError('Unavailable join body accepted: '+flag)
        assert len(body.data.vertices)==9 and len(body.data.materials)==before_materials
        assert 'jawOpen' not in body.data.shape_keys.key_blocks
        if flag=='hidden':body.hide_set(False)
        else:setattr(body,flag,False)
    result=sculpt.add_sculpt_mouth(body,rig,jaw,**kwargs)
    np.testing.assert_array_equal([p.co[:] for p in body.data.shape_keys.key_blocks['Basis'].data[:9]],v.astype(np.float32).astype(float))
    np.testing.assert_array_equal([p.co[:] for p in body.data.shape_keys.key_blocks['eyeBlinkLeft'].data[:9]],original)
    np.testing.assert_array_equal([p.uv[:] for p in body.data.uv_layers['authored-uv'].data[:len(original_uv)]],original_uv)
    assert [{body.vertex_groups[g.group].name:g.weight for g in p.groups} for p in body.data.vertices[:9]]==rows
    assert [p.value for p in body.data.attributes['_FACE_REGION'].data[:9]]==original_face
    assert body.data.shape_keys.animation_data.nla_tracks[0].strips[0].action==action
    assert body.data.materials[body.data.polygons[2].material_index].name=='mouth_cavity'
    assert len(body.modifiers)==1 and body.modifiers[0].object==rig
    assert result['chin']['ratio']>=.1 and result['checkedJawWeights']==[.25,.5,.75,1.]
    names=[k.name for k in body.data.shape_keys.key_blocks];assert names==['Basis','eyeBlinkLeft','jawOpen']
    for i in range(9,len(body.data.vertices)):
        assert body.data.attributes['_FACE_REGION'].data[i].value==1
        assert {body.vertex_groups[g.group].name:g.weight for g in body.data.vertices[i].groups}=={'head':1.}
        np.testing.assert_array_equal(body.data.shape_keys.key_blocks['eyeBlinkLeft'].data[i].co[:],body.data.shape_keys.key_blocks['Basis'].data[i].co[:])
    return [body,rig]
