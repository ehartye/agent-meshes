import { afterEach, expect, it } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildAssembly, validateAssembly } from '../src/parts/assembly.ts';

const identity = [0, 0, 0, 1], turnY = [0, Math.SQRT1_2, 0, Math.SQRT1_2];
const turnX = [Math.SQRT1_2, 0, 0, Math.SQRT1_2];
let temporary: string | undefined;
afterEach(async () => { if (temporary) { await rm(temporary, { recursive: true, force: true }); temporary = undefined; } });

function manifest(): any {
  const part = { ldraw: 'piece.dat', color: 4, massKg: .01, massSource: 'https://example.com/catalog',
    colliders: [{ shape: 'sphere', radius: .004, position: [0, 0, 0], rotation: identity }] };
  return { version: 1, name: 'connected fixture', libraryPath: '.', requireConnected: true,
    bodies: [{ name: 'base', parent: null, position: [0, 1, 0], rotation: turnY },
      { name: 'hinged', parent: 'base', position: [1, 0, 0], rotation: turnY, hingeAxis: [1, 0, 0] }],
    parts: [{ ...part, name: 'beam', body: 'base', position: [0, 0, 0], rotation: identity,
      connectors: [{ name: 'hole', kind: 'pin-hole', position: [1, 0, 0], axis: [1, 0, 0], source: 'LDraw hole primitive' }] },
    { ...part, name: 'pin', body: 'hinged', position: [0, .002, 0], rotation: turnX,
      connectors: [{ name: 'end', kind: 'pin', position: [0, 0, .002], axis: [0, 1, 0], source: 'LDraw pin primitive' }] }],
    connections: [{ a: { part: 'beam', connector: 'hole' }, b: { part: 'pin', connector: 'end' } }],
  };
}

it('accepts matching connectors through root, child body and centered part transforms', () => {
  expect(validateAssembly(manifest()).connections).toHaveLength(1);
  const opposite = manifest(); opposite.parts[1].connectors[0].axis = [0, -1, 0];
  expect(() => validateAssembly(opposite)).not.toThrow();
});

it.each([
  ['unknown part', (value: any) => { value.connections[0].b.part = 'missing'; }, /unknown part/i],
  ['unknown connector', (value: any) => { value.connections[0].b.connector = 'missing'; }, /unknown connector/i],
  ['duplicate connector names', (value: any) => { value.parts[0].connectors.push(value.parts[0].connectors[0]); }, /duplicate connector/i],
  ['same-part connection', (value: any) => { value.connections[0].b = value.connections[0].a; }, /distinct parts/i],
  ['reused endpoint', (value: any) => { value.connections.push(value.connections[0]); }, /already connected/i],
  ['hole-to-hole pseudoattachment', (value: any) => { value.parts[1].connectors[0].kind = 'pin-hole'; }, /incompatible/i],
  ['mismatched axle', (value: any) => { value.parts[1].connectors[0].kind = 'axle'; }, /incompatible/i],
  ['position gap', (value: any) => { value.parts[0].connectors[0].position[0] += .00011; }, /position/i],
  ['axis misalignment', (value: any) => { value.parts[0].connectors[0].axis = [0, 1, 0]; }, /axis/i],
  ['non-unit axis', (value: any) => { value.parts[0].connectors[0].axis = [2, 0, 0]; }, /unit/i],
  ['overflowing anchor transform', (value: any) => {
    value.bodies[0].position = [1e308, 0, 0];
    for (const body of value.bodies) body.rotation = identity;
    for (const part of value.parts) { part.position = [1e308, 0, 0]; part.rotation = identity; part.connectors[0].axis = [1, 0, 0]; }
  }, /nonfinite/i],
  ['disconnected graph', (value: any) => { value.connections = []; }, /disconnected/i],
])('rejects %s', (_label, mutate, message) => {
  const value = manifest(); mutate(value); expect(() => validateAssembly(value)).toThrow(message);
});

it('uses 0.1 mm position and 1e-6 absolute-dot axis tolerances', () => {
  const value = manifest(); value.parts[0].connectors[0].position[0] += .0001;
  const angle = Math.acos(1-.5e-6);
  value.parts[1].connectors[0].axis = [Math.sin(angle), Math.cos(angle), 0];
  expect(() => validateAssembly(value)).not.toThrow();
  value.parts[1].connectors[0].axis = [Math.sin(.002), Math.cos(.002), 0];
  expect(() => validateAssembly(value)).toThrow(/axis/i);
});

it('accepts ball/socket without axis alignment and axle/axle-hole only as declared types', () => {
  const value = manifest();
  value.parts[0].connectors[0].kind = 'socket'; value.parts[1].connectors[0].kind = 'ball';
  value.parts[1].connectors[0].axis = [1, 0, 0];
  expect(() => validateAssembly(value)).not.toThrow();
  value.parts[0].connectors[0].kind = 'axle-hole'; value.parts[1].connectors[0].kind = 'axle';
  value.parts[1].connectors[0].axis = [0, 1, 0];
  expect(() => validateAssembly(value)).not.toThrow();
});

