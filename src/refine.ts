import { spawn } from 'node:child_process';
import { access, readFile, rm, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { accessSync, constants, lstatSync, readdirSync } from 'node:fs';

/**
 * Optional Blender stage: subdivide, smooth and displace a GLB while keeping its skeleton and
 * clips. Blender is never required; `findBlender` says whether the stage is available.
 */
export interface BlenderLocation { command: string; /** The Windows Store launcher exits at once, so completion is read from a sentinel file. */ detached: boolean }

export function findBlender(): BlenderLocation | null {
  const explicit = process.env.AGENT_MESHES_BLENDER;
  if (explicit) return { command: explicit, detached: /blender-launcher/i.test(explicit) };
  const candidates: BlenderLocation[] = [];
  if (process.platform === 'win32') {
    for (const root of ['C:/Program Files/Blender Foundation', 'C:/Program Files (x86)/Blender Foundation']) {
      try { for (const dir of readdirSync(root)) candidates.push({ command: join(root, dir, 'blender.exe'), detached: false }); } catch { /* not installed there */ }
    }
    const apps = join(homedir(), 'AppData/Local/Microsoft/WindowsApps');
    try { for (const dir of readdirSync(apps)) if (/^BlenderFoundation\.Blender/i.test(dir)) candidates.push({ command: join(apps, dir, 'blender-launcher.exe'), detached: true }); } catch { /* no store apps */ }
  } else if (process.platform === 'darwin') candidates.push({ command: '/Applications/Blender.app/Contents/MacOS/Blender', detached: false });
  for (const dir of (process.env.PATH ?? '').split(process.platform === 'win32' ? ';' : ':')) if (dir) candidates.push({ command: join(dir, process.platform === 'win32' ? 'blender.exe' : 'blender'), detached: false });
  // A Store app's launcher is an execution alias: stat refuses it, lstat calls it a link, access allows it.
  for (const candidate of candidates) {
    try { if (lstatSync(candidate.command).isDirectory()) continue; accessSync(candidate.command, constants.X_OK); return candidate; } catch { /* keep looking */ }
  }
  return null;
}

export interface RefineOptions { subdivide?: number; noise?: number; noiseScale?: number; only?: string[]; timeoutMs?: number }
export interface RefineResult { output: string; bytes: number; meshes: number; blender: string }

/** Run scripts/blender-refine.py on a GLB. Throws if Blender is not installed or the stage fails. */
export async function refineGLB(input: string, output: string, options: RefineOptions = {}): Promise<RefineResult> {
  const blender = findBlender();
  if (!blender) throw new Error('Blender is not installed; the refine stage is optional and was skipped. Set AGENT_MESHES_BLENDER to the executable to enable it.');
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
