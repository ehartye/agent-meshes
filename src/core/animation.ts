import { z } from 'zod';
import { nameSchema, vec3Schema, quatSchema } from './rig.ts';
import type { Project } from './types.ts';

/**
 * A bone scale: three positive multipliers of the bone's rest scale, which is [1, 1, 1] because bones carry no authored scale.
 * Like the other track values it is stored as written (not an offset), so a scale key of [1, 1, 1] is the rest pose.
 */
export const scaleSchema = z.tuple([z.number().finite(), z.number().finite(), z.number().finite()])
  .refine(scale => scale.every(value => value > 0), 'Scale must be positive on every axis (zero or negative collapses or flips the bone; the rest scale is [1, 1, 1])');
const trackSchema = z.discriminatedUnion('property', [
  z.object({ bone: nameSchema, property: z.literal('rotation'), keys: z.array(z.object({ time: z.number().finite().nonnegative(), value: quatSchema }).strict()).min(2).max(10000) }).strict(),
  z.object({ bone: nameSchema, property: z.literal('position'), keys: z.array(z.object({ time: z.number().finite().nonnegative(), value: vec3Schema }).strict()).min(2).max(10000) }).strict(),
  z.object({ bone: nameSchema, property: z.literal('scale'), keys: z.array(z.object({ time: z.number().finite().nonnegative(), value: scaleSchema }).strict()).min(2).max(10000) }).strict(),
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
