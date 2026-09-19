import { z } from 'zod';
import { nameSchema, vec3Schema, quatSchema } from './rig.ts';
import type { Project } from './types.ts';

const trackSchema = z.discriminatedUnion('property', [
  z.object({ bone: nameSchema, property: z.literal('rotation'), keys: z.array(z.object({ time: z.number().finite().nonnegative(), value: quatSchema }).strict()).min(2).max(10000) }).strict(),
  z.object({ bone: nameSchema, property: z.literal('position'), keys: z.array(z.object({ time: z.number().finite().nonnegative(), value: vec3Schema }).strict()).min(2).max(10000) }).strict(),
]);
export const clipSchema = z.object({ name: nameSchema, duration: z.number().finite().min(0.05).max(120), tracks: z.array(trackSchema).min(1).max(512) }).strict();
export function validateAnimation(project: Project): void {
  const names = new Set<string>(); const bones = new Set(project.bones.map(b => b.name));
  for (const clip of project.clips) {
    if (names.has(clip.name)) throw new Error(`Duplicate clip: ${clip.name}`);
    names.add(clip.name); const tracks = new Set<string>();
    for (const track of clip.tracks) {
      if (!bones.has(track.bone)) throw new Error(`Unknown animation bone: ${track.bone}`);
      const id = `${track.bone}:${track.property}`;
      if (tracks.has(id)) throw new Error(`Duplicate track: ${id}`);
      tracks.add(id);
      if (track.keys[0].time !== 0 || Math.abs(track.keys.at(-1)!.time - clip.duration) > 1e-6) throw new Error('Tracks must span the complete clip duration');
      let previous = -1;
      for (const key of track.keys) {
        if (key.time <= previous || key.time > clip.duration) throw new Error('Key times must increase within the clip duration');
        previous = key.time;
      }
    }
  }
}
