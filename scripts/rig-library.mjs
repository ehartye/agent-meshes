#!/usr/bin/env node
// Package-relative catalog, integrity/GLB verification and existing offline viewer.
import { readFile, mkdir, writeFile, lstat, copyFile, unlink } from 'node:fs/promises';
import { constants } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, relative, isAbsolute, extname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { validateBytes } from 'gltf-validator';
import { readGLB } from '../src/gltf-read.ts';

export const packageRoot = fileURLToPath(new URL('../', import.meta.url));
export const catalogPath = resolve(packageRoot, 'scripts/reference-assets/rigs/catalog.json');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
export async function rigCatalog() { return JSON.parse(await readFile(catalogPath, 'utf8')); }

export async function verifyRigLibrary() {
  const catalog = await rigCatalog();
  const results = [];
  for (const entry of catalog.libraries) {
    const bytes = await readFile(resolve(dirname(catalogPath), entry.path));
    if (hash(bytes) !== entry.sha256) throw new Error(`${entry.id}: payload SHA256 mismatch`);
    const gltf = readGLB(bytes).json;
    const actual = (gltf.animations ?? []).map(a => a.name);
    for (const clip of entry.clips) if (!actual.includes(clip.name)) throw new Error(`${entry.id}: missing ${clip.name}`);
    const validation = await validateBytes(new Uint8Array(bytes), { maxIssues: 100 });
    results.push({ id: entry.id, bytes: bytes.length, sha256: hash(bytes),
      bones: gltf.skins[0].joints.length, clips: actual.length,
      errors: validation.issues.numErrors, warnings: validation.issues.numWarnings,
      messages: validation.issues.messages });
  }
  const inventory = JSON.parse(await readFile(resolve(packageRoot, 'scripts/rigging/toy-maker/inventory.json'), 'utf8'));
  const source = inventory.riggingFiles.filter(item => item.destination);
  for (const entry of source) {
    const bytes = await readFile(resolve(packageRoot, entry.destination));
    if (hash(bytes) !== entry.sha256) throw new Error(`${entry.sourcePath}: source snapshot SHA256 mismatch`);
  }
  return { scope: 'actual payload hashes, catalog clip presence, Khronos GLB validation; no playback/art acceptance',
    libraries: results, sourceSnapshots: source.length, errors: results.reduce((sum, item) => sum + item.errors, 0) };
}

export async function rigDemo(ids, output) {
  const catalog = await rigCatalog();
  if (ids.length < 2 || ids.length > 4 || new Set(ids).size !== ids.length) throw new Error('Choose 2–4 distinct library IDs');
  const models = ids.map(id => {
    const entry = catalog.libraries.find(item => item.id === id);
    if (!entry) throw new Error(`Unknown rig library: ${id}`);
    const motion = entry.clips.find(c => /^(Walk_Loop|Walk_Female|Walk)$/i.test(c.name)) ??
      entry.clips.find(c => /walk|crawl|swim|fly|slither|side winding/i.test(c.name)) ?? entry.clips[0];
    return { label: `${id} · ${entry.bodyPlan}`, path: resolve(dirname(catalogPath), entry.path), clips: { motion: motion.name } };
  });
  const destination = resolve(output);
  if (extname(destination).toLowerCase() !== '.html') throw new Error('Demo output must be a fresh .html file');
  const fromSource = relative(resolve(packageRoot, 'scripts'), destination);
  if (!fromSource.startsWith('..') && !isAbsolute(fromSource)) throw new Error('Write demos outside bundled source and assets');
  const config = destination + '.comparison.json';
  for (const path of [destination, config]) {
    try {
      await lstat(path);
      throw new Error(`Output exists; choose fresh paths: ${path}`);
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  await mkdir(dirname(destination), { recursive: true });
  await writeFile(config, JSON.stringify({ models }, null, 2) + '\n', { flag: 'wx' });
  // The legacy viewer overwrites its output. Give it only a uniquely owned staging
  // file, then publish with exclusive-copy semantics; retain failed-build artifacts.
  const staging = destination + `.building-${randomUUID()}.html`;
  await writeFile(staging, '', { flag: 'wx' });
  const result = spawnSync(process.execPath, [resolve(packageRoot, 'scripts/compare-rigs.mjs'), config, staging], { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`Viewer build failed; retained ${config} and ${staging}: ${result.stderr || result.stdout || result.status}`);
  await copyFile(staging, destination, constants.COPYFILE_EXCL);
  await unlink(staging);
  return { output: destination, comparison: config, models,
    scope: 'existing offline clay/skeleton viewer; normalized phase does not align footfalls' };
}

async function main() {
  const [command = 'catalog', ...args] = process.argv.slice(2);
  if (command === 'catalog') {
    const catalog = await rigCatalog();
    const planIndex = args.indexOf('--body-plan'), roleIndex = args.indexOf('--role');
    if (planIndex >= 0) catalog.libraries = catalog.libraries.filter(item => item.bodyPlan === args[planIndex + 1]);
    if (roleIndex >= 0) catalog.libraries = catalog.libraries.filter(item => item.roles.includes(args[roleIndex + 1]));
    console.log(JSON.stringify(catalog, null, 2));
  } else if (command === 'verify') {
    const result = await verifyRigLibrary();
    console.log(JSON.stringify(result, null, 2));
    if (result.errors) process.exitCode = 1;
  } else if (command === 'demo') {
    const outputIndex = args.indexOf('--out');
    if (outputIndex < 0 || !args[outputIndex + 1]) throw new Error('demo --out <project/demo.html> [2–4 library IDs]');
    const ids = args.filter((_, i) => i !== outputIndex && i !== outputIndex + 1);
    console.log(JSON.stringify(await rigDemo(ids.length ? ids : ['human-base', 'human-addon', 'fox', 'spider'], args[outputIndex + 1]), null, 2));
  } else {
    throw new Error('Usage: node scripts/rig-library.mjs catalog [--body-plan <plan>] [--role <role>] | verify | demo --out <file> [2–4 IDs]. CPU tools: python scripts/rigging/toy-maker/rig_library.py --help');
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
