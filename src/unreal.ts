import { spawn, spawnSync } from 'node:child_process';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { mkdir, open, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { auditMorphNames, SHARED_MORPH_FIX, UE_FALLBACK_MORPH_NAME, type MorphNameAudit } from './gltf-morphs.ts';
import { auditSkins, type SkinAudit } from './gltf-skins.ts';
import { ARKIT_FACE_CONTRACT } from './arkit-face.ts';

/**
 * Unreal destination check: import a GLB into a scratch UE project headlessly through
 * Interchange and report what Unreal made of it. This proves the *import* only: no
 * level is loaded and nothing is rendered or animated at runtime.
 */

export interface UnrealLocation { editor: string; root: string; version: string; source: 'AGENT_MESHES_UNREAL' | 'launcher' | 'search' }
export interface FindUnrealOptions { env?: NodeJS.ProcessEnv; platform?: NodeJS.Platform; roots?: string[]; launcherManifest?: string }

const EDITOR_NAMES: Partial<Record<NodeJS.Platform, string>> = { win32: 'Win64/UnrealEditor-Cmd.exe', linux: 'Linux/UnrealEditor-Cmd', darwin: 'Mac/UnrealEditor-Cmd' };

function engineVersion(root: string): string {
  try {
    const build = JSON.parse(readFileSync(join(root, 'Engine', 'Build', 'Build.version'), 'utf8')) as { MajorVersion: number; MinorVersion: number; PatchVersion: number };
    return `${build.MajorVersion}.${build.MinorVersion}.${build.PatchVersion}`;
  } catch { return /UE_(\d+(?:\.\d+)*)/.exec(basename(root))?.[1] ?? 'unknown'; }
}

function editorIn(root: string, platform: NodeJS.Platform): string | null {
  const relative = EDITOR_NAMES[platform] ?? EDITOR_NAMES.linux!;
  const editor = join(root, 'Engine', 'Binaries', ...relative.split('/'));
  try { return statSync(editor).isFile() ? editor : null; } catch { return null; }
}

function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map(Number), pb = b.split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) { const d = (pa[i] || 0) - (pb[i] || 0); if (d) return d; }
  return 0;
}

/** Engine root for a user-supplied path: an editor executable, `.../Engine`, or the install directory. */
function rootFromExplicit(path: string): string {
  const full = resolve(path);
  if (/\.exe$|UnrealEditor(-Cmd)?$/i.test(basename(full))) return resolve(dirname(full), '..', '..', '..');
  return basename(full).toLowerCase() === 'engine' ? dirname(full) : full;
}

export function defaultUnrealRoots(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): string[] {
  if (platform === 'win32') {
    const programFiles = [env.ProgramFiles, env['ProgramW6432'], 'C:/Program Files', 'D:/Program Files'].filter((v): v is string => Boolean(v));
    return [...new Set([...programFiles.map(p => join(p, 'Epic Games')), 'C:/Epic Games', 'D:/Epic Games'])];
  }
  if (platform === 'darwin') return ['/Users/Shared/Epic Games'];
  return [join(homedir(), 'UnrealEngine'), '/opt/UnrealEngine', '/opt'];
}

/**
 * Locate UnrealEditor-Cmd. `AGENT_MESHES_UNREAL` wins and must be valid; otherwise the Epic
 * launcher manifest and the usual install roots are searched and the newest engine is used.
 */
export function findUnreal(options: FindUnrealOptions = {}): UnrealLocation | null {
  const env = options.env ?? process.env, platform = options.platform ?? process.platform;
  const explicit = env.AGENT_MESHES_UNREAL;
  if (explicit) {
    const root = rootFromExplicit(explicit), editor = editorIn(root, platform);
    if (!editor) throw Object.assign(new Error(`AGENT_MESHES_UNREAL="${explicit}" does not contain UnrealEditor-Cmd (looked in ${root}); point it at the engine directory (for example C:/Program Files/Epic Games/UE_5.7) or at UnrealEditor-Cmd itself`), { code: 'UNREAL_NOT_FOUND' });
    return { editor, root, version: engineVersion(root), source: 'AGENT_MESHES_UNREAL' };
  }
  const found: UnrealLocation[] = [];
  const manifest = options.launcherManifest ?? (platform === 'win32' ? join(env.ProgramData ?? 'C:/ProgramData', 'Epic', 'UnrealEngineLauncher', 'LauncherInstalled.dat') : undefined);
  if (manifest) {
    try {
      const list = (JSON.parse(readFileSync(manifest, 'utf8')) as { InstallationList?: { AppName?: string; InstallLocation?: string }[] }).InstallationList ?? [];
      for (const entry of list) {
        if (!entry.InstallLocation || !/^UE_\d/.test(entry.AppName ?? '')) continue;
        const editor = editorIn(entry.InstallLocation, platform);
        if (editor) found.push({ editor, root: entry.InstallLocation, version: engineVersion(entry.InstallLocation), source: 'launcher' });
      }
    } catch { /* no launcher manifest */ }
  }
  for (const base of options.roots ?? defaultUnrealRoots(env, platform)) {
    let entries: string[] = [];
    try { entries = readdirSync(base); } catch { continue; }
    for (const dir of entries) {
      if (!/^UE_\d/.test(dir) && dir !== 'Engine' && !/^UnrealEngine/.test(dir)) continue;
      const root = dir === 'Engine' ? base : join(base, dir);
      const editor = editorIn(root, platform);
      if (editor && !found.some(f => resolve(f.editor) === resolve(editor))) found.push({ editor, root, version: engineVersion(root), source: 'search' });
    }
  }
  found.sort((a, b) => compareVersions(b.version, a.version));
  return found[0] ?? null;
}

