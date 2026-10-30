import { spawnSync } from 'node:child_process';
import { lstatSync } from 'node:fs';

/** The one Blender series agent-meshes supports. Any other major.minor is rejected; there is no override. */
export const SUPPORTED_BLENDER_SERIES = { major: 5, minor: 2, label: '5.2 LTS' } as const;
export const BLENDER_DOWNLOAD_URL = 'https://www.blender.org/download/';

export interface VersionProbe { status: number | null; stdout: string; stderr: string; error?: Error }
/** Runs `<command> --version`; injectable so tests need no Blender. */
export type VersionRunner = (command: string) => VersionProbe;

/** Thrown when Blender is present but is not the supported series (or its version cannot be read). */
export class BlenderVersionError extends Error {
  readonly code = 'BLENDER_UNSUPPORTED_VERSION';
  constructor(message: string) { super(message); this.name = 'BlenderVersionError'; }
}

const runVersion: VersionRunner = command => {
  const result = spawnSync(command, ['--version'], { encoding: 'utf8', timeout: 30000, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '', ...(result.error ? { error: result.error } : {}) };
};

/** Parse `Blender 5.2.2 LTS` from `--version` output; other lines (such as TBBmalloc notes on stderr) are ignored. */
export function parseBlenderVersion(output: string): string | null {
  return /^\s*Blender\s+(\d+\.\d+(?:\.\d+)?)/m.exec(output)?.[1] ?? null;
}

export function isSupportedBlenderVersion(version: string | null | undefined): boolean {
  const match = version ? /^(\d+)\.(\d+)(?:\.\d+)?$/.exec(version) : null;
  return !!match && Number(match[1]) === SUPPORTED_BLENDER_SERIES.major && Number(match[2]) === SUPPORTED_BLENDER_SERIES.minor;
}

const cache = new Map<string, string | null>();
export function clearBlenderVersionCache(): void { cache.clear(); }

/**
 * The version of the Blender at `command`, or null when it cannot be read (for example the Windows Store launcher,
 * which exits before printing one). Run once per executable path and modification time.
 */
export function readBlenderVersion(command: string, run: VersionRunner = runVersion): string | null {
  // lstat, not stat: a Store execution alias refuses stat.
  let stamp = 0;
  try { stamp = lstatSync(command).mtimeMs; } catch { /* unreadable stamp: key on the path alone */ }
  const key = `${command}\0${stamp}`;
  if (cache.has(key)) return cache.get(key) ?? null;
  const probe = run(command);
  const version = probe.error ? null : parseBlenderVersion(`${probe.stdout}\n${probe.stderr}`);
  cache.set(key, version);
  return version;
}

const requirement = `agent-meshes requires Blender ${SUPPORTED_BLENDER_SERIES.label} (any ${SUPPORTED_BLENDER_SERIES.major}.${SUPPORTED_BLENDER_SERIES.minor}.x). Download it from ${BLENDER_DOWNLOAD_URL}`;

export interface RejectedBlender { command: string; version: string | null }

/** The single message shown for a rejected Blender: the version found, the series required and where to get it. */
export function blenderVersionMessage(rejected: RejectedBlender[], explicit: boolean): string {
  const describe = (item: RejectedBlender) => item.version ? `Blender ${item.version}` : 'an unreadable Blender version';
  const unreadable = rejected.some(item => !item.version);
  const tail = unreadable
    ? ' If the version cannot be read (the Windows Store launcher exits before printing one), set AGENT_MESHES_BLENDER to a portable 5.2.x copy.'
    : explicit ? ' Then point AGENT_MESHES_BLENDER at that copy.' : ' Unzip it under ~/tools/blender or set AGENT_MESHES_BLENDER to its executable.';
  if (rejected.length === 1) return `Found ${describe(rejected[0])} at ${rejected[0].command}${explicit ? ' (set by AGENT_MESHES_BLENDER)' : ''}, but ${requirement}.${tail}`;
  return `No installed Blender is ${SUPPORTED_BLENDER_SERIES.label}. Rejected: ${rejected.map(item => `${item.command} (${item.version ?? 'version unreadable'})`).join('; ')}. ${requirement}.${tail}`;
}
