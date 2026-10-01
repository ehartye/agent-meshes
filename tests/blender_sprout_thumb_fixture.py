"""Shortened thumbs retain a continuous root without changing the rest of the rig."""
import json
from pathlib import Path
import bpy
import numpy as np
from mathutils.bvhtree import BVHTree
from agent_meshes_sprout_kin import build_anatomy
from agent_meshes_sprout_rig import anatomy_weights,rig_anatomy,skeleton
from agent_meshes_tessellation import triangulate_surface
import agent_meshes_sprout_gait as gait

EXPORT_ANIMATION_MODE='NLA_TRACKS'

def strict_crossing(a,b):
    for first,second in ((a,b),(b,a)):
        e1=second[1]-second[0];e2=second[2]-second[0]
        for i in range(3):
            origin=first[i];direction=first[(i+1)%3]-origin
            p=np.cross(direction,e2);det=np.dot(e1,p)
            if abs(det)<1e-14:continue
            tvec=origin-second[0];u=np.dot(tvec,p)/det;q=np.cross(tvec,e1)
            v=np.dot(direction,q)/det;t=np.dot(e2,q)/det
            if 1e-6<t<1-1e-6 and u>1e-6 and v>1e-6 and u+v<1-1e-6:return True
    return False

def build(age):
    tri=np.array([[0.,0,0],[1,0,0],[0,1,0]]);cross=np.array([[.2,.2,-1],[.3,.2,1],[.2,.3,1]])
    assert strict_crossing(tri,cross) and not strict_crossing(tri,cross+[3,0,0]) and not strict_crossing(tri,tri+[.05,.05,0])
    objects,a=build_anatomy(age=age,height=1.12 if age=='child' else 1.7,finger_scale=.70,thumb_scale=.85)
    body=next(o for o in objects if o.name=='sprout-body')
    for bad in [1,None,'yes']:
        try:anatomy_weights(body,a,thumb_seams=bad)
        except ValueError:pass
        else:raise AssertionError('thumb_seams must be an explicit boolean')
    for regions in [['trunk'],['palm_l','thumb_l']]:
        try:anatomy_weights(body,a,regions=regions,thumb_seams=True)
        except ValueError:pass
        else:raise AssertionError('Thumb repair requires bilateral palm and thumb sources')
    kwargs=dict(hip_seams=True,neck_seam=True,waist_seam=True)
    before,_=anatomy_weights(body,a,**kwargs)
    default,_=anatomy_weights(body,a,thumb_seams=False,**kwargs)
    assert default==before,'Explicit false changed default rows'
    after,report=anatomy_weights(body,a,thumb_seams=True,**kwargs)
    rest=np.array([v.co[:] for v in body.data.vertices]);bones=skeleton(a)
    masks={side:np.array([np.linalg.norm(p-bones['thumb_'+side+'_base']['head'])<.03*a['scale'] and row.get('thumb_'+side+'_base',0)+row.get('thumb_'+side+'_tip',0)>.01 for p,row in zip(rest,before)]) for side in ['l','r']}
    free=masks['l']|masks['r']
    assert report['thumbSeamVertices']==int(free.sum()) and free.any()
    assert report['thumbSeamVerticesBySide']=={side:int(mask.sum()) for side,mask in masks.items()}
    assert any(x!=y for x,y in zip(before,after)),'Repair did nothing'
    for i,(x,y) in enumerate(zip(before,after)):
        if not free[i]:assert x==y,'Unrelated source weights changed'
        assert 1<=len(y)<=4 and abs(sum(y.values())-1)<1e-6 and all(np.isfinite(w) and w>=0 for w in y.values())
    objects,rig=rig_anatomy(objects,a,thumb_seams=True)
    assert rig['thumbSeamVertices']==report['thumbSeamVertices']
    np.testing.assert_array_equal(rest,[v.co[:] for v in body.data.vertices])
    for vertex,row in zip(body.data.vertices,after):
        actual={body.vertex_groups[g.group].name:g.weight for g in vertex.groups if g.weight>0}
        for n in set(actual)|set(row):assert abs(actual.get(n,0)-row.get(n,0))<1e-7
    arm=next(o for o in objects if o.type=='ARMATURE')
    for name,b in bones.items():
        np.testing.assert_allclose(arm.data.bones[name].head_local,b['head'],atol=3e-7,rtol=0)
        np.testing.assert_allclose(arm.data.bones[name].tail_local,b['tail'],atol=3e-7,rtol=0)
    reference=json.loads((Path(__file__).parent/'fixtures/sprout-reference-rhythm.json').read_text())
    curves={n:gait.periodic_curve(v) for n,v in reference['samples'].items()}
    gait._reference=lambda path:(lambda name,p:curves[name](p),dict(reference['provenance']))
    gait.bake_gaits(objects,a,None)
    faces=triangulate_surface(rest,[tuple(p.vertices) for p in body.data.polygons])['faces']
    names=[b.name for b in arm.data.bones];hand_data={}
    for side in ['l','r']:
        ids=[i for i,row in enumerate(before) if sum(w for n,w in row.items() if n=='hand_'+side or n.startswith(('thumb_'+side,'finger_'+side)))>.5]
        lookup={v:i for i,v in enumerate(ids)};triangles=[tuple(lookup[v] for v in f) for f in faces if all(v in lookup for v in f)]
        hand_data[side]=(np.c_[rest[ids],np.ones(len(ids))],triangles,[set(f) for f in triangles],{version:np.array([[rows[i].get(n,0) for n in names] for i in ids]) for version,rows in [('before',before),('after',after)]})
    tracks=list(arm.animation_data.nla_tracks);arm.animation_data.use_nla=False
    for track in tracks:track.mute=True
    peaks={version:{side:0 for side in ['l','r']} for version in ['before','after']};poses=[]
    for clip in ['check-hands-crest','walk','jog']:
        strip=next(t for t in tracks if t.name==clip).strips[0]
        arm.animation_data.action=strip.action;arm.animation_data.action_slot=strip.action_slot
        start,end=strip.action.frame_range
        for phase in np.linspace(0,1,65):
            frame=start+(end-start)*phase;bpy.context.scene.frame_set(int(frame),subframe=frame-int(frame));bpy.context.view_layer.update()
            matrices=np.array([np.array(arm.pose.bones[n].matrix@arm.data.bones[n].matrix_local.inverted()) for n in names]);poses.append(matrices)
            for side,(rest4,tris,sets,weights) in hand_data.items():
                for version,W in weights.items():
                    points=np.einsum('vij,vj->vi',np.einsum('vb,bij->vij',W,matrices),rest4)[:,:3]
                    tree=BVHTree.FromPolygons(points,tris,all_triangles=True)
                    pairs=[(i,j) for i,j in tree.overlap(tree) if i<j and sets[i].isdisjoint(sets[j]) and strict_crossing(points[list(tris[i])],points[list(tris[j])])]
                    peaks[version][side]=max(peaks[version][side],len(pairs))
                    if version=='after':assert not pairs,(age,clip,phase,side,len(pairs))
    assert max(np.linalg.norm(p-poses[0]) for p in poses)>.01,'Sampler did not advance'
    if age=='child':assert all(n>0 for n in peaks['before'].values()),'Regression control did not reproduce both thumb contacts'
    arm.animation_data.action=None;arm.animation_data.use_nla=True
    for track in tracks:track.mute=False
    bpy.context.scene.frame_set(0)
    print('THUMB_SEAM_CHECK',age,report['thumbSeamVerticesBySide'],peaks)
    return objects
