type Env = Record<string, string | undefined>;
export const REGISTRY_SCHEMA: string;
export const ASSET_SCHEMA: string;
export const REGISTRY_FILE: string;
export const TERMS: string;
export const MIXAMO_SKELETON: RegExp;
export type MixamoKind = 'clip' | 'clip-with-skin' | 'character';
export const KINDS: MixamoKind[];
export interface MixamoClip { name: string; seconds: number | null }
export interface MixamoFacts { fbxVersion: number; creator: string | null; skeleton: string | null; bones: number; hasMesh: boolean; clips: MixamoClip[] }
export interface MixamoStamp { file: string; bytes: number; mtimeMs: number }
export interface MixamoMotion { seconds: number; travelMeters: number; inPlace: boolean; hipsRiseCm: number; hipsDropCm: number; summary: string }
/** The fields an entry takes from its sidecar, or from the header and file name when it has none. */
export interface MixamoSidecarFields { kind: MixamoKind; title: string; tags: string[]; note: string; motion: MixamoMotion | null; preview: string | null }
/** `sidecarError` is set when the sidecar beside the FBX cannot be read (not JSON, or another schema); edits refuse it. */
export interface MixamoEntry extends MixamoFacts, MixamoStamp, MixamoSidecarFields { id: string; sha256: string; sidecarError?: string }
export interface MixamoSkip extends MixamoStamp, Partial<MixamoFacts> { sha256: string; reason: string; problem?: string }
export interface MixamoRegistry { schema: string; source: string; terms: string; directory: string; entries: MixamoEntry[]; skipped: MixamoSkip[]; sidecars: MixamoStamp[] }
export interface MixamoScan { directory: string; registry: string; entries: number; skipped: { file: string; reason: string }[] }
/** The sidecar beside each imported FBX (`<id>.json`). */
export interface MixamoAsset { schema: string; id: string; kind: MixamoKind; title: string; sourceName: string; sha256: string; importedAt: string; tags: string[]; note: string; motion: MixamoMotion | null; preview: string | null }
/** `repaired` lists what a duplicate's import put back: a missing sidecar, a missing or unusable preview. */
export interface MixamoImportResult { source: string; status: 'imported' | 'duplicate' | 'rejected'; id?: string; kind?: MixamoKind; reason?: string; previewError?: string; repaired?: ('sidecar' | 'preview')[] }
export type MixamoRender = (fbxPath: string) => Promise<{ gif: Uint8Array }>;
export interface MixamoImportOptions { directory?: string; env?: Env; tags?: string[]; render?: MixamoRender; onProgress?: (result: MixamoImportResult) => void }
export interface MixamoLibraryOptions { directory?: string; env?: Env }
export interface MixamoEdit { entries: MixamoEntry[]; registry: MixamoRegistry }
export interface FbxArray { array: 'f' | 'd' | 'l' | 'i' | 'b'; count: number; encoding: number; start: number; stored: number }
export function mixamoDir(env?: Env): string;
export function registryFile(env?: Env): string;
export function slug(text: string): string;
export function normalizeTags(tags: readonly unknown[] | null | undefined): string[];
export function walkFbx(bytes: Uint8Array, visit: (name: string, properties: unknown[], depth: number) => boolean | void): number;
export function decodeArray(bytes: Uint8Array, array: FbxArray): number[];
export function describeFbx(bytes: Uint8Array): MixamoFacts;
export function assetKind(facts: Pick<MixamoFacts, 'hasMesh' | 'clips'>): MixamoKind;
export function motionSummary(bytes: Uint8Array): MixamoMotion;
export function suggestTags(title: string, kind: MixamoKind, motion: Pick<MixamoMotion, 'inPlace'> | null): string[];
export function unzipFbx(bytes: Uint8Array): { name: string; bytes: Uint8Array }[];
export function fbxFiles(folder: string, base?: string): Promise<MixamoStamp[]>;
export function scanMixamo(directory?: string, env?: Env, options?: { reuse?: MixamoRegistry | null }): Promise<MixamoScan>;
export function mixamoRegistry(directory?: string, env?: Env): Promise<MixamoRegistry>;
export function mixamoPath(id: string, directory?: string, env?: Env): Promise<string>;
export function assertNotMeshesCheckout(directory: string): void;
export function importAssets(sources: string[], options?: MixamoImportOptions): Promise<{ results: MixamoImportResult[]; registry: MixamoRegistry }>;
export function setTags(ids: string[], add?: string[], remove?: string[], options?: MixamoLibraryOptions): Promise<MixamoEdit>;
export function setTitle(id: string, title: string, options?: MixamoLibraryOptions): Promise<MixamoEdit>;
export function setNote(id: string, note: string, options?: MixamoLibraryOptions): Promise<MixamoEdit>;
export function removeAssets(ids: string[], options?: MixamoLibraryOptions): Promise<{ removed: string[]; registry: MixamoRegistry }>;
export function addMixamo(sources: string[], directory?: string, env?: Env, options?: Omit<MixamoImportOptions, 'directory' | 'env'>): Promise<MixamoScan & { copied: string[]; results: MixamoImportResult[] }>;
