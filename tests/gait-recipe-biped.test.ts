import { beforeAll, describe, expect, it } from 'vitest';
import { analyzeGait, loadGait, resolveGaitBones } from '../src/gait-analysis.ts';
import type { GaitSource } from '../src/gait-analysis.ts';
import { exportGLB } from '../src/export.ts';
import { createCreature } from '../src/recipes/index.ts';

describe('gait analysis of the biped recipe', () => {
  it('resolves the recipe bone names: the root as pelvis, the chest as spine, hip, knee and ankle as the leg', () => {
    const project = createCreature('biped');
    const parent = new Map(project.bones.map(bone => [bone.name, bone.parent]));
    const rig = resolveGaitBones(project.bones.map(bone => bone.name), name => parent.get(name) ?? null);
    expect(rig.pelvis).toBe('root');
    expect(rig.spine).toEqual(['chest']);
    expect(rig.head).toBe('head');
    expect(rig.legs.a).toEqual({ thigh: 'leg_L_hip', calf: 'leg_L_knee', foot: 'leg_L_ankle' });
    expect(rig.legs.b).toEqual({ thigh: 'leg_R_hip', calf: 'leg_R_knee', foot: 'leg_R_ankle' });
    expect(rig.arms.a).toEqual({ upper: 'arm_L', lower: 'elbow_L' });
  });

  describe('the walk clip', () => {
    let source: GaitSource;
    beforeAll(async () => { source = await loadGait(await exportGLB(createCreature('biped'))); });
    const analyze = (travelSpeed?: number) => analyzeGait(source, { clip: 'walk', ...(travelSpeed ? { travelSpeed } : {}) });

    it('plants the stance foot: at its own design speed the sole slides under a tenth of travel speed', () => {
      const { metrics } = analyze();
      expect(metrics.skate).toBeLessThanOrEqual(0.1);
      expect(metrics.stanceSpeedRatio.min).toBeGreaterThanOrEqual(0.9);
      expect(metrics.stanceSpeedRatio.max).toBeLessThanOrEqual(1.1);
    });

    it('reports the clip design speed as the travel speed it is measured at, stride over stance times duration', () => {
      const { metrics } = analyze();
      expect(metrics.stride.travelSpeed).toBeCloseTo(0.52 / (0.62 * 1.2), 2);
    });

    it('slides when the character moves faster than the design speed, in proportion to the mismatch', () => {
      const design = analyze().metrics.stride.travelSpeed;
      const fast = analyze(design * 1.4).metrics;
      expect(fast.stanceSpeedRatio.max).toBeCloseTo(1 / 1.4, 1);
      expect(fast.skate).toBeGreaterThan(0.25);
      const slow = analyze(design * 0.7).metrics;
      expect(slow.stanceSpeedRatio.min).toBeGreaterThan(1.3);
    });
  });
});
