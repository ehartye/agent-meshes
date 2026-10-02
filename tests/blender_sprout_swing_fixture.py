"""Gait fitting keeps knees open and planted toes grounded on adult/child rigs."""
import bpy,math
import numpy as np
from agent_meshes_sprout_kin import build_anatomy
from agent_meshes_sprout_rig import rig_anatomy
import agent_meshes_sprout_gait as gait
EXPORT_ANIMATION_MODE='NLA_TRACKS'
def build(age_to_export=None,body_references=None):
    # Captured CC0 reference rhythm keeps the reproduction independent of downloads.
    from pathlib import Path
    import json
    data=json.loads((Path(__file__).parent/'fixtures/sprout-reference-rhythm.json').read_text())
    curves={name:gait.periodic_curve(values) for name,values in data['samples'].items()}
    gait._reference=lambda path:(lambda name,p:curves[name](p),dict(data['provenance']))
    objects=[]
    for age,height in [('child',1.12),('adult',1.7)]:
        if age_to_export is not None and age!=age_to_export:continue
        for obj in objects:bpy.data.objects.remove(obj,do_unlink=True)
        objects,a=build_anatomy(height=height,age=age,clay=True);objects,_=rig_anatomy(objects,a)
        report=gait.bake_gaits(objects,a,None,body_references=body_references)
        arm=next(o for o in objects if o.type=='ARMATURE')
        tracks=list(arm.animation_data.nla_tracks)
        for track in tracks:track.mute=True
        arm.animation_data.use_nla=False
        for clip in ['walk','jog']:
            strip=next(t for t in tracks if t.name==clip).strips[0]
            arm.animation_data.action=strip.action;arm.animation_data.action_slot=strip.action_slot
            start,end=strip.action.frame_range;poses=[];max_contact_drift=0.;min_angle=180.
            for frame in np.linspace(start,end,round((end-start)*4)+1):
                bpy.context.scene.frame_set(int(frame),subframe=frame-int(frame));bpy.context.view_layer.update();phase=(frame-start)/(end-start)
                for side,offset in [('l',0),('r',.5)]:
                    hip=np.array(arm.pose.bones['thigh_'+side].head);knee=np.array(arm.pose.bones['shin_'+side].head);hock=np.array(arm.pose.bones['metatarsal_'+side].head)
                    u=hip-knee;v=hock-knee;angle=np.degrees(np.arccos(np.clip(np.dot(u,v)/np.linalg.norm(u)/np.linalg.norm(v),-1,1)))
                    min_angle=min(min_angle,float(angle))
                    assert angle>=59.99,f'{age} {clip} frame {frame}: knee folded to {angle}'
                    if (phase+offset)%1<=report['clips'][clip]['stance']:
                        toe=arm.pose.bones['toes_'+side].head
                        drift=abs(toe.z-a['joints']['toe_'+side][2]);max_contact_drift=max(max_contact_drift,drift)
                        tolerance=1e-5 if frame==int(frame) else .005
                        assert drift<tolerance,f'{age} {clip} frame {frame}: contact drift {drift}'
                poses.append(np.array([b.head[:] for b in arm.pose.bones]))
            np.testing.assert_allclose(poses[0],poses[-1],atol=1e-5)
            assert max(np.linalg.norm(p-poses[0]) for p in poses)>.01,'Sampler did not advance'
            print(f'SWING_CHECK {age} {clip}: min knee {min_angle:.6f}, max contact drift {max_contact_drift:.8f}')
        arm.animation_data.action=None;arm.animation_data.use_nla=True
        for track in tracks:track.mute=False
        bpy.context.scene.frame_set(0)
    return objects
