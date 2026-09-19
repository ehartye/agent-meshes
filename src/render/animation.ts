import { AnimationClip, QuaternionKeyframeTrack, VectorKeyframeTrack, Quaternion, Vector3 } from 'three';
import type { Bone, KeyframeTrack } from 'three';
import type { Project, Quat, Vec3 } from '../core/types.ts';

export function createClips(project: Project, bones: Map<string, Bone>): AnimationClip[] {
  return (project.clips ?? []).map(clip => {
    const tracks: KeyframeTrack[] = clip.tracks.map(track => {
      const def = project.bones.find(b => b.name === track.bone)!;
      const target = bones.get(track.bone)!;
      const times = track.keys.map(key => key.time);
      if (track.property === 'rotation') {
        const values = track.keys.flatMap(key => new Quaternion().fromArray(def.rotation).multiply(new Quaternion().fromArray(key.value as Quat)).normalize().toArray());
        return new QuaternionKeyframeTrack(`${target.uuid}.quaternion`, times, values);
      }
      const values = track.keys.flatMap(key => new Vector3().fromArray(def.position).add(new Vector3().fromArray(key.value as Vec3)).toArray());
      return new VectorKeyframeTrack(`${target.uuid}.position`, times, values);
    });
    return new AnimationClip(clip.name, clip.duration, tracks);
  });
}
