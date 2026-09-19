import express from 'express';
import type { NextFunction, Request, Response } from 'express';
import { createServer as createHttpServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { createProject, validateProject, Editor } from './core/model.ts';
import type { Project } from './core/types.ts';
import { loadProject, saveProject } from './storage.ts';
import { capabilities, inspectProject, planOperations } from './agent-contract.ts';
import { Workspace, RevisionConflict } from './workspace.ts';
import { errorDetails } from './errors.ts';

export async function createServer(options: { port?: number; projectPath?: string; publicOrigin?: string; workspacePath?: string } = {}) {
  let publicOrigin: string | undefined;
  if (options.publicOrigin !== undefined) {
    const invalidOrigin = () => new Error('Public origin must be an HTTP(S) origin without credentials, path, query or fragment');
    let parsed: URL;
    try { parsed = new URL(options.publicOrigin); } catch { throw invalidOrigin(); }
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.pathname !== '/' || parsed.search || parsed.hash) throw invalidOrigin();
    publicOrigin = parsed.origin;
  }
  if (options.workspacePath && options.projectPath) throw new Error('Use either workspace or startup project; open a project into the workspace explicitly');
  const workspace = options.workspacePath ? new Workspace(options.workspacePath) : undefined;
  let workspaceState = workspace?.read();
  let editor = new Editor(workspaceState ? workspaceState.project : options.projectPath ? await loadProject(options.projectPath) : createProject('Untitled'));
  let revision = workspaceState?.revision ?? 0;
  let publishedRevision = revision;
  const app = express();
  const server = createHttpServer(app);
  const clients = new Set<Response>();
  let url = '';
  let queue = Promise.resolve();
  app.disable('x-powered-by');
  app.use((request, response, next) => {
    const origin = request.headers.origin;
    if (origin && origin !== url && origin !== publicOrigin) {
      response.status(403).json({ error: 'Cross-origin requests are not allowed' });
      return;
    }
    next();
  });
  app.use(express.json({ limit: '10mb' }));
  const refresh = () => {
    if (workspace && workspace.revision() !== revision) {
      workspaceState = workspace.read(); revision = workspaceState.revision; editor = new Editor(workspaceState.project); return true;
    }
    return false;
  };
  const publish = () => {
    publishedRevision = revision;
    const message = `data: ${JSON.stringify(editor.project)}\n\n`;
    for (const client of clients) client.write(message);
  };
  const mutate = (path: string, action: (request: Request, candidate: Editor, prepared?: Project) => void, prepare?: (request: Request) => Promise<Project>) => {
    app.post(`/api/${path}`, (request, response, next) => {
      const operation = queue.then(async () => {
        const prepared = await prepare?.(request);
        const expected = request.headers['x-agent-meshes-revision'];
        if (expected !== undefined && (!workspace || typeof expected !== 'string' || !/^\d+$/.test(expected))) throw new Error('Revision checks require a workspace and a nonnegative integer revision');
        if (workspace) {
          const result = workspace.transact(candidate => action(request, candidate, prepared), expected === undefined ? undefined : Number(expected));
          workspaceState = result;
          editor = new Editor(result.project); revision = result.revision;
          response.setHeader('x-agent-meshes-revision', String(revision));
        } else {
          const candidate = Editor.restore(editor.snapshot()); action(request, candidate, prepared); editor = candidate;
        }
        publish();
        response.json(editor.project);
      });
      queue = operation.catch(() => {});
      operation.catch(next);
    });
  };
  app.get('/api/health', (_request, response) => response.json({ service: 'agent-meshes', version: '0.1.0' }));
  app.get('/api/project', async (_request, response) => { await queue; refresh(); if (workspace) response.setHeader('x-agent-meshes-revision', String(revision)); response.json(editor.project); });
  const workspaceInfo = () => {
    if (!workspace) return null;
    return { directory: workspace.directory, revision: workspaceState!.revision, undo: workspaceState!.undo, redo: workspaceState!.redo };
  };
  app.get('/api/workspace', async (_request, response) => { await queue; refresh(); response.json(workspaceInfo()); });
  app.get('/api/capabilities', (_request, response) => response.json(capabilities()));
  app.get('/api/inspect', async (request, response) => { await queue; refresh(); response.json({ ...inspectProject(editor.project, typeof request.query.select === 'string' ? request.query.select : undefined), workspace: workspaceInfo() }); });
  app.post('/api/plan', async (request, response) => {
    await queue; refresh();
    if (!Array.isArray(request.body?.operations)) throw new Error('operations must be an array');
    response.json({ ...planOperations(editor.project, request.body.operations).report, ...(workspace ? { revision } : {}) });
  });
  app.get('/api/events', async (_request, response) => {
    await queue; refresh();
    response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
    response.write(`data: ${JSON.stringify(editor.project)}\n\n`);
    clients.add(response);
    response.on('close', () => clients.delete(response));
  });
  mutate('new', (request, candidate) => {
    if (typeof request.body?.name !== 'string' || !request.body.name.trim()) throw new Error('A project name is required');
    candidate.replace(createProject(request.body.name));
  });
  mutate('op', (request, candidate) => { candidate.replace(planOperations(candidate.project, [request.body]).project); });
  mutate('project', (request, candidate) => { candidate.replace(validateProject(request.body)); });
  mutate('batch', (request, candidate) => {
    if (!Array.isArray(request.body?.operations)) throw new Error('operations must be an array');
    const planned = planOperations(candidate.project, request.body.operations);
    if (request.body.operations.length) candidate.replace(planned.project);
  });
  mutate('undo', (_request, candidate) => { candidate.undo(); });
  mutate('redo', (_request, candidate) => { candidate.redo(); });
  app.post('/api/save', (request, response, next) => {
    const operation = queue.then(async () => { refresh(); await saveProject(request.body?.path, editor.project); response.json(editor.project); });
    queue = operation.catch(() => {}); operation.catch(next);
  });
  mutate('open', (_request, candidate, prepared) => { candidate.replace(prepared!); }, request => loadProject(request.body?.path));
  app.post('/api/export', async (_request, response, next) => {
    try {
      await queue;
      refresh();
      const project = editor.project;
      const { exportGLB } = await import('./export.ts');
      const bytes = await exportGLB(project);
      response.type('model/gltf-binary').send(Buffer.from(bytes));
    } catch (error) { next(error); }
  });
  app.use('/api', (_request, response) => { response.status(404).json({ error: 'Unknown API route' }); });
  app.use(express.static(fileURLToPath(new URL('../dist-web/', import.meta.url))));
  app.use((error: Error, _request: Request, response: Response, _next: NextFunction) => {
    response.status(error instanceof RevisionConflict ? 409 : 400).json({ error: error.message, details: errorDetails(error) });
  });
  try { await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port ?? 3388, '127.0.0.1', () => {
      server.off('error', reject);
      const address = server.address();
      if (!address || typeof address === 'string') { reject(new Error('No listening address')); return; }
      url = `http://127.0.0.1:${address.port}`;
      resolve();
    });
  }); } catch (error) { workspace?.close(); throw error; }
  const poll = workspace ? setInterval(() => {
    // Revision polling is a single scalar query; only changed state is rebuilt/published.
    queue = queue.then(() => { refresh(); if (revision !== publishedRevision) publish(); }).catch(() => {});
  }, 500) : undefined;
  poll?.unref();
  let closed = false;
  return { server, url, close: async () => {
    if (closed) return; closed = true; clearInterval(poll);
    await queue;
    for (const client of clients) client.end();
    await new Promise<void>((resolve, reject) => {
      server.close(error => error ? reject(error) : resolve());
      server.closeAllConnections();
    });
    workspace?.close();
  } };
}