/** Split a comma list, trimming blanks and dropping duplicates while keeping order. */
export function parseNameList(value: string): string[] {
  const names = [...new Set(value.split(',').map(v => v.trim()).filter(Boolean))];
  if (!names.length) throw Object.assign(new Error(`Expected at least one name in "${value}"`), { code: 'CLI_ARGUMENT_ERROR' });
  return names;
}

/** UE parses `-script=` with backslash escapes (`\t`, `\5`...), so every path goes over as forward slashes. */
const slashes = (path: string) => path.replace(/\\/g, '/');

export function unrealCommandLine(paths: { project: string; script: string; log: string }): string[] {
  return [slashes(paths.project), '-run=pythonscript', `-script=${slashes(paths.script)}`, '-unattended', '-nullrhi', '-nosplash', '-nopause', '-nosound', '-notraceserver', '-stdout', '-FullStdOutLogOutput', `-abslog=${slashes(paths.log)}`];
}

/**
 * The asset name a GLB is imported under. UE's glTF parser names meshes (and its fallback
 * morph names) after the source file, and Interchange renames anything with spaces or
 * punctuation again, logging "Duplicate morph target" warnings; so the GLB is imported
 * from a copy with this name.
 */
export function unrealImportName(path: string): string {
  return basename(path).replace(/\.[^.]*$/, '').replace(/[^A-Za-z0-9_]/g, '_').replace(/^(\d)/, '_$1') || 'Model';
}

export function defaultUnrealCache(env: NodeJS.ProcessEnv = process.env): string {
  if (env.AGENT_MESHES_UNREAL_CACHE) return resolve(env.AGENT_MESHES_UNREAL_CACHE);
  const base = process.platform === 'win32' ? (env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local')) : (env.XDG_CACHE_HOME ?? join(homedir(), '.cache'));
  return join(base, 'agent-meshes', 'unreal');
}

const UPROJECT = {
  FileVersion: 3, EngineAssociation: '', Category: '', Description: 'agent-meshes verify-unreal scratch project (safe to delete)',
  Plugins: [
    { Name: 'PythonScriptPlugin', Enabled: true }, { Name: 'Interchange', Enabled: true },
    { Name: 'InterchangeEditor', Enabled: true }, { Name: 'InterchangeAssets', Enabled: true },
  ],
};

/**
 * Create (or reuse) the scratch project under `cache`. Imports left by a killed run are
 * cleared so every run starts from an empty /Game/Verify.
 */
export async function scratchProject(cache: string): Promise<{ root: string; project: string; created: boolean }> {
  const root = join(cache, 'VerifyProject'), project = join(root, 'AgentMeshesVerify.uproject');
  const text = `${JSON.stringify(UPROJECT, null, 2)}\n`;
  let created = false;
  if ((await readFile(project, 'utf8').catch(() => '')) !== text) {
    await mkdir(join(root, 'Content'), { recursive: true }); await writeFile(project, text); created = true;
  }
  await rm(join(root, 'Content', 'Verify'), { recursive: true, force: true });
  return { root, project, created };
}

const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === 'EPERM'; } };

/** One verify-unreal run per scratch project. A lock whose owner process is gone is stale and replaced. */
export async function acquireProjectLock(dir: string, options: { waitMs?: number } = {}): Promise<() => Promise<void>> {
  const lock = join(dir, 'verify.lock'); const deadline = Date.now() + (options.waitMs ?? 600000);
  await mkdir(dir, { recursive: true });
  for (;;) {
    try {
      const handle = await open(lock, 'wx'); await handle.writeFile(JSON.stringify({ pid: process.pid, started: Date.now() })); await handle.close();
      return async () => { await rm(lock, { force: true }); };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    let owner = 0;
    try { owner = Number((JSON.parse(await readFile(lock, 'utf8')) as { pid?: number }).pid) || 0; } catch { /* half-written or unreadable */ }
    if (!owner || !alive(owner)) { await rm(lock, { force: true }); continue; }
    if (Date.now() >= deadline) throw Object.assign(new Error(`another verify-unreal run (pid ${owner}) is using ${dir}; wait for it or delete ${lock} if that process is not agent-meshes`), { code: 'UNREAL_BUSY' });
    await new Promise(done => setTimeout(done, 500));
  }
}

export interface ParsedUnrealLog { importErrors: string[]; importWarnings: string[]; otherErrors: string[]; interchangeCompleted: boolean; windowFound: boolean }

/** Pull `Error:`/`Warning:` lines out of a UE log, split into the import window and the rest. */
export function parseUnrealLog(text: string): ParsedUnrealLog {
  const result: ParsedUnrealLog = { importErrors: [], importWarnings: [], otherErrors: [], interchangeCompleted: false, windowFound: false };
  let state: 'before' | 'inside' | 'after' = 'before', sawEnd = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/^\[[^\]]*\]\[[^\]]*\]/, '').trim();
    if (/Warning\/Error Summary/.test(line)) break; // UE echoes every error again in its exit summary
    if (line.includes('AGENT_MESHES_IMPORT_BEGIN')) { state = 'inside'; continue; }
    if (line.includes('AGENT_MESHES_IMPORT_END')) { state = 'after'; sawEnd = true; continue; }
    if (/Interchange import completed/.test(line)) result.interchangeCompleted = true;
    const kind = /^\w+: Error: /.test(line) ? 'error' : /^\w+: Warning: /.test(line) ? 'warning' : null;
    if (!kind) continue;
    // Interchange keeps logging for the import (async asset builds) after the script's END marker.
    const importRelated = state === 'inside' || (state === 'after' && /^LogInterchange/.test(line));
    const bucket = importRelated ? (kind === 'error' ? result.importErrors : result.importWarnings) : kind === 'error' ? result.otherErrors : null;
    if (bucket && !bucket.includes(line)) bucket.push(line);
  }
  result.windowFound = sawEnd;
  return result;
}

