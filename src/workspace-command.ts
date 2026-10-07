import { Workspace } from './workspace.ts';
import { createProject } from './core/model.ts';
import { inspectProject, planOperations, withWarnings } from './agent-contract.ts';
import { loadProject, saveProject } from './storage.ts';
import type { Project } from './core/types.ts';

export async function workspaceCommand(directory: string, path: string, body?: unknown, expectedRevision?: number) {
  const value = body as { name?: string; path?: string; operations?: unknown[]; selection?: string } | undefined;
  // Parse filesystem input before holding a synchronous write transaction.
  const opened = path === 'open' ? await loadProject(value?.path) : undefined;
  const workspace = new Workspace(directory);
  try {
    if (path === 'project' && body === undefined) return workspace.read();
    if (path === 'inspect') {
      const { project, ...state } = workspace.read();
      return { ...inspectProject(project, value?.selection), workspace: { directory: workspace.directory, ...state } };
    }
    if (path === 'plan') {
      const state = workspace.read();
      return { ...planOperations(state.project, value?.operations as unknown[]).report, revision: state.revision };
    }
    if (path === 'save') {
      const state = workspace.read(); await saveProject(value?.path, state.project); return state;
    }
    const result = workspace.transact(editor => {
      switch (path) {
        // A new project starts a clean history; the revision still counts up (it is the --expect-revision token).
        case 'new': editor.reset(createProject(value?.name as string)); break;
        case 'project': editor.replace(body as Project); break;
        case 'open': editor.replace(opened!); break;
        case 'op': editor.replace(planOperations(editor.project, [body]).project); break;
        case 'batch': {
          const planned = planOperations(editor.project, value?.operations as unknown[]);
          if (planned.report.operations) editor.replace(planned.project);
          break;
        }
        case 'undo': editor.undo(); break;
        case 'redo': editor.redo(); break;
        default: throw new Error(`Unsupported workspace command: ${path}`);
      }
    }, expectedRevision);
    return { ...result, ...withWarnings(result.project) };
  } finally { workspace.close(); }
}
