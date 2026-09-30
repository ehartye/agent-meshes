"""Regression for folding at fused trunk/thigh weight boundaries."""
import bpy
import numpy as np
from mathutils.bvhtree import BVHTree
from agent_meshes_sprout_kin import build_anatomy
from agent_meshes_sprout_rig import rig_anatomy,anatomy_weights

EXPORT_ANIMATION_MODE='NLA_TRACKS'


def build():
    objects=[]
    for age,height in [('child',1.12),('adult',1.7)]:
        for obj in objects:bpy.data.objects.remove(obj,do_unlink=True)
        objects,a=build_anatomy(height=height,age=age,clay=True)
        body=next(o for o in objects if o.name=='sprout-body')
        rest=np.array([v.co[:] for v in body.data.vertices])
        original,_=anatomy_weights(body,a)
        try:anatomy_weights(body,a,regions=['trunk'],hip_seams=True)
        except ValueError:pass
        else:raise AssertionError('Restricted trunk source must not acquire leg influences')
        objects,_=rig_anatomy(objects,a)
        np.testing.assert_array_equal(rest,[v.co[:] for v in body.data.vertices])
        hip=a['joints']['hip_l'][2];s=a['scale']
        for v,row in zip(body.data.vertices,original):
            actual={body.vertex_groups[g.group].name:g.weight for g in v.groups}
            if not hip-.08*s<v.co.z<hip+.07*s:
                for n in set(row)|set(actual):assert abs(row.get(n,0)-actual.get(n,0))<1e-7,'Weights outside hip band changed'
        arm=next(o for o in objects if o.type=='ARMATURE')
        tracks=list(arm.animation_data.nla_tracks)
        for track in tracks:track.mute=True
        for clip in ['check-legs','check-legs-right']:
            track=next(t for t in tracks if t.name==clip);track.mute=False
            for phase in [0,.125,.25,.375,.5,.625,.75,.875,1]:
                strip=track.strips[0];f=strip.frame_start+(strip.frame_end-strip.frame_start)*phase
                bpy.context.scene.frame_set(int(f),subframe=f-int(f));bpy.context.view_layer.update()
                evaluated=body.evaluated_get(bpy.context.evaluated_depsgraph_get())
                faces=[tuple(p.vertices) for p in evaluated.data.polygons]
                tree=BVHTree.FromPolygons([v.co for v in evaluated.data.vertices],faces)
                sets=[set(face) for face in faces]
                pairs=[(i,j) for i,j in tree.overlap(tree) if i<j and sets[i].isdisjoint(sets[j])]
                assert not pairs, f'{age} {clip} phase {phase}: {len(pairs)} nonadjacent body intersections'
            track.mute=True
        for track in tracks:track.mute=False
        bpy.context.scene.frame_set(0)
    return objects
