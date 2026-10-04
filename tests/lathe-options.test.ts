import { describe, expect, it } from 'vitest';
import { Box3, Vector3 } from 'three';
import { applyOperation, createProject } from '../src/core/model.ts';
import { geometryFor } from '../src/geometry.ts';
import { exportGLB, verifyGLB } from '../src/export.ts';
import type { Part, Vec2 } from '../src/core/types.ts';

const part = (geometry: Record<string, unknown>): Part =>
  applyOperation(createProject('t'), { op: 'add', part: { name: 'p', geometry } } as never).parts[0];
const attr = (p: Part, name: 'position' | 'normal') => geometryFor(p).getAttribute(name);
const bounds = (p: Part) => new Box3().setFromBufferAttribute(attr(p, 'position') as never);
/** Angle about +y measured from +z toward +x, in degrees, 0 to 360. */
const angle = (x: number, z: number) => ((Math.atan2(x, z) * 180 / Math.PI) % 360 + 360) % 360;
const distanceToGrid = (v: number, step: number) => { const r = v % step; return Math.min(r, step - r); };

// A stepped profile in metres: a wide plinth, a narrower column on top.
const step: Vec2[] = [[0, 0], [0.4, 0], [0.4, 0.1], [0.2, 0.1], [0.2, 0.5], [0, 0.5]];

describe('lathe hard edges (corners)', () => {
  it('leaves existing lathes untouched when no new option is used', () => {
    const p = part({ type: 'lathe', size: [0.4, 1, 0.4], segments: 12, profile: [[0.1, -0.5], [0.5, 0], [0.2, 0.5]] });
    expect(attr(p, 'position').count).toBe(13 * 3);
  });

  it('splits normals at a corner and keeps them unit length', () => {
    const smooth = part({ type: 'lathe', segments: 16, profileUnits: 'metres', profile: step });
    const crisp = part({ type: 'lathe', segments: 16, profileUnits: 'metres', profile: step, corners: [2, 3] });
    // Two corner points gain one extra ring of vertices each (17 columns).
    expect(attr(crisp, 'position').count - attr(smooth, 'position').count).toBe(2 * 17);
    const pos = attr(crisp, 'position'), nor = attr(crisp, 'normal');
    const at: number[] = [];
    for (let i = 0; i < pos.count; i++) {
      expect(Math.hypot(nor.getX(i), nor.getY(i), nor.getZ(i))).toBeCloseTo(1, 6);
      if (Math.abs(Math.hypot(pos.getX(i), pos.getZ(i)) - 0.4) < 1e-6 && Math.abs(pos.getY(i) - 0.1) < 1e-6 && distanceToGrid(angle(pos.getX(i), pos.getZ(i)), 360) < 1e-4) at.push(i);
    }
    // The corner at [0.4, 0.1]: one vertex faces up with the ledge, the other faces out with the wall.
    expect(at.length).toBeGreaterThanOrEqual(2);
    const normals = at.map(i => new Vector3(nor.getX(i), nor.getY(i), nor.getZ(i)));
    const up = normals.filter(n => n.y > 0.99), out = normals.filter(n => Math.abs(n.y) < 0.01);
    expect(up.length).toBeGreaterThan(0); expect(out.length).toBeGreaterThan(0);
    expect(up[0].dot(out[0])).toBeCloseTo(0, 6);
    // Splitting normals costs vertices only, never triangles.
    expect(geometryFor(crisp).getIndex()!.count).toBe(geometryFor(smooth).getIndex()!.count);
  });

  it('keeps normals smooth around the circumference between corners', () => {
    const crisp = part({ type: 'lathe', segments: 16, profileUnits: 'metres', profile: step, corners: [2, 3] });
    const pos = attr(crisp, 'position'), nor = attr(crisp, 'normal');
    for (let i = 0; i < pos.count; i++) {
      const r = Math.hypot(pos.getX(i), pos.getZ(i));
      if (r < 1e-9) continue;
      // Every normal is radial in the horizontal plane: its direction follows the vertex angle.
      const horizontal = Math.hypot(nor.getX(i), nor.getZ(i));
      if (horizontal < 1e-9) continue;
      expect(nor.getX(i) / horizontal).toBeCloseTo(pos.getX(i) / r, 6);
      expect(nor.getZ(i) / horizontal).toBeCloseTo(pos.getZ(i) / r, 6);
    }
  });

  it('rejects corner indices outside the profile and on other shapes', () => {
    expect(() => part({ type: 'lathe', profile: step, profileUnits: 'metres', corners: [9] })).toThrow(/corner/i);
    expect(() => part({ type: 'box', corners: [1] })).toThrow(/corner/i);
  });
});

