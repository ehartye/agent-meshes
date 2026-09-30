"""Reference-informed plant-kin locomotion with explicit toe contact targets.

Blender Z up, forward -Y. Pure trajectory and IK functions are separately tested.
"""
import math
import json
import hashlib
from pathlib import Path
import numpy as np
from agent_meshes_sprout_kin import anatomy


def foot_path(phase, stance, stride, lift):
    """Return backward displacement and lift; C2 joins preserve contact speed."""
    if not 0 < stance < 1 or stride <= 0 or lift < 0:
        raise ValueError('Require 0 < stance < 1, positive stride and nonnegative lift')
    p=phase%1
    if p <= stance:return np.array([-stride/2+stride*p/stance,0.])
    u=(p-stance)/(1-stance);m=stride*(1-stance)/stance
    turn=np.clip((u-.06)/.88,0.,1.)
    smooth=turn**3*(10+turn*(-15+6*turn))
    rise=min(u/.50,1.);fall=min((1-u)/.50,1.)
    envelope=lambda t:t**3*(10+t*(-15+6*t))
    return np.array([stride/2+m*u+(-stride-m)*smooth,lift*envelope(rise)*envelope(fall)])


def two_bone(hip, ankle, upper, lower, pole):
    """Exact three-dimensional two-link solve; reject unreachable targets."""
    hip=np.asarray(hip,float);ankle=np.asarray(ankle,float);v=ankle-hip;d=np.linalg.norm(v)
    if not abs(upper-lower)+1e-8 < d < upper+lower-1e-8:
        raise ValueError(f'Unreachable leg target: distance {d}, lengths {upper}, {lower}')
    axis=v/d;pole=np.asarray(pole,float);bend=pole-axis*np.dot(pole,axis)
    if np.linalg.norm(bend)<1e-8:raise ValueError('Pole is parallel to the target')
    bend/=np.linalg.norm(bend);along=(upper*upper-lower*lower+d*d)/(2*d)
    return hip+along*axis+math.sqrt(max(0,upper*upper-along*along))*bend


def periodic_curve(values,harmonics=5):
    """Smooth uniformly sampled closed reference curves without a derivative seam."""
    values=np.asarray(values,float)
    if values.ndim!=1 or len(values)<4 or not np.isfinite(values).all():
        raise ValueError('Reference curve needs at least four finite scalar samples')
    coefficients=np.fft.rfft(values[:-1])/len(values[:-1])
    count=min(harmonics,len(coefficients)-1)
    def sample(phase):
        return float(coefficients[0].real+2*sum((coefficients[k]*np.exp(2j*np.pi*k*phase)).real for k in range(1,count+1)))
    return sample


def _reference(path):
    """Sample kaiju Walk in Blender; retain measured rhythm, not body proportions."""
    import bpy
    from agent_meshes_retarget import import_reference
    before=set(bpy.data.objects);arm,meshes,actions=import_reference(path)
    action=next((a for n,a in actions.items() if n=='Walk' or n.endswith('|Walk')),None)
    if action is None:raise ValueError('Reference must contain kaiju Walk')
    arm.animation_data.action=action;start,end=action.frame_range;rows=[]
    try:
        for i in range(121):
            f=start+(end-start)*i/120;bpy.context.scene.frame_set(int(f),subframe=f-int(f))
            bpy.context.view_layer.update()
            rows.append({n:np.array(arm.matrix_world@arm.pose.bones[n].head) for n in
                         ['Hips','Back_Leg_Upper_L','Back_Leg_Upper_R','Back_Leg_Ankle_L','Back_Leg_Foot_L','Back_Leg_Foot_1_L','Spine_1','Spine_2','Head']})
    finally:
        for obj in set(bpy.data.objects)-before:bpy.data.objects.remove(obj,do_unlink=True)
    toe=np.array([r['Back_Leg_Foot_1_L'] for r in rows]);touch=int(np.argmin(toe[:,1]))/120
    pelvis=np.array([r['Hips'][2] for r in rows])
    meta=np.array([math.atan2(*(r['Back_Leg_Ankle_L']-r['Back_Leg_Foot_L'])[[1,2]]) for r in rows])
    spine=np.array([math.atan2(-(r['Spine_2']-r['Spine_1'])[1],(r['Spine_2']-r['Spine_1'])[2]) for r in rows])
    curves={}
    for name,values in [('bob',pelvis),('hock',np.unwrap(meta)),('spine',np.unwrap(spine))]:
        # Close small source endpoint drift before periodic interpolation.
        values=values-np.linspace(0,1,len(values))*(values[-1]-values[0]);values-=values.mean()
        curves[name]=values
    fitted={name:periodic_curve(values) for name,values in curves.items()}
    def sample(name,phase):return fitted[name]((phase+touch)%1)
    return sample,{'source':str(path),'clip':'Walk','touchdownPhase':touch,
                   'sha256':hashlib.sha256(Path(path).read_bytes()).hexdigest(),
                   'bobRange':float(np.ptp(curves['bob'])),'hockRange':float(np.ptp(curves['hock']))}


