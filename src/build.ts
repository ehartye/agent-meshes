import { lstat, mkdir, mkdtemp, open, readFile, readdir, realpath, rename, rm, unlink, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import type { Project } from './core/types.ts';
import { createProject, validateProject } from './core/model.ts';
import { applyOperations } from './agent-contract.ts';
import { lintProject, type ProjectWarning } from './project-lint.ts';
import { checkDetached, type DetachedFinding, type DetachedReport } from './verify-detached.ts';
import { exportGLB, verifyGLB } from './export.ts';
import { verifyEnclosures, type EnclosuresReport } from './enclosure.ts';
import { findBlender, refineGLB } from './refine.ts';
import { authorGLB } from './author.ts';
import { mergeModes, type MergeMode } from './export-merge.ts';
import { checkLimits, limitsSchema } from './glb-limits.ts';
import { lintSilhouette, silhouette } from './silhouette.ts';
import { captureBuildInputs, captureBuildRoot, captureBuildToolchain, checkToolchainPin } from './build-provenance.ts';
import { prepareNativeCache } from './build-native-cache.ts';
import { classifyReadAudit, portableReadAudit, type ReadAudit } from './build-read-audit.ts';
import type { NativeBuildSession } from './build-session.ts';
import { loadBuildConfig } from './build-config.ts';
import { prepareBuildEnvironment } from './build-environment.ts';

const markerName = '.agent-meshes-build.json';
/** Optional Blender pass over the exported GLB: subdivision, smoothing and a clouds displacement on named meshes. */
const refineSchema = z.object({ subdivide: z.number().int().min(0).max(3).default(1), noise: z.number().min(0).max(1).default(0), noiseScale: z.number().positive().max(10).default(0.12), only: z.array(z.string().min(1)).optional() }).strict();
/**
 * Optional `verify` section: triangle, material, pivot and height limits plus an optional silhouette lint, all checked
 * on the final GLB. A violation fails the build with VERIFY_LIMITS_FAILED unless `warnOnly` is set.
 */
const buildVerifySchema = limitsSchema.extend({
  lintProfile: z.object({
    axis: z.enum(['x', 'y', 'z']).default('y'), bins: z.number().int().min(2).max(2000).default(100),
    tolerance: z.number().min(0).finite().optional(), allow: z.array(z.tuple([z.number(), z.number()])).optional(),
  }).strict().optional(),
}).strict();
const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/, 'Expected a lowercase SHA-256 digest');
/** Explicit config-relative files or bounded trees; no Python import discovery. */
const blenderSchema = z.object({
  script: z.string().min(1),
  projectRoot: z.string().min(1).optional(),
  environment: z.object({ inputs: z.array(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/)).max(256), overrides: z.record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/), z.string().refine(value => !value.includes('\0'), 'Environment overrides must not contain NUL')).optional() }).strict().optional(),
  readAudit: z.enum(['warn', 'strict']).optional(),
  inputs: z.array(z.union([
    z.object({ path: z.string().min(1), sha256: sha256Schema.optional() }).strict(),
    z.object({ dir: z.string().min(1), include: z.array(z.string().min(1)).min(1).max(100).optional(), exclude: z.array(z.string().min(1)).max(100).optional(), maxFiles: z.number().int().min(1).max(10000).optional(), sha256: sha256Schema.optional() }).strict(),
  ])).optional(),
  toolchain: z.object({
    agentMeshesVersion: z.string().min(1), helpersSha256: sha256Schema, blenderVersion: z.string().min(1).optional(),
  }).strict().optional(),
}).strict();
const configSchema = z.object({ version: z.literal(1), project: z.string().min(1).optional(), operations: z.string().min(1).optional(), blender: blenderSchema.optional(), name: z.string().min(1).optional(), output: z.string().min(1), refine: refineSchema.optional(), target: z.literal('uefn').optional(), renderVertexBudget: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(), merge: z.enum(mergeModes as [MergeMode, ...MergeMode[]]).optional(), verify: buildVerifySchema.optional() }).strict()
  .refine(config => !(config.merge && config.blender), 'merge applies to project and operations inputs; a Blender-authored GLB is not merged by agent-meshes')
  .refine(config => [config.project, config.operations, config.blender].filter(Boolean).length === 1, 'Exactly one project, operations or blender input is required')
  .refine(config => config.renderVertexBudget === undefined || config.target !== undefined, 'renderVertexBudget requires an explicit target')
  .refine(config => !(config.blender && config.refine), 'Blender authoring cannot be combined with refine; author modifiers in the source script');
