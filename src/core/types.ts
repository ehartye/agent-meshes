import type { AssemblyCopyOperation } from './assembly.ts';
import type { PoseTargetOperation } from './pose-target.ts';
export type Vec3 = [number, number, number];
export type Quat = [number, number, number, number];
export type GeometryKind = 'box' | 'sphere' | 'cylinder' | 'cone' | 'capsule' | 'lathe' | 'prism' | 'group';
/** [radius, height] points of a unit profile (radius 0..0.5, height -0.5..0.5) or [x, y] points of a unit outline (-0.5..0.5). */
export type Vec2 = [number, number];
/** A painted surface pattern baked into vertex colors in world space: dots on a lattice, stripes along an axis, or checks across the other two axes. `size` is meters. */
export interface Pattern { type: 'dots' | 'stripes' | 'checks'; color: string; size: number; axis?: 'x' | 'y' | 'z'; offset?: Vec3 }
export interface BoneDef {
  name: string;
  parent: string | null;
  position: Vec3;
  rotation: Quat;
  pose: Quat;
}
export type Binding =
  | { type: 'rigid'; bone: string }
  | { type: 'linear'; bones: [string, string]; axis: 'x' | 'y' | 'z'; range: [number, number] }
  | { type: 'weights'; bones: string[]; weights: number[][] };
/** Surface finish, 0 to 1 each: metalness 1 is bare metal, roughness 0 is a mirror. */
export interface Material { metalness: number; roughness: number }
export interface Part {
  name: string;
  geometry: { type: GeometryKind; size: Vec3; segments: number; mirrorX?: boolean; profile?: Vec2[]; outline?: Vec2[] };
  color: string;
  position: Vec3;
  rotation: Quat;
  scale: Vec3;
  parent: string | null;
  binding?: Binding;
  material?: Material;
  pattern?: Pattern;
}
export interface Keyframe { time: number; value: Vec3 | Quat }
export interface Track { bone: string; property: 'rotation' | 'position'; keys: Keyframe[] }
export interface Clip { name: string; duration: number; tracks: Track[] }
/** A smooth surface blended from several parts; it replaces them when rendered or exported. */
export interface Shell { name: string; parts: string[]; cut?: string[]; blend: number; resolution: number; material?: Material; pattern?: Pattern }
export interface Project { version: 1; name: string; parts: Part[]; bones: BoneDef[]; clips: Clip[]; shells?: Shell[] }
export type PartInput = Pick<Part, 'name'> & Partial<Omit<Part, 'name' | 'geometry' | 'material'>> & {
  geometry?: { type: GeometryKind; size?: Vec3; segments?: number; mirrorX?: boolean; profile?: Vec2[]; outline?: Vec2[] };
  material?: Partial<Material>;
  /** Express position and rotation in this bone's rest frame; the stored part is converted to world coordinates. */
  anchor?: string;
};
export type Operation =
  | { op: 'add'; part: PartInput }
  | { op: 'update'; name: string; changes: Partial<Omit<Part, 'name' | 'material' | 'pattern'>> & { material?: Partial<Material>; pattern?: Pattern | null } }
  | { op: 'remove'; name: string }
  | RigOperation
  | AssemblyCopyOperation
  | PoseTargetOperation
  | { op: 'clip.set'; clip: Clip }
  | { op: 'clip.remove'; name: string }
  | { op: 'shell.set'; shell: Omit<Shell, 'material'> & { material?: Partial<Material> } }
  | { op: 'shell.remove'; name: string };
export type RigOperation =
  | { op: 'bone.add'; bone: Partial<BoneDef> & Pick<BoneDef, 'name'> }
  | { op: 'bone.update'; name: string; changes: Partial<Omit<BoneDef, 'name' | 'pose'>> }
  | { op: 'bone.remove'; name: string }
  | { op: 'bone.mirror'; name: string; prefix: string; axis: 'x' | 'y' | 'z' }
  | { op: 'pose'; name: string; rotation: Quat }
  | { op: 'pose.reset' }
  | { op: 'bind'; name: string; binding: Binding }
  | { op: 'unbind'; name: string };