def bake_gaits(objects,a,reference):
    """Add walk/jog to the shared sprout rig. Returns source and contact metadata."""
    import bpy
    from mathutils import Vector,Quaternion
    arm=next(o for o in objects if o.type=='ARMATURE');s=a['scale'];j={n:np.array(v) for n,v in a['joints'].items()}
    def leg_length(joints):
        return sum(np.linalg.norm(np.array(joints[x+'_l'])-joints[y+'_l']) for x,y in [('hip','knee'),('knee','hock')])
    step_scale=leg_length(j)/leg_length(anatomy()['joints'])
    scene=bpy.context.scene;previous_fps=scene.render.fps;scene.render.fps=60;fps=60
    sample,report=_reference(reference)
    # The existing diagnostic tracks must not blend into newly baked actions.
    for track in arm.animation_data.nla_tracks:
        track.mute=True
        for strip in track.strips:strip.scale*=fps/previous_fps
    rests={b.name:b.matrix_local.copy() for b in arm.data.bones}
    def rotate(name,axis,angle):
        pb=arm.pose.bones[name];pb.rotation_mode='QUATERNION'
        local=pb.bone.matrix_local.to_3x3().inverted()@Vector(axis)
        pb.rotation_quaternion=pb.rotation_quaternion@Quaternion(local,angle)
    def point(name,target):
        bpy.context.view_layer.update();pb=arm.pose.bones[name];head=pb.head.copy()
        direction=Vector(target)-head;rest=rests[name]
        q=(pb.bone.tail_local-pb.bone.head_local).rotation_difference(direction)
        matrix=q.to_matrix().to_4x4()@rest;matrix.translation=head;pb.matrix=matrix
    out=[];report['clips']={}
    for clip,duration,stance,stride,lift,bob,lean in [('walk',1.55,.62,.49,.09,.035,8),('jog',.9,.36,.48,.16,.07,18)]:
        action=bpy.data.actions.new(clip);arm.animation_data.action=action;frames=round(duration*60)
        report['clips'][clip]={'duration':duration,'stance':stance,'travelSpeed':stride*step_scale/(stance*duration),'contactPhase':{'metatarsal_l':0.,'metatarsal_r':.5}}
        for frame in range(frames+1):
            phase=frame/frames;cycle=2*math.pi*phase
            for pb in arm.pose.bones:pb.matrix_basis.identity();pb.rotation_mode='QUATERNION'
            bodybob=sample('bob',phase)/max(report['bobRange'],1e-6)*bob*s
            arm.pose.bones['root'].location=rests['root'].to_3x3().inverted()@Vector((0,0,bodybob-(.015 if clip=='walk' else .045)*s))
            rotate('pelvis',(0,0,1),math.radians(5)*math.sin(cycle))
            rotate('pelvis',(0,1,0),-math.radians(4 if clip=='walk' else 5)*math.sin(cycle+math.pi*(.5-stance)))
            # Pitch is distributed over two spine joints; upper spine counters yaw.
            pitch=math.radians(lean+(3 if clip=='walk' else 4.5)*math.sin(2*cycle))
            rotate('spine_low',(1,0,0),pitch*.55)
            rotate('spine_high',(1,0,0),pitch*.45)
            rotate('spine_high',(0,0,1),math.radians(-10)*math.sin(cycle))
            rotate('neck_middle',(1,0,0),-pitch*.25)
            rotate('neck_upper',(1,0,0),-pitch*.25)
            rotate('tail_base',(0,0,1),math.radians(10)*math.sin(cycle+.3))
            rotate('tail_tip',(0,0,1),math.radians(6)*math.sin(cycle-.3))
            for i in range(a['crest_count']):rotate(f'crest_{i}_base',(1,0,0),math.radians(3)*math.sin(2*cycle-.4))
            for side,offset in [('l',0),('r',.5)]:
                p=(phase+offset)%1;wave=math.sin(2*math.pi*(p-.25))
                rotate('upperarm_'+side,(1,0,0),-math.radians(14 if clip=='walk' else 24)*wave)
                rotate('forearm_'+side,(1,0,0),-math.radians((12 if clip=='walk' else 32)+6*wave))
                for name in rests:
                    if name.startswith(('finger_'+side,'thumb_'+side)):rotate(name,(0,1 if side=='l' else -1,0),math.radians(12))
                bpy.context.view_layer.update();hip=np.array(arm.pose.bones['thigh_'+side].head)
                dy,dz=foot_path(p,stance,stride*step_scale,lift*s);toe=j['toe_'+side]+[0,dy,dz]
                restmeta=j['hock_'+side]-j['toe_'+side];length=np.linalg.norm(restmeta)
                angle=math.atan2(restmeta[1],restmeta[2])+sample('hock',p)*.35
                hock=toe+[0,length*math.sin(angle),length*math.cos(angle)]
                upper=np.linalg.norm(j['knee_'+side]-j['hip_'+side]);lower=np.linalg.norm(j['hock_'+side]-j['knee_'+side])
                knee=two_bone(hip,hock,upper,lower,[0,-1,0])
                point('thigh_'+side,knee);point('shin_'+side,hock);point('metatarsal_'+side,toe)
                bpy.context.view_layer.update();pb=arm.pose.bones['toes_'+side]
                matrix=rests[pb.name].copy();matrix.translation=pb.head;pb.matrix=matrix
            bpy.context.view_layer.update()
            for pb in arm.pose.bones:
                pb.keyframe_insert('rotation_quaternion',frame=frame*fps/60)
                if pb.name=='root':pb.keyframe_insert('location',frame=frame*fps/60)
        arm.animation_data.action=None;out.append((clip,action))
    for track in arm.animation_data.nla_tracks:track.mute=False
    for clip,action in out:
        track=arm.animation_data.nla_tracks.new();track.name=clip;track.strips.new(clip,0,action)
    for pb in arm.pose.bones:pb.matrix_basis.identity()
    scene.frame_set(0)
    from agent_meshes_face import EXTRAS_PROPERTY
    extras=json.loads(arm.get(EXTRAS_PROPERTY,'{}'))
    extras['gait']={'format':'agent-meshes/gait/1','height':a['height'],'clips':report['clips']}
    arm[EXTRAS_PROPERTY]=json.dumps(extras)
    return report
