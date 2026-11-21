type Env = Record<string, string | undefined>;
export const REGISTRY_SCHEMA: string;
export const REGISTRY_FILE: string;
export const TERMS: string;
export const MIXAMO_SKELETON: RegExp;
export interface MixamoClip { name: string; seconds: number | null }
export interface MixamoFacts { fbxVersion: number; creator: string | null; skeleton: string | null; bones: number; hasMesh: boolean; clips: MixamoClip[] }
export interface MixamoStamp { file: string; bytes: number; mtimeMs: number }
export interface MixamoEntry extends MixamoFacts, MixamoStamp { id: string; sha256: string }
export interface MixamoSkip extends MixamoStamp, Partial<MixamoFacts> { sha256: string; reason: string; problem?: string }
export interface MixamoRegistry { schema: string; source: string; terms: string; directory: string; entries: MixamoEntry[]; skipped: MixamoSkip[] }
export interface MixamoScan { directory: string; registry: string; entries: number; skipped: { file: string; reason: string }[] }
export function mixamoDir(env?: Env): string;
export function registryFile(env?: Env): string;
export function slug(text: string): string;
export function walkFbx(bytes: Uint8Array, visit: (name: string, properties: unknown[], depth: number) => boolean | void): number;
export function describeFbx(bytes: Uint8Array): MixamoFacts;
export function unzipFbx(bytes: Uint8Array): { name: string; bytes: Uint8Array }[];
export function fbxFiles(folder: string, base?: string): Promise<MixamoStamp[]>;
export function scanMixamo(directory?: string, env?: Env, options?: { reuse?: MixamoRegistry | null }): Promise<MixamoScan>;
export function addMixamo(sources: string[], directory?: string, env?: Env): Promise<MixamoScan & { copied: string[] }>;
export function mixamoRegistry(directory?: string, env?: Env): Promise<MixamoRegistry>;
export function mixamoPath(id: string, directory?: string, env?: Env): Promise<string>;
