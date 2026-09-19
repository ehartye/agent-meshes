import { Command } from 'commander';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Project } from './core/types.ts';

export async function main(args = process.argv): Promise<void> {
  const program = new Command();
  program.name('agent-meshes').description('Named-part 3D authoring').version('0.1.0')
    .option('--url <url>', 'Running authoring server URL', 'http://127.0.0.1:3388');
  const requestRaw = async (path: string, body?: unknown) => {
    const base = String(program.opts().url).replace(/\/$/, '');
    const health = await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(5000) });
    const identity = await health.json() as { service?: string; version?: string };
    if (!health.ok || identity.service !== 'agent-meshes' || identity.version !== '0.1.0') {
      throw new Error('Endpoint is not an agent-meshes server with protocol version 0.1.0');
    }
    const response = await fetch(`${base}/api/${path}`, {
      ...(body === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(30000),
    });
    if (!response.ok) { const value = await response.json() as { error?: string }; throw new Error(value.error ?? `Server returned ${response.status}`); }
    return response;
  };
  const request = async (path: string, body?: unknown) => {
    const value = await (await requestRaw(path, body)).json();
    process.stdout.write(`${JSON.stringify(value)}\n`);
  };
  program.command('serve').description('Start the loopback authoring server')
    .option('--port <port>', 'Listening port', '3388').option('--project <file>', 'Project to open')
    .action(async options => {
      const { createServer } = await import('./server.ts');
      const port = Number(options.port);
      if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('Port must be an integer from 0 to 65535');
      const server = await createServer({ port, projectPath: options.project });
      process.stdout.write(`${JSON.stringify({ service: 'agent-meshes', url: server.url })}\n`);
      const shutdown = async () => { await server.close(); process.exitCode = 0; };
      process.once('SIGINT', shutdown);
      process.once('SIGTERM', shutdown);
    });
  program.command('new <name>').action(name => request('new', { name }));
  program.command('state').action(() => request('project'));
  program.command('op <json>').action(json => request('op', JSON.parse(json)));
  program.command('batch <file>').action(async file => {
    const value = JSON.parse(await readFile(file, 'utf8'));
    return request('batch', { operations: Array.isArray(value) ? value : value.operations });
  });
  program.command('save <file>').action(file => request('save', { path: resolve(file) }));
  program.command('open <file>').action(file => request('open', { path: resolve(file) }));
  program.command('undo').action(() => request('undo', {}));
  program.command('redo').action(() => request('redo', {}));
  program.command('export <file>').description('Export the current project as animated GLB').action(async file => {
    const bytes = new Uint8Array(await (await requestRaw('export', {})).arrayBuffer());
    const output = resolve(file); await mkdir(dirname(output), { recursive: true }); await writeFile(output, bytes);
    process.stdout.write(`${JSON.stringify({ output, bytes: bytes.length })}\n`);
  });
  program.command('verify <file>').description('Validate an exported GLB without a server').action(async file => {
    const { verifyGLB } = await import('./export.ts');
    const result = await verifyGLB(await readFile(file)); process.stdout.write(`${JSON.stringify(result)}\n`);
    if (!result.ok) process.exitCode = 1;
  });
  program.command('view <directory>').description('Render fixed views and animation contact sheets').action(async directory => {
    const project = await (await requestRaw('project')).json() as Project;
    const { captureProject } = await import('./capture.ts'); const output = resolve(directory);
    const files = await captureProject(project, output); process.stdout.write(`${JSON.stringify({ output, files })}\n`);
  });
  program.command('build <config>').description('Build an isolated, verified asset project').option('--no-preview', 'Skip browser renders and standalone preview').action(async (config, options) => {
    const { buildAsset } = await import('./build.ts');
    const decorate = options.preview ? (await import('./capture.ts')).decorateBuild : undefined;
    process.stdout.write(`${JSON.stringify(await buildAsset(config, { decorate }))}\n`);
  });
  try {
    await program.parseAsync(args);
  } catch (error) {
    process.stderr.write(`Error: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
