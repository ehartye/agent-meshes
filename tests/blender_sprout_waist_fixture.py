"""The pear trunk must bend without locally folding at the lumbar joint."""
import bpy,json
import numpy as np
from pathlib import Path
from mathutils.bvhtree import BVHTree
from agent_meshes_sprout_kin import build_anatomy
from agent_meshes_sprout_rig import rig_anatomy,anatomy_weights,skin_regions
import agent_meshes_sprout_gait as gait

EXPORT_ANIMATION_MODE='NLA_TRACKS'

def build():
    reference=json.loads((Path(__file__).parent/'fixtures/sprout-reference-rhythm.json').read_text())
    curves={n:gait.periodic_curve(v) for n,v in reference['samples'].items()}
    gait._reference=lambda path:(lambda name,p:curves[name](p),dict(reference['provenance']))
    objects=[]
    for age,height in [('child',1.12),('adult',1.7)]:
        for obj in objects:bpy.data.objects.remove(obj,do_unlink=True)
        objects,a=build_anatomy(height=height,age=age,clay=True)
        body=next(o for o in objects if o.name=='sprout-body')
        rest=np.array([v.co[:] for v in body.data.vertices])
        original,_=anatomy_weights(body,a,hip_seams=True,neck_seam=True)
        for args in [{'regions':['neck'],'waist_seam':True},{'waist_seam':'yes'}]:
            try:anatomy_weights(body,a,**args)
            except ValueError:pass
            else:raise AssertionError('Waist repair needs the trunk source and a boolean flag')
        vertices=[];source_faces=[];regions=[]
        for part in skin_regions(a):
            offset=len(vertices);vertices.extend(part['vertices'])
            for face in part['faces']:
                for k in range(1,len(face)-1):
                    source_faces.append(tuple(offset+i for i in (face[0],face[k],face[k+1])));regions.append(part['name'])
        tree=BVHTree.FromPolygons(vertices,source_faces,all_triangles=True)
        labels=[regions[tree.find_nearest(v.co)[2]] for v in body.data.vertices]
        waist=.55*a['joints']['pelvis'][2]+.45*a['joints']['chest'][2]
        free=np.array([label=='trunk' and abs(v.co.z-waist)<.075*a['scale'] for label,v in zip(labels,body.data.vertices)])
        objects,_=rig_anatomy(objects,a);gait.bake_gaits(objects,a,None)
        np.testing.assert_array_equal(rest,[v.co[:] for v in body.data.vertices])
        for v,label,row,active in zip(body.data.vertices,labels,original,free):
            actual={body.vertex_groups[g.group].name:g.weight for g in v.groups if g.weight>0}
            assert len(actual)<=4 and abs(sum(actual.values())-1)<1e-6
            if label=='bulb-head':assert actual=={'head':1.},'Head lost rigidity'
            if not active:
                for n in set(actual)|set(row):assert abs(actual.get(n,0)-row.get(n,0))<1e-7,'Unrelated weights changed'
        faces=[tuple(p.vertices) for p in body.data.polygons];sets=[set(f) for f in faces]
        near=[any(free[i] for i in f) for f in faces]
        tris=np.array([(f[0],f[k],f[k+1]) for f,selected in zip(faces,near) if selected for k in range(1,len(f)-1)])
        rc=np.cross(rest[tris[:,1]]-rest[tris[:,0]],rest[tris[:,2]]-rest[tris[:,0]])
        ra=np.linalg.norm(rc,axis=1);rn=rc/ra[:,None]
        arm=next(o for o in objects if o.type=='ARMATURE');names=[b.name for b in arm.data.bones]
        rows=[{body.vertex_groups[g.group].name:g.weight for g in v.groups} for v in body.data.vertices]
        W=np.array([[row.get(n,0) for n in names] for row in rows]);TW=W[tris].mean(axis=1)
        arm.animation_data.use_nla=False;tracks=list(arm.animation_data.nla_tracks)
        assert {t.name for t in tracks}=={'check-arms','check-legs','check-legs-right','check-spine',
            'check-neck-tail','check-hands-crest','walk','jog'} and len(tracks)==8,'Required clip set changed'
        for track in tracks:track.mute=True
        worst=1.
        for track in tracks:
            strip=track.strips[0];arm.animation_data.action=strip.action;arm.animation_data.action_slot=strip.action_slot
            start,end=strip.action.frame_range;poses=[]
            for phase in np.linspace(0,1,65):
                frame=start+(end-start)*phase;bpy.context.scene.frame_set(int(frame),subframe=frame-int(frame));bpy.context.view_layer.update()
                mats=np.array([np.array(arm.pose.bones[n].matrix@arm.data.bones[n].matrix_local.inverted()) for n in names]);poses.append(mats)
                ev=body.evaluated_get(bpy.context.evaluated_depsgraph_get());p=np.array([v.co[:] for v in ev.data.vertices])
                pc=np.cross(p[tris[:,1]]-p[tris[:,0]],p[tris[:,2]]-p[tris[:,0]])
                carried=np.einsum('tij,tj->ti',np.einsum('tb,bij->tij',TW,mats[:,:3,:3]),rn)
                signed=np.sum(pc*carried,axis=1)/(ra*np.linalg.norm(carried,axis=1))
                # Local signed area is a regression diagnostic for this bounded
                # bend, used together with contacts and rendered inspection.
                assert signed.min()>.10,f'{age} {track.name} phase {phase}: waist signed area {signed.min()}'
                worst=min(worst,float(signed.min()))
                tree=BVHTree.FromPolygons(p,faces)
                pairs=[(i,j) for i,j in tree.overlap(tree) if i<j and sets[i].isdisjoint(sets[j]) and (near[i] or near[j])]
                assert not pairs,f'{age} {track.name} phase {phase}: {len(pairs)} waist intersections'
            assert max(np.linalg.norm(p-poses[0]) for p in poses)>.01,'Sampler did not advance'
            np.testing.assert_allclose(poses[0],poses[-1],atol=1e-5)
        arm.animation_data.action=None;arm.animation_data.use_nla=True
        for track in tracks:track.mute=False
        bpy.context.scene.frame_set(0)
        print(f'WAIST_CHECK {age}: 520 poses, min signed area {worst}; no waist contacts; rest geometry and unrelated weights preserved')
    return objects
