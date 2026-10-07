import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Box3, Mesh, MeshStandardMaterial, Vector3 } from 'three';
import { loadLDrawPart } from '../src/physical/ldraw.ts';
import { assemble, buildAssembly, validateAssembly } from '../src/physical/assembly.ts';

let directory: string;
const identity = [0, 0, 0, 1];
const source = 'https://example.com/catalog';
async function file(name: string, text: string) { await mkdir(join(directory, 'parts'), { recursive: true }); await writeFile(join(directory, name), text); }
function manifest() {
  return { version: 1, name: 'fixture robot', libraryPath: directory,
    bodies: [{ name: 'chassis', parent: null, position: [0, 1, 0] }, { name: 'wheel-body', parent: 'chassis', position: [1, 0, 0], hingeAxis: [1, 0, 0] }],
    parts: [{ name: 'hub-with-battery', ldraw: 'parent.dat', color: 4, body: 'chassis', position: [0, 0, 0], rotation: identity, massKg: 0.15, massSource: source,
      massComponents: [{ name: 'hub', massKg: 0.06, massSource: source }, { name: 'battery', massKg: 0.09, massSource: source }],
      colliders: [{ shape: 'box', size: [0.008, 0.004, 0.002], position: [0, 0, 0], rotation: identity }] },
    { name: 'wheel', ldraw: 'child.dat', color: 4, body: 'wheel-body', position: [0, 0, 0], rotation: identity, massKg: 0.05, massSource: source,
      colliders: [{ shape: 'cylinder', radius: 0.01, height: 0.004, position: [0, 0, 0], rotation: [0, 0, Math.SQRT1_2, Math.SQRT1_2] }] }] };
}
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'agent-meshes-parts-'));
  await file('LDConfig.ldr', '0 !COLOUR Red CODE 4 VALUE #C91A09 EDGE #333333\n0 !COLOUR Blue CODE 1 VALUE #0055BF EDGE #333333');
  await file('parts/child.dat', '0 Child\n0 Author: Test Author\n0 !LICENSE Redistributable under CC BY 4.0 : see CAreadme.txt\n0 !LDRAW_ORG Part\n0 BFC CERTIFY CCW\n3 16 0 0 0 20 0 0 0 -10 0\n3 1 0 0 5 0 -10 5 20 0 5');
  await file('parts/parent.dat', '0 Parent\n0 !LDRAW_ORG Part\n1 16 10 20 30 1 0 0 0 1 0 0 0 1 child.dat');
});
afterEach(async () => { await rm(directory, { recursive: true, force: true }); });

describe('local LDraw physical parts', () => {
  it('preserves outward winding when a dependency is reflected', async () => {
    await file('parts/parent.dat', '0 Parent\n0 !LDRAW_ORG Part\n1 16 0 0 0 -1 0 0 0 1 0 0 0 1 child.dat');
    const result = await loadLDrawPart(directory, 'parent.dat', 4);
    result.group.traverse(object => {
      if (!(object instanceof Mesh)) return;
      const geometry = object.geometry.index ? object.geometry.toNonIndexed() : object.geometry;
      const positions = geometry.getAttribute('position'), normals = geometry.getAttribute('normal');
      for (let i = 0; i < positions.count; i += 3) {
        const a = new Vector3().fromBufferAttribute(positions, i), b = new Vector3().fromBufferAttribute(positions, i+1), c = new Vector3().fromBufferAttribute(positions, i+2);
        expect(b.sub(a).cross(c.sub(a)).dot(new Vector3().fromBufferAttribute(normals, i))).toBeGreaterThan(0);
      }
    });
  });
  it('imports nested surfaces and colors, rotates -Y to +Y without mirroring and centers SI geometry', async () => {
    const part = await loadLDrawPart(directory, 'parent.dat', 4);
    expect(part.sourceBounds.min).toEqual([expect.closeTo(0.004, 8), expect.closeTo(-0.008, 8), expect.closeTo(-0.014, 8)]);
    expect(part.sourceBounds.max).toEqual([expect.closeTo(0.012, 8), expect.closeTo(-0.004, 8), expect.closeTo(-0.012, 8)]);
    const size = new Box3().setFromObject(part.group).getSize(new Vector3());
    expect(size.x).toBeCloseTo(0.008); expect(size.y).toBeCloseTo(0.004); expect(size.z).toBeCloseTo(0.002);
    expect(new Box3().setFromObject(part.group).getCenter(new Vector3()).length()).toBeLessThan(1e-8);
    const colors = new Set<string>();
    part.group.traverse(object => { if (object instanceof Mesh) for (const material of [object.material].flat()) colors.add((material as MeshStandardMaterial).color.getHexString()); });
    expect(colors).toEqual(new Set(['c91a09', '0055bf']));
    expect(part.sources.some(entry => entry.authors.includes('Test Author'))).toBe(true);
  });
  it.each(['../escape.dat', 'C:/escape.dat', '/escape.dat'])('rejects unsafe reference %s', async reference => {
    await file('parts/parent.dat', `1 16 0 0 0 1 0 0 0 1 0 0 0 1 ${reference}`);
    await expect(loadLDrawPart(directory, 'parent.dat', 4)).rejects.toThrow(/unsafe/i);
  });
  it('rejects missing and cyclic dependencies before parsing', async () => {
    await expect(loadLDrawPart(directory, 'absent.dat', 4)).rejects.toThrow(/missing/i);
    await file('parts/child.dat', '1 16 0 0 0 1 0 0 0 1 0 0 0 1 parent.dat');
    await expect(loadLDrawPart(directory, 'parent.dat', 4)).rejects.toThrow(/cycle/i);
  });
  it('composes a rotated dependency and rejects unsupported embedded files and textures', async () => {
    await file('parts/parent.dat', '1 16 0 0 0 0 -1 0 1 0 0 0 0 1 child.dat');
    const result = await loadLDrawPart(directory, 'parent.dat', 4);
    const size = new Box3().setFromObject(result.group).getSize(new Vector3());
    expect(size.x).toBeCloseTo(0.004, 8); expect(size.y).toBeCloseTo(0.008, 8);
    for (const directive of ['0 FILE escaped.dat', '0 !TEXMAP START PLANAR']) {
      await file('parts/parent.dat', directive);
      await expect(loadLDrawPart(directory, 'parent.dat', 4)).rejects.toThrow(/unsupported/i);
    }
  });
});

