import { describe, expect, it } from 'vitest';
import { AnimationMixer, Vector3 } from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { createStrandbeest, JANSEN, solveJansenLeg } from '../src/recipes/strandbeest.ts';
import { buildScene } from '../src/render/scene.ts';
import { exportGLB, verifyGLB } from '../src/export.ts';

const dist = (a: [number, number], b: [number, number]) => Math.hypot(a[0] - b[0], a[1] - b[1]);

describe("Jansen's linkage", () => {
  it('keeps every rod at its published length through a full crank turn', () => {
    for (let k = 0; k < 24; k++) {
      const leg = solveJansenLeg(2 * Math.PI * k / 24);
      expect(dist(leg.O, leg.C)).toBeCloseTo(JANSEN.m, 6);
      expect(dist(leg.P, leg.A)).toBeCloseTo(JANSEN.b, 6);
      expect(dist(leg.C, leg.A)).toBeCloseTo(JANSEN.j, 6);
      expect(dist(leg.P, leg.B)).toBeCloseTo(JANSEN.c, 6);
      expect(dist(leg.C, leg.B)).toBeCloseTo(JANSEN.k, 6);
      expect(dist(leg.P, leg.D)).toBeCloseTo(JANSEN.d, 6);
      expect(dist(leg.A, leg.D)).toBeCloseTo(JANSEN.e, 6);
      expect(dist(leg.D, leg.E)).toBeCloseTo(JANSEN.f, 6);
      expect(dist(leg.B, leg.E)).toBeCloseTo(JANSEN.g, 6);
      expect(dist(leg.B, leg.F)).toBeCloseTo(JANSEN.h, 6);
      expect(dist(leg.E, leg.F)).toBeCloseTo(JANSEN.i, 6);
    }
  });

  it('traces the famous foot path: a flat stance along the bottom and a lifted return', () => {
    const feet = Array.from({ length: 120 }, (_, k) => solveJansenLeg(2 * Math.PI * k / 120).F);
    const ys = feet.map(f => f[1]), low = Math.min(...ys), high = Math.max(...ys);
    // The foot stays low (within about six percent of the leg's reach) for over half the turn, with a short high return.
    const stance = ys.filter(y => y < low + 7).length / ys.length;
    expect(stance).toBeGreaterThan(0.5);
    expect(high - low).toBeGreaterThan(15);
    // The foot is always below the fixed frame.
    expect(high).toBeLessThan(0);
  });
});

describe('strandbeest recipe', () => {
  it('takes crank offset patterns, one clip each, and a six-pair beest stays on its feet only when the cranks are spread', () => {
    const project = createStrandbeest({ pairs: 6, patterns: { together: [0, 0, 0, 0, 0, 0], turn: [0, 1 / 6, 2 / 6, 3 / 6, 4 / 6, 5 / 6], teams: [0, 0.5, 0, 0.5, 0, 0.5] } });
    expect(project.clips.map(c => c.name)).toEqual(['together', 'turn', 'teams']);
    expect(project.bones.filter(b => /_foot$/.test(b.name))).toHaveLength(12);
    const fewest = (clipName: string) => {
      const built = buildScene(project);
      try {
        const clip = built.clips.find(c => c.name === clipName)!;
        const mixer = new AnimationMixer(built.root); mixer.clipAction(clip).play();
        const feet = [...built.bones.values()].filter(b => /_foot$/.test(b.name));
        let ground = Infinity; const heights: number[][] = [];
        for (let frame = 0; frame < 96; frame++) { mixer.setTime(clip.duration * frame / 96); built.root.updateMatrixWorld(true); const ys = feet.map(f => f.getWorldPosition(new Vector3()).y); heights.push(ys); ground = Math.min(ground, ...ys); }
        return Math.min(...heights.map(ys => ys.filter(y => y < ground + 0.09).length));
      } finally { built.dispose(); }
    };
    expect(fewest('together')).toBe(0);
    expect(fewest('turn')).toBeGreaterThanOrEqual(4);
    expect(fewest('teams')).toBeGreaterThanOrEqual(4);
    expect(() => createStrandbeest({ pairs: 3, patterns: { bad: [0, 0] } })).toThrow(/3 crank offsets/);
  });

  it('builds a walking beast with mirrored leg pairs on one crankshaft and exports it', async () => {
    const project = createStrandbeest({ pairs: 3 });
    expect(project.bones.filter(b => /^leg_[LR]_\d+_m$/.test(b.name))).toHaveLength(6);
    expect(project.clips.map(c => c.name)).toEqual(['walk']);
    // Rods are parts bound to their own bones; every rod bone has a position and a rotation track.
    const tracks = project.clips[0].tracks;
    for (const rod of ['leg_L_1_b', 'leg_L_1_h', 'leg_R_3_j']) {
      expect(tracks.some(t => t.bone === rod && t.property === 'rotation')).toBe(true);
      expect(tracks.some(t => t.bone === rod && t.property === 'position')).toBe(true);
    }
    const built = buildScene(project);
    try {
      const clip = built.clips[0];
      const mixer = new AnimationMixer(built.root); mixer.clipAction(clip).play();
      const feet = [...built.bones.values()].filter(b => /_foot$/.test(b.name));
      expect(feet).toHaveLength(6);
      let fewest = 6, ground = Infinity;
      const heights: number[][] = [];
      for (let frame = 0; frame < 120; frame++) {
        mixer.setTime(clip.duration * frame / 120); built.root.updateMatrixWorld(true);
        const ys = feet.map(f => f.getWorldPosition(new Vector3()).y); heights.push(ys); ground = Math.min(ground, ...ys);
      }
      for (const ys of heights) fewest = Math.min(fewest, ys.filter(y => y < ground + 0.09).length);
      // Three pairs at 120 degrees keep at least two feet down at all times.
      expect(fewest).toBeGreaterThanOrEqual(2);
      // Opposite legs of a pair mirror across the body: same height, opposite x.
      const l = built.bones.get('leg_L_1_foot')!.getWorldPosition(new Vector3()), r = built.bones.get('leg_R_1_foot')!.getWorldPosition(new Vector3());
      expect(l.y).toBeCloseTo(r.y, 5); expect(l.x).toBeCloseTo(-r.x, 5);
    } finally { built.dispose(); }
    expect((await verifyGLB(await exportGLB(project))).errors).toBe(0);
    const gltf = await new GLTFLoader().parseAsync((await exportGLB(project)).slice().buffer, '');
    expect(gltf.animations[0].name).toBe('walk');
  });
});