export interface UnrealSkeletalMeshFacts {
  path: string; skeleton: string | null; morphTargets: string[]; bones: string[]; lods: number; vertices: number[]; materialSlots?: number;
  /** Whether the import kept vertex colors (COLOR_0, skin paint), and each slot's material and base material. */
  hasVertexColors?: boolean | null; materials?: ({ name: string; base?: string } | null)[];
  /** The mesh's reference skeleton: each bone mapped to its parent bone, null for the root. */
  boneParents?: Record<string, string | null>;
  /** Why `boneParents` could not be read. */
  boneParentsError?: string;
}
export interface UnrealRawReport {
  ok: boolean; engineVersion?: string; destination: string; importReturned: boolean; error?: string;
  assets: { path: string; class: string }[]; skeletalMeshes: UnrealSkeletalMeshFacts[]; staticMeshes: { path: string; lods: number; vertices: number[] }[];
}
/** What the GLB itself says before Unreal sees it: its morph name and skin audits, or why it could not be read. */
export interface UnrealPreflight { morphNames?: MorphNameAudit; skins?: SkinAudit; error?: string }
export interface UnrealReport {
  tool: 'agent-meshes verify-unreal'; ok: boolean; failures: string[]; input: string;
  /** Findings that did not fail this run, such as a pre-flight issue Unreal happened to tolerate. */
  warnings: string[];
  preflight: UnrealPreflight;
  unreal: { editor: string; version: string; engineVersion?: string; exitCode: number; timedOutAfterMs?: number };
  importer: 'Interchange'; verified: string; destination: string; importReturned: boolean; scriptError?: string;
  summary: { skeletalMeshes: number; skeletons: number; materials: number; textures: number; animations: number; staticMeshes: number };
  assetsByClass: Record<string, string[]>; skeletalMeshes: UnrealSkeletalMeshFacts[]; staticMeshes: UnrealRawReport['staticMeshes'];
  morphTargets: string[]; bones: string[];
  log: { file: string; importErrors: string[]; importWarnings: string[]; otherErrors: string[]; interchangeCompleted: boolean; windowFound: boolean };
  expectations?: { contract?: string; morphs: string[]; bones: string[]; parents?: Record<string, string | null> };
  /**
   * The GLB's rendered vertices (triangles' distinct vertices, from the pre-flight) against
   * LOD 0 of every SkeletalMesh and StaticMesh Unreal made. Absent when the GLB was unreadable.
   */
  geometry?: UnrealGeometry;
  elapsedMs: number;
}

export interface UnrealGeometry {
  glbVertices: number; unrealVertices: number;
  /** glbVertices - unrealVertices (negative when Unreal split vertices). */
  missing: number;
  /** How many missing vertices welding may explain before the check fails. */
  tolerance: number;
  /** Mesh nodes Interchange's default pipeline is known to drop (see interchangeDroppedMeshNodes). */
  droppedByInterchange: string[];
}

/**
 * Share of the GLB's (already welded, see gltf-skins.ts) vertices that may still go missing.
 * Derived from UE 5.7.3 runs on the P9a heads: SkeletalMeshes matched the pre-flight count
 * exactly (3360, 1152, 2208, 1104, and 146 for the repeated-vertex fixture sphere), and a
 * StaticMesh build welded 4 more of an eyeball's 1104 (0.36%); 1% leaves room for other meshes.
 */
export const UNREAL_WELD_TOLERANCE = 0.01;

/**
 * Mesh nodes that Interchange's default pipeline drops without a warning: in a file with at
 * least one skinned mesh, `bAutoDetectMeshType` sets `bIgnoreStaticMeshes`
 * (InterchangeGenericMeshPipeline.cpp, GetMeshesInformationFromTranslatedData, UE 5.7), so an
 * unskinned mesh with no morph targets that is not parented under a joint is thrown away.
 * A morph-bearing unskinned mesh still becomes its own SkeletalMesh, and a mesh parented to a
 * joint is merged into the rig's SkeletalMesh (both seen in UE 5.7.3 runs).
 */
export function interchangeDroppedMeshNodes(audit: SkinAudit): SkinAudit['meshNodes'] {
  if (!audit.meshNodes.some(n => n.skin !== null)) return [];
  return audit.meshNodes.filter(n => n.skin === null && n.morphTargets === 0 && n.jointAncestor === null && (n.vertices ?? 1) > 0);
}

/** What the GLB should import as: every node's vertices, except that an unskinned static mesh reused by several nodes is one StaticMesh. */
function expectedVertices(audit: SkinAudit): number | null {
  if (audit.vertices === null) return null;
  const counted = new Set<number>();
  return audit.meshNodes.reduce((sum, n) => {
    const shared = n.skin === null && n.morphTargets === 0 && n.jointAncestor === null;
    if (shared && counted.has(n.mesh)) return sum;
    counted.add(n.mesh);
    return sum + (n.vertices ?? 0);
  }, 0);
}

function geometryOf(raw: UnrealRawReport, audit: SkinAudit | undefined): UnrealGeometry | undefined {
  const glbVertices = audit ? expectedVertices(audit) : null;
  if (!audit || glbVertices === null) return undefined;
  const unrealVertices = [...raw.skeletalMeshes, ...raw.staticMeshes].reduce((sum, m) => sum + (m.vertices[0] ?? 0), 0);
  return {
    glbVertices, unrealVertices, missing: glbVertices - unrealVertices, tolerance: Math.ceil(glbVertices * UNREAL_WELD_TOLERANCE),
    droppedByInterchange: interchangeDroppedMeshNodes(audit).map(n => n.name ?? `node ${n.node}`),
  };
}

const union = (lists: string[][]) => [...new Set(lists.flat())];

