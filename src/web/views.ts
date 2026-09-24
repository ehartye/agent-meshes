import * as THREE from 'three';

/** Camera directions. `side` is the model's right (+x); `top` and `bottom` lean a hair off the pole so the orbit up vector stays defined. */
export type ViewName = 'front' | 'back' | 'left' | 'right' | 'side' | 'top' | 'bottom' | 'perspective';
export interface ViewSpec { position: [number, number, number]; target?: [number, number, number] }

const directions: Record<ViewName, THREE.Vector3> = {
  front: new THREE.Vector3(0, 0.12, 1), back: new THREE.Vector3(0, 0.12, -1),
  left: new THREE.Vector3(-1, 0.12, 0), right: new THREE.Vector3(1, 0.12, 0), side: new THREE.Vector3(1, 0.12, 0),
  top: new THREE.Vector3(0, 1, 0.0001), bottom: new THREE.Vector3(0, -1, 0.0001), perspective: new THREE.Vector3(1, 0.65, 1.4),
};
export const viewNames = Object.keys(directions) as ViewName[];
/** The camera direction of a named view (a fresh vector); an unknown name throws an Error listing the valid names. */
export function viewDirection(name: string): THREE.Vector3 {
  const direction = Object.hasOwn(directions, name) ? directions[name as ViewName] : null;
  if (!direction) throw new Error(`Unknown view "${name}"; use one of ${viewNames.join(', ')}, or {position, target}`);
  return direction.clone();
}
