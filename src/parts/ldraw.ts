import { readFile, readdir, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { createHash } from 'node:crypto';
import { Box3, Group, LoadingManager, Matrix4, Mesh, Vector3 } from 'three';
import { LDrawLoader } from 'three/examples/jsm/loaders/LDrawLoader.js';
import { LDrawConditionalLineMaterial } from 'three/examples/jsm/materials/LDrawConditionalLineMaterial.js';

export type Vector = [number, number, number];
export interface Bounds { min: Vector; max: Vector }
export interface PartSource { file: string; sha256: string; authors: string[]; licenses: string[] }
export const ldrawMetersPerUnit = 0.0004;
export const boundsJSON = (box: Box3): Bounds => ({ min: box.min.toArray() as Vector, max: box.max.toArray() as Vector });
export function inside(directory: string, path: string): boolean {
  const rel = relative(directory, path);
  return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`));
}
function safeReference(value: string): string {
  const name = value.replaceAll('\\', '/').toLowerCase();
  if (!name || isAbsolute(name) || /[:\0\r\n]/.test(name) || name.split('/').some(piece => !piece || piece === '.' || piece === '..')) throw new Error(`Unsafe LDraw reference: ${value}`);
  return name;
}

/** Resolve and pack a complete local dependency closure before Three sees any input. */
export async function loadLDrawPart(libraryPath: string, partId: string, color: number): Promise<{ group: Group; sourceBounds: Bounds; sourceCenter: Vector; sources: PartSource[] }> {
  const library = await realpath(libraryPath), packed = new Map<string, string>(), active = new Set<string>(), sources: PartSource[] = [];
  async function locate(reference: string, parent?: string): Promise<string> {
    const name = safeReference(reference);
    const candidates = [resolve(library, 'parts', name), resolve(library, 'p', name), resolve(library, name), ...(parent ? [resolve(dirname(parent), name)] : [])];
    for (const candidate of candidates) {
      if (!inside(library, candidate)) throw new Error(`Unsafe LDraw reference: ${reference}`);
      try {
        const actual = await realpath(candidate);
        if (!inside(library, actual)) throw new Error(`Unsafe LDraw symlink: ${reference}`);
        return actual;
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    }
    throw new Error(`Missing LDraw dependency: ${reference}`);
  }
  async function visit(reference: string, parent?: string): Promise<string> {
    const path = await locate(reference, parent), key = relative(library, path).split(sep).join('/').toLowerCase();
    if (active.has(key)) throw new Error(`LDraw dependency cycle at ${key}`);
    if (packed.has(key)) return key;
    active.add(key);
    const raw = await readFile(path, 'utf8'), lines = raw.replaceAll('\r', '').split('\n'), rewritten: string[] = [];
    for (const line of lines) {
      const tokens = line.trim().split(/\s+/);
      if (tokens[0] === '0' && ['FILE', 'NOFILE', '!TEXMAP', '!DATA'].includes(tokens[1])) throw new Error(`Unsupported embedded file or texture directive in ${key}`);
      if (tokens[0] === '1') {
        if (tokens.length < 15 || tokens.slice(2, 14).some(value => !Number.isFinite(Number(value)))) throw new Error(`Invalid LDraw transform in ${key}`);
        const dependency = await visit(tokens.slice(14).join(' '), path);
        rewritten.push(`${tokens.slice(0, 14).join(' ')} ${dependency}`);
      } else rewritten.push(line);
    }
    sources.push({ file: key, sha256: createHash('sha256').update(raw).digest('hex'), authors: lines.filter(line => /^0\s+Author:/.test(line)).map(line => line.replace(/^0\s+Author:\s*/, '')), licenses: lines.filter(line => /^0\s+!LICENSE/.test(line)).map(line => line.replace(/^0\s+!LICENSE\s*/, '')) });
    active.delete(key); packed.set(key, rewritten.join('\n')); return key;
  }
  const entry = await visit(partId);
  const configName = (await readdir(library)).find(name => name.toLowerCase() === 'ldconfig.ldr');
  if (!configName) throw new Error('Missing LDraw color configuration: LDConfig.ldr');
  const configPath = await realpath(resolve(library, configName));
  if (!inside(library, configPath)) throw new Error('Unsafe LDraw color configuration symlink');
  const config = await readFile(configPath, 'utf8');
  const colors = config.split(/\r?\n/).filter(line => /^0\s+!COLOUR\s/.test(line));
  if (!colors.some(line => new RegExp(`\\bCODE\\s+${color}\\b`).test(line))) throw new Error(`Unknown LDraw color: ${color}`);
  sources.push({ file: 'LDConfig.ldr', sha256: createHash('sha256').update(config).digest('hex'), authors: [], licenses: config.split(/\r?\n/).filter(line => /^0\s+!LICENSE/.test(line)).map(line => line.replace(/^0\s+!LICENSE\s*/, '')) });
  const manager = new LoadingManager();
  manager.setURLModifier(url => { throw new Error(`Unexpected external LDraw request: ${url}`); });
  const loader = new LDrawLoader(manager).setConditionalLineMaterial(LDrawConditionalLineMaterial);
  const document = [`0 FILE assembly-root.ldr`, ...colors, `1 ${color} 0 0 0 1 0 0 0 1 0 0 0 1 ${entry}`, ...[...packed].flatMap(([name, text]) => [`0 FILE ${name}`, text])].join('\n');
  const parsed = await new Promise<Group>((accept, reject) => loader.parse(document, accept, reject));
  parsed.updateMatrixWorld(true);
  const group = new Group();
  // 180 degrees about X is a proper rotation: source -Y becomes +Y and source +Z becomes -Z.
  const conversion = new Matrix4().makeScale(ldrawMetersPerUnit, -ldrawMetersPerUnit, -ldrawMetersPerUnit);
  parsed.traverse(object => {
    if (!(object instanceof Mesh)) return;
    const mesh = new Mesh(object.geometry.clone(), object.material);
    const transform = new Matrix4().multiplyMatrices(conversion, object.matrixWorld);
    mesh.geometry.applyMatrix4(transform);
    // Baking a reflection removes Three's object-level front-face correction.
    if (transform.determinant() < 0) {
      const count = mesh.geometry.getAttribute('position').count;
      const indices = mesh.geometry.index ? Array.from(mesh.geometry.index.array) : Array.from({ length: count }, (_, i) => i);
      for (let i = 0; i < indices.length; i += 3) [indices[i + 1], indices[i + 2]] = [indices[i + 2], indices[i + 1]];
      mesh.geometry.setIndex(indices);
    }
    group.add(mesh);
  });
  const bounds = new Box3().setFromObject(group);
  if (bounds.isEmpty() || [...bounds.min.toArray(), ...bounds.max.toArray()].some(value => !Number.isFinite(value))) throw new Error(`LDraw part has no finite surfaces: ${partId}`);
  const center = bounds.getCenter(new Vector3());
  for (const object of group.children) (object as Mesh).geometry.translate(-center.x, -center.y, -center.z);
  return { group, sourceBounds: boundsJSON(bounds), sourceCenter: center.toArray() as Vector, sources };
}