export function buildUnrealReport(raw: UnrealRawReport, log: ParsedUnrealLog, run: { input: string; editor: string; version: string; exitCode: number; logFile: string; elapsedMs: number; /** Set when the run was stopped at this timeout. */ timeoutMs?: number; preflight?: UnrealPreflight }): UnrealReport {
  const assetsByClass: Record<string, string[]> = {};
  for (const asset of raw.assets) (assetsByClass[asset.class] ??= []).push(asset.path);
  const morphTargets = union(raw.skeletalMeshes.map(m => m.morphTargets));
  const preflight = run.preflight ?? {};
  const renamed = morphTargets.some(n => UE_FALLBACK_MORPH_NAME.test(n));
  const warnings = [
    ...(preflight.error ? [`pre-flight could not read the file: ${preflight.error}`] : []),
    ...(renamed ? [] : (preflight.morphNames?.issues ?? []).map(issue => `pre-flight: ${issue.message}`)),
    ...(preflight.skins && preflight.skins.vertices === null ? ["pre-flight could not read the GLB's vertex data (external buffers, sparse or Draco-compressed accessors), so geometry Unreal dropped is not checked"] : []),
  ];
  const count = (test: (cls: string) => boolean) => Object.entries(assetsByClass).filter(([cls]) => test(cls)).reduce((n, [, paths]) => n + paths.length, 0);
  return {
    tool: 'agent-meshes verify-unreal', ok: true, failures: [], input: run.input, warnings, preflight,
    unreal: { editor: run.editor, version: run.version, ...(raw.engineVersion ? { engineVersion: raw.engineVersion } : {}), exitCode: run.exitCode, ...(run.timeoutMs ? { timedOutAfterMs: run.timeoutMs } : {}) },
    importer: 'Interchange',
    verified: 'import only: Interchange created these assets headlessly (-nullrhi); nothing was rendered, animated or played at runtime',
    destination: raw.destination, importReturned: raw.importReturned, ...(raw.error ? { scriptError: raw.error } : {}),
    summary: {
      skeletalMeshes: count(c => c === 'SkeletalMesh'), skeletons: count(c => c === 'Skeleton'),
      materials: count(c => /^Material/.test(c) && c !== 'MaterialFunction'), textures: count(c => /^Texture/.test(c)),
      animations: count(c => /^Anim/.test(c)), staticMeshes: count(c => c === 'StaticMesh'),
    },
    assetsByClass, skeletalMeshes: raw.skeletalMeshes, staticMeshes: raw.staticMeshes,
    morphTargets, bones: union(raw.skeletalMeshes.map(m => m.bones)),
    log: { file: run.logFile, ...log },
    ...(() => { const geometry = geometryOf(raw, preflight.skins); return geometry ? { geometry } : {}; })(),
    elapsedMs: run.elapsedMs,
  };
}

export interface UnrealExpectations {
  morphs: string[]; bones: string[]; requireSkeletalMesh: boolean;
  /** The rig contract these names come from, used in messages. */
  contract?: string;
  /** Fail when Unreal made more than one SkeletalMesh or Skeleton (a single-skin head must make one of each). */
  singleSkeletalMesh?: boolean;
  /** Required bone parents: a bone mapped to its parent bone, or null for the skin's root joint. */
  parents?: Record<string, string | null>;
}

const quoted = (names: readonly string[], limit = 8) => names.slice(0, limit).map(n => `"${n}"`).join(', ') + (names.length > limit ? ` and ${names.length - limit} more` : '');
const assetName = (path: string) => `"${path.split('/').pop()}"`;
const plural = (n: number, word: string) => n === 1 ? word : `${word}${/h$/.test(word) ? 'es' : 's'}`;
const skinLabel = (skin: SkinAudit['skins'][number]) => `skin ${skin.skin}${skin.name ? ` "${skin.name}"` : ''}`;
const nodeName = (n: SkinAudit['meshNodes'][number]) => n.name ?? `node ${n.node}`;
const andList = (items: string[]) => items.length < 2 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
/** The skin that holds the rig: the one naming the most expected bones, then the one binding the most meshes. */
const rigSkin = (audit: SkinAudit, bones: string[]) => [...audit.skins].sort((a, b) =>
  bones.filter(j => b.joints.includes(j)).length - bones.filter(j => a.joints.includes(j)).length || b.usedBy.length - a.usedBy.length)[0];
/** The root Interchange adds above a skin with several root joints, named after the armature node. */
export const UNREAL_PROXY_ROOT = /_ProxyTrueRootJoint$/;

/**
 * Geometry that never reached Unreal: the GLB's rendered vertices against LOD 0 of every
 * SkeletalMesh and StaticMesh, with the cause when the pre-flight predicts Interchange's drop.
 */
