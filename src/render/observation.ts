import { Matrix4, Object3D, Vector3 } from 'three';
import type { AnimationClip } from 'three';
import { clone } from 'three/addons/utils/SkeletonUtils.js';
import type { PoseInput } from './puppet.ts';

export interface Anchor { node: string; point?: readonly [number, number, number] }
export type Anchors = Readonly<Record<string, Anchor>>;
export type Observations = Readonly<Record<string, readonly [number, number, number]>>;
export interface PoseSample {
  /** null selects authored rest; clip times wrap, including negative times. */
  clip: string | null;
  time: number;
  poses?: Readonly<Record<string, PoseInput>>;
  morphs?: readonly { part: string; target: string; weight: number }[];
}
export interface PoseSampler {
  /** Independent authored scene for observation or a separate renderer. Geometry/textures are borrowed read-only. */
  readonly root: Object3D;
  sample(input: PoseSample): void;
  observe(anchors: Anchors, relativeTo?: string): Observations;
  /** Releases owned materials and skeleton textures, never borrowed geometry/textures. */
  dispose(): void;
}

export function finiteTriple(value: readonly number[], label: string): void {
  if (!Array.isArray(value) || value.length !== 3 || ![0, 1, 2].every(index => Number.isFinite(value[index]))) throw new Error(`${label} must be three finite numbers`);
}

/** Node frames, not deformed surface points or inferred physical contacts. */
export function observePoints(root: Object3D, anchors: Anchors, relativeTo?: string): Observations {
  const entries = Object.entries(anchors);
  if (entries.length > 4096) throw new Error('At most 4096 anchors may be observed');
  const nodes = new Map<string, Object3D | null>();
  root.traverse(node => { if (node.name) nodes.set(node.name, nodes.has(node.name) ? null : node); });
  const find = (name: string): Object3D => {
    if (!nodes.has(name)) throw new Error(`Unknown node: ${name}`);
    const node = nodes.get(name); if (!node) throw new Error(`Ambiguous node: ${name}`); return node;
  };
  const relative = relativeTo === undefined ? null : find(relativeTo);
  const resolved = entries.map(([key, anchor]) => {
    const point = anchor.point ?? [0, 0, 0]; finiteTriple(point, `Anchor ${key}`);
    return { key, node: find(anchor.node), point };
  });
  root.updateWorldMatrix(true, true);
  const inverse = new Matrix4();
  if (relative) {
    if (!Number.isFinite(relative.matrixWorld.determinant()) || Math.abs(relative.matrixWorld.determinant()) < 1e-15) throw new Error('Relative frame is singular');
    inverse.copy(relative.matrixWorld).invert();
  }
  const result: Record<string, readonly [number, number, number]> = Object.create(null);
  for (const { key, node, point } of resolved) {
    const value = new Vector3().fromArray(point).applyMatrix4(node.matrixWorld);
    if (relative) value.applyMatrix4(inverse);
    const numbers = value.toArray() as [number, number, number]; finiteTriple(numbers, `Observed ${key}`);
    result[key] = Object.freeze(numbers);
  }
  return Object.freeze(result);
}

type Source = { scene: Object3D; animations: AnimationClip[] };
/** Keep transforms from before the first clip; also rewrite UUID-bound tracks on each clone. */
export function clonePoseSource(source: Source): Source {
  const scene = clone(source.scene), ids = new Map<string, string>();
  function pair(a: Object3D, b: Object3D): void { ids.set(a.uuid, b.uuid); a.children.forEach((child, i) => pair(child, b.children[i])); }
  pair(source.scene, scene);
  const animations = source.animations.map(clip => {
    const copy = clip.clone();
    for (const track of copy.tracks) {
      const separator = track.name.indexOf('.'), prefix = track.name.slice(0, separator);
      if (separator > 0 && ids.has(prefix)) track.name = ids.get(prefix)! + track.name.slice(separator);
    }
    return copy;
  });
  return { scene, animations };
}
