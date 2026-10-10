import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { Mesh } from 'three';
import { applyOperation, createProject } from '../src/core/model.ts';
import { exportGLB } from '../src/export.ts';
import { readAccessor, readGLB } from '../src/gltf-read.ts';
import { buildScene, createProject as runtimeCreateProject, disposeScene, validateProject } from '../src/runtime.ts';

const here = dirname(fileURLToPath(import.meta.url));
const entry = resolve(here, '../src/runtime.ts');

/** Every file reachable from `file` through static import/export-from statements, plus the bare specifiers they name. */
function closure(file: string, files = new Set<string>(), specifiers = new Set<string>()): { files: Set<string>; specifiers: Set<string> } {
  if (files.has(file)) return { files, specifiers };
  files.add(file);
  const source = readFileSync(file, 'utf8');
  for (const match of source.matchAll(/^\s*(?:import|export)\s+(?!type\b)[^;]*?from\s+['"]([^'"]+)['"]/gm)) {
    const spec = match[1];
    if (spec.startsWith('.')) closure(resolve(dirname(file), spec), files, specifiers);
    else specifiers.add(spec);
  }
  for (const match of source.matchAll(/^\s*import\s+['"]([^'"]+)['"]/gm)) specifiers.add(match[1]);
  for (const match of source.matchAll(/\bimport\(\s*['"]([^'"]+)['"]\s*\)/g)) specifiers.add(match[1]);
  return { files, specifiers };
}

it('the runtime entry reaches only browser-safe code: three and zod, no Node built-ins, no workspace or CLI modules', () => {
  const { files, specifiers } = closure(entry);
  const bare = [...specifiers].sort();
  // Anything that is not three, a three sub-path, or zod would be a new dependency in a game bundle.
  const allowed = (spec: string) => spec === 'three' || spec.startsWith('three/') || spec === 'zod';
  expect(bare.filter(spec => !allowed(spec))).toEqual([]);
  const names = [...files].map(file => file.replace(/\\/g, '/').split('/src/')[1]);
  for (const forbidden of ['workspace.ts', 'storage.ts', 'build.ts', 'capture.ts', 'server.ts', 'cli.ts', 'node-file-reader.ts', 'refine.ts', 'author.ts', 'export.ts']) {
    expect(names).not.toContain(forbidden);
  }
});

function shipProject() {
  let project = createProject('probe-ship');
  project = applyOperation(project, { op: 'add', part: { name: 'hull', geometry: { type: 'lathe', size: [1, 1, 1], segments: 24, profile: [[0, 0], [0.6, 0.4], [0.4, 3], [0, 3.4]], profileUnits: 'metres' }, color: '#8899aa' } });
  project = applyOperation(project, { op: 'add', part: { name: 'wing', geometry: { type: 'prism', size: [0.2, 1, 1.4], segments: 3, outline: [[0, 0], [1.4, 0.2], [0.3, 1]], outlineUnits: 'metres', axis: 'y' }, color: '#556677', position: [0.5, 0, 0.2] } });
  project = applyOperation(project, { op: 'add', part: { name: 'socket_engine', geometry: { type: 'group', size: [1, 1, 1], segments: 3 }, position: [0, 0, -0.1] } });
  return project;
}

it('builds the same parts the GLB exporter writes: same names, same vertex counts, sockets as empty groups', async () => {
  const project = shipProject();
  const scene = buildScene(project);
  try {
    const hull = scene.objects.get('hull');
    expect(hull).toBeInstanceOf(Mesh);
    expect(scene.objects.get('socket_engine')).not.toBeInstanceOf(Mesh);

    const doc = readGLB(await exportGLB(project));
    for (const name of ['hull', 'wing']) {
      const node = doc.json.nodes!.find(n => n.name === name)!;
      const primitive = doc.json.meshes![node.mesh!].primitives[0];
      const exported = readAccessor(doc, primitive.attributes.POSITION).count;
      const runtime = (scene.objects.get(name) as Mesh).geometry.getAttribute('position').count;
      expect(runtime, name).toBe(exported);
    }
  } finally {
    scene.dispose();
  }
});

it('re-exports the model API a game needs and nothing that touches the filesystem', () => {
  expect(typeof validateProject).toBe('function');
  expect(typeof disposeScene).toBe('function');
  expect(runtimeCreateProject('x').parts).toEqual([]);
});