function geometryFailure(report: UnrealReport, expect: UnrealExpectations): string | null {
  const g = report.geometry, audit = report.preflight?.skins;
  if (!g || !audit) return null;
  const dropped = interchangeDroppedMeshNodes(audit);
  const droppedVertices = dropped.reduce((sum, n) => sum + (n.vertices ?? 0), 0);
  const known = dropped.length > 0 && g.missing >= droppedVertices / 2;
  if (g.missing <= g.tolerance && !known) return null;
  const ue = [
    ...report.skeletalMeshes.map(m => `SkeletalMesh ${assetName(m.path)} ${m.vertices[0] ?? 0}`),
    ...(report.staticMeshes.length ? report.staticMeshes.map(m => `StaticMesh ${assetName(m.path)} ${m.vertices[0] ?? 0}`) : ['no StaticMesh']),
  ].join(', ');
  const head = `Unreal imported ${g.unrealVertices} of the GLB's ${g.glbVertices} vertices; ${g.missing} are missing`;
  if (!known) {
    return `${head} (more than the ${g.tolerance} welding can explain). GLB mesh nodes: ${audit.meshNodes.map(n => `"${nodeName(n)}" ${n.vertices}`).join(', ')}; Unreal: ${ue}. Look for the mesh Interchange skipped in ${report.log.file}.`;
  }
  const one = dropped.length === 1;
  const rig = rigSkin(audit, expect.bones);
  const eyes = expect.contract === ARKIT_FACE_CONTRACT ? `; under ${expect.contract}, weight each eyeball 100% to its eye bone (eye_L, eye_R)` : '';
  return `${head} (Unreal: ${ue}). Cause: the mesh ${one ? 'node' : 'nodes'} ${dropped.map(n => `"${nodeName(n)}" (${n.vertices} vertices)`).join(', ')} ${one ? 'is' : 'are'} not bound to the skin (the node has no "skin", no morph targets and no skin joint above it). In a GLB with skinned meshes, Interchange's default pipeline drops every such static mesh without a warning (bAutoDetectMeshType sets bIgnoreStaticMeshes in InterchangeGenericMeshPipeline.cpp), so ${one ? 'it' : 'they'} never reached Unreal. Fix: bind ${one ? 'it' : 'them'} to ${skinLabel(rig)} (joints ${quoted(rig.joints)})${eyes}.`;
}

/**
 * Bones whose parent breaks `expect.parents`, read from the target SkeletalMesh's reference
 * skeleton (Interchange's proxy root above a root bone is allowed), or from the GLB's rig skin
 * when Unreal gave no parents. The GLB's joint parents are given as the cause.
 */
function hierarchyFailure(report: UnrealReport, expect: UnrealExpectations, target: UnrealSkeletalMeshFacts | null, what: string): string | null {
  const wanted = Object.entries(expect.parents ?? {});
  if (!wanted.length) return null;
  const audit = report.preflight?.skins;
  const rig = audit?.skins.length ? rigSkin(audit, expect.bones) : undefined;
  const glbWrong = (bone: string, want: string | null) => {
    if (!rig || !(bone in rig.jointParents)) return false;
    const got = rig.jointParents[bone];
    return want === null ? got !== null && rig.joints.includes(got) : got !== want;
  };
  const seen = target?.boneParents ?? null;
  const problems = wanted.filter(([bone, want]) => {
    if (!seen) return glbWrong(bone, want);
    if (!(bone in seen)) return false; // a missing bone is reported on its own
    const got = seen[bone];
    return want === null ? got !== null && !UNREAL_PROXY_ROOT.test(got) : got !== want;
  });
  if (!problems.length) return null;
  const inGlb = problems.filter(([bone, want]) => glbWrong(bone, want));
  const glbSentence = rig && inGlb.length
    ? `${skinLabel(rig)} parents ${andList(inGlb.map(([bone]) => rig.jointParents[bone] === null ? `"${bone}" at the scene root` : `"${bone}" to "${rig.jointParents[bone]}"`))}${rig.roots.length > 1 ? `, so the skin has ${rig.roots.length} root joints (${quoted(rig.roots)})` : ''}`
    : '';
  let text: string;
  if (seen) {
    const parts = problems.map(([bone, want]) => {
      const got = seen[bone];
      return `"${bone}" is ${got === null ? 'a root bone' : `a child of "${got}"`}, ${want === null ? 'not the root' : `not of "${want}"`}`;
    });
    text = `in SkeletalMesh ${assetName(target!.path)}, ${parts.join('; ')}.`;
    text += glbSentence ? ` In the GLB, ${glbSentence}.` : rig ? " The GLB's skin has the expected parents, so Interchange changed the hierarchy." : '';
    const proxy = [...new Set(problems.map(([bone]) => seen[bone]).filter((p): p is string => p !== null && UNREAL_PROXY_ROOT.test(p)))];
    if (proxy.length) text += ` ${quoted(proxy)} is the root Interchange adds above a skin with several root joints.`;
  } else {
    text = `in the GLB, ${glbSentence}.`;
  }
  const byParent = new Map<string | null, string[]>();
  for (const [bone, want] of problems) byParent.set(want, [...(byParent.get(want) ?? []), bone]);
  const fixes = [...byParent].map(([want, bones]) => want === null ? `make ${andList(bones.map(b => `"${b}"`))} the skin's only root joint` : `parent ${andList(bones.map(b => `"${b}"`))} to "${want}"`);
  return `wrong bone hierarchy for ${what}: ${text} Fix: ${fixes.join(', and ')} (in Blender, set the bone's parent in the armature).`;
}

/**
 * Why the GLB's skinning makes Unreal split the rig from the morphs, read from the skin
 * audit: no skin at all, a morph-bearing mesh node left out of the skin, or meshes bound to
 * different skins. Interchange builds one SkeletalMesh and Skeleton per skin, and gives an
 * unskinned mesh with morphs its own SkeletalMesh on a made-up one-bone skeleton. Null
 * when one skin binds every morph-bearing node.
 */
