import { describe, expect, it } from 'vitest';
import { Box3 } from 'three';
import { applyOperation, createProject } from '../src/core/model.ts';
import { geometryFor } from '../src/geometry.ts';
import type { Part, Vec2 } from '../src/core/types.ts';

const make = (geometry: Record<string, unknown>): Part => applyOperation(createProject('t'), { op: 'add', part: { name: 'p', geometry } } as never).parts[0];
const box = (p: Part) => new Box3().setFromBufferAttribute(geometryFor(p).getAttribute('position') as never);
const round = (v: number[]) => v.map(n => +n.toFixed(6) + 0);
const square: Vec2[] = [[0, 0], [2, 0], [2, 1], [0, 1]];

describe('prism axis and metres', () => {
  it('extrudes a metre outline in the XZ plane upward from the origin', () => {
    const b = box(make({ type: 'prism', axis: 'y', outlineUnits: 'metres', size: [1, 0.3, 1], outline: square }));
    expect(round(b.min.toArray())).toEqual([0, 0, 0]);
    expect(round(b.max.toArray())).toEqual([2, 0.3, 1]);
  });
  it('keeps axis z in metres as an XY outline from z=0 to size[2]', () => {
    const b = box(make({ type: 'prism', outlineUnits: 'metres', size: [1, 1, 0.2], outline: square }));
    expect(round(b.max.toArray())).toEqual([2, 1, 0.2]);
    expect(round(b.min.toArray())).toEqual([0, 0, 0]);
  });
  it('axis y with a unit outline scales by size and is centred', () => {
    const b = box(make({ type: 'prism', axis: 'y', size: [2, 0.5, 4], outline: [[-0.5, -0.5], [0.5, -0.5], [0.5, 0.5], [-0.5, 0.5]] }));
    expect(round(b.min.toArray())).toEqual([-1, -0.25, -2]);
    expect(round(b.max.toArray())).toEqual([1, 0.25, 2]);
  });
  it('winds faces outward when extruded along y', () => {
    const g = geometryFor(make({ type: 'prism', axis: 'y', outlineUnits: 'metres', size: [1, 1, 1], outline: square }));
    const p = g.getAttribute('position'); let volume = 0;
    for (let i = 0; i < p.count; i += 3) {
      const [ax, ay, az, bx, by, bz, cx, cy, cz] = [0, 1, 2].flatMap(k => [p.getX(i + k), p.getY(i + k), p.getZ(i + k)]);
      volume += (ax * (by * cz - bz * cy) - ay * (bx * cz - bz * cx) + az * (bx * cy - by * cx)) / 6;
    }
    expect(volume).toBeCloseTo(2, 6);
  });
  it('accepts large metre outlines and still rejects unit overflow with the point index', () => {
    expect(() => make({ type: 'prism', outlineUnits: 'metres', outline: [[0, 0], [30, 0], [0, 4]] })).not.toThrow();
    expect(() => make({ type: 'prism', outline: [[0, 0], [0.4, 0], [0.7, 0.2]] })).toThrow(/point 2/i);
  });
  it('bevels the caps without changing the footprint or height', () => {
    const base = { type: 'prism', axis: 'y', outlineUnits: 'metres', size: [1, 0.3, 1], outline: square };
    const b = box(make({ ...base, bevel: 0.02 }));
    expect(round(b.max.toArray())).toEqual([2, 0.3, 1]);
    expect(round(b.min.toArray())).toEqual([0, 0, 0]);
    expect(() => make({ ...base, bevel: 0.2 })).toThrow(/bevel/i);
    expect(geometryFor(make({ ...base, bevel: 0.02 })).getAttribute('position').count).toBeGreaterThan(geometryFor(make(base)).getAttribute('position').count);
  });
  it('rejects prism-only fields on other shapes', () => {
    expect(() => make({ type: 'box', axis: 'y' })).toThrow(/prism/i);
  });
});
