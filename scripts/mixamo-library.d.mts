export const REGISTRY_SCHEMA: string;
export const REGISTRY_FILE: string;
export const TERMS: string;
export interface MixamoClip { name: string; seconds: number | null }
export interface MixamoFacts { fbxVersion: number; creator: string | null; skeleton: string | null; bones: number; hasMesh: boolean; clips: MixamoClip[] }
export interface MixamoEntry extends MixamoFacts { id: string; file: string; sha256: string; bytes: number }
export interface MixamoRegistry { schema: string; source: string; terms: string; entries: MixamoEntry[] }
export interface MixamoScan { directory: string; registry: string; entries: number; skipped: { file: string; reason: string }[] }
export function mixamoDir(env?: Record<string, string | undefined>): string;
export function slug(text: string): string;
export function walkFbx(bytes: Uint8Array, visit: (name: string, properties: unknown[], depth: number) => boolean | void): number;
export function describeFbx(bytes: Uint8Array): MixamoFacts;
export function unzipFbx(bytes: Uint8Array): { name: string; bytes: Uint8Array }[];
export function scanMixamo(directory?: string): Promise<MixamoScan>;
export function addMixamo(sources: string[], directory?: string): Promise<MixamoScan & { copied: string[] }>;
export function mixamoRegistry(directory?: string): Promise<MixamoRegistry>;
export function mixamoPath(id: string, directory?: string): Promise<string>;