export function skinStructureCause(audit: SkinAudit | undefined, bones: string[]): { cause: string; madeUpBones: boolean } | null {
  if (!audit) return null;
  const node = (n: SkinAudit['meshNodes'][number]) => `"${n.meshName ?? `mesh ${n.mesh}`}" (node "${n.name ?? n.node}")`;
  const joints = bones.length ? ` with joints ${quoted(bones)}` : '';
  const morphNodes = audit.meshNodes.filter(n => n.morphTargets > 0);
  if (!audit.skins.length) {
    const which = morphNodes.length ? ` ${morphNodes.map(node).join(', ')}` : '';
    return { madeUpBones: true, cause: `the GLB has no skin, so Interchange gave the morph-bearing mesh${which} a made-up one-bone skeleton named after its node, and imported the unskinned meshes without morphs as StaticMeshes; add one skin${joints} and bind every mesh to it` };
  }
  const unskinned = morphNodes.filter(n => n.skin === null);
  if (unskinned.length) {
    const rig = [...audit.skins].sort((a, b) => bones.filter(j => b.joints.includes(j)).length - bones.filter(j => a.joints.includes(j)).length)[0];
    const target = bones.some(j => rig.joints.includes(j)) ? `the skin with those joints (${skinLabel(rig)}: ${quoted(rig.joints)})` : `one skin${joints}`;
    const one = unskinned.length === 1;
    return { madeUpBones: true, cause: `the morph-bearing glTF ${one ? 'mesh' : 'meshes'} ${unskinned.map(node).join(', ')} ${one ? 'is' : 'are'} not skinned (the node has no "skin"), so Interchange imported ${one ? 'it as its own SkeletalMesh' : 'each as its own SkeletalMesh'} on a made-up one-bone skeleton, apart from the rig; bind ${one ? 'it' : 'them'} to ${target}` };
  }
  const used = audit.skins.filter(skin => skin.usedBy.length);
  if (used.length > 1) {
    return { madeUpBones: false, cause: `the GLB binds its meshes to ${used.length} different skins (${used.map(skin => `${skinLabel(skin)}: joints ${quoted(skin.joints)}, used by ${quoted(skin.usedBy)}`).join('; ')}), and Interchange builds a separate SkeletalMesh and Skeleton per skin; bind every mesh to one skin${joints}` };
  }
  return null;
}

/**
 * Every way the import falls short of the expectations; empty means it passed. Names must
 * match verbatim, and every expected morph and bone must be on ONE SkeletalMesh: a morph on
 * one asset and a bone on another do not make a rig.
 */
export function checkUnrealReport(report: UnrealReport, expect: UnrealExpectations): string[] {
  return reviewUnrealReport(report, expect).failures;
}

/**
 * Failures (see checkUnrealReport) plus warnings: findings that do not fail the run, such as
 * a GLB with several skins that Unreal merged into one correct SkeletalMesh anyway.
 */
