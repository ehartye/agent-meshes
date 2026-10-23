import { describe, expect, it } from 'vitest';
import { analyzeGait, loadGait } from '../src/gait-analysis.ts';
import { exportGLB } from '../src/export.ts';
import { createCreature } from '../src/recipes/index.ts';

const clip = (project: ReturnType<typeof createCreature>, name: string) => project.clips.find(c => c.name === name)!;
const analyze = async (project: ReturnType<typeof createCreature>, name: string) =>
  analyzeGait(await loadGait(await exportGLB(project)), { clip: name }).metrics;

describe('biped design speed', () => {
  it('keeps the default walk exactly as before: one clip, 1.2 s', () => {
    const project = createCreature('biped');
    expect(project.clips.map(c => c.name)).toEqual(['walk']);
    expect(clip(project, 'walk').duration).toBe(1.2);
  });

  it('builds a run clip beside the walk when asked', () => {
    const project = createCreature('biped', { gaits: ['walk', 'run'] });
    expect(project.clips.map(c => c.name)).toEqual(['walk', 'run']);
    expect(clip(project, 'run').duration).toBeLessThan(clip(project, 'walk').duration);
  });

  it('sets the cycle length from a travel speed: duration is stride over stance times speed', () => {
    const project = createCreature('biped', { gaits: ['walk', 'run'], speed: { walk: 0.99, run: 3.52 } });
    expect(clip(project, 'walk').duration).toBeCloseTo(0.52 / (0.62 * 0.99), 2);
    expect(clip(project, 'run').duration).toBeCloseTo(0.8 / (0.4 * 3.52), 2);
  });

  it('applies one number to every requested clip', () => {
    const project = createCreature('biped', { gaits: ['walk', 'run'], speed: 1.5 });
    expect(clip(project, 'walk').duration).toBeCloseTo(0.52 / (0.62 * 1.5), 2);
    expect(clip(project, 'run').duration).toBeCloseTo(0.8 / (0.4 * 1.5), 2);
  });

  it('plants the stance foot at the requested speed: gait reports it as the clip design speed with little slide', async () => {
    const project = createCreature('biped', { gaits: ['walk', 'run'], speed: { walk: 0.99, run: 3.52 } });
    const walk = await analyze(project, 'walk');
    expect(walk.stride.travelSpeed).toBeCloseTo(0.99, 1);
    expect(walk.skate).toBeLessThanOrEqual(0.15);
    const run = await analyze(project, 'run');
    expect(run.stride.travelSpeed).toBeCloseTo(3.52, 1);
    expect(run.skate).toBeLessThanOrEqual(0.15);
  });

  it('rejects options it cannot honour, with the reason', () => {
    expect(() => createCreature('biped', { gaits: ['gallop'] })).toThrow(/walk, run/);
    expect(() => createCreature('biped', { speed: 0 })).toThrow(/speed/i);
    expect(() => createCreature('biped', { speed: { sprint: 2 } })).toThrow(/sprint/);
    expect(() => createCreature('biped', { speed: 40 })).toThrow(/cycle/);
    expect(() => createCreature('insectoid', { speed: 1 })).toThrow(/biped/);
    expect(() => createCreature('insectoid', { gaits: ['walk'] })).toThrow(/equine, vulpine or biped/);
  });
});
