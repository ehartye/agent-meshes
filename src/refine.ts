import { spawn } from 'node:child_process';
import { access, readFile, rm, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { accessSync, constants, lstatSync, readdirSync } from 'node:fs';
import { BlenderVersionError, blenderVersionMessage, isSupportedBlenderVersion, readBlenderVersion, type RejectedBlender } from './blender-version.ts';

/**
 * Optional Blender stage: subdivide, smooth and displace a GLB while keeping its skeleton and
 * clips. Blender is never required, but when it is used it must be the 5.2 LTS series; `findBlender` says whether the stage is available.
 */
export type BlenderSource = 'AGENT_MESHES_BLENDER' | 'agent-meshes-home' | 'tools-blender' | 'program-files' | 'windows-store' | 'applications' | 'path';
export interface BlenderLocation {
  command: string;
  /** The Windows Store launcher exits at once, so completion is read from a sentinel file. */
  detached: boolean;
  /** Which discovery rule found it, so `setup --check` can say where Blender came from. */
  source: BlenderSource;
}
export interface FindBlenderOptions { env?: NodeJS.ProcessEnv; platform?: NodeJS.Platform; home?: string; /** Replaces `blender --version`, for tests. */ readVersion?: (command: string) => string | null }

/** Version-like directory names sort newest first (`blender-5.2.2-...` before `blender-4.5.0-...`). */
function newestFirst(names: string[]): string[] {
  const version = (name: string) => (/(\d+(?:\.\d+)+)/.exec(name)?.[1] ?? '0').split('.').map(Number);
  return [...names].sort((a, b) => {
    const [x, y] = [version(a), version(b)];
    for (let i = 0; i < Math.max(x.length, y.length); i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (y[i] ?? 0) - (x[i] ?? 0);
    return b.localeCompare(a);
  });
}

/** A portable Blender is an unzipped release folder: `<root>/<blender-x.y.z-platform>/blender(.exe)` (macOS: Blender.app inside it). */
function portableCandidates(root: string, platform: NodeJS.Platform, source: BlenderSource): BlenderLocation[] {
  let names: string[];
  try { names = readdirSync(root); } catch { return []; }
  const executables = platform === 'win32' ? ['blender.exe'] : platform === 'darwin' ? ['Blender.app/Contents/MacOS/Blender', 'Contents/MacOS/Blender'] : ['blender'];
  return newestFirst(names).flatMap(dir => executables.map(exe => ({ command: join(root, dir, exe), detached: false, source })));
}

/**
 * Every Blender install that exists on this machine, in discovery order: a portable copy under `<managed home>/blender/*`
 * (default `~/.agent-meshes/blender`), a portable copy under `~/tools/blender/*`, the usual system installs, then PATH. Portable
 * folders come before system installs because putting one there is a deliberate choice (the installers can be blocked by a bot
 * challenge). Folders are newest version first.
 */
function installedCandidates(env: NodeJS.ProcessEnv, platform: NodeJS.Platform, home: string): BlenderLocation[] {
  const candidates: BlenderLocation[] = [];
  candidates.push(...portableCandidates(join(env.AGENT_MESHES_HOME ? resolve(env.AGENT_MESHES_HOME) : join(home, '.agent-meshes'), 'blender'), platform, 'agent-meshes-home'));
  candidates.push(...portableCandidates(join(home, 'tools', 'blender'), platform, 'tools-blender'));
  if (platform === 'win32') {
    for (const root of ['C:/Program Files/Blender Foundation', 'C:/Program Files (x86)/Blender Foundation']) {
      try { for (const dir of newestFirst(readdirSync(root))) candidates.push({ command: join(root, dir, 'blender.exe'), detached: false, source: 'program-files' }); } catch { /* not installed there */ }
    }
    const apps = join(home, 'AppData/Local/Microsoft/WindowsApps');
    try { for (const dir of readdirSync(apps)) if (/^BlenderFoundation\.Blender/i.test(dir)) candidates.push({ command: join(apps, dir, 'blender-launcher.exe'), detached: true, source: 'windows-store' }); } catch { /* no store apps */ }
  } else if (platform === 'darwin') candidates.push({ command: '/Applications/Blender.app/Contents/MacOS/Blender', detached: false, source: 'applications' });
  for (const dir of (env.PATH ?? '').split(platform === 'win32' ? ';' : ':')) if (dir) candidates.push({ command: join(dir, platform === 'win32' ? 'blender.exe' : 'blender'), detached: false, source: 'path' });
  // A Store app's launcher is an execution alias: stat refuses it, lstat calls it a link, access allows it.
  return candidates.filter(candidate => {
    try { if (lstatSync(candidate.command).isDirectory()) return false; accessSync(candidate.command, constants.X_OK); return true; } catch { return false; }
  });
}

export interface BlenderInspection {
  /** The supported Blender; or, when none qualifies, the first rejected one (so a check can name it); null when nothing is installed. */
  location: BlenderLocation | null;
  version: string | null;
  supported: boolean;
  rejected: RejectedBlender[];
  /** The one error to show when `location` exists but is not the supported series. */
  message?: string;
}

/** Find Blender and say whether it is the supported series, without throwing. `findBlender` is the throwing form. */
export function inspectBlender(options: FindBlenderOptions = {}): BlenderInspection {
  const env = options.env ?? process.env, platform = options.platform ?? process.platform, home = options.home ?? homedir();
  const read = options.readVersion ?? ((command: string) => readBlenderVersion(command));
  const reject = (found: BlenderLocation[], explicit: boolean): BlenderInspection => {
    const rejected = found.map(location => ({ command: location.command, version: read(location.command) }));
    return { location: found[0], version: rejected[0].version, supported: false, rejected, message: blenderVersionMessage(rejected, explicit) };
  };
  const explicit = env.AGENT_MESHES_BLENDER;
  if (explicit) {
    // An explicit choice is never swapped for another install.
    const location: BlenderLocation = { command: explicit, detached: /blender-launcher/i.test(explicit), source: 'AGENT_MESHES_BLENDER' };
    const version = read(explicit);
    return isSupportedBlenderVersion(version) ? { location, version, supported: true, rejected: [] } : reject([location], true);
  }
  const candidates = installedCandidates(env, platform, home);
  const rejected: BlenderLocation[] = [];
  for (const candidate of candidates) {
    const version = read(candidate.command);
    if (isSupportedBlenderVersion(version)) return { location: candidate, version, supported: true, rejected: rejected.map(item => ({ command: item.command, version: read(item.command) })) };
    rejected.push(candidate);
  }
  return rejected.length ? reject(rejected, false) : { location: null, version: null, supported: false, rejected: [] };
}

/**
 * Find a Blender in the supported series (5.2 LTS), or null when none is installed. Throws a BlenderVersionError when Blender is
 * installed but no copy qualifies, or when AGENT_MESHES_BLENDER names one that does not; it never substitutes another install.
 */
export function findBlender(options: FindBlenderOptions = {}): BlenderLocation | null {
  const found = inspectBlender(options);
  if (found.message) throw new BlenderVersionError(found.message);
  return found.location;
}

export interface RefineOptions { subdivide?: number; noise?: number; noiseScale?: number; only?: string[]; timeoutMs?: number }
export interface RefineResult { output: string; bytes: number; meshes: number; blender: string }

/** Run scripts/blender-refine.py on a GLB. Throws if Blender is not installed or the stage fails. */
export async function refineGLB(input: string, output: string, options: RefineOptions = {}): Promise<RefineResult> {
  const blender = findBlender();
  if (!blender) throw new Error('Blender is not installed; the refine stage is optional and was skipped. Install Blender 5.2 LTS from https://www.blender.org/download/ or set AGENT_MESHES_BLENDER to its executable to enable it.');
  const script = fileURLToPath(new URL('../scripts/blender-refine.py', import.meta.url));
  const out = resolve(output), sentinel = `${out}.done`;
  await rm(sentinel, { force: true }); await rm(out, { force: true });
  const args = ['-b', '--python', script, '--', resolve(input), out, '--subdivide', String(options.subdivide ?? 1), '--noise', String(options.noise ?? 0), '--noise-scale', String(options.noiseScale ?? 0.12)];
  if (options.only?.length) args.push('--only', options.only.join(','));
  const child = spawn(blender.command, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  let log = '';
  child.stdout.on('data', chunk => { log += chunk; }); child.stderr.on('data', chunk => { log += chunk; });
  const exited = new Promise<number>(done => child.on('exit', code => done(code ?? -1)));
  const deadline = Date.now() + (options.timeoutMs ?? 600000);
  while (Date.now() < deadline) {
    try { await access(sentinel); break; } catch { /* not yet */ }
    await new Promise(done => setTimeout(done, 400));
  }
  if (!blender.detached) await exited;
  let report: { ok: boolean; meshes?: number; blender?: string; error?: string };
  try { report = JSON.parse(await readFile(sentinel, 'utf8')); } catch { throw new Error(`Blender did not finish within the timeout.\n${log.slice(-2000)}`); }
  await rm(sentinel, { force: true });
  if (!report.ok) throw new Error(`Blender refine failed: ${report.error}\n${log.slice(-2000)}`);
  return { output: out, bytes: (await stat(out)).size, meshes: report.meshes ?? 0, blender: report.blender ?? 'unknown' };
}