/** Check a built GLB against the config's verify section; returns what verification.json records, or null when no section. */
function checkBuildLimits(bytes: Uint8Array, verify: z.infer<typeof buildVerifySchema> | undefined) {
  if (!verify) return null;
  const { lintProfile, ...limits } = verify;
  const report = checkLimits(bytes, limits);
  const lint = lintProfile ? { ...lintProfile, findings: lintSilhouette(silhouette(bytes, lintProfile), lintProfile) } : undefined;
  const failures = [...report.failures, ...(lint?.findings.map(finding => finding.message) ?? [])];
  const result = { ...report, ok: failures.length === 0, failures, ...(lint ? { lintProfile: lint } : {}) };
  if (!result.ok && !result.warnOnly) throw Object.assign(new Error(`Verify limits failed:\n${failures.join('\n')}`), { code: 'VERIFY_LIMITS_FAILED' });
  return result;
}
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
/** An output-directory refusal: the message says what is wrong, `hint` says how to proceed (the CLI prints both). */
function outputError(code: string, summary: string, hint: string): Error {
  return Object.assign(new Error(`${summary} Hint: ${hint}`), { code, hint });
}
const replaceHint = 'A build replaces its whole output directory, so move the file out of it or give the build a different "output" in its config.';
const unownedHint = `${replaceHint} If it is a preview (a .png or preview.html) that mesh preview wrote into the build folder, or one restored from version control, delete it: give mesh preview an --out outside the build folder, and rebuild with previews on (omit --no-preview) instead of restoring old ones. --if-changed and --force apply to native blender.script builds only, so they do not get past this check.`;
/** A preview is a name ending in .png in any case, or exactly preview.html. */
const isPreview = (file: string) => /\.png$/i.test(file) || file === 'preview.html';
/**
 * The preview files the owned directory's marker lists and that are on disk, in the marker's order. Empty when the marker
 * is missing or unreadable (an adopted empty folder has none), so no result proves nothing about what a swap removes.
 */
async function earlierPreviews(directory: string): Promise<string[]> {
  try {
    const marker = markerSchema.safeParse(JSON.parse(await readFile(join(directory, markerName), 'utf8')));
    if (!marker.success) return [];
    const present = await Promise.all(marker.data.files.filter(isPreview).map(async file => [file, await exists(join(directory, ...file.split('/')))] as const));
    return present.filter(([, there]) => there).map(([file]) => file);
  } catch { return []; }
}
async function checkTree(directory: string, files: string[], allowMissing = false): Promise<void> {
  checkFiles(files);
  const expected = new Set([...files, markerName]);
  const found = new Set<string>();
  async function visit(path: string, prefix: string): Promise<void> {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const name = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isSymbolicLink()) throw new Error(`Symlink in build output: ${name}`);
      if (entry.isDirectory()) {
        if (![...expected].some(file => file.startsWith(`${name}/`))) throw outputError('BUILD_OUTPUT_UNOWNED_FILE', `Unexpected directory "${name}" in build output ${directory}.`, unownedHint);
        await visit(join(path, entry.name), name);
      } else if (entry.isFile() && expected.has(name)) found.add(name);
      else throw outputError('BUILD_OUTPUT_UNOWNED_FILE', `Unexpected unowned file "${name}" in build output ${directory}.`, unownedHint);
    }
  }
  await visit(directory, '');
  for (const file of expected) if (!found.has(file) && !allowMissing) throw outputError('BUILD_OUTPUT_FILE_MISSING', `Missing owned build file: ${file}.`, `${file} is listed in the ${markerName} marker of ${directory} but is not on disk, often because version control ignores it. --if-changed and --force apply to native blender.script builds only, so a project or operations build cannot use them. Restore ${file}, or delete the output directory so the next build recreates it.`);
}
async function checkOwnership(output: string, config: string, allowMissing = false): Promise<boolean> {
  if (!await exists(output)) return false;
  const stat = await lstat(output);
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw outputError('BUILD_OUTPUT_NOT_OWNED', `Build output ${output} is a ${stat.isSymbolicLink() ? 'symlink' : 'file'}, not a directory that agent-meshes created.`, 'Set "output" in the build config to a path that does not exist yet.');
  const markerPath = join(output, markerName);
  if (!await exists(markerPath) || !(await lstat(markerPath)).isFile() || (await lstat(markerPath)).isSymbolicLink()) {
    const entries = await readdir(output);
    // Nothing to lose: an empty directory is replaced by the build, which then marks it as owned.
    if (entries.length === 0) return true;
    const shown = entries.slice(0, 5).join(', ') + (entries.length > 5 ? `, and ${entries.length - 5} more` : '');
    throw outputError('BUILD_OUTPUT_NOT_OWNED', `Build output ${output} is not owned by agent-meshes: it holds ${entries.length} ${entries.length === 1 ? 'entry' : 'entries'} (${shown}) and no ${markerName} marker, and a build replaces its whole output directory.`, 'Set "output" in the build config to a different directory, or move or delete these entries.');
  }
  const marker = await readFile(markerPath, 'utf8').then(text => { try { return markerSchema.safeParse(JSON.parse(text)); } catch { return undefined; } });
  if (!marker?.success) throw outputError('BUILD_OUTPUT_NOT_OWNED', `Build output ${output} has an unreadable ${markerName} marker.`, 'Set "output" in the build config to a different directory, or delete this one if it holds no work.');
  const parsed = marker;
  if (parsed.data.config !== portable(relative(output, config))) throw outputError('BUILD_OUTPUT_OTHER_CONFIG', `Build output ${output} belongs to the build config ${resolve(output, parsed.data.config)}, not ${config}.`, 'Give each build config its own "output" directory.');
  await checkTree(output, parsed.data.files, allowMissing);
  return true;
}
/**
 * A GLB that declares `extras.encloses` (a glass helmet round a head) must hold it at every pose; null when
 * nothing is declared. A failure stops the build, like a validator error.
 */
