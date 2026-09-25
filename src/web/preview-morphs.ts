// Morph controls for preview.html: every morph target a model carries, the parts or mesh groups that carry it, and
// emotion presets from an `arkit-face/1` head's `extras.arkitFace`. Pure: no DOM, so Node tests can check it.
import type { Object3D } from 'three';

/** The part of the puppet API the controls need. */
export interface MorphSource {
  morphGroups: string[];
  parts: string[];
  morphTargets(name: string): string[];
  object(name: string): Object3D;
  root: Object3D;
}
export interface MorphControl { target: string; owners: string[] }
export interface MorphControls { targets: MorphControl[]; presets: Record<string, Record<string, number>> }

/**
 * The model's morph targets in first-seen order, each with the names that drive it (`setMorph(owner, target, w)`):
 * multi-primitive mesh groups first (a face's skin, lids and teeth), then single parts outside those groups. Presets
 * are `extras.arkitFace.emotions` from any node (the rig root of an arkit-face head), keeping only targets the model
 * has; `neutral` is always first.
 */
export function morphControls(source: MorphSource): MorphControls {
  const owners = new Map<string, string[]>();
  const add = (owner: string) => { for (const target of source.morphTargets(owner)) owners.set(target, [...owners.get(target) ?? [], owner]); };
  const groups = new Set(source.morphGroups);
  for (const group of source.morphGroups) add(group);
  for (const part of source.parts) {
    const parent = source.object(part).parent?.name;
    if (!groups.has(part) && !(parent && groups.has(parent))) add(part);
  }
  const presets: Record<string, Record<string, number>> = { neutral: {} };
  source.root.traverse(node => {
    const face = (node.userData as { arkitFace?: { emotions?: Record<string, Record<string, number>> } }).arkitFace;
    for (const [name, weights] of Object.entries(face?.emotions ?? {})) {
      if (name === 'neutral' || !weights || typeof weights !== 'object') continue;
      presets[name] = Object.fromEntries(Object.entries(weights).filter(([target, w]) => owners.has(target) && typeof w === 'number' && Number.isFinite(w)));
    }
  });
  return { targets: [...owners].map(([target, names]) => ({ target, owners: names })), presets };
}