describe('physical assembly', () => {
  it('accepts an explicit passive ball joint and exposes the assembly CLI', async () => {
    const value: any = manifest(); delete value.bodies[1].hingeAxis; value.bodies[1].ballJoint = true;
    expect(validateAssembly(value).bodies[1].ballJoint).toBe(true);
    const config = join(directory, 'assembly.json'), output = join(directory, 'cli-output');
    await writeFile(config, JSON.stringify(value));
    const result = await promisify(execFile)(process.execPath, ['src/cli.ts', 'assemble', config, output]);
    expect(JSON.parse(result.stdout).totalMassKg).toBeCloseTo(0.2);
    expect(JSON.parse(await readFile(join(output, 'robot.json'), 'utf8')).bodies[1].ballJoint).toBe(true);
  });
  it('requires catalog mass, known bodies, normalized transforms and exact component accounting', () => {
    for (const mutate of [
      (m: any) => { m.parts[0].massKg = -1; },
      (m: any) => { m.name = m.parts[0].name; },
      (m: any) => { m.parts[0].body = 'absent'; },
      (m: any) => { m.parts[0].rotation = [0, 0, 0, 0]; },
      (m: any) => { m.parts[0].massComponents[1].massKg = 0.1; },
      (m: any) => { m.bodies[0].parent = 'wheel-body'; },
      (m: any) => { m.bodies[1].ballJoint = true; },
    ]) { const value = manifest(); mutate(value); expect(() => validateAssembly(value)).toThrow(); }
  });
  it('counts battery once and preserves named body hierarchy, bounds and COM estimates', async () => {
    const result = await assemble(manifest());
    expect(result.robot.totalMassKg).toBeCloseTo(0.2);
    expect(result.robot.centerOfMassEstimate).toEqual([0.25, expect.closeTo(1, 12), 0]);
    expect(result.robot.centerOfMassMethod).toBe('catalog masses at geometry bounding-box centers; not measured');
    expect(result.robot.bodies[0].aggregateMassKg).toBeCloseTo(0.15);
    expect(result.root.getObjectByName('wheel')?.parent?.name).toBe('wheel-body');
    expect(result.root.getObjectByName('wheel-body')?.parent?.name).toBe('chassis');
    expect(result.robot.bounds.max[0]).toBeCloseTo(1.004);
    expect(result.robot.parts[0].massComponents).toHaveLength(2);
  });
  it('writes verified GLB and attribution, and preserves a successful output on invalid rebuild', async () => {
    const config = join(directory, 'assembly.json'), output = join(directory, 'output');
    await writeFile(config, JSON.stringify(manifest()));
    await buildAssembly(config, output);
    const bytes = await readFile(join(output, 'model.glb'));
    expect(bytes.toString('utf8', 0, 4)).toBe('glTF');
    expect(JSON.parse(await readFile(join(output, 'verification.json'), 'utf8')).ok).toBe(true);
    expect(await readFile(join(output, 'ATTRIBUTION.md'), 'utf8')).toContain('Test Author');
    expect(await readFile(join(output, 'ATTRIBUTION.md'), 'utf8')).toContain('https://creativecommons.org/licenses/by/4.0/');
    expect(await readFile(join(output, 'ATTRIBUTION.md'), 'utf8')).toContain('Modification notice');
    const gltf = JSON.parse(bytes.toString('utf8', 20, 20 + bytes.readUInt32LE(12)));
    const chassis = gltf.nodes.find((node: any) => node.name === 'chassis'), wheel = gltf.nodes.findIndex((node: any) => node.name === 'wheel-body');
    expect(chassis.children).toContain(wheel);
    expect(gltf.nodes[wheel].matrix.slice(12, 15)).toEqual([1, 0, 0]);
    expect(new Set(gltf.materials.map((material: any) => JSON.stringify(material.pbrMetallicRoughness.baseColorFactor))).size).toBe(2);
    await buildAssembly(config, output);
    const bad = manifest(); bad.parts[0].ldraw = 'missing.dat'; await writeFile(config, JSON.stringify(bad));
    await expect(buildAssembly(config, output)).rejects.toThrow(/missing/i);
    expect(await readFile(join(output, 'model.glb'))).toEqual(bytes);
  });
  it('refuses to replace an unrelated directory', async () => {
    const config = join(directory, 'assembly.json'), output = join(directory, 'output');
    await writeFile(config, JSON.stringify(manifest()));
    await mkdir(output); await writeFile(join(output, 'precious.txt'), 'keep me');
    await expect(buildAssembly(config, output)).rejects.toThrow(/unowned/i);
    expect(await readFile(join(output, 'precious.txt'), 'utf8')).toBe('keep me');
  });
});
