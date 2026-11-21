/**
 * Sync for an animation library kept in a git repository of the owner's own: stage the library's `mixamo/` changes,
 * commit them with a message that counts the imports, edits and removals, `git pull --rebase`, then `git push`.
 * A rebase that conflicts is aborted, so the working tree is left clean with the local commit in place, and the
 * conflicting paths are reported. Nothing here force-pushes or configures Git LFS (that is the repository's own
 * `.gitattributes`). Git runs through `execFile`, never a shell.
 */
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { assertNotMeshesCheckout } from '../scripts/mixamo-library.mjs';

export interface SyncStatus {
  available: boolean;
  /** Why Sync is unavailable: not a git working tree, no upstream, or a library inside an agent-meshes checkout. */
  reason?: string;
  branch: string | null;
  /** Commits on the branch that its upstream lacks, and the reverse, as of the last fetch. */
  ahead: number;
  behind: number;
  /** Changed paths under the library's `mixamo/` folder, relative to the repository's top level. */
  changed: string[];
}

export interface SyncResult {
  committed: boolean;
  pulled: boolean;
  pushed: boolean;
  /** The commit message, when a commit was made. */
  message?: string;
  error?: string;
  /** Paths the rebase could not merge; the rebase was aborted. */
  conflicts?: string[];
}

/** Sync cannot run for this library; `status` is the HTTP status the server answers with. */
export class SyncUnavailableError extends Error {
  readonly status = 409;
}

interface GitResult { code: number; stdout: string; stderr: string }

/** The environment for git: the library folder alone decides the repository, and git never waits for a prompt. */
function gitEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_MERGE_AUTOEDIT: 'no' };
  for (const key of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_PREFIX']) delete env[key];
  return env;
}

function git(cwd: string, args: string[]): Promise<GitResult> {
  return new Promise((done, fail) => {
    execFile('git', args, { cwd, env: gitEnv(), windowsHide: true, maxBuffer: 64 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error && typeof (error as NodeJS.ErrnoException).code === 'string') { fail(new Error(`git could not run: ${error.message}`)); return; }
      done({ code: error ? Number((error as { code?: number }).code ?? 1) : 0, stdout: String(stdout), stderr: String(stderr) });
    });
  });
}
async function gitOk(cwd: string, args: string[]): Promise<string> {
  const result = await git(cwd, args);
  if (result.code !== 0) throw new Error(`git ${args.find(arg => !arg.startsWith('-'))} failed: ${(result.stderr || result.stdout).trim()}`);
  return result.stdout;
}
const paths = (output: string) => output.split('\0').filter(Boolean);

/** Whether Sync can run for this library folder, and what it would send. Reads only, in one `git status`; it does
 *  not fetch, so `behind` is as of the last fetch or pull. */
