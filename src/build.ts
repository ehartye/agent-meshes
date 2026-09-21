import { lstat, mkdir, mkdtemp, open, readFile, readdir, realpath, rename, rm, unlink, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Project } from './core/types.ts';
import type { Operation } from './core/types.ts';
import { createProject, applyOperation, validateProject } from './core/model.ts';
import { exportGLB, verifyGLB } from './export.ts';
import { findBlender, refineGLB } from './refine.ts';
import { authorGLB } from './author.ts';

const markerName = '.agent-meshes-build.json';
/** Optional Blender pass over the exported GLB: subdivision, smoothing and a clouds displacement on named meshes. */
const refineSchema = z.object({ subdivide: z.number().int().min(0).max(3).default(1), noise: z.number().min(0).max(1).default(0), noiseScale: z.number().positive().max(10).default(0.12), only: z.array(z.string().min(1)).optional() }).strict();
const configSchema = z.object({ version: z.literal(1), project: z.string().min(1).optional(), operations: z.string().min(1).optional(), blender: z.object({ script: z.string().min(1) }).strict().optional(), name: z.string().min(1).optional(), output: z.string().min(1), refine: refineSchema.optional() }).strict()
  .refine(config => [config.project, config.operations, config.blender].filter(Boolean).length === 1, 'Exactly one project, operations or blender input is required')
  .refine(config => !(config.blender && config.refine), 'Blender authoring cannot be combined with refine; author modifiers in the source script');
