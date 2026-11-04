import { applyOperation, createProject } from '../../src/core/model.ts';
import type { Clip, Project } from '../../src/core/types.ts';
import { exportGLB } from '../../src/export.ts';

/**
 * A small rigged figure for preview-framing tests, built from core operations and the Node exporter so no Blender is
 * needed to make it and no binary is committed: a platform and a mast, and an arm on a shoulder bone that the `reach`
 * clip slides out along X (the character's side) by REACH metres and back.
 *
 * The platform and mast are larger than the unit bone-shape sphere that Blender's glTF importer leaves at the origin
 * (a mesh in a collection the render never shows, which the preview fit still counts), so the fit measures the figure
 * and nothing else. The `still` clip keys the same two channels at the rest pose, so every one of its poses equals
 * the rest pose.
 */
export const REACH = 2;
export const DURATION = 1.2;
const KEYS = 12;
const times = Array.from({ length: KEYS + 1 }, (_, i) => Number((i * DURATION / KEYS).toFixed(6)));
const identity: [number, number, number, number] = [0, 0, 0, 1];

const reach: Clip = {
  name: 'reach', duration: DURATION, tracks: [
    { bone: 'shoulder', property: 'position', keys: times.map((time, i) => ({ time, value: [i === KEYS ? 0 : REACH * Math.sin(Math.PI * time / DURATION), 0, 0] as [number, number, number] })) },
  ],
};
const still: Clip = {
  name: 'still', duration: DURATION, tracks: [
    { bone: 'shoulder', property: 'position', keys: times.map(time => ({ time, value: [0, 0, 0] as [number, number, number] })) },
    { bone: 'shoulder', property: 'rotation', keys: times.map(time => ({ time, value: identity })) },
  ],
};

export function framingProject(): Project {
  let project = createProject('framing-fixture');
  const part = (name: string, size: [number, number, number], position: [number, number, number], bone: string) => {
    project = applyOperation(project, { op: 'add', part: { name, geometry: { type: 'box', size }, position } });
    project = applyOperation(project, { op: 'bind', name, binding: { type: 'rigid', bone } });
  };
  project = applyOperation(project, { op: 'bone.add', bone: { name: 'root' } });
  project = applyOperation(project, { op: 'bone.add', bone: { name: 'shoulder', parent: 'root', position: [0.3, 0.6, 0] } });
  part('platform', [2.2, 0.1, 2.2], [0, -1.05, 0], 'root');
  part('mast', [0.3, 2.2, 0.3], [0, 0, 0], 'root');
  part('arm', [0.8, 0.15, 0.15], [0.7, 0.6, 0], 'shoulder');
  return { ...project, clips: [reach, still] };
}

export async function framingGlb(): Promise<Buffer> {
  return Buffer.from(await exportGLB(framingProject()));
}

/** Half the diagonal of the fixture's bounding box in metres, with the arm at rest and with it at its full reach. */
export const restRadius = Math.hypot(2.2, 2.2, 2.2) / 2;
export const unionRadius = Math.hypot(2.2 + REACH, 2.2, 2.2) / 2;

/**
 * A small figure that differs left to right (a long arm on +X, a stub on -X) and front to back (a nose on +Z). Rigged,
 * its parts ride two bones and the importer adds its hidden bone-shape sphere, which is larger than the figure; static,
 * it has no armature and so no such helper.
 */
export async function smallFigureGlb(rigged: boolean): Promise<Buffer> {
  let project = createProject(rigged ? 'small-rigged' : 'small-static');
  if (rigged) {
    project = applyOperation(project, { op: 'bone.add', bone: { name: 'root' } });
    project = applyOperation(project, { op: 'bone.add', bone: { name: 'shoulder', parent: 'root', position: [0.25, 0.7, 0] } });
  }
  const part = (name: string, size: [number, number, number], position: [number, number, number], bone: string) => {
    project = applyOperation(project, { op: 'add', part: { name, geometry: { type: 'box', size }, position } });
    if (rigged) project = applyOperation(project, { op: 'bind', name, binding: { type: 'rigid', bone } });
  };
  part('body', [0.5, 0.8, 0.3], [0, 0.4, 0], 'root');
  part('head', [0.3, 0.3, 0.3], [0, 0.95, 0], 'root');
  part('nose', [0.1, 0.1, 0.25], [0, 0.95, 0.2], 'root');
  part('stub', [0.1, 0.1, 0.1], [-0.3, 0.7, 0], 'root');
  part('arm', [0.6, 0.12, 0.12], [0.55, 0.7, 0], 'shoulder');
  return Buffer.from(await exportGLB(project));
}
