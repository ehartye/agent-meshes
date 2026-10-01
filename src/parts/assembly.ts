import { lstat, mkdir, mkdtemp, open, readFile, readdir, realpath, rename, rm, unlink, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Box3, Group, Mesh, Vector3 } from 'three';
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js';
import { z } from 'zod';
import { ensureFileReader } from '../node-file-reader.ts';
import { verifyGLB } from '../export.ts';
import { boundsJSON, inside, loadLDrawPart, ldrawMetersPerUnit, type Bounds, type PartSource, type Vector } from './ldraw.ts';
import { validateConnectivity } from './connectivity.ts';

const number = z.number().finite();
const vector = z.tuple([number, number, number]);
const quaternion = z.tuple([number, number, number, number]).refine(value => Math.abs(Math.hypot(...value) - 1) < 1e-6, 'Quaternion must have unit length');
const transform = { position: vector, rotation: quaternion };
const name = z.string().min(1).regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/);
const mass = { massKg: number.positive(), massSource: z.url().refine(url => /^https?:\/\//.test(url), 'Catalog source must be HTTP(S)') };
const connector = z.object({ name, kind: z.enum(['pin-hole', 'axle-hole', 'pin', 'axle', 'ball', 'socket']), position: vector,
  axis: vector.refine(value => Math.abs(Math.hypot(...value) - 1) < 1e-6, 'Connector axis must have unit length'), source: z.string().trim().min(1),
}).strict();
const endpoint = z.object({ part: name, connector: name }).strict();
const collider = z.discriminatedUnion('shape', [
  z.object({ shape: z.literal('box'), size: vector.refine(value => value.every(n => n > 0)), ...transform }).strict(),
  z.object({ shape: z.literal('sphere'), radius: number.positive(), ...transform }).strict(),
  z.object({ shape: z.literal('cylinder'), radius: number.positive(), height: number.positive(), ...transform }).strict(),
]);
const schema = z.object({
  version: z.literal(1), name: z.string().min(1), libraryPath: z.string().min(1),
  requireConnected: z.boolean().default(false), connections: z.array(z.object({ a: endpoint, b: endpoint }).strict()).default([]),
  bodies: z.array(z.object({ name, parent: name.nullable(), position: vector, rotation: quaternion.default([0, 0, 0, 1]), hingeAxis: vector.refine(value => Math.abs(Math.hypot(...value) - 1) < 1e-6, 'Hinge axis must have unit length').optional(), ballJoint: z.literal(true).optional() }).strict()).min(1),
  parts: z.array(z.object({ name, ldraw: z.string().min(1), color: z.number().int().nonnegative(), body: name, ...transform, ...mass, massNote: z.string().optional(),
    massComponents: z.array(z.object({ name, ...mass }).strict()).min(1).optional(), colliders: z.array(collider).min(1), connectors: z.array(connector).optional(),
  }).strict()).min(1),
}).strict();
export type AssemblyManifest = z.infer<typeof schema>;

export function validateAssembly(value: unknown): AssemblyManifest {
  const manifest = schema.parse(value), bodies = new Map(manifest.bodies.map(body => [body.name, body]));
  const names = [manifest.name, ...manifest.bodies.map(body => body.name), ...manifest.parts.map(part => part.name)];
  if (new Set(names).size !== names.length) throw new Error('Assembly, body and part names must be unique');
  for (const body of manifest.bodies) {
    if (body.ballJoint && body.hingeAxis) throw new Error(`Body cannot have both ball joint and hinge: ${body.name}`);
    if (!body.parent && (body.ballJoint || body.hingeAxis)) throw new Error(`Joint requires a parent body: ${body.name}`);
    const seen = new Set<string>(); let current: typeof body | undefined = body;
    while (current) {
      if (seen.has(current.name)) throw new Error(`Body hierarchy cycle: ${body.name}`);
      seen.add(current.name);
      if (current.parent && !bodies.has(current.parent)) throw new Error(`Unknown parent body: ${current.parent}`);
      current = current.parent ? bodies.get(current.parent) : undefined;
    }
    if (!manifest.parts.some(part => part.body === body.name)) throw new Error(`Body requires at least one mass-bearing part: ${body.name}`);
  }
  for (const part of manifest.parts) {
    if (!bodies.has(part.body)) throw new Error(`Unknown body: ${part.body}`);
    if (part.massComponents) {
      if (new Set(part.massComponents.map(component => component.name)).size !== part.massComponents.length) throw new Error(`Duplicate mass component: ${part.name}`);
      const sum = part.massComponents.reduce((total, component) => total + component.massKg, 0);
      if (Math.abs(sum - part.massKg) > 1e-9) throw new Error(`Mass components must sum to massKg: ${part.name}`);
    }
  }
  validateConnectivity(manifest);
  return manifest;
}

/** Positions refer to centered geometry, in meters and body-local coordinates. */
export async function assemble(value: unknown) {
  const manifest = validateAssembly(value), root = new Group(); root.name = manifest.name;
  const groups = new Map(manifest.bodies.map(body => { const group = new Group(); group.name = body.name; group.position.fromArray(body.position); group.quaternion.fromArray(body.rotation); return [body.name, group] as const; }));
  for (const body of manifest.bodies) (body.parent ? groups.get(body.parent)! : root).add(groups.get(body.name)!);
  const parts: (AssemblyManifest['parts'][number] & { sourceBounds: Bounds; sourceCenter: Vector; sourceFiles: string[] })[] = [], sources = new Map<string, PartSource>();
  for (const part of manifest.parts) {
    const loaded = await loadLDrawPart(manifest.libraryPath, part.ldraw, part.color);
    loaded.group.name = part.name; loaded.group.position.fromArray(part.position); loaded.group.quaternion.fromArray(part.rotation);
    groups.get(part.body)!.add(loaded.group);
    for (const source of loaded.sources) sources.set(source.file, source);
    parts.push({ ...part, sourceBounds: loaded.sourceBounds, sourceCenter: loaded.sourceCenter, sourceFiles: loaded.sources.map(source => source.file) });
  }
  root.updateMatrixWorld(true);
  const totalMassKg = parts.reduce((sum, part) => sum + part.massKg, 0), center = new Vector3();
  for (const part of parts) center.addScaledVector(root.getObjectByName(part.name)!.getWorldPosition(new Vector3()), part.massKg / totalMassKg);
  const bodies = manifest.bodies.map(body => {
    const own = parts.filter(part => part.body === body.name), aggregateMassKg = own.reduce((sum, part) => sum + part.massKg, 0), local = new Vector3();
    for (const part of own) local.addScaledVector(new Vector3(...part.position), part.massKg / aggregateMassKg);
    const bounds = new Box3();
    for (const part of own) {
      const object = root.getObjectByName(part.name)!;
      object.traverse(child => { if (child instanceof Mesh) {
        const geometry = child.geometry.clone(); geometry.applyMatrix4(child.matrixWorld).applyMatrix4(groups.get(body.name)!.matrixWorld.clone().invert());
        geometry.computeBoundingBox(); bounds.union(geometry.boundingBox!); geometry.dispose();
      } });
    }
    return { ...body, aggregateMassKg, centerOfMassEstimate: local.toArray() as Vector, bounds: boundsJSON(bounds) };
  });
  const robot = { version: 1 as const, name: manifest.name, units: 'meters-kilograms' as const, axes: { up: '+Y', forward: '+Z', wheel: 'X', cylinder: 'Y' },
    bodies, parts, connections: manifest.connections, requireConnected: manifest.requireConnected, connectivity: validateConnectivity(manifest), totalMassKg, centerOfMassEstimate: center.toArray() as Vector,
    centerOfMassMethod: 'catalog masses at geometry bounding-box centers; not measured', bounds: boundsJSON(new Box3().setFromObject(root)),
    sourceTransform: { metersPerLDrawUnit: ldrawMetersPerUnit, rotation: [1, 0, 0, 0], centering: 'per-part geometry bounding-box center' },
    sources: [...sources.values()].sort((a, b) => a.file.localeCompare(b.file)),
  };
  return { root, robot };
}

const marker = '.agent-meshes-assembly.json';
const files = ['model.glb', 'robot.json', 'verification.json', 'ATTRIBUTION.md'];
async function owned(output: string, manifest: string): Promise<boolean> {
  try {
    const stat = await lstat(output);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Assembly output must be an owned directory');
  } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
  const entries = await readdir(output, { withFileTypes: true });
  if (entries.length !== files.length + 1 || entries.some(entry => !entry.isFile() || ![...files, marker].includes(entry.name))) throw new Error('Assembly output contains unowned files');
  const metadata = JSON.parse(await readFile(join(output, marker), 'utf8'));
  if (metadata.generator !== 'agent-meshes-assembly' || metadata.manifest !== manifest) throw new Error('Assembly output ownership does not match manifest');
  return true;
}

/** Stage and validate every artifact before replacing a previously successful owned build. */
export async function buildAssembly(manifestPath: string, outputPath: string) {
  const input = await realpath(resolve(manifestPath)), manifest = validateAssembly(JSON.parse(await readFile(input, 'utf8')));
  manifest.libraryPath = await realpath(resolve(dirname(input), manifest.libraryPath));
  const requested = resolve(outputPath);
  await mkdir(dirname(requested), { recursive: true });
  const parent = await realpath(dirname(requested)), output = join(parent, basename(requested));
  if (dirname(output) === output || inside(output, input) || inside(output, manifest.libraryPath)) throw new Error('Assembly output cannot contain its source or library');
  const lockPath = join(parent, `.${basename(output)}.assembly.lock`), lock = await open(lockPath, 'wx');
  let stage: string | undefined, backup: string | undefined;
  try {
    await owned(output, input);
    stage = await mkdtemp(join(parent, `.${basename(output)}.assembly-stage-`));
    const { root, robot } = await assemble(manifest);
    ensureFileReader();
    let binary: ArrayBuffer | { [key: string]: unknown };
    try { binary = await new GLTFExporter().parseAsync(root, { binary: true, onlyVisible: true }); }
    finally { root.traverse(object => { if (object instanceof Mesh) { object.geometry.dispose(); for (const material of [object.material].flat()) material.dispose(); } }); }
    if (!(binary instanceof ArrayBuffer)) throw new Error('Exporter did not produce GLB');
    const bytes = new Uint8Array(binary), verification = await verifyGLB(bytes);
    if (!verification.ok) throw new Error(`Assembly GLB validation failed: ${verification.errors} errors`);
    const attribution = ['# LDraw assembly attribution', '', 'Geometry sourced from the local LDraw Parts Library (https://www.ldraw.org/).', 'Each file retains its own author and license metadata below. Geometry provenance is distinct from catalog mass provenance.', 'License links: CC BY 4.0 https://creativecommons.org/licenses/by/4.0/ ; CC BY 2.0 https://creativecommons.org/licenses/by/2.0/ ; original LDraw agreement https://www.ldraw.org/article/227.html . These links explain the per-file declarations below; they do not replace or broaden them.', 'Modification notice: Agent Meshes converts LDraw geometry to meters, rotates axes, centers each part, bakes transforms and assembles surfaces into GLB. Edges and conditional lines are omitted.', '', ...robot.sources.flatMap(source => [`## ${source.file}`, `SHA-256: ${source.sha256}`, `Authors: ${source.authors.join('; ') || '(not declared)'}`, `License: ${source.licenses.join('; ') || '(not declared; consult library distribution)'}`, '']), '# Catalog mass sources', '', ...robot.parts.flatMap(part => [`- ${part.name}: ${part.massKg} kg — ${part.massSource}${part.massNote ? ` (${part.massNote})` : ''}`, ...(part.massComponents ?? []).map(component => `  - ${component.name}: ${component.massKg} kg — ${component.massSource}`)]), ''].join('\n');
    await Promise.all([writeFile(join(stage, 'model.glb'), bytes), writeFile(join(stage, 'robot.json'), `${JSON.stringify(robot, null, 2)}\n`), writeFile(join(stage, 'verification.json'), `${JSON.stringify(verification, null, 2)}\n`), writeFile(join(stage, 'ATTRIBUTION.md'), attribution), writeFile(join(stage, marker), JSON.stringify({ version: 1, generator: 'agent-meshes-assembly', manifest: input }))]);
    if (await owned(output, input)) { backup = join(parent, `.${basename(output)}.assembly-backup-${randomUUID()}`); await rename(output, backup); }
    try { await rename(stage, output); stage = undefined; }
    catch (error) { if (backup) { await rename(backup, output); backup = undefined; } throw error; }
    // Both paths were created here as immediate siblings under the verified absolute parent.
    if (backup && inside(parent, backup)) await rm(backup, { recursive: true, force: true });
    return { output, files, totalMassKg: robot.totalMassKg, bounds: robot.bounds };
  } finally {
    if (stage && inside(parent, stage)) await rm(stage, { recursive: true, force: true });
    await lock.close(); await unlink(lockPath);
  }
}