const markerSchema = z.object({ version: z.literal(1), generator: z.literal('agent-meshes'), config: z.string().min(1), files: z.array(z.string()) }).strict();
const portable = (path: string) => path.split(sep).join('/');
const inside = (directory: string, path: string) => { const rel = relative(directory, path); return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`)); };
async function exists(path: string): Promise<boolean> {
  try { await lstat(path); return true; } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
}
async function canonical(path: string): Promise<string> {
  try { return await realpath(path); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    const parent = dirname(path); if (parent === path) throw error;
    return join(await canonical(parent), basename(path));
  }
}
function checkFiles(files: string[]): void {
  if (new Set(files).size !== files.length) throw new Error('Build file list contains duplicate files');
  for (const file of files) if (!file || isAbsolute(file) || file.includes('\\') || file.includes(':') || file.includes('\0') || file.split('/').some(piece => !piece || piece === '.' || piece === '..') || file === markerName) throw new Error(`Unsafe build artifact path: ${file}`);
}
async function checkTree(directory: string, files: string[]): Promise<void> {
  checkFiles(files);
  const expected = new Set([...files, markerName]);
  const found = new Set<string>();
  async function visit(path: string, prefix: string): Promise<void> {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const name = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isSymbolicLink()) throw new Error(`Symlink in build output: ${name}`);
      if (entry.isDirectory()) {
        if (![...expected].some(file => file.startsWith(`${name}/`))) throw new Error(`Unexpected directory in build output: ${name}`);
        await visit(join(path, entry.name), name);
      } else if (entry.isFile() && expected.has(name)) found.add(name);
      else throw new Error(`Unexpected unowned file in build output: ${name}`);
    }
  }
  await visit(directory, '');
  for (const file of expected) if (!found.has(file)) throw new Error(`Missing owned build file: ${file}`);
}
async function checkOwnership(output: string, config: string): Promise<boolean> {
  if (!await exists(output)) return false;
  const stat = await lstat(output);
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error('Build output must be an owned directory, not a symlink or file');
  const markerPath = join(output, markerName);
  if (!await exists(markerPath) || !(await lstat(markerPath)).isFile() || (await lstat(markerPath)).isSymbolicLink()) throw new Error('Output directory is not owned by agent-meshes');
  const parsed = markerSchema.safeParse(JSON.parse(await readFile(markerPath, 'utf8')));
  if (!parsed.success || parsed.data.config !== portable(relative(output, config))) throw new Error('Output ownership does not match this build config');
  await checkTree(output, parsed.data.files);
  return true;
}
async function move(source: string, destination: string): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try { await rename(source, destination); return; } catch (error) {
      if (attempt >= 5 || !['EPERM', 'EACCES', 'EBUSY'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
      await new Promise(resolve => setTimeout(resolve, 25 * 2 ** attempt));
    }
  }
}

export interface AuthoredAsset { name: string }
export async function buildAsset(configPath: string, options: { decorate?: (project: Project, stage: string) => Promise<string[]>; decorateAsset?: (asset: AuthoredAsset, stage: string) => Promise<string[]> } = {}): Promise<{ output: string; files: string[] }> {
  const configFile = await realpath(resolve(configPath));
  const config = configSchema.parse(JSON.parse(await readFile(configFile, 'utf8')));
  const input = await realpath(resolve(dirname(configFile), config.project ?? config.operations ?? config.blender!.script));
  const requestedOutput = resolve(dirname(configFile), config.output);
  // Resolve parent aliases, but never follow an output symlink into somebody else's directory.
  const output = join(await canonical(dirname(requestedOutput)), basename(requestedOutput));
  if (dirname(output) === output || inside(output, configFile) || inside(output, input)) throw new Error('Build output cannot contain its config or input source');
  await mkdir(dirname(output), { recursive: true });
  const lockPath = join(dirname(output), `.${basename(output)}.agent-meshes.lock`);
  const lock = await open(lockPath, 'wx').catch((error: NodeJS.ErrnoException) => { if (error.code === 'EEXIST') throw new Error('Build output is locked by another build in progress'); throw error; });
  let stage: string | undefined;
  let backup: string | undefined;
  try {
    await lock.writeFile(JSON.stringify({ config: configFile, pid: process.pid }));
    await checkOwnership(output, configFile);
    stage = await mkdtemp(join(dirname(output), `.${basename(output)}.stage-`));
    let files: string[];
    if (config.blender) {
      const source = await readFile(input);
      const result = await authorGLB(input, join(stage, 'model.glb'));
      const verification = await verifyGLB(await readFile(join(stage, 'model.glb')));
      if (!verification.ok) throw new Error(`Authored GLB verification failed with ${verification.errors} errors`);
      files = ['model.glb', 'verification.json', 'authoring.json'];
      await Promise.all([
        writeFile(join(stage, 'verification.json'), `${JSON.stringify(verification, null, 2)}\n`),
        writeFile(join(stage, 'authoring.json'), `${JSON.stringify({ version: 1, source: { script: portable(relative(dirname(configFile), input)), sha256: createHash('sha256').update(source).digest('hex') }, blender: result.blender, meshes: result.meshes }, null, 2)}\n`),
      ]);
      if (options.decorateAsset) files.push(...await options.decorateAsset({ name: config.name ?? basename(input).replace(/\.[^.]+$/, '') }, stage));
    } else {
      const source: unknown = JSON.parse(await readFile(input, 'utf8'));
      let project: Project;
      if (config.project) project = validateProject(source);
      else {
        if (!Array.isArray(source)) throw new Error('Operations input must be a JSON array');
        project = createProject(config.name ?? basename(configFile).replace(/\.[^.]+$/, ''));
        for (const operation of source) project = applyOperation(project, operation as Operation);
      }
      let bytes = await exportGLB(project);
      let verification = await verifyGLB(bytes);
      if (!verification.ok) throw new Error(`GLB verification failed with ${verification.errors} errors`);
      if (config.refine) {
        // The refine pass is part of the recipe, so a missing Blender fails the build rather than quietly shipping a coarser model.
        if (!findBlender()) throw new Error('This build asks for a Blender refine pass but Blender is not installed');
        const raw = join(stage, 'model.raw.glb'), refined = join(stage, 'model.refined.glb');
        await writeFile(raw, bytes);
        await refineGLB(raw, refined, config.refine);
        bytes = new Uint8Array(await readFile(refined));
        await Promise.all([unlink(raw), unlink(refined)]);
        verification = await verifyGLB(bytes);
        if (!verification.ok) throw new Error(`Refined GLB verification failed with ${verification.errors} errors`);
      }
      files = ['project.mesh.json', 'model.glb', 'verification.json'];
      await Promise.all([
        writeFile(join(stage, files[0]), `${JSON.stringify(project, null, 2)}\n`),
        writeFile(join(stage, files[1]), bytes),
        writeFile(join(stage, files[2]), `${JSON.stringify(verification, null, 2)}\n`),
      ]);
      if (options.decorate) files.push(...await options.decorate(structuredClone(project), stage));
    }
    checkFiles(files);
    await writeFile(join(stage, markerName), `${JSON.stringify({ version: 1, generator: 'agent-meshes', config: portable(relative(output, configFile)), files }, null, 2)}\n`);
    await checkTree(stage, files);
    // Check again just before replacing, so files added during a long render are preserved.
    if (await checkOwnership(output, configFile)) {
      backup = join(dirname(output), `.${basename(output)}.backup-${randomUUID()}`);
      await move(output, backup);
    }
    try { await move(stage, output); stage = undefined; }
    catch (error) { if (backup) { await move(backup, output); backup = undefined; } throw error; }
    if (backup) { await rm(backup, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); backup = undefined; }
    return { output, files };
  } finally {
    if (stage) await rm(stage, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    await lock.close(); await unlink(lockPath);
  }
}
