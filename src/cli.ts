import { Command, CommanderError, InvalidArgumentError } from 'commander';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Project } from './core/types.ts';
import { capabilities } from './agent-contract.ts';
import { errorDetails } from './errors.ts';

export async function main(args = process.argv): Promise<void> {
  const program = new Command();
  const print = (value: unknown) => { process.stdout.write(`${JSON.stringify(value)}\n`); };
  program.exitOverride().configureOutput({ writeErr: () => {} });
  program.name('agent-meshes').description('Named-part 3D authoring').version('0.1.0')
    .option('--url <url>', 'Running authoring server URL', 'http://127.0.0.1:3388')
    .option('--workspace <directory>', 'Durable local workspace; no running server required')
    .option('--expect-revision <revision>', 'Require this workspace revision before mutation', value => {
      if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value))) throw new InvalidArgumentError('Revision must be a nonnegative safe integer');
      return Number(value);
    });
  program.hook('preAction', () => {
    if (program.opts().workspace !== undefined && program.getOptionValueSource('url') === 'cli') {
      throw Object.assign(new Error('--workspace and --url cannot be used together'), { code: 'CLI_ARGUMENT_ERROR' });
    }
  });
  const requestRaw = async (path: string, body?: unknown) => {
    const base = String(program.opts().url).replace(/\/$/, '');
    const health = await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(5000) });
    const identity = await health.json() as { service?: string; version?: string };
    if (!health.ok || identity.service !== 'agent-meshes' || identity.version !== '0.1.0') {
      throw Object.assign(new Error('Endpoint is not an agent-meshes server with protocol version 0.1.0'), { code: 'SERVICE_MISMATCH' });
    }
    const response = await fetch(`${base}/api/${path}`, {
      ...(body === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json', ...(program.opts().expectRevision === undefined ? {} : { 'x-agent-meshes-revision': String(program.opts().expectRevision) }) }, body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(30000),
    });
    if (!response.ok) {
      const value = await response.json() as { error?: string; details?: Record<string, unknown> };
      throw Object.assign(new Error(value.error ?? `Server returned ${response.status}`), value.details ?? {});
    }
    return response;
  };
  const requestValue = async (path: string, body?: unknown): Promise<unknown> => {
    if (program.opts().workspace !== undefined) {
      const { workspaceCommand } = await import('./workspace-command.ts');
      return workspaceCommand(program.opts().workspace, path, body, program.opts().expectRevision);
    }
    return (await requestRaw(path, body)).json();
  };
  const request = async (path: string, body?: unknown) => { print(await requestValue(path, body)); };
  const currentProject = async () => {
    const value = await requestValue('project');
    return (program.opts().workspace === undefined ? value : (value as { project: Project }).project) as Project;
  };
  program.command('capabilities').description('Print versioned JSON operation schemas, examples and constraints').action(() => print(capabilities()));
  program.command('inspect [selector]').description('Summarize the project or inspect a named part, bone or clip').action(async selector => {
    if (program.opts().workspace !== undefined) await request('inspect', { selection: selector });
    else await request(`inspect${selector ? `?select=${encodeURIComponent(selector)}` : ''}`);
  });
  program.command('serve').description('Start the loopback authoring server')
    .option('--port <port>', 'Listening port', '3388').option('--project <file>', 'Project to open')
    .option('--public-origin <origin>', 'Exact browser origin of a trusted reverse proxy')
    .action(async options => {
      const { createServer } = await import('./server.ts');
      const port = Number(options.port);
      if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('Port must be an integer from 0 to 65535');
      const server = await createServer({ port, projectPath: options.project, publicOrigin: options.publicOrigin, workspacePath: program.opts().workspace });
      process.stdout.write(`${JSON.stringify({ service: 'agent-meshes', url: server.url })}\n`);
      const shutdown = async () => { await server.close(); process.exitCode = 0; };
      process.once('SIGINT', shutdown);
      process.once('SIGTERM', shutdown);
    });
  program.command('new <name>').action(name => request('new', { name }));
  program.command('recipe <kind>').description('Load biped, equine, vulpine, insectoid, arachnid or strandbeest (quadruped aliases vulpine)')
    .option('--gaits <list>', 'Comma-separated clips for equine or vulpine: walk, trot, gallop (default walk,trot)')
    .option('--shell', 'Equine or vulpine: blend every part into one smooth skin with lathe hooves')
    .option('--leg-phases <json>', 'Insectoid: JSON object of clip name to six touchdown phases (0 to 1) in leg order L1 L2 L3 R1 R2 R3')
    .option('--pairs <count>', 'Strandbeest: crank positions on the crankshaft, four legs each (default 3, at most 5)')
    .option('--spacing <meters>', 'Strandbeest: distance between crank positions (default 0.42)')
    .option('--patterns <json>', 'Strandbeest: JSON object of clip name to one crank offset (0 to 1) per crank position').action(async (kind, options) => {
    const { createCreature } = await import('./recipes/index.ts');
    await request('project', createCreature(kind, { ...(options.gaits ? { gaits: String(options.gaits).split(',').map((g: string) => g.trim()) } : {}), ...(options.shell ? { shell: true } : {}), ...(options.legPhases ? { legPhases: JSON.parse(String(options.legPhases)) } : {}), ...(options.pairs ? { pairs: Number(options.pairs) } : {}), ...(options.spacing ? { spacing: Number(options.spacing) } : {}), ...(options.patterns ? { patterns: JSON.parse(String(options.patterns)) } : {}) }));
  });
  program.command('state').action(() => request('project'));
  program.command('op <json>').action(json => request('op', JSON.parse(json)));
  program.command('batch <file>').option('--dry-run', 'Validate and report changes without saving or adding undo history').action(async (file, options) => {
    const value = JSON.parse(await readFile(file, 'utf8'));
    return request(options.dryRun ? 'plan' : 'batch', { operations: Array.isArray(value) ? value : value?.operations });
  });
  program.command('save <file>').action(file => request('save', { path: resolve(file) }));
  program.command('open <file>').action(file => request('open', { path: resolve(file) }));
  program.command('undo').action(() => request('undo', {}));
  program.command('redo').action(() => request('redo', {}));
  program.command('export <file>').description('Export the current project as animated GLB').action(async file => {
    const bytes = program.opts().workspace === undefined
      ? new Uint8Array(await (await requestRaw('export', {})).arrayBuffer())
      : await (await import('./export.ts')).exportGLB(await currentProject());
    const output = resolve(file); await mkdir(dirname(output), { recursive: true }); await writeFile(output, bytes);
    process.stdout.write(`${JSON.stringify({ output, bytes: bytes.length })}\n`);
  });
  program.command('verify <file>').description('Validate an exported GLB without a server; --contract arkit-face/1 also checks the face-rig contract')
    .option('--contract <name>', 'Also check a rig contract (arkit-face/1)').action(async (file, options) => {
    if (options.contract !== undefined) {
      const { contractExpectations } = await import('./arkit-face.ts');
      contractExpectations(String(options.contract));
      const { verifyFaceContract } = await import('./face-contract.ts');
      const report = await verifyFaceContract(await readFile(file));
      process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
      if (!report.ok) {
        const failed = report.checks.filter(check => !check.ok).length;
        process.stderr.write(`${report.contract}: ${failed} check${failed === 1 ? '' : 's'} failed\n${report.failures.map(line => `FAIL ${line}`).join('\n')}\n`);
        process.exitCode = 1;
      }
      return;
    }
    const { verifyGLB } = await import('./export.ts');
    const result = await verifyGLB(await readFile(file)); process.stdout.write(`${JSON.stringify(result)}\n`);
    if (!result.ok) process.exitCode = 1;
  });
  program.command('verify-unreal <file>').description('Import a GLB into a scratch Unreal project headlessly (Interchange) and report what Unreal created; import only, no runtime render')
    .option('--contract <name>', 'Require a rig contract\'s names verbatim, for example arkit-face/1')
    .option('--expect-morphs <list>', 'Comma-separated morph target names that must survive verbatim')
    .option('--expect-bones <list>', 'Comma-separated bone names that must exist')
    .option('--timeout <seconds>', 'Stop Unreal after this long (first runs compile shaders)', '1800')
    .option('--log <file>', 'Write the Unreal log here instead of the cache Logs directory')
    .option('--json', 'Print only one compact JSON line: no progress or pretty-printing').action(async (file, options) => {
    const unreal = await import('./unreal.ts');
    const { contractExpectations } = await import('./arkit-face.ts');
    const base = options.contract ? contractExpectations(String(options.contract)) : { morphs: [], bones: [], parents: {} };
    const timeout = Number(options.timeout);
    if (!Number.isFinite(timeout) || timeout <= 0) throw Object.assign(new Error('--timeout must be a positive number of seconds'), { code: 'CLI_ARGUMENT_ERROR' });
    const morphs = [...new Set([...base.morphs, ...(options.expectMorphs ? unreal.parseNameList(String(options.expectMorphs)) : [])])];
    const bones = [...new Set([...base.bones, ...(options.expectBones ? unreal.parseNameList(String(options.expectBones)) : [])])];
    const report = await unreal.verifyUnreal(resolve(file), {
      morphs, bones, parents: base.parents, requireSkeletalMesh: Boolean(options.contract) || morphs.length > 0 || bones.length > 0, singleSkeletalMesh: Boolean(options.contract),
      ...(options.contract ? { contract: String(options.contract) } : {}), timeoutMs: timeout * 1000,
      ...(options.log ? { logFile: resolve(options.log) } : {}), quiet: Boolean(options.json),
    });
    process.stdout.write(`${options.json ? JSON.stringify(report) : JSON.stringify(report, null, 2)}\n`);
    if (!report.ok) process.exitCode = 1;
  });
  program.command('refine <input> <output>').description('Optional Blender stage: subdivide, smooth and displace a GLB, keeping bones and clips')
    .option('--subdivide <levels>', 'Subdivision surface levels', '1')
    .option('--noise <strength>', 'Displacement strength from a clouds texture, in meters', '0')
    .option('--noise-scale <size>', 'Clouds texture scale', '0.12')
    .option('--only <names>', 'Comma-separated mesh names to refine; others pass through').action(async (input, output, options) => {
    const { refineGLB } = await import('./refine.ts');
    const result = await refineGLB(input, output, { subdivide: Number(options.subdivide), noise: Number(options.noise), noiseScale: Number(options.noiseScale), only: options.only ? String(options.only).split(',') : undefined });
    process.stdout.write(`${JSON.stringify(result)}\n`);
  });
  program.command('viewer <file>').description('Write the standalone viewer runtime: one script defining window.MeshViewer.mount()').action(async file => {
    const { viewerScript } = await import('./preview-html.ts');
    const code = await viewerScript(); const output = resolve(file);
    await mkdir(dirname(output), { recursive: true }); await writeFile(output, code);
    process.stdout.write(`${JSON.stringify({ output, bytes: Buffer.byteLength(code) })}\n`);
  });
  program.command('mobile-physics <file>').description('Write optional offline hanging-mobile physics: window.MobilePhysics, without a renderer').action(async file => {
    const { mobilePhysicsScript } = await import('./preview-html.ts');
    const code = await mobilePhysicsScript(); const output = resolve(file);
    await mkdir(dirname(output), { recursive: true }); await writeFile(output, code);
    process.stdout.write(`${JSON.stringify({ output, bytes: Buffer.byteLength(code) })}\n`);
  });
  program.command('view <directory>').description('Render fixed views and animation contact sheets').action(async directory => {
    const project = await currentProject();
    const { captureProject } = await import('./capture.ts'); const output = resolve(directory);
    const files = await captureProject(project, output); process.stdout.write(`${JSON.stringify({ output, files })}\n`);
  });
  program.command('build <config>').description('Build an isolated, verified project or Blender-authored asset')
    .option('--no-preview', 'Skip browser renders and the standalone preview page')
    .option('--no-preview-page', 'Keep the PNG renders and contact sheets but skip the standalone preview.html').action(async (config, options) => {
    const { buildAsset } = await import('./build.ts');
    const decorate = (await import('./capture.ts')).decoratorFor({ preview: options.preview, previewPage: options.previewPage });
    const decorateAsset = options.preview && options.previewPage ? async (asset: { name: string }, stage: string): Promise<string[]> => {
      const { previewHTML } = await import('./preview-html.ts');
      await writeFile(resolve(stage, 'preview.html'), await previewHTML(asset.name, await readFile(resolve(stage, 'model.glb'))));
      return ['preview.html'];
    } : undefined;
    process.stdout.write(`${JSON.stringify(await buildAsset(config, { decorate, decorateAsset }))}\n`);
  });
  try {
    await program.parseAsync(args);
  } catch (error) {
    if (error instanceof CommanderError && error.exitCode === 0) return;
    process.stderr.write(`${JSON.stringify({ ok: false, error: errorDetails(error) })}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
