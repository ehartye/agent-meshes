/**
 * A small rigged GLB with looping clips, built from a recipe: a root with a tail joint. Every clip loops
 * (last key equals first) and sways the tail by 30 degrees; the root bobs by 2 cm. Corruptions are applied to a
 * copy of the recipe, so the unmodified clip is the negative for each.
 */
import { applyOperation, createProject } from '../../src/core/model.ts';
import { exportGLB } from '../../src/export.ts';
import type { Clip, Project } from '../../src/core/types.ts';

export const KEYS = 21, DURATION = 2;
const aboutZ = (degrees: number): [number, number, number, number] => [0, 0, Math.sin(degrees * Math.PI / 360), Math.cos(degrees * Math.PI / 360)];

export interface WagOptions {
  /** Degrees added to the tail's last rotation key, which opens the loop. */
  seamDegrees?: number;
  /** Metres added to the root's last position key. */
  seamMetres?: number;
  /** Replace the tail rotation key at this index with this many degrees: one bad key. */
  spike?: { index: number; degrees: number };
  /** Leave the root bob track out. */
  tailOnly?: boolean;
}

export function wagClip(name: string, options: WagOptions = {}): Clip {
  const times = Array.from({ length: KEYS }, (_, i) => Number((i * DURATION / (KEYS - 1)).toFixed(6)));
  const tail = times.map((time, i) => {
    let degrees = i === KEYS - 1 ? 0 : 30 * Math.sin(Math.PI * time);
    if (i === KEYS - 1) degrees += options.seamDegrees ?? 0;
    if (options.spike && options.spike.index === i) degrees = options.spike.degrees;
    return { time, value: aboutZ(degrees) };
  });
  const bob = times.map((time, i) => ({ time, value: [0, i === KEYS - 1 ? options.seamMetres ?? 0 : 0.02 * Math.sin(2 * Math.PI * time / DURATION), 0] as [number, number, number] }));
  return { name, duration: DURATION, tracks: [{ bone: 'tail', property: 'rotation', keys: tail }, ...(options.tailOnly ? [] : [{ bone: 'root', property: 'position' as const, keys: bob }])] };
}

export function wagProject(clips: Clip[] = [wagClip('wag')]): Project {
  let project = createProject('wagger');
  project = applyOperation(project, { op: 'bone.add', bone: { name: 'root' } });
  project = applyOperation(project, { op: 'bone.add', bone: { name: 'tail', parent: 'root', position: [0, 0.5, 0] } });
  project = applyOperation(project, { op: 'add', part: { name: 'body', geometry: { type: 'box', size: [0.4, 0.5, 0.4] }, position: [0, 0.25, 0] } });
  project = applyOperation(project, { op: 'bind', name: 'body', binding: { type: 'rigid', bone: 'root' } });
  project = applyOperation(project, { op: 'add', part: { name: 'tailtip', geometry: { type: 'box', size: [0.1, 0.5, 0.1] }, position: [0, 0.75, 0] } });
  project = applyOperation(project, { op: 'bind', name: 'tailtip', binding: { type: 'rigid', bone: 'tail' } });
  return { ...project, clips };
}

export const wagGLB = (options: WagOptions = {}) => exportGLB(wagProject([wagClip('wag', options)]));
