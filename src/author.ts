import { spawn } from 'node:child_process';
import { readFile, realpath, rm, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { findBlender } from './refine.ts';

export interface AuthorOptions { timeoutMs?: number }
export interface AuthorResult { output: string; bytes: number; meshes: number; blender: string }
interface Report { ok: boolean; meshes?: number; blender?: string; error?: string }

/** Run a trusted Blender Python source's build() through the morph-preserving export wrapper. */
export async function authorGLB(input: string, output: string, options: AuthorOptions = {}): Promise<AuthorResult> {
  const blender = findBlender();
  if (!blender) throw new Error('Blender is not installed. Set AGENT_MESHES_BLENDER to its executable for authored builds.');
  const timeout = options.timeoutMs ?? 600000;
  if (!Number.isFinite(timeout) || timeout <= 0) throw new Error('Blender authoring timeout must be positive and finite');
  const source = await realpath(resolve(input)), out = resolve(output);
  const destination = await realpath(out).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return out; throw error; });
  const pathKey = (path: string) => process.platform === 'win32' ? path.toLowerCase() : path;
  if (pathKey(source) === pathKey(destination)) throw new Error('Blender output cannot replace its source script');
  const sentinel = `${out}.done`, pidFile = `${out}.pid`;
  const transient = [sentinel, pidFile, `${sentinel}.tmp`, `${pidFile}.tmp`];
  await Promise.all(transient.map(path => rm(path, { force: true })));
  await rm(out, { force: true });
  const wrapper = fileURLToPath(new URL('../scripts/blender-author.py', import.meta.url));
  const child = spawn(blender.command, ['-b', '--python-exit-code', '1', '--python', wrapper, '--', source, out], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  let log = '', exitCode: number | undefined, spawnError: Error | undefined, succeeded = false;
  child.stdout.on('data', chunk => { log = (log + chunk).slice(-4000); });
  child.stderr.on('data', chunk => { log = (log + chunk).slice(-4000); });
  child.once('error', error => { spawnError = error; });
  child.once('close', code => { exitCode = code ?? -1; });
  const deadline = Date.now() + timeout;
  try {
    while (true) {
      if (spawnError) throw new Error(`Cannot start Blender: ${spawnError.message}`);
      const exitedBeforeRead = exitCode !== undefined;
      let report: Report | undefined;
      try { report = JSON.parse(await readFile(sentinel, 'utf8')) as Report; }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error(`Invalid Blender completion report: ${String(error)}`); }
      // A close event can arrive while the file read is pending. Read once after that event
      // before deciding a fast process exited without writing its report.
      if (!report && exitCode !== undefined && !exitedBeforeRead) continue;
      if (report && report.ok !== true) throw new Error(`Blender authoring failed: ${report.error ?? 'invalid completion report'}\n${log}`);
      if (exitCode !== undefined && exitCode !== 0) throw new Error(`Blender exited with code ${exitCode}\n${log}`);
      if (report && (blender.detached || exitCode === 0)) {
        if (typeof report.blender !== 'string' || !Number.isInteger(report.meshes) || report.meshes! < 1) throw new Error('Invalid Blender completion report: missing version or mesh count');
        const info = await stat(out);
        if (!info.isFile() || !info.size) throw new Error('Blender produced no GLB');
        succeeded = true;
        return { output: out, bytes: info.size, meshes: report.meshes!, blender: report.blender };
      }
      if (!blender.detached && exitCode !== undefined) throw new Error(`Blender exited without a completion report\n${log}`);
      if (Date.now() >= deadline) throw new Error(`Blender authoring timed out after ${timeout} ms\n${log}`);
      await new Promise(done => setTimeout(done, Math.min(50, Math.max(1, deadline - Date.now()))));
    }
  } finally {
    if (!succeeded) {
      if (exitCode === undefined) {
        child.kill('SIGKILL');
        // Do not remove staging files while a terminated process still has pending writes.
        const stoppedBy = Date.now() + 2000;
        while (exitCode === undefined && Date.now() < stoppedBy) await new Promise(done => setTimeout(done, 20));
      }
      // Store launchers exit before Blender does. The wrapper records Blender's actual PID.
      if (blender.detached) {
        try {
          const pid: unknown = JSON.parse(await readFile(pidFile, 'utf8')).pid;
          if (typeof pid === 'number' && Number.isInteger(pid) && pid > 0) {
            process.kill(pid, 'SIGKILL');
            const stoppedBy = Date.now() + 2000;
            while (Date.now() < stoppedBy) { process.kill(pid, 0); await new Promise(done => setTimeout(done, 20)); }
          }
        }
        catch { /* Process may already have exited or failed before starting the wrapper. */ }
      }
      await rm(out, { force: true });
    }
    await Promise.all(transient.map(path => rm(path, { force: true })));
  }
}
