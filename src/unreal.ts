import { spawn, spawnSync } from 'node:child_process';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { mkdir, open, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

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
  return [slashes(paths.project), '-run=pythonscript', `-script=${slashes(paths.script)}`, '-unattended', '-nullrhi', '-nosplash', '-nopause', '-nosound', '-stdout', '-FullStdOutLogOutput', `-abslog=${slashes(paths.log)}`];
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

export interface UnrealSkeletalMeshFacts { path: string; skeleton: string | null; morphTargets: string[]; bones: string[]; lods: number; vertices: number[]; materialSlots?: number }
export interface UnrealRawReport {
  ok: boolean; engineVersion?: string; destination: string; importReturned: boolean; error?: string;
  assets: { path: string; class: string }[]; skeletalMeshes: UnrealSkeletalMeshFacts[]; staticMeshes: { path: string; lods: number; vertices: number[] }[];
}
export interface UnrealReport {
  tool: 'agent-meshes verify-unreal'; ok: boolean; failures: string[]; input: string;
  unreal: { editor: string; version: string; engineVersion?: string; exitCode: number; timedOutAfterMs?: number };
  importer: 'Interchange'; verified: string; destination: string; importReturned: boolean; scriptError?: string;
  summary: { skeletalMeshes: number; skeletons: number; materials: number; textures: number; animations: number; staticMeshes: number };
  assetsByClass: Record<string, string[]>; skeletalMeshes: UnrealSkeletalMeshFacts[]; staticMeshes: UnrealRawReport['staticMeshes'];
  morphTargets: string[]; bones: string[];
  log: { file: string; importErrors: string[]; importWarnings: string[]; otherErrors: string[]; interchangeCompleted: boolean; windowFound: boolean };
  expectations?: { contract?: string; morphs: string[]; bones: string[] };
  elapsedMs: number;
}

const union = (lists: string[][]) => [...new Set(lists.flat())];

export function buildUnrealReport(raw: UnrealRawReport, log: ParsedUnrealLog, run: { input: string; editor: string; version: string; exitCode: number; logFile: string; elapsedMs: number; /** Set when the run was stopped at this timeout. */ timeoutMs?: number }): UnrealReport {
  const assetsByClass: Record<string, string[]> = {};
  for (const asset of raw.assets) (assetsByClass[asset.class] ??= []).push(asset.path);
  const count = (test: (cls: string) => boolean) => Object.entries(assetsByClass).filter(([cls]) => test(cls)).reduce((n, [, paths]) => n + paths.length, 0);
  return {
    tool: 'agent-meshes verify-unreal', ok: true, failures: [], input: run.input,
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
    morphTargets: union(raw.skeletalMeshes.map(m => m.morphTargets)), bones: union(raw.skeletalMeshes.map(m => m.bones)),
    log: { file: run.logFile, ...log }, elapsedMs: run.elapsedMs,
  };
}

export interface UnrealExpectations { morphs: string[]; bones: string[]; requireSkeletalMesh: boolean }

/** Every way the import falls short of the expectations; empty means it passed. Names must match verbatim. */
export function checkUnrealReport(report: UnrealReport, expect: UnrealExpectations): string[] {
  const failures: string[] = [];
  if (report.unreal.timedOutAfterMs) return [`Unreal did not finish within ${Math.round(report.unreal.timedOutAfterMs / 1000)} s and was stopped; see ${report.log.file}`];
  if (!report.log.windowFound) return ['the import script never ran (no AGENT_MESHES_IMPORT_BEGIN/END in the log)'];
  if (report.scriptError) return [`import script failed: ${report.scriptError.trim()}`];
  if (report.unreal.exitCode !== 0) failures.push(`Unreal exited with code ${report.unreal.exitCode}`);
  if (expect.requireSkeletalMesh && !report.skeletalMeshes.length) failures.push(`no SkeletalMesh was created (assets: ${Object.keys(report.assetsByClass).join(', ') || 'none'})`);
  const missing = (kind: string, wanted: string[], have: string[]) => {
    for (const name of wanted) {
      if (have.includes(name)) continue;
      const near = have.find(h => h.toLowerCase() === name.toLowerCase());
      failures.push(`missing ${kind} "${name}"${near ? ` (Unreal has "${near}": names must survive verbatim)` : ''}`);
    }
  };
  missing('morph target', expect.morphs, report.morphTargets);
  missing('bone', expect.bones, report.bones);
  if (report.log.importErrors.length) failures.push(`${report.log.importErrors.length} import error(s): ${report.log.importErrors.join(' | ')}`);
  return failures;
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
  const unreal = findUnreal();
  if (!unreal) throw Object.assign(new Error(`Unreal Engine was not found. Install UE 5.x or set AGENT_MESHES_UNREAL to the engine directory (for example C:/Program Files/Epic Games/UE_5.7). Searched: ${defaultUnrealRoots().join(', ')}`), { code: 'UNREAL_NOT_FOUND' });
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
    const assetName = basename(input).replace(/\.[^.]+$/, '').replace(/[^A-Za-z0-9_]/g, '_').replace(/^(\d)/, '_$1') || 'Model';
    const request = join(work, 'request.json'), reportPath = join(work, 'report.json');
    await writeFile(request, JSON.stringify({ glb: slashes(input), destination: `/Game/Verify/${assetName}`, report: slashes(reportPath) }));
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
    const report = buildUnrealReport(raw, parseUnrealLog(logText), { input, editor: unreal.editor, version: unreal.version, exitCode, logFile, elapsedMs, ...(timedOut ? { timeoutMs } : {}) });
    report.failures = checkUnrealReport(report, options);
    report.ok = report.failures.length === 0;
    report.expectations = { ...(options.contract ? { contract: options.contract } : {}), morphs: options.morphs, bones: options.bones };
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
