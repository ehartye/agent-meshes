export type Vec3 = [number, number, number];
export type Quat = [number, number, number, number];
export type GeometryKind = 'box' | 'sphere' | 'cylinder' | 'cone' | 'capsule' | 'group';
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
export interface Part {
  name: string;
  geometry: { type: GeometryKind; size: Vec3; segments: number };
  color: string;
  position: Vec3;
  rotation: Quat;
  scale: Vec3;
  parent: string | null;
  binding?: Binding;
}
export interface Keyframe { time: number; value: Vec3 | Quat }
export interface Track { bone: string; property: 'rotation' | 'position'; keys: Keyframe[] }
export interface Clip { name: string; duration: number; tracks: Track[] }
export interface Project { version: 1; name: string; parts: Part[]; bones: BoneDef[]; clips: Clip[] }
export type PartInput = Pick<Part, 'name'> & Partial<Omit<Part, 'name' | 'geometry'>> & {
  geometry?: { type: GeometryKind; size?: Vec3; segments?: number };
};
export type Operation =
  | { op: 'add'; part: PartInput }
  | { op: 'update'; name: string; changes: Partial<Omit<Part, 'name'>> }
  | { op: 'remove'; name: string }
  | RigOperation
  | { op: 'clip.set'; clip: Clip }
  | { op: 'clip.remove'; name: string };
export type RigOperation =
  | { op: 'bone.add'; bone: Partial<BoneDef> & Pick<BoneDef, 'name'> }
  | { op: 'bone.update'; name: string; changes: Partial<Omit<BoneDef, 'name' | 'pose'>> }
  | { op: 'bone.remove'; name: string }
  | { op: 'bone.mirror'; name: string; prefix: string; axis: 'x' | 'y' | 'z' }
  | { op: 'pose'; name: string; rotation: Quat }
  | { op: 'pose.reset' }
  | { op: 'bind'; name: string; binding: Binding }
  | { op: 'unbind'; name: string };