async function checkEnclosures(bytes: Uint8Array): Promise<EnclosuresReport | null> {
  const report = await verifyEnclosures(bytes);
  if (!report.ok) throw new Error(`Enclosure check failed:\n${report.failures.join('\n')}`);
  return report.enclosures.length ? report : null;
}
async function move(source: string, destination: string): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try { await rename(source, destination); return; } catch (error) {
      if (attempt >= 5 || !['EPERM', 'EACCES', 'EBUSY'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
      await new Promise(resolve => setTimeout(resolve, 25 * 2 ** attempt));
    }
  }
}

/** Replace the receipt itself, never write through a path a decorator may have changed into a link. */
async function writeBuildReceipt(stage: string, name: 'authoring.json' | 'verification.json', receipt: unknown): Promise<void> {
  const destination = join(stage, name);
  if (await exists(destination)) {
    const info = await lstat(destination);
    if (!info.isFile() || info.nlink !== 1) throw new Error(`${name} must be a regular file without links`);
  }
  const temporary = join(stage, `.${name}-${randomUUID()}.tmp`);
  await writeFile(temporary, `${JSON.stringify(receipt, null, 2)}\n`, { flag: 'wx' });
  await move(temporary, destination);
}

export interface AuthoredAsset { name: string }
export interface BuildOptions {
  ifChanged?: boolean;
  force?: boolean;
  decorate?: (project: Project, stage: string) => Promise<string[]>;
  /** Renders of a Blender-authored GLB (stills and contact sheets), written into the stage before `decorateAsset`. */
  renderAsset?: (asset: AuthoredAsset, stage: string) => Promise<string[] | { files: string[]; warnings?: { code: string; message: string }[] }>;
  decorateAsset?: (asset: AuthoredAsset, stage: string) => Promise<string[]>;
}
export async function buildAsset(configPath: string, options: BuildOptions = {}, session?: NativeBuildSession): Promise<{ output: string; files: string[]; warnings?: (ProjectWarning | DetachedFinding | { code: string; message: string })[]; readAudit?: ReadAudit; incremental?: { blender: 'built' | 'reused'; reason: string; changedComponents?: string[] } }> {
  const configFile = await realpath(resolve(configPath));
  const loadedConfig = await loadBuildConfig(resolve(configPath));
  const config = configSchema.parse(loadedConfig.value);
  const incremental = options.ifChanged === true || options.force === true;
  if (incremental && !config.blender) throw new Error('Incremental Blender flags require a native blender.script build');
  const geometryTarget = config.target ? { target: config.target, renderVertexBudget: config.renderVertexBudget } : undefined;
  const input = await realpath(resolve(dirname(configFile), config.project ?? config.operations ?? config.blender!.script));
  const requestedOutput = resolve(dirname(configFile), config.output);
  // Resolve parent aliases, but never follow an output symlink into somebody else's directory.
  const output = join(await canonical(dirname(requestedOutput)), basename(requestedOutput));
  if (dirname(output) === output || loadedConfig.sources.some(file => inside(output, resolve(dirname(configFile), file.path))) || inside(output, input)) throw new Error('Build output cannot contain its config or input source');
  if (config.blender?.projectRoot !== undefined) await loadedConfig.assertPlainSources();
  const inputRoot = config.blender?.projectRoot !== undefined ? await captureBuildRoot({ configFile, projectRoot: config.blender.projectRoot, configurations: loadedConfig.sources, script: resolve(dirname(configFile), config.blender.script), output: requestedOutput }) : undefined;
  const inputs = config.blender ? await captureBuildInputs(configFile, input, config.blender.inputs ?? [], output, inputRoot?.base) : undefined;
  if (inputs && inputs.config.sha256 !== loadedConfig.leafSha256) throw new Error('Build config changed while reading');
  const tools = config.blender ? await captureBuildToolchain(undefined, output, session) : undefined;
  if (config.blender?.toolchain && tools) {
    // The actual Blender version is available only after the runner's completion report.
    const { blenderVersion: _blenderVersion, ...pin } = config.blender.toolchain;
    checkToolchainPin(pin, tools.identity);
  }
  await mkdir(dirname(output), { recursive: true });
  const lockPath = join(dirname(output), `.${basename(output)}.agent-meshes.lock`);
  const lock = await open(lockPath, 'wx').catch((error: NodeJS.ErrnoException) => { if (error.code === 'EEXIST') throw new Error('Build output is locked by another build in progress'); throw error; });
  let stage: string | undefined;
  let backup: string | undefined;
  try {
    await lock.writeFile(JSON.stringify({ config: configFile, pid: process.pid }));
    await checkOwnership(output, configFile, incremental);
    stage = await mkdtemp(join(dirname(output), `.${basename(output)}.stage-`));
    let files: string[];
    let finishAuthoring: (() => Promise<void>) | undefined;
    let incrementalResult: { blender: 'built' | 'reused'; reason: string; changedComponents?: string[] } | undefined;
    let readAudit: ReadAudit | undefined;
    const warnings: (ProjectWarning | DetachedFinding | { code: string; message: string })[] = [];
    /** The detached-part lint on the final GLB: always recorded; a failing verify.maxGap budget has already stopped the build. */
    const lintDetached = (bytes: Uint8Array, limits: { detached?: DetachedReport } | null): DetachedReport => {
      const report = limits?.detached ?? checkDetached(bytes, { allow: config.verify?.allowDetached });
      warnings.push(...report.findings);
      return report;
    };
    if (config.blender) {
      const environment = prepareBuildEnvironment(config.blender.environment?.inputs, process.env, process.platform, config.blender.environment?.overrides);
      const blender = findBlender();
      const prepared = incremental ? await prepareNativeCache(blender, { config: inputs!.config, configurations: loadedConfig.sources, inputs: inputs!.files, helpers: tools!.identity, script: input, configFile, inputRoot: inputRoot?.base }, output, stage, session, environment) : undefined;
      // A changed previously shared tool must not escape into fallback generation.
      if (session && !prepared?.cache) await session.assertUnchanged();
      const lookup = prepared?.cache && !options.force ? await prepared.cache.read(output) : undefined;
      const cached = lookup?.value;
      if (cached) await writeFile(join(stage, 'model.glb'), cached.bytes, { flag: 'wx' });
      const result = cached ?? await authorGLB(input, join(stage, 'model.glb'), prepared?.cache?.launch ?? { ...(blender ? { blender } : {}), env: environment.env, ...(environment.contract.mode === 'declared' ? { factoryStartup: true } : {}), pythonCachePrefix: join(stage, '.agent-meshes-python-imports') });
      readAudit = cached?.readAudit ?? classifyReadAudit(result.readAudit, { base: inputRoot?.base ?? dirname(configFile), ...(inputRoot ? { scope: 'project-root' } : {}), inputs: inputs!.files, helperRoot: fileURLToPath(new URL('../', import.meta.url)), helpers: tools!.files });
      if (config.blender.readAudit === 'strict' && readAudit.status !== 'clean') throw Object.assign(new Error(`READ_AUDIT_FAILED: ${readAudit.status}; undeclared reads: ${readAudit.undeclaredReads.join(', ') || '(none resolved)'}`), { code: 'READ_AUDIT_FAILED', readAudit });
      const cacheable = readAudit.status === 'clean';
      if (incremental) incrementalResult = { blender: cached ? 'reused' : 'built', reason: cached ? 'matching-native-cache' : options.force ? 'forced' : lookup?.reason ?? prepared!.reason, ...(lookup?.changedComponents ? { changedComponents: lookup.changedComponents } : {}) };
      if (incrementalResult && !cacheable) incrementalResult.reason = `read-audit-${readAudit.status}`;
      checkToolchainPin(config.blender.toolchain, { ...tools!.identity, blenderVersion: result.blender });
      const bytes = await readFile(join(stage, 'model.glb'));
      const recordVerification = async (current: Uint8Array) => {
        const verification = await verifyGLB(current, geometryTarget);
        if (!verification.ok) throw new Error(`Authored GLB verification failed with ${verification.errors} errors`);
        const enclosures = await checkEnclosures(current);
        const limits = checkBuildLimits(current, config.verify);
        warnings.length = 0;
        const detached = lintDetached(current, limits);
        await writeBuildReceipt(stage!, 'verification.json', { ...verification, ...(enclosures ? { enclosures } : {}), detached, ...(limits ? { limits } : {}) });
      };
      await recordVerification(bytes);
      files = ['model.glb', 'verification.json', 'authoring.json'];
      const receipt = {
        version: 1,
        source: { script: inputs!.entry.path, sha256: inputs!.entry.sha256 },
        blender: result.blender, meshes: result.meshes,
        provenance: {
          dependencyDiscovery: 'entry-and-declared-only', inputs: inputs!.files,
          ...(loadedConfig.sources.length > 1 ? { configurations: loadedConfig.sources } : {}),
          ...(inputRoot ? { inputRoot: inputRoot.receipt } : {}),
          ...(environment.contract.mode === 'declared' ? { environment: { ...environment.contract, sha256: createHash('sha256').update(JSON.stringify(Object.entries(environment.env).filter(([,value]) => value !== undefined).sort(([a],[b]) => a < b ? -1 : a > b ? 1 : 0))).digest('hex') } } : {}),
          readAudit: portableReadAudit(readAudit),
          ...(inputs!.trees.length ? { inputTrees: inputs!.trees } : {}),
          toolchain: { ...tools!.identity, blenderVersion: result.blender }, helpers: tools!.files,
          pins: { inputs: inputs!.pins, ...(inputs!.trees.length ? { inputTrees: inputs!.treePins } : {}), toolchain: config.blender.toolchain ?? null },
          output: { path: 'model.glb', sha256: createHash('sha256').update(bytes).digest('hex') },
        },
      };
      await writeBuildReceipt(stage, 'authoring.json', receipt);
      finishAuthoring = async () => {
        // Hash the final staged artifact after decoration, rather than an earlier runner buffer.
        const info = await lstat(join(stage!, 'model.glb'));
        if (!info.isFile() || info.nlink !== 1) throw new Error('Authored model.glb must be a regular file without links');
        const finalBytes = await readFile(join(stage!, 'model.glb'));
        const finalHash = createHash('sha256').update(finalBytes).digest('hex');
        if (finalHash !== receipt.provenance.output.sha256) await recordVerification(finalBytes);
        receipt.provenance.output.sha256 = finalHash;
        await writeBuildReceipt(stage!, 'authoring.json', receipt);
        if (prepared?.cache) {
          await prepared.cache.assertUnchanged();
          if (cacheable) files.push(...await prepared.cache.write(stage!, bytes, { ...result, readAudit: readAudit! }));
        } else if (session) await session.assertUnchanged();
      };
      const asset = { name: config.name ?? basename(input).replace(/\.[^.]+$/, '') };
      if (options.renderAsset) {
        // Renders are part of the owned output and run on the built GLB, so a cache hit renders the same bytes again.
        const rendered = await options.renderAsset(asset, stage);
        if (Array.isArray(rendered)) files.push(...rendered);
        else { files.push(...rendered.files); if (rendered.warnings) warnings.push(...rendered.warnings); }
      }
      if (options.decorateAsset) files.push(...await options.decorateAsset(asset, stage));
    } else {
      const source: unknown = JSON.parse(await readFile(input, 'utf8'));
      let project: Project;
      if (config.project) project = validateProject(source);
      else {
        if (!Array.isArray(source)) throw new Error('Operations input must be a JSON array');
        project = createProject(config.name ?? basename(configFile).replace(/\.[^.]+$/, ''));
        project = applyOperations(project, source);
      }
      warnings.push(...lintProject(project));
      let bytes = await exportGLB(project, { merge: config.merge });
      let verification = await verifyGLB(bytes, geometryTarget);
      if (!verification.ok) throw new Error(`GLB verification failed with ${verification.errors} errors`);
      if (config.refine) {
        // The refine pass is part of the recipe, so a missing Blender fails the build rather than quietly shipping a coarser model.
        if (!findBlender()) throw new Error('This build asks for a Blender refine pass but Blender is not installed');
        const raw = join(stage, 'model.raw.glb'), refined = join(stage, 'model.refined.glb');
        await writeFile(raw, bytes);
        await refineGLB(raw, refined, config.refine);
        bytes = new Uint8Array(await readFile(refined));
        await Promise.all([unlink(raw), unlink(refined)]);
        verification = await verifyGLB(bytes, geometryTarget);
        if (!verification.ok) throw new Error(`Refined GLB verification failed with ${verification.errors} errors`);
      }
      const enclosures = await checkEnclosures(bytes);
      const limits = checkBuildLimits(bytes, config.verify);
      const detached = lintDetached(bytes, limits);
      files = ['project.mesh.json', 'model.glb', 'verification.json'];
      await Promise.all([
        writeFile(join(stage, files[0]), `${JSON.stringify(project, null, 2)}\n`),
        writeFile(join(stage, files[1]), bytes),
        writeFile(join(stage, files[2]), `${JSON.stringify({ ...verification, ...(enclosures ? { enclosures } : {}), detached, ...(limits ? { limits } : {}) }, null, 2)}\n`),
      ]);
      if (options.decorate) files.push(...await options.decorate(structuredClone(project), stage));
    }
    checkFiles(files);
    if (finishAuthoring) await finishAuthoring();
    await writeFile(join(stage, markerName), `${JSON.stringify({ version: 1, generator: 'agent-meshes', config: portable(relative(output, configFile)), files }, null, 2)}\n`, { flag: 'wx' });
    await checkTree(stage, files);
    // Include config/entry/import/data changes and helper-tree additions/removals during authoring or decoration.
    if (tools) await tools.assertUnchanged();
    if (inputs) await inputs.assertUnchanged();
    await loadedConfig.assertUnchanged();
    if (inputRoot) { await loadedConfig.assertPlainSources(); await inputRoot.assertUnchanged(); }
    // Check again just before replacing, so files added during a long render are preserved.
    const owned = await checkOwnership(output, configFile, incremental);
    const earlier = owned ? await earlierPreviews(output) : [];
    if (owned) {
      backup = join(dirname(output), `.${basename(output)}.backup-${randomUUID()}`);
      await move(output, backup);
    }
    try { await move(stage, output); stage = undefined; }
    catch (error) { if (backup) { await move(backup, output); backup = undefined; } throw error; }
    if (backup) { await rm(backup, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); backup = undefined; }
    const removed = earlier.filter(file => !files.includes(file));
    if (removed.length) warnings.push({ code: 'BUILD_PREVIEWS_REMOVED', message: `Removed ${removed.length} preview ${removed.length === 1 ? 'file' : 'files'} of the earlier build from ${output}: ${removed.join(', ')}. A build replaces its whole output directory and this one did not write them again. Rebuild with previews on (omit --no-preview and --no-preview-page) to write fresh ones; restoring the old files from version control makes the next build refuse them as unowned (BUILD_OUTPUT_UNOWNED_FILE).` });
    if (readAudit && readAudit.status !== 'clean') warnings.push({ code: 'BLENDER_READ_AUDIT', message: `Python read audit ${readAudit.status}; native reuse disabled. Declare observed inputs: ${readAudit.undeclaredReads.join(', ') || '(audit incomplete)'}. Native file reads and dependency closure are not covered.` });
    return { output, files, ...(warnings.length ? { warnings } : {}), ...(readAudit ? { readAudit } : {}), ...(incrementalResult ? { incremental: incrementalResult } : {}) };
  } finally {
    if (stage) await rm(stage, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    await lock.close(); await unlink(lockPath);
  }
}
