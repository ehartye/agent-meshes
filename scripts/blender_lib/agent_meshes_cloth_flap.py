"""Kinematic hanging cloth: sampled leg clearance drives a waist hinge.

Z-up, Y-depth armature space. This is a constrained flap, not cloth simulation;
clearance is proved only for supplied obstacle vertices and sampled frames.
"""
import math
import numpy as np


def clearance_angle(points,hinge,length,half_width,direction,gap=.008):
    """Smallest outward angle for obstacles in a rectangular flap's swept reach."""
    p=np.asarray(points,float);h=np.asarray(hinge,float)
    if p.ndim!=2 or p.shape[1]!=3 or h.shape!=(3,) or not np.isfinite(p).all() or not np.isfinite(h).all():
        raise ValueError('Finite Nx3 obstacle points and XYZ hinge required')
    if not all(np.isfinite(v) for v in [length,half_width,direction,gap]) or length<=0 or half_width<=0 or direction not in [-1,1] or gap<0:
        raise ValueError('Positive length/width, direction -1 or 1 and nonnegative gap required')
    d=p-h;down=-d[:,2];out=d[:,1]*direction
    keep=(abs(d[:,0])<=half_width+gap)&(down>0)&(np.hypot(down,out)<=length+gap)&(out+gap>0)
    return float(np.max(np.arctan2(out[keep]+gap,down[keep]))) if np.any(keep) else 0.


def conservative_smooth(values,loop=False):
    """A temporal maximum then positive convolution smooths without losing clearance."""
    values=np.asarray(values,float)
    if values.ndim!=1 or len(values)<6 or not np.isfinite(values).all() or np.any(values<0):
        raise ValueError('At least six finite nonnegative angles required')
    v=values[:-1].copy() if loop else values.copy()
    if loop:v[0]=max(values[0],values[-1])
    padded=np.pad(v,3,mode='wrap' if loop else 'edge')
    envelope=np.max(np.lib.stride_tricks.sliding_window_view(padded,7),axis=1)
    result=np.convolve(np.pad(envelope,2,mode='wrap' if loop else 'edge'),[1/9,2/9,3/9,2/9,1/9],mode='valid')
    return np.r_[result,result[0]] if loop else result


def rig_flaps(body,arm,specs,obstacle_bones,gap=.008,loop_clips=()):
    """Append flap bones and bake each existing single-strip NLA clip at scene fps.

    Specs: name, parent, hinge (rest armature XYZ), length, half_width, direction
    (-1 front, +1 back). Obstacles are body vertices mostly bound to the supplied
    leg bones. Panel weights are authored by the caller. Body tracks are retained.
    Pass cyclic clip names in loop_clips; other clips keep independent endpoints.
    """
    import bpy
    from mathutils import Vector,Quaternion
    if not specs or len({s['name'] for s in specs})!=len(specs):raise ValueError('Unique flap names required')
    for spec in specs:
        if spec['name'] in arm.data.bones or spec['parent'] not in arm.data.bones:raise ValueError('New flap and existing parent required')
        clearance_angle(np.zeros((0,3)),spec['hinge'],spec['length'],spec['half_width'],spec['direction'],gap)
    tracks=list(arm.animation_data.nla_tracks)
    if not tracks or any(len(t.strips)!=1 for t in tracks):raise ValueError('One strip per NLA track required')
    selected=[]
    for v in body.data.vertices:
        total=sum(g.weight for g in v.groups if body.vertex_groups[g.group].name in obstacle_bones)
        if total>.3:selected.append(v.index)
    if not selected:raise ValueError('No leg obstacle vertices selected')
    bpy.ops.object.select_all(action='DESELECT');arm.select_set(True);bpy.context.view_layer.objects.active=arm
    bpy.ops.object.mode_set(mode='EDIT')
    for spec in specs:
        bone=arm.data.edit_bones.new(spec['name']);bone.head=spec['hinge'];bone.tail=np.array(spec['hinge'])+[0,0,-spec['length']]
        bone.parent=arm.data.edit_bones[spec['parent']]
    bpy.ops.object.mode_set(mode='OBJECT')
    scene=bpy.context.scene;prior_frame=scene.frame_current;prior_pose=arm.data.pose_position
    prior_action=arm.animation_data.action;mutes=[t.mute for t in tracks]
    arm.data.pose_position='POSE';arm.animation_data.action=None
    report={'obstacleVertices':len(selected),'gap':gap,'clips':{}}
    try:
        for track in tracks:track.mute=True
        for track in tracks:
            strip=track.strips[0];track.mute=False;count=max(6,round(strip.frame_end-strip.frame_start));curves={s['name']:[] for s in specs}
            for i in range(count+1):
                frame=strip.frame_start+(strip.frame_end-strip.frame_start)*i/count
                scene.frame_set(int(frame),subframe=frame-int(frame));bpy.context.view_layer.update()
                evaluated=body.evaluated_get(bpy.context.evaluated_depsgraph_get())
                points=[arm.matrix_world.inverted()@evaluated.matrix_world@evaluated.data.vertices[k].co for k in selected]
                for spec in specs:
                    parent=spec['parent'];inverse=(arm.pose.bones[parent].matrix@arm.data.bones[parent].matrix_local.inverted()).inverted()
                    rest_points=np.array([inverse@p for p in points])
                    curves[spec['name']].append(clearance_angle(rest_points,spec['hinge'],spec['length'],spec['half_width'],spec['direction'],gap))
            track.mute=True;action=strip.action;arm.animation_data.action=action
            report['clips'][track.name]={}
            for spec in specs:
                angles=conservative_smooth(curves[spec['name']],loop=track.name in loop_clips)
                if max(angles)>math.radians(85):raise ValueError('Flap needs more than 85 degrees: revise hinge/garment fit')
                pb=arm.pose.bones[spec['name']];pb.rotation_mode='QUATERNION'
                axis=pb.bone.matrix_local.to_3x3().inverted()@Vector((1,0,0))
                for i,angle in enumerate(angles):
                    pb.rotation_quaternion=Quaternion(axis,float(angle)*spec['direction'])
                    pb.keyframe_insert('rotation_quaternion',frame=strip.action_frame_start+(strip.action_frame_end-strip.action_frame_start)*i/count)
                pb.matrix_basis.identity()
                report['clips'][track.name][spec['name']]={'minDeg':float(min(angles)*180/math.pi),'maxDeg':float(max(angles)*180/math.pi),'samples':len(angles)}
            arm.animation_data.action=None
    finally:
        arm.animation_data.action=prior_action
        for track,mute in zip(tracks,mutes):track.mute=mute
        arm.data.pose_position=prior_pose;scene.frame_set(prior_frame)
        for spec in specs:arm.pose.bones[spec['name']].matrix_basis.identity()
    return report