export function reviewUnrealReport(report: UnrealReport, expect: UnrealExpectations): { failures: string[]; warnings: string[] } {
  const failures: string[] = [], warnings: string[] = [];
  const only = (failure: string) => ({ failures: [failure], warnings });
  if (report.unreal.timedOutAfterMs) return only(`Unreal did not finish within ${Number((report.unreal.timedOutAfterMs / 1000).toFixed(3))} s and was stopped; see ${report.log.file}`);
  if (!report.log.windowFound) return only('the import script never ran (no AGENT_MESHES_IMPORT_BEGIN/END in the log)');
  if (report.scriptError) return only(`import script failed: ${report.scriptError.trim()}`);
  const errors = report.log.importErrors;
  if (!Object.keys(report.assetsByClass).length) {
    // Nothing to compare names against: listing every expected name as missing would only bury the cause.
    const code = report.unreal.exitCode ? ` (exit code ${report.unreal.exitCode})` : '';
    return only(`Unreal imported nothing${code}: ${errors.length ? errors.join(' | ') : `no import error was logged; see ${report.log.file}`}`);
  }
  if (report.unreal.exitCode !== 0) failures.push(`Unreal exited with code ${report.unreal.exitCode}`);
  if (expect.requireSkeletalMesh && !report.skeletalMeshes.length) failures.push(`no SkeletalMesh was created (assets: ${Object.keys(report.assetsByClass).join(', ') || 'none'})`);
  const audit = report.preflight?.morphNames;
  const glbNames = audit ? new Set(audit.names) : null;
  const renamed = report.morphTargets.filter(n => UE_FALLBACK_MORPH_NAME.test(n));
  if (renamed.length) {
    const how = renamed.length === report.morphTargets.length ? 'every morph target' : `${renamed.length} of ${report.morphTargets.length} morph targets`;
    const cause = audit?.issues.length ? `Cause: ${audit.issues.map(i => i.message).join(' ')}`
      : audit ? `The pre-flight audit found no name problem UE's glTF parser (GLTFAsset.cpp) is known to reject; see ${report.log.file}.`
        : `The GLB could not be audited. UE's glTF parser (GLTFAsset.cpp) does this when a morph name repeats across glTF meshes (then it drops every name in the file), repeats within a mesh, or a mesh's extras.targetNames count differs from its targets; if parts share morph names, ${SHARED_MORPH_FIX}.`;
    failures.push(`Unreal renamed ${how} to <file>_mesh_<m>_<i>_MorphTarget (for example "${renamed[0]}"), so those glTF morph names did not survive. ${cause}`);
  }
  // Checked against ONE SkeletalMesh: the one carrying the most expected morphs, then the most expected bones.
  const meshes = report.skeletalMeshes;
  const hits = (m: UnrealSkeletalMeshFacts) => [expect.morphs.filter(n => m.morphTargets.includes(n)).length, expect.bones.filter(n => m.bones.includes(n)).length];
  const target = meshes.reduce<UnrealSkeletalMeshFacts | null>((best, m) => {
    if (!best) return m;
    const [a, b] = hits(m), [c, d] = hits(best);
    return a > c || (a === c && b > d) ? m : best;
  }, null);
  const haveMorphs = target?.morphTargets ?? report.morphTargets, haveBones = target?.bones ?? report.bones;
  const what = expect.contract ? `the ${expect.contract} contract` : 'the expected names';
  const skins = report.preflight?.skins;
  const structure = skinStructureCause(skins, expect.bones);
  const becauseOf = structure ? ` Cause: ${structure.cause}.` : '';
  const elsewhere = (names: string[], key: 'morphTargets' | 'bones') => names.filter(n => meshes.some(m => m !== target && m[key].includes(n)));
  const missingBones = expect.bones.filter(n => !haveBones.includes(n));
  const splitMorphs = elsewhere(expect.morphs.filter(n => !haveMorphs.includes(n)), 'morphTargets'), splitBones = elsewhere(missingBones, 'bones');
  const explained = new Set<string>();
  const split = Boolean(target && (splitMorphs.length || splitBones.length));
  if (target && split) {
    const holders = meshes.filter(m => m !== target && (splitMorphs.some(n => m.morphTargets.includes(n)) || splitBones.some(n => m.bones.includes(n))));
    const [morphHits] = hits(target);
    const carrier = expect.morphs.length
      ? `SkeletalMesh ${assetName(target.path)} has ${morphHits} of the ${expect.morphs.length} morph targets, but its skeleton has only the ${plural(target.bones.length, 'bone')} ${quoted(target.bones)}`
      : `SkeletalMesh ${assetName(target.path)} has the ${plural(target.bones.length, 'bone')} ${quoted(target.bones)}`;
    const moved = [...splitMorphs, ...splitBones];
    const rig = splitBones.length && morphHits ? ', so the rig cannot move the morph-bearing mesh in Unreal' : '';
    failures.push(`no single SkeletalMesh carries ${what}: ${carrier}, while ${quoted(moved)} ${moved.length === 1 ? 'is' : 'are'} on ${holders.map(m => `SkeletalMesh ${assetName(m.path)}`).join(', ')}, a separate asset with its own skeleton${rig}.${becauseOf}`);
    for (const n of moved) explained.add(n);
    if (structure) for (const n of missingBones) explained.add(n);
  } else if (target && missingBones.length && structure) {
    const made = structure.madeUpBones ? ', which Interchange made up from the mesh node' : '';
    failures.push(`missing ${plural(missingBones.length, 'bone')} ${quoted(missingBones)}: SkeletalMesh ${assetName(target.path)} has only the ${plural(target.bones.length, 'bone')} ${quoted(target.bones)}${made}. Cause: ${structure.cause}.`);
    for (const n of missingBones) explained.add(n);
  }
  const skinJoints = skins ? new Set(skins.skins.flatMap(skin => skin.joints)) : null;
  const missing = (kind: 'morph target' | 'bone', wanted: string[], have: string[], inFile: Set<string> | null) => {
    for (const name of wanted) {
      if (have.includes(name) || explained.has(name)) continue;
      // Already explained by the rename failure above.
      if (kind === 'morph target' && renamed.length && (!inFile || inFile.has(name))) continue;
      const near = have.find(h => h.toLowerCase() === name.toLowerCase());
      const absent = kind === 'bone' ? ' (the GLB has no skin joint with this name)' : ` (the GLB has no ${kind} with this name)`;
      const kept = kind === 'bone' ? '' : ' (the GLB has it; Unreal drops a morph that moves no triangle vertex)';
      const why = near ? ` (Unreal has "${near}": names must survive verbatim)` : !inFile ? '' : inFile.has(name) ? kept : absent;
      failures.push(`missing ${kind} "${name}"${why}`);
    }
  };
  missing('morph target', expect.morphs, haveMorphs, glbNames);
  missing('bone', expect.bones, haveBones, skinJoints);
  if (expect.singleSkeletalMesh && !split && (meshes.length > 1 || report.summary.skeletons > 1)) {
    failures.push(`Unreal created ${meshes.length} ${plural(meshes.length, 'SkeletalMesh')} (${meshes.map(m => assetName(m.path)).join(', ')}) and ${report.summary.skeletons} ${plural(report.summary.skeletons, 'Skeleton')}, but ${what} needs one SkeletalMesh on one Skeleton, from a single glTF skin.${becauseOf}`);
  }
  const lost = geometryFailure(report, expect);
  if (lost) failures.push(lost);
  const hierarchy = hierarchyFailure(report, expect, target, what);
  if (hierarchy) failures.push(hierarchy);
  const used = skins?.skins.filter(skin => skin.usedBy.length) ?? [];
  if (used.length > 1 && meshes.length === 1 && report.summary.skeletons <= 1) {
    warnings.push(`pre-flight: the GLB binds its meshes to ${used.length} skins (${used.map(skin => `${skinLabel(skin)}: joints ${quoted(skin.joints)}, used by ${quoted(skin.usedBy)}`).join('; ')}). Unreal merged them into one SkeletalMesh here, but ${expect.contract ? `the ${expect.contract} contract asks for a single skin, and ` : ''}other importers may keep one skeleton per skin; bind every mesh to one skin.`);
  }
  if (errors.length) failures.push(`${report.log.importErrors.length} import error(s): ${report.log.importErrors.join(' | ')}`);
  return { failures, warnings };
}

export interface VerifyUnrealOptions extends UnrealExpectations {
  contract?: string; timeoutMs?: number; logFile?: string; cacheDir?: string; quiet?: boolean;
  /** Progress lines go here (stderr by default). */
  progress?: (line: string) => void;
}

function killTree(pid: number) {
  if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
  else try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ }
}

async function pruneLogs(dir: string, keep: number) {
  const files = (await readdir(dir).catch(() => [] as string[])).filter(f => /^verify-.*\.log$/.test(f)).sort();
  for (const file of files.slice(0, Math.max(0, files.length - keep))) await rm(join(dir, file), { force: true });
}