it('keeps connectivity optional but validates declarations even without requiring the whole graph', () => {
  const invalid = manifest(); invalid.requireConnected = false; invalid.parts[1].connectors[0].position[0] += .01;
  expect(() => validateAssembly(invalid)).toThrow(/position/i);
  const value = manifest(); delete value.requireConnected; value.connections = [];
  expect(validateAssembly(value).requireConnected).toBe(false);
  delete value.connections; for (const part of value.parts) delete part.connectors;
  expect(() => validateAssembly(value)).not.toThrow();
});

it('supports a shaft joining two parts through separately named anchors and rejects an omitted part', () => {
  const value = manifest();
  value.parts[0].connectors[0].kind = 'axle-hole'; value.parts[1].connectors[0].kind = 'axle';
  const secondBeam = structuredClone(value.parts[0]); secondBeam.name = 'second-beam'; secondBeam.position = [0, .008, 0];
  value.parts.push(secondBeam);
  value.parts[1].connectors.push({ ...value.parts[1].connectors[0], name: 'second-end', position: [0, 0, -.006] });
  expect(() => validateAssembly(value)).toThrow(/disconnected.*second-beam/i);
  value.connections.push({ a: { part: 'second-beam', connector: 'hole' }, b: { part: 'pin', connector: 'second-end' } });
  expect(() => validateAssembly(value)).not.toThrow();
});

it.each(['pin-hole', 'axle-hole'])('rejects two named anchors consuming the same physical %s on a part', kind => {
  const value = manifest();
  value.parts[0].connectors[0].kind = kind;
  value.parts[1].connectors[0].kind = kind === 'pin-hole' ? 'pin' : 'axle';
  const otherPin = structuredClone(value.parts[1]); otherPin.name = 'other-pin';
  value.parts.push(otherPin);
  value.parts[0].connectors.push({ ...value.parts[0].connectors[0], name: 'other-name', axis: [-1, 0, 0] });
  value.connections.push({ a: { part: 'beam', connector: 'other-name' }, b: { part: 'other-pin', connector: 'end' } });
  expect(() => validateAssembly(value)).toThrow(/physical hole already consumed/i);
  // Sub-tolerance offsets must not evade occupancy; genuinely separate holes remain usable.
  value.parts[0].connectors[1].position = [1, .00005, 0]; otherPin.position[1] += .00005;
  expect(() => validateAssembly(value)).toThrow(/physical hole already consumed/i);
  value.parts[0].connectors[1].position = [1, .008, 0]; otherPin.position[1] = .01;
  expect(() => validateAssembly(value)).not.toThrow();
});

it('allows unconsumed alias metadata without granting a second engagement', () => {
  const value = manifest();
  value.parts[0].connectors.push({ ...value.parts[0].connectors[0], name: 'unused-alias' });
  expect(() => validateAssembly(value)).not.toThrow();
});

it('exports declared connector provenance, rest residuals and connected components', async () => {
  temporary = await mkdtemp(join(tmpdir(), 'agent-meshes-connectivity-'));
  await mkdir(join(temporary, 'parts'));
  await writeFile(join(temporary, 'LDConfig.ldr'), '0 !COLOUR Red CODE 4 VALUE #C91A09 EDGE #333333');
  await writeFile(join(temporary, 'parts/piece.dat'), '0 !LDRAW_ORG Part\n3 16 0 0 0 1 0 0 0 1 0');
  const value = manifest(), input = join(temporary, 'assembly.json'), output = join(temporary, 'output');
  await writeFile(input, JSON.stringify(value));
  await buildAssembly(input, output);
  const robot = JSON.parse(await readFile(join(output, 'robot.json'), 'utf8'));
  expect(robot.parts[0].connectors).toEqual(value.parts[0].connectors);
  expect(robot.connections).toEqual(value.connections);
  expect(robot.requireConnected).toBe(true);
  expect(robot.connectivity.allPartsConnected).toBe(true);
  expect(robot.connectivity.connectedComponents).toEqual([['beam', 'pin']]);
  expect(robot.connectivity.residuals[0].positionErrorMeters).toBeLessThan(1e-12);
  expect(robot.connectivity.residuals[0].axisError).toBeLessThan(1e-12);
  expect(robot.connectivity.residuals[0].worldPositionA).toEqual([expect.closeTo(0, 12), 1, expect.closeTo(-1, 12)]);
  value.requireConnected = false; value.connections = [];
  await writeFile(input, JSON.stringify(value)); await buildAssembly(input, output);
  const disconnected = JSON.parse(await readFile(join(output, 'robot.json'), 'utf8'));
  expect(disconnected.connectivity.allPartsConnected).toBe(false);
  expect(disconnected.connectivity.connectedComponents).toEqual([['beam'], ['pin']]);
  value.requireConnected = true;
  await writeFile(input, JSON.stringify(value));
  await expect(buildAssembly(input, output)).rejects.toThrow(/disconnected/i);
  expect(JSON.parse(await readFile(join(output, 'robot.json'), 'utf8'))).toEqual(disconnected);
});
