"""The rigid bulb head must not shear through its connected neck skin."""
import bpy
import numpy as np
from mathutils.bvhtree import BVHTree
from agent_meshes_sprout_kin import build_anatomy
from agent_meshes_sprout_rig import rig_anatomy,anatomy_weights,skin_regions
EXPORT_ANIMATION_MODE='NLA_TRACKS'

def build():
    objects=[]
    for age,height in [('child',1.12),('adult',1.7)]:
        for obj in objects:bpy.data.objects.remove(obj,do_unlink=True)
        objects,a=build_anatomy(height=height,age=age,clay=True)
        body=next(o for o in objects if o.name=='sprout-body')
        rest=np.array([v.co[:] for v in body.data.vertices]);original,_=anatomy_weights(body,a,hip_seams=True)
        for args in [{'regions':['neck'],'neck_seam':True},{'neck_seam':'yes'}]:
            try:anatomy_weights(body,a,**args)
            except ValueError:pass
            else:raise AssertionError('Neck seam needs both source regions and an explicit boolean flag')
        vertices=[];source_faces=[];regions=[]
        for part in skin_regions(a):
            offset=len(vertices);vertices.extend(part['vertices'])
            for face in part['faces']:
                for k in range(1,len(face)-1):
                    source_faces.append(tuple(offset+i for i in (face[0],face[k],face[k+1])));regions.append(part['name'])
        tree=BVHTree.FromPolygons(vertices,source_faces,all_triangles=True)
        labels=[regions[tree.find_nearest(v.co)[2]] for v in body.data.vertices]
        objects,_=rig_anatomy(objects,a)
        np.testing.assert_array_equal(rest,[v.co[:] for v in body.data.vertices])
        for v,label,row in zip(body.data.vertices,labels,original):
            actual={body.vertex_groups[g.group].name:g.weight for g in v.groups if g.weight>0}
            if label=='bulb-head':assert actual=={'head':1.},'Head skin lost rigidity'
            if label!='neck' or v.co.z<=a['joints']['neck_mid'][2]-.06*a['scale']:
                for n in set(actual)|set(row):assert abs(actual.get(n,0)-row.get(n,0))<1e-7,'Unrelated skin weights changed'
        faces=[tuple(p.vertices) for p in body.data.polygons];sets=[set(f) for f in faces]
        neck_faces=[any(labels[v]=='neck' for v in f) for f in faces]
        arm=next(o for o in objects if o.type=='ARMATURE');tracks=list(arm.animation_data.nla_tracks)
        arm.animation_data.use_nla=False
        for track in tracks:track.mute=True
        strip=next(t for t in tracks if t.name=='check-neck-tail').strips[0]
        arm.animation_data.action=strip.action;arm.animation_data.action_slot=strip.action_slot
        start,end=strip.action.frame_range;poses=[]
        for phase in np.linspace(0,1,65):
            frame=start+(end-start)*phase;bpy.context.scene.frame_set(int(frame),subframe=frame-int(frame));bpy.context.view_layer.update()
            poses.append(np.array([b.matrix[:] for b in arm.pose.bones]))
            evaluated=body.evaluated_get(bpy.context.evaluated_depsgraph_get())
            tree=BVHTree.FromPolygons([v.co[:] for v in evaluated.data.vertices],faces)
            pairs=[(i,j) for i,j in tree.overlap(tree) if i<j and sets[i].isdisjoint(sets[j]) and (neck_faces[i] or neck_faces[j])]
            assert not pairs,f'{age} neck phase {phase}: {len(pairs)} nonadjacent neck intersections'
        assert max(np.linalg.norm(p-poses[0]) for p in poses)>.01,'Neck sampler did not advance'
        np.testing.assert_allclose(poses[0],poses[-1],atol=1e-5)
        arm.animation_data.action=None;arm.animation_data.use_nla=True
        for track in tracks:track.mute=False
        bpy.context.scene.frame_set(0)
        print(f'NECK_CHECK {age}: 65 phases, zero intersections; head rigid and unrelated weights preserved')
    return objects