export async function syncStatus(directory: string): Promise<SyncStatus> {
  const dir = resolve(directory);
  const status: SyncStatus = { available: false, branch: null, ahead: 0, behind: 0, changed: [] };
  if (!existsSync(dir)) return { ...status, reason: `the library folder ${dir} does not exist yet` };
  const result = await git(dir, ['--no-optional-locks', 'status', '--porcelain=v2', '--branch', '-z', '--untracked-files=all', '--', 'mixamo']);
  if (result.code !== 0) return { ...status, reason: `the library folder ${dir} is not a git working tree` };
  try { assertNotMeshesCheckout(dir); } catch (error) { return { ...status, reason: (error as Error).message }; }
  let upstream: string | null = null;
  const records = paths(result.stdout);
  for (let i = 0; i < records.length; i++) {
    const record = records[i]!;
    // Porcelain v2 paths are relative to the repository's top level. Each kind has a fixed number of fields before
    // the path; a rename (2) is followed by a record holding its source.
    const field = (count: number) => record.split(' ').slice(count).join(' ');
    if (record.startsWith('# branch.head ')) { const head = record.slice(14); status.branch = head === '(detached)' ? null : head; }
    else if (record.startsWith('# branch.upstream ')) upstream = record.slice(18);
    else if (record.startsWith('# branch.ab ')) { const [ahead, behind] = record.slice(12).split(' ').map(value => Math.abs(Number(value))); status.ahead = ahead ?? 0; status.behind = behind ?? 0; }
    else if (record.startsWith('1 ')) status.changed.push(field(8));
    else if (record.startsWith('2 ')) { status.changed.push(field(9)); i++; }
    else if (record.startsWith('u ')) status.changed.push(field(10));
    else if (record.startsWith('? ')) status.changed.push(record.slice(2));
  }
  if (!status.branch) return { ...status, reason: 'the library repository is not on a branch (detached HEAD)' };
  if (!upstream) return { ...status, reason: `the branch ${status.branch} has no upstream: push it once with "git push -u origin ${status.branch}"` };
  return { ...status, available: true };
}

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? '' : 's'}`;

/** A one-line commit subject from `git diff --cached --name-status --no-renames -z`: added FBX files are imports, deleted FBX files
 *  removals, and changed sidecars of clips that stayed are edits. */
export function syncMessage(nameStatus: string, summary?: string): string {
  const records = paths(nameStatus), added = new Set<string>(), deleted = new Set<string>(), modified = new Set<string>();
  for (let i = 0; i < records.length; i++) {
    const code = records[i]!, path = records[++i]!;
    const stem = path.replace(/\.[^./]+$/, '');
    if (/\.fbx$/i.test(path) && code === 'A') added.add(stem);
    else if (/\.fbx$/i.test(path) && code === 'D') deleted.add(stem);
    else if (/\.json$/i.test(path) && code === 'M') modified.add(stem);
  }
  const edits = [...modified].filter(stem => !added.has(stem) && !deleted.has(stem)).length;
  const parts = [added.size ? plural(added.size, 'import') : '', edits ? plural(edits, 'edit') : '', deleted.size ? plural(deleted.size, 'removal') : ''].filter(Boolean);
  const subject = `Animation library: ${parts.length ? parts.join(', ') : plural(records.length / 2, 'changed file')}`;
  return summary?.trim() ? `${subject}\n\n${summary.trim()}` : subject;
}

/** Commit the library's `mixamo/` changes, pull with rebase and push. Throws `SyncUnavailableError` when Sync cannot
 *  run; reports a failed pull or push in `error`. `summary` is added to the commit message body. */
export async function syncLibrary(directory: string, summary?: string): Promise<SyncResult> {
  const dir = resolve(directory);
  // The checkout rule is checked first, so it is the reason given even when the checkout has no upstream.
  if (existsSync(dir)) assertNotMeshesCheckout(dir);
  const status = await syncStatus(dir);
  if (!status.available) throw new SyncUnavailableError(`Sync is unavailable: ${status.reason}`);
  const result: SyncResult = { committed: false, pulled: false, pushed: false };
  // Status lists staged and unstaged changes alike, so with none there is nothing to add or commit.
  if (status.changed.length) await gitOk(dir, ['add', '-A', '--', 'mixamo']);
  const staged = status.changed.length ? await gitOk(dir, ['--no-optional-locks', 'diff', '--cached', '--name-status', '--no-renames', '-z', '--', 'mixamo']) : '';
  if (staged) {
    const message = syncMessage(staged, summary);
    await gitOk(dir, ['commit', '--quiet', '-m', message, '--', 'mixamo']);
    result.committed = true; result.message = message;
  }
  const pull = await git(dir, ['pull', '--rebase', '--no-autostash', '--quiet']);
  if (pull.code !== 0) {
    const conflicts = paths((await git(dir, ['--no-optional-locks', 'diff', '--name-only', '--diff-filter=U', '-z'])).stdout);
    // Undo a stopped rebase; when none is in progress this fails harmlessly.
    await git(dir, ['rebase', '--abort']);
    if (conflicts.length) {
      return { ...result, conflicts, error: `Sync stopped: ${conflicts.join(', ')} changed here and on the remote. The rebase was undone and your commit kept; resolve it with git in ${dir}, then Sync again.` };
    }
    return { ...result, error: `git pull --rebase failed: ${(pull.stderr || pull.stdout).trim()}` };
  }
  result.pulled = true;
  const [ahead] = (await gitOk(dir, ['--no-optional-locks', 'rev-list', '--left-right', '--count', 'HEAD...@{upstream}'])).trim().split(/\s+/).map(Number);
  if (ahead) {
    const push = await git(dir, ['push', '--quiet']);
    if (push.code !== 0) return { ...result, error: `git push failed: ${(push.stderr || push.stdout).trim()}` };
    result.pushed = true;
  }
  return result;
}
