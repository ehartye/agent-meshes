import { accessSync, constants, statSync } from 'node:fs';
import { isAbsolute } from 'node:path';

/** Explicit opt-in only: never silently select a browser from PATH. */
export function browserLaunchOptions(env: NodeJS.ProcessEnv = process.env): { executablePath?: string } {
  const path = env.AGENT_MESHES_CHROMIUM_EXECUTABLE_PATH;
  if (path === undefined) return {};
  if (!path || !isAbsolute(path)) throw new Error('AGENT_MESHES_CHROMIUM_EXECUTABLE_PATH must be an absolute executable path');
  try {
    if (!statSync(path).isFile()) throw new Error('not a file');
    accessSync(path, constants.X_OK);
  } catch {
    throw new Error(`AGENT_MESHES_CHROMIUM_EXECUTABLE_PATH is not an executable file: ${path}`);
  }
  return { executablePath: path };
}
