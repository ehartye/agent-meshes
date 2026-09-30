import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { surfaceCrossings, type CrossingSurface } from '../src/surface-crossings.ts';

const surface = (label: string, points: number[]): CrossingSurface => ({ label, points: Float64Array.from(points), triangles: Uint32Array.from([0, 1, 2]) });
const skin = surface('skin', [-1, -1, 0, 1, -1, 0, 0, 1, 0]);
const through = surface('gum', [-.25, 0, -.5, .25, 0, .5, 0, .5, -.5]);
describe('strict triangle surface crossings', () => {
  it('finds crossings even when neither triangle has a vertex on the other', () => {
    expect(surfaceCrossings([skin], [through])).toHaveLength(1);
    expect(surfaceCrossings([through], [skin])).toHaveLength(1);
  });
  it('detects a crossing aligned with an internal triangulation edge', () => {
    const splitSkin: CrossingSurface = {
      label: 'skin',
      points: Float64Array.from([-1, -1, 0, 0, -1, 0, 0, 1, 0, -1, 1, 0, 1, -1, 0, 1, 1, 0]),
      triangles: Uint32Array.from([0, 1, 2, 0, 2, 3, 1, 4, 5, 1, 5, 2]),
    };
    const aligned = surface('gum', [0, -.5, -1, 0, .5, -1, 0, 0, 1]);
    // The connected skin spans both sides of x=0: this is an intersection,
    // not contact at a boundary seam. A tiny sideways shift must not change that.
    for (const dx of [0, -1e-9, 1e-9, -1e-7, 1e-7, -1e-6, 1e-6, -.001, .001]) {
      const part = { ...aligned, points: aligned.points.map((v, i) => i % 3 === 0 ? v + dx : v) };
      expect(surfaceCrossings([splitSkin], [part]).length, `gum x=${dx}`).toBeGreaterThan(0);
      expect(surfaceCrossings([part], [splitSkin]).length, `reversed gum x=${dx}`).toBeGreaterThan(0);
    }
  });
  it('is unchanged by world translation, rotation and winding', () => {
    const transform = (s: CrossingSurface): CrossingSurface => ({ ...s,
      points: Float64Array.from(Array.from({length: 3}, (_, v) => [s.points[v * 3 + 2] + 10, s.points[v * 3] - 5, s.points[v * 3 + 1] + 3]).flat()),
      triangles: Uint32Array.from([2, 1, 0]) });
    expect(surfaceCrossings([transform(skin)], [transform(through)])).toHaveLength(1);
  });
  it('does not mistake overlap of bounding boxes for triangle intersection', () => {
    const outside = surface('gum', [.8, .8, -.5, 1, .8, .5, .8, 1, .5]);
    expect(surfaceCrossings([skin], [outside])).toEqual([]);
  });
  it('allows coplanar contact, shared seams and point tangency', () => {
    for (const z of [[0, 0, 0], [0, 0, -.5], [0, -.5, -.5]]) {
      const contact = { ...through, points: through.points.map((v, i) => i % 3 === 2 ? z[Math.floor(i / 3)] : v) };
      expect(surfaceCrossings([skin], [contact])).toEqual([]);
    }
  });
  it('preserves original triangle IDs and bounds diagnostic examples', () => {
    const a = { ...skin, sourceTriangles: Uint32Array.from([41]) };
    const b = { ...through, sourceTriangles: Uint32Array.from([72]) };
    expect(surfaceCrossings([a], [b, b], 1e-6, 1)).toMatchObject([{ triangle: 72, skinTriangle: 41 }]);
  });
  it('documents that a fully detached exterior part is not an intersection', () => {
    const detached = { ...through, points: through.points.map((v, i) => i % 3 === 2 ? v + 2 : v) };
    expect(surfaceCrossings([skin], [detached])).toEqual([]);
  });
  it('reproduces the rejected Mara gum and isolates the fitted correction', () => {
    const fixture = JSON.parse(readFileSync(new URL('./fixtures/mara-mouth-crossings.json', import.meta.url), 'utf8'));
    for (const sample of fixture.samples) {
      const jaw = sample.name === 'lining' ? .5 : .25;
      const [part, face] = sample.parts.map((p: {label: string; rest: number[]; jawOpen: number[]; triangle: number}) => ({
        ...surface(p.label, p.rest.map((v, k) => v + jaw * p.jawOpen[k])), sourceTriangles: Uint32Array.from([p.triangle]) }));
      expect(surfaceCrossings([face], [part]).length, sample.name).toBe(sample.name === 'fitted' ? 0 : 1);
    }
  });
});
