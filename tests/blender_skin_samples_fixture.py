"""Exercise actual Blender NLA evaluation, including timing and state restoration."""
import bpy
import numpy as np
from agent_meshes_skin_samples import sample_deform_poses


def build():
    bpy.ops.object.armature_add()
    arm=bpy.context.object;arm.name='sample-rig'
    bpy.ops.object.mode_set(mode='EDIT')
    root=arm.data.edit_bones[0];root.name='root'
    child=arm.data.edit_bones.new('child');child.head=(0,0,1);child.tail=(0,0,2);child.parent=root
    control=arm.data.edit_bones.new('control');control.head=(0,0,2);control.tail=(0,0,3);control.use_deform=False
    bpy.ops.object.mode_set(mode='OBJECT')
    arm.location=(3,-2,1);arm.rotation_euler.z=.4
    arm.animation_data_create();ad=arm.animation_data
    bone=arm.pose.bones['root'];bone.rotation_mode='XYZ'

    def action(name,values,axis):
        ad.action=bpy.data.actions.new(name)
        for frame,value in zip((1,5,9),values):
            bone.rotation_euler=(0,0,0);bone.rotation_euler[axis]=value
            bone.keyframe_insert('rotation_euler',frame=frame)
        result,slot=ad.action,ad.action_slot
        ad.action=None
        return result,slot

    tracks=[];controls={}
    for name,start,scale,axis,values in [('walk',11,1.5,0,(0,.65,-.2)),('reach',53,.75,2,(.1,-.8,.35))]:
        clip,slot=action(name,values,axis)
        track=ad.nla_tracks.new();track.name=name
        strip=track.strips.new(name,start,clip);strip.action_slot=slot;strip.scale=scale
        tracks.append(track)
        # Independent reference: bypass NLA and evaluate the authored action.
        ad.action=clip;ad.action_slot=slot;ad.use_nla=False
        controls[name]=[]
        for frame in (1,5,9):
            bpy.context.scene.frame_set(frame);bpy.context.view_layer.update()
            controls[name].append({pb.name:np.array(pb.matrix@pb.bone.matrix_local.inverted()) for pb in arm.pose.bones if pb.bone.use_deform})
        ad.action=None

    foreign,foreign_slot=action('foreign-active-action',(.4,.2,.7),1)
    foreign_slot=foreign.slots.new(id_type='OBJECT',name='nondefault-slot')
    ad.action=foreign;ad.action_slot=foreign_slot
    ad.action_influence=.37;ad.action_blend_type='ADD';ad.use_nla=False
    tracks[0].mute=True;tracks[1].mute=False;tracks[1].is_solo=True
    arm.data.pose_position='REST'
    scene=bpy.context.scene;scene.frame_set(127,subframe=.375)

    def state():
        return (ad.action,ad.action_slot,ad.use_nla,ad.action_influence,ad.action_blend_type,
                arm.data.pose_position,scene.frame_current,scene.frame_subframe,
                tuple((t.name,t.mute,t.is_solo) for t in ad.nla_tracks),tuple(arm.matrix_world))

    before=state()
    result=sample_deform_poses(arm,samples=3)
    assert state()==before,'Sampler changed animation state'
    assert len(result['poses'])==len(result['samples'])==6
    assert list(result['clips'])==['walk','reach']
    for offset,track in zip((0,3),tracks):
        clip=result['clips'][track.name];strip=track.strips[0]
        assert clip['maxMatrixVariation']>.1
        assert clip['samples']==3
        assert clip['frameStart']==strip.frame_start and clip['frameEnd']==strip.frame_end
        for k in range(3):
            row=result['samples'][offset+k]
            assert row=={'clip':track.name,'phase':k/2,'frame':strip.frame_start+(strip.frame_end-strip.frame_start)*k/2}
            pose=result['poses'][offset+k]
            assert set(pose)=={'root','child'},'Sampler omitted a deform bone or included controls'
            for name,matrix in controls[track.name][k].items():
                np.testing.assert_allclose(pose[name],matrix,atol=1e-6,err_msg=f'{track.name} sample {k} {name}')
    assert result['maxMatrixVariation']==max(v['maxMatrixVariation'] for v in result['clips'].values())
    subset=sample_deform_poses(arm,samples=3,clips=['reach'])
    assert list(subset['clips'])==['reach'] and len(subset['poses'])==3
    assert state()==before
    ad.action=None
    without_action=state()
    assert len(sample_deform_poses(arm,clips=['walk'])['poses'])==33
    assert state()==without_action
    ad.action=foreign;ad.action_slot=foreign_slot

    # A caller may evaluate its rest geometry with every NLA track disabled.
    # Sampling must still restart animation and restore that external state.
    ad.action=None;ad.use_nla=True
    for track in tracks:track.is_solo=False;track.mute=True
    arm.data.pose_position='REST';scene.frame_set(0);bpy.context.view_layer.update()
    arm.evaluated_get(bpy.context.evaluated_depsgraph_get())
    muted_rest=state()
    restarted=sample_deform_poses(arm,samples=3)
    assert state()==muted_rest,'Sampler changed externally evaluated muted REST state'
    for offset,track in zip((0,3),tracks):
        for k in range(3):
            for name,matrix in controls[track.name][k].items():
                np.testing.assert_allclose(restarted['poses'][offset+k][name],matrix,atol=1e-6)
    ad.action=foreign;ad.action_slot=foreign_slot
    ad.use_nla=False;tracks[0].mute=True;tracks[1].mute=False;tracks[1].is_solo=True
    scene.frame_set(127,subframe=.375)

    def rejects(**kwargs):
        previous=state()
        try:sample_deform_poses(arm,**kwargs)
        except ValueError:pass
        else:raise AssertionError(f'Sampler accepted invalid input: {kwargs}')
        assert state()==previous,f'Sampler failed to restore state after error: {[(i,a,b) for i,(a,b) in enumerate(zip(previous,state())) if a!=b]}'

    rejects(clips=['missing']);rejects(clips=[]);rejects(samples=1);rejects(samples=2.5)
    static,static_slot=action('static',(0,0,0),0)
    track=ad.nla_tracks.new();track.name='static'
    strip=track.strips.new('static',80,static);strip.action_slot=static_slot
    ad.action=foreign;ad.action_slot=foreign_slot
    rejects(samples=3,clips=['walk','static'])
    # Sampling must not leave keyed channels behind when the caller has a
    # manually posed rig and no action/active NLA to restore them on frame_set.
    ad.action=bpy.data.actions.new('manual-channel-check')
    control=arm.pose.bones['control'];control.rotation_mode='AXIS_ANGLE'
    channels=('location','rotation_euler','rotation_quaternion','rotation_axis_angle','scale')
    for frame,value in [(1,0),(9,1)]:
        bone.rotation_euler.x=value;bone.keyframe_insert('rotation_euler',index=0,frame=frame)
        arm.location.x=2+value;arm.keyframe_insert('location',index=0,frame=frame)
        for channel in channels:
            values=[value+.1]*len(getattr(control,channel))
            setattr(control,channel,values);control.keyframe_insert(channel,frame=frame)
    manual_action,manual_slot=ad.action,ad.action_slot
    ad.action=None
    manual=ad.nla_tracks.new();manual.name='manual'
    manual_strip=manual.strips.new('manual',140,manual_action);manual_strip.action_slot=manual_slot
    ad.action=bpy.data.actions.new('partial-y')
    for frame,value in [(1,0),(9,.6)]:
        bone.rotation_euler.y=value;bone.keyframe_insert('rotation_euler',index=1,frame=frame)
    y_action,y_slot=ad.action,ad.action_slot;ad.action=None
    y_track=ad.nla_tracks.new();y_track.name='partial-y'
    y_strip=y_track.strips.new('partial-y',170,y_action);y_strip.action_slot=y_slot
    ad.use_nla=True;arm.data.pose_position='POSE'
    for t in ad.nla_tracks:t.is_solo=False;t.mute=True
    scene.frame_set(200,subframe=.25)
    for pb in arm.pose.bones:
        pb.location=(.03,.04,.05);pb.rotation_euler=(.2,.3,.4)
        pb.rotation_quaternion=(.9,.1,.2,.3);pb.rotation_axis_angle=(.4,0,0,1)
        pb.scale=(1.1,1.2,1.3)
    arm.location=(.31,.42,.53)
    bpy.context.view_layer.update()
    object_channels=(arm.rotation_mode,*(tuple(getattr(arm,channel)) for channel in channels))
    def pose_channels():
        return {pb.name:(pb.rotation_mode,*(tuple(getattr(pb,channel)) for channel in channels)) for pb in arm.pose.bones}
    manual_pose=pose_channels();manual_basis={pb.name:np.array(pb.matrix_basis) for pb in arm.pose.bones}
    manual_state=state()
    sample_deform_poses(arm,samples=3,clips=['manual'])
    assert pose_channels()==manual_pose,'Sampler leaked transform channels after success'
    assert (arm.rotation_mode,*(tuple(getattr(arm,channel)) for channel in channels))==object_channels,'Sampler leaked armature object channels after success'
    assert state()==manual_state
    for pb in arm.pose.bones:np.testing.assert_allclose(pb.matrix_basis,manual_basis[pb.name],atol=1e-6)
    rejects(samples=3,clips=['manual','static'])
    assert pose_channels()==manual_pose,'Sampler leaked transform channels after an error'
    assert (arm.rotation_mode,*(tuple(getattr(arm,channel)) for channel in channels))==object_channels,'Sampler leaked armature object channels after an error'
    for pb in arm.pose.bones:np.testing.assert_allclose(pb.matrix_basis,manual_basis[pb.name],atol=1e-6)
    y_only=sample_deform_poses(arm,samples=3,clips=['partial-y'])
    x_then_y=sample_deform_poses(arm,samples=3,clips=['manual','partial-y'])
    for alone,after_x in zip(y_only['poses'],x_then_y['poses'][3:]):
        for name in alone:
            np.testing.assert_allclose(alone[name],after_x[name],atol=1e-6,
                                       err_msg='Unkeyed channels leaked between clips')
    empty=ad.nla_tracks.new();empty.name='empty';rejects(clips=['empty'])
    track.strips.new('second',100,static);rejects(clips=['static'])
    # Export a bound mesh so authorGLB also validates this is a usable fixture.
    bpy.ops.mesh.primitive_cube_add(size=.2)
    mesh=bpy.context.object;mesh.name='sample-mesh';mesh.matrix_world=arm.matrix_world
    group=mesh.vertex_groups.new(name='root');group.add(list(range(len(mesh.data.vertices))),1,'REPLACE')
    modifier=mesh.modifiers.new('skin','ARMATURE');modifier.object=arm
    print('SKIN_SAMPLES_CHECK: scaled timing, direct matrices, deform bones, static guards, state restoration')
    return [arm,mesh]
