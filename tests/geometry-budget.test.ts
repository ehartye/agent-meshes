import { describe, expect, it } from 'vitest';
import { auditGeometryBudget } from '../src/geometry-budget.ts';
import { verifyGLB } from '../src/export.ts';

import { budgetFixture } from './fixtures/budget-glb.ts';

describe('exported geometry budget', () => {
  it('separates used render records, distinct positions, triangles and unknown authoring vertices', () => {
    const report = auditGeometryBudget(budgetFixture(), { target: 'uefn' });
    expect(report.renderVertexBudget).toBe(30000);
    expect(report.meshes).toEqual([expect.objectContaining({ name: 'seamed', sourceVertices: null,
      positionVertices: 4, renderVertices: 6, triangles: 2, instances: 1 })]);
    expect(report.warnings).toEqual([]);
  });

  it('counts only triangle-referenced records rather than unused accessor rows', () => {
    expect(auditGeometryBudget(budgetFixture({ unused: true }), { target: 'uefn' }).meshes[0])
      .toMatchObject({ positionVertices: 4, renderVertices: 6, triangles: 2 });
  });

  it('uses each primitive index range instead of multiplying a shared POSITION accessor', () => {
    expect(auditGeometryBudget(budgetFixture({ primitives: [[0, 1, 2], [3, 4, 5]] }), { target: 'uefn' }).meshes[0])
      .toMatchObject({ positionVertices: 4, renderVertices: 6, triangles: 2 });
  });

  it('warns per asset rather than multiplying shared mesh instances into the budget', () => {
    const report = auditGeometryBudget(budgetFixture({ instances: 3 }), { target: 'uefn', renderVertexBudget: 6 });
    expect(report.meshes[0].instances).toBe(3);
    expect(report.totals.renderVertices).toBe(6);
    expect(report.warnings).toEqual([]);
  });

  it('treats an exceeded target budget as a warning without failing structural GLB validation', async () => {
    const report = await verifyGLB(budgetFixture(), { target: 'uefn', renderVertexBudget: 5 });
    expect(report.ok).toBe(true); expect(report.errors).toBe(0);
    expect(report.geometryBudget!.warnings).toEqual([expect.objectContaining({ code: 'RENDER_VERTEX_BUDGET_EXCEEDED', mesh: 0 })]);
    expect(report.geometryBudget!.nativeVerified).toBe(false);
  });

  it('does not claim that an unreadable primitive is below budget', () => {
    const report = auditGeometryBudget(budgetFixture({ primitives: [[0, 1, 999]] }), { target: 'uefn' });
    expect(report.meshes[0].renderVertices).toBeNull();
    expect(report.totals.renderVertices).toBeNull();
    expect(report.warnings[0].code).toBe('GEOMETRY_COUNT_UNKNOWN');
  });

  it('does not count line primitives as triangle surface geometry', () => {
    expect(auditGeometryBudget(budgetFixture({ mode: 1 }), { target: 'uefn' }).meshes[0])
      .toMatchObject({ positionVertices: 0, renderVertices: 0, triangles: 0 });
  });

  it('reports unsupported compressed geometry as unknown rather than a misleading count', () => {
    for (const compression of ['draco', 'meshopt'] as const) {
      const report = auditGeometryBudget(budgetFixture({ compression }), { target: 'uefn' });
      expect(report.meshes[0].renderVertices).toBeNull();
      expect(report.warnings[0].code).toBe('GEOMETRY_COUNT_UNKNOWN');
    }
  });

  it('rejects invalid warning budgets rather than silently ignoring them', () => {
    for (const budget of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => auditGeometryBudget(budgetFixture(), { target: 'uefn', renderVertexBudget: budget })).toThrow(/positive.*integer/i);
    }
  });

  it('keeps target reporting opt-in for existing generic GLB verification', async () => {
    expect(await verifyGLB(budgetFixture())).not.toHaveProperty('geometryBudget');
  });
});