describe('lathe real-units profile', () => {
  it('uses metres directly: radius and height from the part origin upward, size ignored', () => {
    const p = part({ type: 'lathe', segments: 24, profileUnits: 'metres', profile: step });
    const b = bounds(p);
    expect(b.min.y).toBeCloseTo(0, 6); expect(b.max.y).toBeCloseTo(0.5, 6);
    expect(b.max.x).toBeCloseTo(0.4, 6);
    const sized = part({ type: 'lathe', size: [9, 9, 9], segments: 24, profileUnits: 'metres', profile: step });
    expect(bounds(sized).max.y).toBeCloseTo(0.5, 6);
  });
  it('keeps unit profiles unit: radius = r * size[0], centred on the origin', () => {
    const p = part({ type: 'lathe', size: [2, 1, 2], segments: 24, profile: [[0, -0.5], [0.5, -0.5], [0.5, 0.5], [0, 0.5]] });
    const b = bounds(p);
    expect(b.max.x).toBeCloseTo(1, 6); expect(b.min.y).toBeCloseTo(-0.5, 6);
  });
  it('rejects unit-range violations only for unit profiles', () => {
    expect(() => part({ type: 'lathe', profile: [[0, 0], [0.8, 0], [0, 1]] })).toThrow(/profileUnits/);
    expect(() => part({ type: 'lathe', profileUnits: 'metres', profile: [[0, 0], [0.8, 0], [0, 1]] })).not.toThrow();
    expect(() => part({ type: 'lathe', profileUnits: 'metres', profile: [[0, 0], [-0.1, 0], [0, 1]] })).toThrow(/radius/i);
  });
});

