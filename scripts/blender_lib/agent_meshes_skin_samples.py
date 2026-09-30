"""Sample deform matrices in armature-local space from isolated NLA clips.

Matrices act on rest vertices in the same armature-local coordinate frame.
Callers must apply or reconcile mesh transforms before using these samples;
object/world transforms are deliberately excluded. Rest identity poses, when
needed by a fitter, are added separately by the caller.
"""
import math


def sample_deform_poses(armature, *, samples=33, clips=None):
    """Return poses, sample metadata, and observed matrix variation per clip.

    Each selected named NLA track must contain exactly one nonempty strip.
    ``samples`` includes both strip endpoints, in global scene time (including
    strip scaling). ``clips=None`` selects all tracks in their existing order.
    A clip whose matrices never differ from its first sample by more than 1e-7
    is rejected, preventing a disabled or otherwise static sampler from silently
    supplying a fitter with repeated rest poses. Variation is the maximum
    absolute matrix-component difference from the first sample of that clip.
    Unkeyed transform channels use the caller's pose as a consistent baseline
    for each clip; sampled clips do not inherit channels from preceding clips.

    The active action/slot, NLA mute/solo flags, NLA enablement, pose position,
    scene frame/subframe, and armature object/every bone's local transform
    channels are restored even when sampling raises an error. Animation of
    custom properties or constraint settings is not isolated or restored;
    supported clips drive local transform channels.
    """
    import bpy

    if isinstance(samples, bool) or not isinstance(samples, int) or samples < 2:
        raise ValueError('At least two integer samples per clip required')
    if armature.type != 'ARMATURE':
        raise ValueError('An armature object is required')
    ad = armature.animation_data
    tracks = list(ad.nla_tracks) if ad else []
    names = [track.name for track in tracks] if clips is None else list(clips)
    if not names or len(set(names)) != len(names):
        raise ValueError('At least one unique NLA clip name required')
    by_name = {track.name: track for track in tracks}
    if any(name not in by_name for name in names):
        raise ValueError('Selected NLA clip does not exist')
    selected = [by_name[name] for name in names]
    for track in selected:
        if len(track.strips) != 1:
            raise ValueError(f'Clip {track.name}: exactly one NLA strip required')
        strip = track.strips[0]
        if strip.action is None or not math.isfinite(strip.frame_start) or not math.isfinite(strip.frame_end) or strip.frame_end <= strip.frame_start:
            raise ValueError(f'Clip {track.name}: nonempty finite action strip required')
    bones = [bone for bone in armature.pose.bones if bone.bone.use_deform]
    if not bones:
        raise ValueError('At least one deform bone required')
    inverse_rest = {bone.name: bone.bone.matrix_local.inverted() for bone in bones}
    scene = bpy.context.scene
    prior_action, prior_slot = ad.action, ad.action_slot
    prior_nla = ad.use_nla
    prior_tracks = [(track, track.mute, track.is_solo) for track in tracks]
    prior_pose = armature.data.pose_position
    prior_frame, prior_subframe = scene.frame_current, scene.frame_subframe
    transform_channels = ('location', 'rotation_euler', 'rotation_quaternion', 'rotation_axis_angle', 'scale')
    prior_transforms = [(target, target.rotation_mode,
                         {channel: tuple(getattr(target, channel)) for channel in transform_channels})
                        for target in [armature, *armature.pose.bones]]

    def restore_transforms():
        for target, mode, channels in prior_transforms:
            target.rotation_mode = mode
            for channel, value in channels.items():
                setattr(target, channel, value)

    result = {'poses': [], 'samples': [], 'clips': {}, 'maxMatrixVariation': 0.0}
    try:
        # Reassign even if already None: this refreshes animation dependencies
        # after a caller evaluated REST with every NLA track muted.
        ad.action = None
        ad.use_nla = True
        armature.data.pose_position = 'POSE'
        for track in tracks:
            track.is_solo = False
            track.mute = True
        for track in selected:
            restore_transforms()
            track.mute = False
            strip = track.strips[0]
            first_pose = None
            variation = 0.0
            for index in range(samples):
                phase = index / (samples - 1)
                frame = strip.frame_start + (strip.frame_end - strip.frame_start) * phase
                integer_frame = math.floor(frame)
                scene.frame_set(integer_frame, subframe=frame - integer_frame)
                bpy.context.view_layer.update()
                pose = {bone.name: [list(row) for row in bone.matrix @ inverse_rest[bone.name]] for bone in bones}
                if first_pose is None:
                    first_pose = pose
                else:
                    variation = max(variation, max(abs(pose[name][i][j] - first_pose[name][i][j])
                                                  for name in pose for i in range(4) for j in range(4)))
                result['poses'].append(pose)
                result['samples'].append({'clip': track.name, 'phase': phase, 'frame': frame})
            track.mute = True
            if variation <= 1e-7:
                raise ValueError(f'Clip {track.name}: sampled deform matrices are static (variation {variation:g})')
            result['clips'][track.name] = {'samples': samples, 'frameStart': float(strip.frame_start),
                                          'frameEnd': float(strip.frame_end), 'maxMatrixVariation': variation}
            result['maxMatrixVariation'] = max(result['maxMatrixVariation'], variation)
    finally:
        ad.action = prior_action
        if prior_action is not None:
            ad.action_slot = prior_slot
        ad.use_nla = prior_nla
        for track, mute, solo in prior_tracks:
            track.mute = mute
            track.is_solo = False
        # Blender's solo setter can clear other tracks even when set to False.
        # Restore the selected solo track only after clearing every track.
        for track, mute, solo in prior_tracks:
            if solo:
                track.is_solo = True
        armature.data.pose_position = prior_pose
        restore_transforms()
        scene.frame_set(prior_frame, subframe=prior_subframe)
        bpy.context.view_layer.update()
    return result
