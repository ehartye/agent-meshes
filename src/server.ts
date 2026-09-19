import express from 'express';
import type { NextFunction, Request, Response } from 'express';
import { createServer as createHttpServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { createProject, validateProject, applyOperation, Editor } from './core/model.ts';
import type { Operation } from './core/types.ts';
import { loadProject, saveProject } from './storage.ts';

export async function createServer(options: { port?: number; projectPath?: string } = {}) {
  let editor = new Editor(options.projectPath ? await loadProject(options.projectPath) : createProject('Untitled'));
  const app = express();
  const server = createHttpServer(app);
  const clients = new Set<Response>();
  let url = '';
  let queue = Promise.resolve();
  app.disable('x-powered-by');
  app.use((request, response, next) => {
    const origin = request.headers.origin;
    if (origin && origin !== url) {
      response.status(403).json({ error: 'Cross-origin requests are not allowed' });
      return;
    }
    next();
  });
  app.use(express.json({ limit: '10mb' }));
  const publish = () => {
    const message = `data: ${JSON.stringify(editor.project)}\n\n`;
    for (const client of clients) client.write(message);
  };
  const mutate = (path: string, action: (request: Request) => void | Promise<void>, changed = true) => {
    app.post(`/api/${path}`, (request, response, next) => {
      const operation = queue.then(async () => {
        await action(request);
        if (changed) publish();
        response.json(editor.project);
      });
      queue = operation.catch(() => {});
      operation.catch(next);
    });
  };
  app.get('/api/health', (_request, response) => response.json({ service: 'agent-meshes', version: '0.1.0' }));
  app.get('/api/project', async (_request, response) => { await queue; response.json(editor.project); });
  app.get('/api/events', (_request, response) => {
    response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
    response.write(`data: ${JSON.stringify(editor.project)}\n\n`);
    clients.add(response);
    response.on('close', () => clients.delete(response));
  });
  mutate('new', request => {
    if (typeof request.body?.name !== 'string' || !request.body.name.trim()) throw new Error('A project name is required');
    editor = new Editor(createProject(request.body.name));
  });
  mutate('op', request => { editor.apply(request.body); });
  mutate('project', request => { editor.replace(validateProject(request.body)); });
  mutate('batch', request => {
    if (!Array.isArray(request.body?.operations)) throw new Error('operations must be an array');
    const operations = request.body.operations as Operation[];
    let candidate = editor.project;
    for (const operation of operations) candidate = applyOperation(candidate, operation);
    validateProject(candidate);
    if (operations.length) editor.replace(candidate);
  });
  mutate('undo', () => { editor.undo(); });
  mutate('redo', () => { editor.redo(); });
  mutate('save', async request => { await saveProject(request.body?.path, editor.project); }, false);
  mutate('open', async request => { editor = new Editor(await loadProject(request.body?.path)); });
  app.use('/api', (_request, response) => { response.status(404).json({ error: 'Unknown API route' }); });
  app.use(express.static(fileURLToPath(new URL('../dist-web/', import.meta.url))));
  app.use((error: Error, _request: Request, response: Response, _next: NextFunction) => {
    response.status(400).json({ error: error.message });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port ?? 3388, '127.0.0.1', () => {
      server.off('error', reject);
      const address = server.address();
      if (!address || typeof address === 'string') { reject(new Error('No listening address')); return; }
      url = `http://127.0.0.1:${address.port}`;
      resolve();
    });
  });
  return { server, url, close: async () => {
    await queue;
    for (const client of clients) client.end();
    await new Promise<void>((resolve, reject) => {
      server.close(error => error ? reject(error) : resolve());
      server.closeAllConnections();
    });
  } };
}
