import { readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { validateProject } from './core/model.ts';
import type { Project } from './core/types.ts';

export function projectPath(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.includes('\0')) throw new Error('A nonempty project path is required');
  return resolve(value);
}

export async function loadProject(path: unknown): Promise<Project> {
  return validateProject(JSON.parse(await readFile(projectPath(path), 'utf8')));
}

export async function saveProject(path: unknown, project: Project): Promise<void> {
  const destination = projectPath(path);
  const temporary = `${destination}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(validateProject(project), null, 2)}\n`, { flag: 'wx' });
    await rename(temporary, destination);
  } finally {
    await unlink(temporary).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error;
    });
  }
}
