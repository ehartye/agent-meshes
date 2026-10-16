export const packageRoot: string;
export const catalogPath: string;
export interface RigLibraryEntry {
  id: string;
  bodyPlan: string;
  path: string;
  roles: string[];
  clips: { id: string; name: string }[];
  [key: string]: unknown;
}
export function rigCatalog(): Promise<{ libraries: RigLibraryEntry[]; [key: string]: unknown }>;
export function verifyRigLibrary(): Promise<{
  libraries: { id: string; errors: number; warnings: number; [key: string]: unknown }[];
  sourceSnapshots: number;
  errors: number;
  scope: string;
}>;
export function rigDemo(ids: string[], output: string): Promise<{
  output: string; comparison: string; models: unknown[]; scope: string;
}>;
