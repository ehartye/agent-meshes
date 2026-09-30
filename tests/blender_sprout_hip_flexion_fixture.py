"""Raised thighs must not pierce the pear trunk in either age's walk/jog."""
import bpy,json
import numpy as np
from pathlib import Path
from mathutils.bvhtree import BVHTree
from agent_meshes_sprout_kin import build_anatomy
from agent_meshes_sprout_rig import rig_anatomy,skin_regions
import agent_meshes_sprout_gait as gait
import agent_meshes_sprout_kin as kin

EXPORT_ANIMATION_MODE='NLA_TRACKS'

def build():
    reference=json.loads((Path(__file__).parent/'fixtures/sprout-reference-rhythm.json').read_text())
    curves={name:gait.periodic_curve(values) for name,values in reference['samples'].items()}
    gait._reference=lambda path:(lambda name,p:curves[name](p),dict(reference['provenance']))
    original_smoothing=kin._smooth_hip_join
    def checked_smoothing(body,a):
        before=np.array([v.co[:] for v in body.data.vertices])
        faces=[tuple(p.vertices) for p in body.data.polygons]
        original_smoothing(body,a)
        after=np.array([v.co[:] for v in body.data.vertices])
        assert faces==[tuple(p.vertices) for p in body.data.polygons],'Sculpt changed topology'
        # Identity and contacts outside the join are not a price of clearance.
        joints=a['joints'];s=a['scale']
        fixed=(before[:,2]>=joints['chest'][2])|(before[:,2]<=joints['knee_l'][2])|(np.abs(before[:,0])>=.20*s)|(before[:,1]>=joints['tail_mid'][1])
        np.testing.assert_array_equal(before[fixed],after[fixed])
        assert np.linalg.norm(after-before,axis=1).max()<.04*s,'Hip relaxation eroded too much volume'
        assert len(body.vertex_groups)==0,'Temporary sculpt mask leaked into skin binding'
    kin._smooth_hip_join=checked_smoothing
    objects=[]
    for age,height in [('child',1.12),('adult',1.7)]:
        for obj in objects:bpy.data.objects.remove(obj,do_unlink=True)
        objects,a=build_anatomy(height=height,age=age,clay=True)
        body=next(o for o in objects if o.name=='sprout-body')
        objects,_=rig_anatomy(objects,a);gait.bake_gaits(objects,a,None)
        # Classify from the original anatomical source surfaces, before posing.
        vertices=[];source_faces=[];regions=[]
        for part in skin_regions(a):
            offset=len(vertices);vertices.extend(part['vertices'])
            for face in part['faces']:
                for k in range(1,len(face)-1):
                    source_faces.append(tuple(offset+i for i in (face[0],face[k],face[k+1])))
                    regions.append(part['name'])
        tree=BVHTree.FromPolygons(vertices,source_faces,all_triangles=True)
        labels=[regions[tree.find_nearest(v.co)[2]] for v in body.data.vertices]
        faces=[tuple(p.vertices) for p in body.data.polygons]
        sets=[set(f) for f in faces];face_regions=[{labels[i] for i in f} for f in faces]
        assert all(any(n in row for row in face_regions) for n in ['trunk','leg_l','leg_r'])
        arm=next(o for o in objects if o.type=='ARMATURE')
        tracks=list(arm.animation_data.nla_tracks)
        for track in tracks:track.mute=True
        arm.animation_data.use_nla=False
        for clip in ['walk','jog']:
            strip=next(t for t in tracks if t.name==clip).strips[0]
            arm.animation_data.action=strip.action;arm.animation_data.action_slot=strip.action_slot
            start,end=strip.action.frame_range;poses=[]
            for phase in np.linspace(0,1,65):
                frame=start+(end-start)*phase
                bpy.context.scene.frame_set(int(frame),subframe=frame-int(frame));bpy.context.view_layer.update()
                poses.append(np.array([b.head[:] for b in arm.pose.bones]))
                evaluated=body.evaluated_get(bpy.context.evaluated_depsgraph_get())
                tree=BVHTree.FromPolygons([v.co[:] for v in evaluated.data.vertices],faces)
                pairs=[]
                for i,j in tree.overlap(tree):
                    if i>=j or not sets[i].isdisjoint(sets[j]):continue
                    left,right=face_regions[i],face_regions[j]
                    if ('trunk' in left and right&{'leg_l','leg_r'}) or ('trunk' in right and left&{'leg_l','leg_r'}):pairs.append((i,j))
                assert not pairs,f'{age} {clip} phase {phase}: {len(pairs)} thigh/trunk intersections'
            assert max(np.linalg.norm(p-poses[0]) for p in poses)>.01,'Sampler did not advance'
            np.testing.assert_allclose(poses[0],poses[-1],atol=1e-5)
            print(f'HIP_FLEXION_CHECK {age} {clip}: 65 phases, no thigh/trunk intersections')
        arm.animation_data.action=None;arm.animation_data.use_nla=True
        for track in tracks:track.mute=False
        bpy.context.scene.frame_set(0)
    return objects
