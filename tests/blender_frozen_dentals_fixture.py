"""Attach explicit dental motion after curved-pocket construction, without refitting."""
import bpy
import numpy as np
import agent_meshes_sculpt_face as sculpt
from agent_meshes_author import ellipsoid_geometry
import blender_curved_pocket_fixture as curved

EXPORT_ANIMATION_MODE='NLA_TRACKS'

def build():
    assert hasattr(sculpt,'attach_sculpt_dentals'),'Shared frozen-jaw dental attachment is missing'
    body,rig=curved.build()
    # Existing outside membership and arbitrary point metadata must not change.
    body.data.attributes['_FACE_REGION'].data[8].value=0
    owner=body.data.attributes.new(name='_OWNER',type='FLOAT',domain='POINT')
    for i,p in enumerate(owner.data):p.value=i/40
    count=len(body.data.vertices);polygons=len(body.data.polygons)
    key_names=[k.name for k in body.data.shape_keys.key_blocks]
    coordinates={k.name:np.array([p.co[:] for p in k.data]) for k in body.data.shape_keys.key_blocks}
    membership=[p.value for p in body.data.attributes['_FACE_REGION'].data]
    owners=[p.value for p in owner.data]
    weights=[{body.vertex_groups[g.group].name:g.weight for g in p.groups} for p in body.data.vertices]
    faces=[list(p.vertices) for p in body.data.polygons]
    slots=[p.material_index for p in body.data.polygons]
    materials=list(body.data.materials)
    uv={layer.name:np.array([p.uv[:] for p in layer.data]) for layer in body.data.uv_layers}
    action=body.data.shape_keys.animation_data.nla_tracks[0].strips[0].action
    parts=[];targets={}
    for name,z,color,moving in [('teeth_upper',.102,'#fff5df',False),
                                ('teeth_lower',.0985,'#fff5df',True),('tongue',.0975,'#a44f58',True)]:
        geometry=ellipsoid_geometry((0,.008,z),(.003,.001,.0006),rings=4,segments=6)
        rest=np.array(geometry['vertices']);target=rest.copy()
        if moving:
            # Explicit nonrigid motion makes an implicit hinge refit observable.
            target[:,2]-=.003+.04*rest[:,0]
            target[:,0]*=1.02
            geometry['morphs']={'jawOpen':target.tolist()}
        targets[name]=(rest.astype(np.float32).astype(float),target.astype(np.float32).astype(float))
        parts.append((name,geometry,color))
    before_objects=len(bpy.data.objects)
    def rejected(candidate):
        try:sculpt.attach_sculpt_dentals(body,rig,parts=candidate)
        except ValueError:pass
        else:raise AssertionError('Invalid dental attachment accepted')
        assert len(body.data.vertices)==count and len(body.data.polygons)==polygons
        assert list(body.data.materials)==materials and len(bpy.data.objects)==before_objects
        for key in body.data.shape_keys.key_blocks:
            np.testing.assert_array_equal([p.co[:] for p in key.data],coordinates[key.name])
    rejected(parts[:2])
    rejected(parts+[parts[0]])
    rejected([parts[0],('teeth_lower',{**parts[1][1],'morphs':{}},parts[1][2]),parts[2]])
    bad_upper={**parts[0][1],'morphs':{'jawOpen':(np.array(parts[0][1]['vertices'])+[0,0,.001]).tolist()}}
    rejected([('teeth_upper',bad_upper,parts[0][2]),*parts[1:]])
    bad_lower={**parts[1][1],'morphs':{'jawOpen':np.full_like(np.array(parts[1][1]['vertices']),np.nan).tolist()}}
    rejected([parts[0],('teeth_lower',bad_lower,parts[1][2]),parts[2]])
    jaw=body.data.shape_keys.key_blocks['jawOpen'];jaw.name='unrelated-expression'
    try:sculpt.attach_sculpt_dentals(body,rig,parts=parts)
    except ValueError:pass
    else:raise AssertionError('Missing frozen jaw accepted')
    jaw.name='jawOpen'
    jaw.value=.2
    rejected(parts)
    jaw.value=0
    # Neither adding dentals nor native join is allowed to replace the old jaw.
    result=sculpt.attach_sculpt_dentals(body,rig,parts=parts)
    assert [k.name for k in body.data.shape_keys.key_blocks]==key_names
    for key in body.data.shape_keys.key_blocks:
        np.testing.assert_array_equal([p.co[:] for p in key.data[:count]],coordinates[key.name])
    assert [list(p.vertices) for p in body.data.polygons[:polygons]]==faces
    assert [p.material_index for p in body.data.polygons[:polygons]]==slots
    assert list(body.data.materials[:len(materials)])==materials
    for name,old in uv.items():np.testing.assert_array_equal([p.uv[:] for p in body.data.uv_layers[name].data[:len(old)]],old)
    assert [{body.vertex_groups[g.group].name:g.weight for g in p.groups} for p in body.data.vertices[:count]]==weights
    assert [p.value for p in body.data.attributes['_FACE_REGION'].data[:count]]==membership
    assert [p.value for p in body.data.attributes['_OWNER'].data[:count]]==owners
    assert body.data.shape_keys.animation_data.nla_tracks[0].strips[0].action==action
    assert len(body.modifiers)==1 and body.modifiers[0].object==rig
    # Check motion by material ownership, independent of selected-object ordering.
    for name,(rest,target) in targets.items():
        ids=sorted({i for p in body.data.polygons[polygons:] if body.data.materials[p.material_index].name==name for i in p.vertices})
        assert len(ids)==len(rest)
        np.testing.assert_array_equal([body.data.shape_keys.key_blocks['Basis'].data[i].co[:] for i in ids],rest)
        np.testing.assert_array_equal([body.data.shape_keys.key_blocks['jawOpen'].data[i].co[:] for i in ids],target)
        for old in key_names[1:]:
            if old!='jawOpen':np.testing.assert_array_equal([body.data.shape_keys.key_blocks[old].data[i].co[:] for i in ids],rest)
        for i in ids:
            assert body.data.attributes['_FACE_REGION'].data[i].value==1
            assert {body.vertex_groups[g.group].name:g.weight for g in body.data.vertices[i].groups}=={'head':1.}
    assert len(body.data.vertices)==count+sum(len(p[1]['vertices']) for p in parts)
    assert len(body.data.polygons)==polygons+sum(len(p[1]['faces']) for p in parts)
    assert result['existingJawReused'] and result['newBodyJawFits']==0 and not result['fullFaceContractClaim']
    return [body,rig]