describe('partial lathe (angleRange)', () => {
  const ring: Vec2[] = [[0.3, 0], [0.4, 0], [0.4, 0.2], [0.3, 0.2]];
  it('puts a 1/8 sector exactly on the full lathe vertex angles', () => {
    const full = part({ type: 'lathe', segments: 48, profileUnits: 'metres', profile: step });
    const sector = part({ type: 'lathe', segments: 48, profileUnits: 'metres', profile: ring, angleRange: [45, 90] });
    const grid = 360 / 48, p = attr(sector, 'position');
    const f = attr(full, 'position'), fullAngles: number[] = [];
    for (let i = 0; i < f.count; i++) if (Math.hypot(f.getX(i), f.getZ(i)) > 1e-9) fullAngles.push(angle(f.getX(i), f.getZ(i)));
    for (let i = 0; i < p.count; i++) {
      const a = angle(p.getX(i), p.getZ(i));
      // Positions are float32, so angles agree to about 1e-5 degrees.
      expect(distanceToGrid(a, grid)).toBeLessThan(1e-5);
      expect(a).toBeGreaterThan(45 - 1e-5); expect(a).toBeLessThan(90 + 1e-5);
      expect(fullAngles.some(v => Math.abs(v - a) < 1e-5)).toBe(true);
    }
    // 45 to 90 degrees is six of the 48 steps: seven distinct angles.
    expect(new Set(Array.from({ length: p.count }, (_, i) => angle(p.getX(i), p.getZ(i)).toFixed(3))).size).toBe(7);
  });
  it('closes the sector with radial end faces', () => {
    const sector = part({ type: 'lathe', segments: 8, profileUnits: 'metres', profile: ring, angleRange: [0, 45] });
    const g = geometryFor(sector), pos = g.getAttribute('position'), idx = g.getIndex()!;
    // The signed volume of a closed, outward-wound mesh is positive and equals the annular sector's volume.
    let volume = 0; const a = new Vector3(), b = new Vector3(), c = new Vector3();
    for (let i = 0; i < idx.count; i += 3) {
      a.fromBufferAttribute(pos, idx.getX(i)); b.fromBufferAttribute(pos, idx.getX(i + 1)); c.fromBufferAttribute(pos, idx.getX(i + 2));
      volume += a.dot(b.clone().cross(c)) / 6;
    }
    // Chordal tessellation of the arc: exact volume of the polygonal wedge between radius 0.3 and 0.4, 0.2 tall, one 45 degree step.
    const wedge = (r: number) => 0.5 * r * r * Math.sin(Math.PI / 4);
    expect(volume).toBeCloseTo((wedge(0.4) - wedge(0.3)) * 0.2, 6);
    const nor = g.getAttribute('normal');
    for (let i = 0; i < nor.count; i++) expect(Math.hypot(nor.getX(i), nor.getY(i), nor.getZ(i))).toBeCloseTo(1, 6);
    // The end face at angle 0 faces -x (away from the sector, which runs toward +x).
    let faces = 0;
    for (let i = 0; i < nor.count; i++) if (Math.abs(pos.getX(i)) < 1e-6 && Math.abs(nor.getX(i) + 1) < 1e-6 && Math.abs(nor.getY(i)) < 1e-6) faces++;
    expect(faces).toBeGreaterThan(0);
  });
  it('exports as a valid GLB and validates the range', async () => {
    const project = applyOperation(createProject('s'), { op: 'add', part: { name: 'm', geometry: { type: 'lathe', segments: 48, profileUnits: 'metres', profile: ring, angleRange: [0, 45], corners: [1, 2] } } });
    expect((await verifyGLB(await exportGLB(project))).errors).toBe(0);
    expect(() => part({ type: 'lathe', profileUnits: 'metres', profile: ring, angleRange: [90, 45] })).toThrow(/angleRange/);
    expect(() => part({ type: 'lathe', profileUnits: 'metres', profile: ring, angleRange: [0, 400] })).toThrow(/angleRange/);
  });
  it('aligns grids through startAngle', () => {
    const full = part({ type: 'lathe', segments: 12, startAngle: 10, profileUnits: 'metres', profile: step });
    const sector = part({ type: 'lathe', segments: 12, startAngle: 10, profileUnits: 'metres', profile: ring, angleRange: [10, 70] });
    const angles = (p: Part) => {
      const a = attr(p, 'position'), out = new Set<string>();
      for (let i = 0; i < a.count; i++) if (Math.hypot(a.getX(i), a.getZ(i)) > 1e-9) out.add(angle(a.getX(i), a.getZ(i)).toFixed(3));
      return out;
    };
    const fullAngles = angles(full);
    expect(fullAngles.has('10.000')).toBe(true);
    for (const a of angles(sector)) expect(fullAngles.has(a)).toBe(true);
  });
});

describe('shell interaction', () => {
  it('refuses shape options a shell cannot model instead of silently using the wrong shape', () => {
    let project = applyOperation(createProject('s'), { op: 'add', part: { name: 'm', geometry: { type: 'lathe', profileUnits: 'metres', profile: step } } });
    project = applyOperation(project, { op: 'add', part: { name: 'n', geometry: { type: 'box' } } });
    expect(() => applyOperation(project, { op: 'shell.set', shell: { name: 'skin', parts: ['m', 'n'], blend: 0.1, resolution: 32 } })).toThrow(/profileUnits/);
  });
});
