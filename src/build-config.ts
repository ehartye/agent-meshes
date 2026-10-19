import { createHash } from 'node:crypto';
import type { BigIntStats } from 'node:fs';
import { lstat, readFile, realpath } from 'node:fs/promises';
import { dirname, relative, resolve, sep } from 'node:path';

interface Snapshot { requested: string; absolute: string; metadata: string; sha256: string; bytes: Buffer }
export interface BuildConfigSource { path: string; sha256: string }
export interface LoadedBuildConfig {
  value: unknown;
  /** Leaf first, followed by its ancestors; canonical paths relative to the canonical leaf directory. */
  sources: BuildConfigSource[];
  leafSha256: string;
  assertUnchanged: () => Promise<void>;
}
const pathKey = (path: string) => process.platform === 'win32' ? path.toLowerCase() : path;
const metadata = (info: BigIntStats) => [info.dev, info.ino, info.size, info.mtimeNs, info.ctimeNs, info.mode, info.nlink].join(':');
const plainObject = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const dangerous = new Set(['__proto__', 'constructor', 'prototype']);

function checkProperties(value: unknown): void {
  if (Array.isArray(value)) { for (const item of value) checkProperties(item); return; }
  if (!plainObject(value)) return;
  for (const [key, child] of Object.entries(value)) {
    if (dangerous.has(key)) throw new Error(`Unsafe build config property: ${key}`);
    checkProperties(child);
  }
}

function merge(base: Record<string, unknown>, leaf: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries([...new Set([...Object.keys(base), ...Object.keys(leaf)])].map(key => {
    if (!Object.hasOwn(leaf, key)) return [key, base[key]];
    return [key, plainObject(base[key]) && plainObject(leaf[key]) ? merge(base[key], leaf[key]) : leaf[key]];
  }));
}

async function snapshot(requested: string): Promise<Snapshot> {
  const absolute = await realpath(requested);
  const before = await lstat(absolute, { bigint: true });
  if (!before.isFile()) throw new Error(`Build config must be a regular file: ${requested}`);
  const bytes = await readFile(absolute);
  const after = await lstat(absolute, { bigint: true });
  if (metadata(before) !== metadata(after) || pathKey(await realpath(requested)) !== pathKey(absolute)) throw new Error(`Build config changed while reading: ${requested}`);
  return { requested, absolute, metadata: metadata(after), sha256: createHash('sha256').update(bytes).digest('hex'), bytes };
}

/**
 * One optional extends file per config, at most 16 configs. Only extends resolves
 * relative to its declaring file; every inherited asset path remains relative to
 * the leaf config when the caller validates and executes the merged value.
 * Arrays/scalars replace, plain objects merge recursively, and the leaf wins.
 */
export async function loadBuildConfig(configPath: string): Promise<LoadedBuildConfig> {
  const snapshots: Snapshot[] = [];
  const visited = new Set<string>();
  async function load(requested: string): Promise<Record<string, unknown>> {
    if (snapshots.length >= 16) throw new Error('Build config extends chain exceeds the 16-config limit');
    const captured = await snapshot(resolve(requested));
    const key = pathKey(captured.absolute);
    if (visited.has(key)) throw new Error(`Build config extends cycle: ${requested}`);
    visited.add(key); snapshots.push(captured);
    const value: unknown = JSON.parse(captured.bytes.toString('utf8'));
    if (!plainObject(value)) throw new Error(`Build config must be a JSON object: ${requested}`);
    checkProperties(value);
    if (Object.hasOwn(value, 'extends') && (typeof value.extends !== 'string' || !value.extends.trim())) throw new Error(`Build config extends must be one non-empty path string: ${requested}`);
    const own = Object.fromEntries(Object.entries(value).filter(([name]) => name !== 'extends'));
    if (!Object.hasOwn(value, 'extends')) return own;
    return merge(await load(resolve(dirname(captured.absolute), value.extends as string)), own);
  }
  const value = await load(resolve(configPath));
  const base = dirname(snapshots[0].absolute);
  return {
    value,
    sources: snapshots.map(file => ({ path: relative(base, file.absolute).split(sep).join('/'), sha256: file.sha256 })),
    leafSha256: snapshots[0].sha256,
    assertUnchanged: async () => {
      for (const expected of snapshots) {
        try {
          // Recheck only the captured files and alias targets, never a new extends chain.
          const actual = await snapshot(expected.requested);
          if (pathKey(actual.absolute) !== pathKey(expected.absolute) || actual.metadata !== expected.metadata || actual.sha256 !== expected.sha256) throw new Error('config bytes, file identity or alias target changed');
        } catch (error) { throw new Error(`Build config changed or missing during build: ${expected.requested}`, { cause: error }); }
      }
    },
  };
}
