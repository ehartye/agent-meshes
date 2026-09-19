export type Vec3 = [number, number, number];
export type Quat = [number, number, number, number];
export type GeometryKind = 'box' | 'sphere' | 'cylinder' | 'cone' | 'capsule' | 'group';
export interface Part {
  name: string;
  geometry: { type: GeometryKind; size: Vec3; segments: number };
  color: string;
  position: Vec3;
  rotation: Quat;
  scale: Vec3;
  parent: string | null;
}
export interface Project { version: 1; name: string; parts: Part[] }
export type PartInput = Pick<Part, 'name'> & Partial<Omit<Part, 'name' | 'geometry'>> & {
  geometry?: { type: GeometryKind; size?: Vec3; segments?: number };
};
export type Operation =
  | { op: 'add'; part: PartInput }
  | { op: 'update'; name: string; changes: Partial<Omit<Part, 'name'>> }
  | { op: 'remove'; name: string };
