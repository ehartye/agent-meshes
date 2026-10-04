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
/**
 * Surface finish, 0 to 1 each: metalness 1 is bare metal, roughness 0 is a mirror. Glass adds opacity below 1 (glTF
 * alphaMode BLEND), transmission (KHR_materials_transmission), ior (KHR_materials_ior, 1 to 2.333) and doubleSided.
 */
export interface Material { metalness: number; roughness: number; /** glTF material name; identical name, colour and finish share one exported material. */ name?: string; opacity?: number; transmission?: number; ior?: number; doubleSided?: boolean }
/**
 * Optional shape refinements. Absent means the original behaviour exactly.
 * lathe: profileUnits, corners, angleRange, startAngle. prism: outlineUnits, axis, bevel.
 */
export interface ShapeOptions {
  /** lathe: 'metres' reads profile points as real [radius, height] in meters, height up from the part origin, ignoring size. Default 'unit'. */
  profileUnits?: 'unit' | 'metres';
  /** lathe: indices of profile points that are hard edges (normals split there). */
  corners?: number[];
  /** lathe: [startDeg, endDeg] revolves only that sector and caps its radial ends. Angles run about +y from +z toward +x. */
  angleRange?: [number, number];
  /** lathe: degrees of phase of the segment grid (default 0), so lathes and sectors with equal segments and phase share vertices. */
  startAngle?: number;
  /** prism: 'metres' reads outline points as real meters and extrudes from the part origin to size along the axis. Default 'unit'. */
  outlineUnits?: 'unit' | 'metres';
  /** prism: extrusion axis. 'z' (default) takes an XY outline; 'y' takes an XZ outline and extrudes upward. */
  axis?: 'y' | 'z';
  /** prism: chamfer width on both cap edges (outline units), without changing footprint or height. */
  bevel?: number;
}
export interface Part {
  name: string;
  geometry: { type: GeometryKind; size: Vec3; segments: number; mirrorX?: boolean; profile?: Vec2[]; outline?: Vec2[] } & ShapeOptions;
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
export interface Shell { name: string; parts: string[]; cut?: string[]; blend: number; colorBlend?: number; resolution: number; material?: Material; pattern?: Pattern; /** false omits the baked COLOR_0/COLOR_1 (member tint times occlusion); the material carries the single member colour. Default true. */ vertexColors?: boolean }
export interface Project { version: 1; name: string; parts: Part[]; bones: BoneDef[]; clips: Clip[]; shells?: Shell[] }
export type PartInput = Pick<Part, 'name'> & Partial<Omit<Part, 'name' | 'geometry' | 'material'>> & {
  geometry?: { type: GeometryKind; size?: Vec3; segments?: number; mirrorX?: boolean; profile?: Vec2[]; outline?: Vec2[] } & ShapeOptions;
  material?: Partial<Material>;
  /** Alternative to `rotation`: [x, y, z] degrees, three.js 'XYZ' order (world axes: z first, then y, then x). Giving both is an error. */
  rotationEuler?: Vec3;
  /** Express position and rotation in this bone's rest frame; the stored part is converted to world coordinates. */
  anchor?: string;
};
export type Operation =
  | { op: 'add'; part: PartInput }
  | { op: 'update'; name: string; changes: Partial<Omit<Part, 'name' | 'material' | 'pattern'>> & { material?: Partial<Material>; pattern?: Pattern | null; rotationEuler?: Vec3 } }
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
