import { afterEach, describe, expect, it } from 'vitest';
import { BoxGeometry, Group, Mesh, MeshStandardMaterial } from 'three';
import { assemble, validateAssembly } from '../src/physical/assembly.ts';
import { connectorProfile, registerConnectorProfile, unregisterConnectorProfile } from '../src/physical/profiles.ts';
import { geometryAdapter, registerGeometryAdapter, unregisterGeometryAdapter } from '../src/physical/adapters.ts';

const fasteners = { id: 'fasteners', mates: { bolt: 'tapped-hole', 'tapped-hole': 'bolt' }, exclusive: ['tapped-hole'], axisless: [] };
const boxAdapter = {
  id: 'box',
  validatePart(part: { source?: { size?: number[] } }) { if (!part.source?.size || part.source.size.length !== 3) throw new Error('box adapter needs source.size'); },
  async load(_library: string, part: { source: { size: number[] } }) {
    const [x, y, z] = part.source.size, group = new Group();
    group.add(new Mesh(new BoxGeometry(x, y, z), new MeshStandardMaterial()));
    const half = [x / 2, y / 2, z / 2];
    return { group, sourceBounds: { min: half.map(v => -v), max: half } as never, sourceCenter: [0, 0, 0] as [number, number, number], sources: [] };
  },
  sourceTransform: { units: 'meters', centering: 'none' },
  attributionHeader: ['# Box assembly attribution'],
};

const unit = { massSource: 'https://example.com/measured', colliders: [{ shape: 'box', size: [.02, .02, .02], position: [0, 0, 0], rotation: [0, 0, 0, 1] }] };
function manifest() {
  return {
    version: 1, name: 'bracket', libraryPath: '.', profile: 'fasteners', adapter: 'box', requireConnected: true,
    bodies: [{ name: 'base', parent: null, position: [0, 0, 0] }],
    parts: [
      { name: 'plate', body: 'base', source: { size: [.04, .01, .04] }, position: [0, 0, 0], rotation: [0, 0, 0, 1], massKg: .05, ...unit,
        connectors: [{ name: 'hole', kind: 'tapped-hole', position: [0, 0, 0], axis: [0, 1, 0], source: 'drawing' }] },
      { name: 'screw', body: 'base', source: { size: [.005, .02, .005] }, position: [0, .02, 0], rotation: [0, 0, 0, 1], massKg: .004, ...unit,
        connectors: [{ name: 'thread', kind: 'bolt', position: [0, -.02, 0], axis: [0, 1, 0], source: 'drawing' }] },
    ],
    connections: [{ a: { part: 'plate', connector: 'hole' }, b: { part: 'screw', connector: 'thread' } }],
  };
}

afterEach(() => { unregisterConnectorProfile('fasteners'); unregisterGeometryAdapter('box'); });

describe('connector profiles', () => {
  it('ships the LEGO Technic profile as the default and rejects unknown ids', () => {
    expect(connectorProfile('lego-technic').mates['pin']).toBe('pin-hole');
    expect(() => connectorProfile('nope')).toThrow(/unknown connector profile/i);
  });
  it('refuses to replace a registered profile', () => {
    registerConnectorProfile(fasteners);
    expect(() => registerConnectorProfile(fasteners)).toThrow(/already registered/i);
  });
  it('validates a non-LEGO profile with its own mate pairs and exclusive holes', () => {
    registerConnectorProfile(fasteners); registerGeometryAdapter(boxAdapter);
    expect(validateAssembly(manifest()).connections).toHaveLength(1);
  });
  it('rejects a kind that belongs to a different profile', () => {
    registerConnectorProfile(fasteners); registerGeometryAdapter(boxAdapter);
    const value = manifest(); value.parts[1].connectors[0].kind = 'pin';
    expect(() => validateAssembly(value)).toThrow(/pin.*fasteners|fasteners.*pin/i);
  });
  it('rejects mismatched pairs under the profile rules', () => {
    registerConnectorProfile(fasteners); registerGeometryAdapter(boxAdapter);
    const value = manifest(); value.parts[1].connectors[0].kind = 'tapped-hole';
    expect(() => validateAssembly(value)).toThrow(/incompatible connector types/i);
  });
  it('defaults to the LEGO profile when the manifest names none', () => {
    const value = manifest() as Record<string, unknown>; delete value.profile; delete value.adapter;
    // Still resolves, then fails on LEGO kinds / LDraw part fields rather than on a missing default.
    expect(() => validateAssembly(value)).toThrow(/pin|axle|ball|socket|ldraw/i);
  });
});

describe('geometry adapters', () => {
  it('rejects unknown adapters and lets an adapter validate its own part fields', () => {
    registerConnectorProfile(fasteners);
    expect(() => validateAssembly(manifest())).toThrow(/unknown geometry adapter/i);
    registerGeometryAdapter(boxAdapter);
    const value = manifest(); delete (value.parts[0] as Record<string, unknown>).source;
    expect(() => validateAssembly(value)).toThrow(/box adapter needs source.size/);
  });
  it('builds a physical robot from a non-LDraw adapter with its own source transform', async () => {
    registerConnectorProfile(fasteners); registerGeometryAdapter(boxAdapter);
    const { robot } = await assemble(manifest());
    expect(robot.totalMassKg).toBeCloseTo(.054);
    expect(robot.connectivity.allPartsConnected).toBe(true);
    expect(robot.sourceTransform).toEqual({ units: 'meters', centering: 'none' });
    expect(geometryAdapter('box').id).toBe('box');
  });
});