/** Import `glb` into a scratch Unreal project through Interchange and check it. Throws when Unreal is absent. */
export async function verifyUnreal(glb: string, options: VerifyUnrealOptions): Promise<UnrealReport> {
  const input = resolve(glb);
  await stat(input).catch(() => { throw Object.assign(new Error(`GLB not found: ${input}`), { code: 'CLI_ARGUMENT_ERROR' }); });
  const bytes = new Uint8Array(await readFile(input));
  let preflight: UnrealPreflight;
  try { preflight = { morphNames: auditMorphNames(bytes), skins: auditSkins(bytes) }; } catch (error) { preflight = { error: (error as Error).message }; }
  const unreal = findUnreal();
  if (!unreal) {
    const found = preflight.morphNames?.issues.map(i => i.message) ?? [];
    throw Object.assign(new Error(`Unreal Engine was not found. Install UE 5.x or set AGENT_MESHES_UNREAL to the engine directory (for example C:/Program Files/Epic Games/UE_5.7). Searched: ${defaultUnrealRoots().join(', ')}${found.length ? `. The pre-flight check (no engine needed) already found: ${found.join(' ')}` : ''}`), { code: 'UNREAL_NOT_FOUND', preflight });
  }
  const say = options.quiet ? () => {} : (options.progress ?? ((line: string) => { process.stderr.write(`verify-unreal: ${line}\n`); }));
  const cache = options.cacheDir ?? join(defaultUnrealCache(), unreal.version);
  await mkdir(cache, { recursive: true });
  const release = await acquireProjectLock(cache);
  const runId = `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`;
  const work = join(tmpdir(), `agent-meshes-unreal-${runId}`);
  let child: ReturnType<typeof spawn> | undefined;
  const onSignal = () => { if (child?.pid) killTree(child.pid); };
  process.once('SIGINT', onSignal); process.once('SIGTERM', onSignal);
  try {
    const { root, project, created } = await scratchProject(cache);
    const logDir = join(cache, 'Logs'); await mkdir(logDir, { recursive: true }); await pruneLogs(logDir, 20);
    const logFile = options.logFile ? resolve(options.logFile) : join(logDir, `verify-${runId}.log`);
    await mkdir(dirname(logFile), { recursive: true }); await mkdir(work, { recursive: true });
    const assetName = unrealImportName(input);
    // A self-contained .glb is imported from a copy named like the asset; a .gltf keeps its
    // relative buffer and image URIs, so it is imported in place.
    const source = /\.glb$/i.test(input) ? join(work, `${assetName}.glb`) : input;
    if (source !== input) await writeFile(source, bytes);
    const request = join(work, 'request.json'), reportPath = join(work, 'report.json');
    await writeFile(request, JSON.stringify({ glb: slashes(source), destination: `/Game/Verify/${assetName}`, report: slashes(reportPath) }));
    const script = fileURLToPath(new URL('../scripts/unreal-verify-import.py', import.meta.url));
    const args = unrealCommandLine({ project, script, log: logFile });
    say(`Unreal ${unreal.version} at ${unreal.editor}`);
    say(`${created ? 'created' : 'reusing'} scratch project ${root}; log ${logFile}`);
    say('starting headless import; the first run can spend several minutes compiling shaders and filling the DDC');
    const started = Date.now(), timeoutMs = options.timeoutMs ?? 30 * 60000;
    child = spawn(unreal.editor, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, env: { ...process.env, AGENT_MESHES_UNREAL_REQUEST: slashes(request) } });
    let last = '', shown = '';
    const watch = (chunk: Buffer) => {
      for (const line of chunk.toString().split(/\r?\n/)) {
        const text = line.replace(/^\[[^\]]*\]\[[^\]]*\]/, '').trim();
        if (/Shaders left to compile|Interchange|AGENT_MESHES|Error:|LogInit: Display: Engine is initialized|Python script executed/.test(text)) last = text.slice(0, 200);
      }
    };
    child.stdout?.on('data', watch); child.stderr?.on('data', watch);
    const heartbeat = setInterval(() => { if (last !== shown) { shown = last; } say(`${Math.round((Date.now() - started) / 1000)} s elapsed${shown ? `: ${shown}` : ''}`); }, 15000);
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; if (child?.pid) killTree(child.pid); }, timeoutMs);
    const exitCode = await new Promise<number>(done => { child!.on('error', () => done(-1)); child!.on('exit', code => done(code ?? -1)); });
    clearTimeout(timer); clearInterval(heartbeat);
    const elapsedMs = Date.now() - started;
    say(`Unreal exited with code ${exitCode} after ${Math.round(elapsedMs / 1000)} s`);
    const logText = await readFile(logFile, 'utf8').catch(() => '');
    let raw: UnrealRawReport;
    try { raw = JSON.parse(await readFile(reportPath, 'utf8')) as UnrealRawReport; } catch {
      raw = { ok: false, destination: `/Game/Verify/${assetName}`, importReturned: false, assets: [], skeletalMeshes: [], staticMeshes: [],
        error: `Unreal wrote no report (exit code ${exitCode}); see ${logFile}` };
    }
    // Unreal logs the sanitized copy's temp path; show the user's file instead.
    const report = buildUnrealReport(raw, parseUnrealLog(logText.split(slashes(source)).join(slashes(input))), { input, editor: unreal.editor, version: unreal.version, exitCode, logFile, elapsedMs, preflight, ...(timedOut ? { timeoutMs } : {}) });
    const review = reviewUnrealReport(report, options);
    report.failures = review.failures; report.warnings.push(...review.warnings);
    report.ok = report.failures.length === 0;
    report.expectations = { ...(options.contract ? { contract: options.contract } : {}), morphs: options.morphs, bones: options.bones, ...(options.parents && Object.keys(options.parents).length ? { parents: options.parents } : {}) };
    await rm(join(root, 'Content', 'Verify'), { recursive: true, force: true });
    return report;
  } finally {
    process.off('SIGINT', onSignal); process.off('SIGTERM', onSignal);
    if (child?.pid && child.exitCode === null && child.signalCode === null) killTree(child.pid);
    await rm(work, { recursive: true, force: true });
    await release();
  }
}

/** Whether an Unreal install can be found (integration tests skip without one). */
export const unrealAvailable = () => { try { return findUnreal() !== null; } catch { return false; } };
