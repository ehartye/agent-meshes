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
      // The published diagram puts h on the outer E–F side and i on B–F.
      // https://www.csuohio.edu/sites/default/files/47A-2016.pdf
      expect(dist(leg.E, leg.F)).toBeCloseTo(JANSEN.h, 6);
      expect(dist(leg.B, leg.F)).toBeCloseTo(JANSEN.i, 6);
    }
  });

  it('keeps the upper triangle unfolded and its circle branches continuous through a full turn', () => {
    const first = solveJansenLeg(0);
    expect(first.A[1]).toBeGreaterThan(first.P[1]);
    expect(first.D[0]).toBeLessThan(first.P[0]);
    expect(first.B[1]).toBeLessThan(first.P[1]);
    const branches = [['P', 'C', 'A', 1], ['P', 'C', 'B', -1], ['P', 'A', 'D', 1], ['D', 'B', 'E', -1], ['B', 'E', 'F', 1]] as const;
    let previous = first;
    for (let frame = 1; frame <= 1440; frame++) {
      const leg = solveJansenLeg(frame / 1440 * 2 * Math.PI);
      for (const name of Object.keys(leg) as (keyof typeof leg)[]) {
        expect(dist(leg[name], previous[name])).toBeLessThan(.4);
        if (frame === 1440) expect(dist(leg[name], first[name])).toBeLessThan(1e-10);
      }
      for (const [a, b, joint, sign] of branches) {
        const p = leg[a], q = leg[b], r = leg[joint];
        const signedHeight = ((q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0])) / dist(p, q);
        expect(signedHeight * sign).toBeGreaterThan(10); // No near-tangent toggle or assembly flip.
      }
      previous = leg;
    }
  });

  it('moves the low foot in one direction instead of doubling back like the old folded assembly', () => {
    const feet = Array.from({ length: 1440 }, (_, frame) => solveJansenLeg(frame / 1440 * 2 * Math.PI).F);
    const low = Math.min(...feet.map(p => p[1]));
    const lowIndices = feet.flatMap((p, i) => p[1] < low + 3 ? [i] : []);
    expect(lowIndices.length / feet.length).toBeGreaterThan(.55);
    expect(lowIndices.length / feet.length).toBeLessThan(.65);
    for (const i of lowIndices) expect(feet[i][0] - feet[(i + feet.length - 1) % feet.length][0]).toBeGreaterThan(0);
    const xs = lowIndices.map(i => feet[i][0]);
    expect(Math.max(...xs) - Math.min(...xs)).toBeGreaterThan(65);
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
  it('drives a front-facing and a back-facing leg from every crank pin so the feet straddle the crankshaft', () => {
    const project = createStrandbeest({ pairs: 3 });
    // Four legs per crank position: L and R sides, each with an f (front) and a b (back) facing leg.
    const feet = project.bones.filter(b => /^leg_[LR]_\d+[fb]_foot$/.test(b.name));
    expect(feet).toHaveLength(12);
    // The front leg's foot path lies behind the axle (z < 0); its back-facing twin mirrors it to z > 0.
    for (let pair = 1; pair <= 3; pair++) for (const side of ['L', 'R']) {
      const front = feet.find(b => b.name === `leg_${side}_${pair}f_foot`)!, back = feet.find(b => b.name === `leg_${side}_${pair}b_foot`)!;
      expect(front.position[2]).toBeLessThan(0);
      expect(back.position[2]).toBeGreaterThan(0);
      expect(front.position[2] * back.position[2]).toBeLessThan(0);
      expect(front.position[0]).toBeCloseTo(back.position[0], 6);
    }
    // Feet are root-local, and the root is the axle: the machine stands over its feet, not beside them.
    const meanZ = feet.reduce((sum, b) => sum + b.position[2], 0) / feet.length;
    expect(Math.abs(meanZ)).toBeLessThan(0.1);
    // Both facings share the crank pin: the m rods of a front and back twin start at the same axle point.
    const mf = project.bones.find(b => b.name === 'leg_L_2f_m')!, mb = project.bones.find(b => b.name === 'leg_L_2b_m')!;
    expect(mf.position).toEqual(mb.position);
  });

  it('exports twelve legs under 2.7 MB with both corrected foot rods joined at every authored key', async () => {
    const bytes = await exportGLB(createStrandbeest({ pairs: 3 }));
    expect(bytes.byteLength).toBeLessThan(2_700_000);
    const gltf = await new GLTFLoader().parseAsync(bytes.slice().buffer, '');
    const mixer = new AnimationMixer(gltf.scene), clip = gltf.animations[0];
    mixer.clipAction(clip).play();
    const origin = (name: string) => gltf.scene.getObjectByName(name)!.getWorldPosition(new Vector3());
    const tip = (name: string, length: number) => new Vector3(0, length * .012, 0).applyMatrix4(gltf.scene.getObjectByName(name)!.matrixWorld);
    let maximumGap = 0;
    // This recipe exports sampled animation. Check exact keys, not a claim that
    // interpolating separate position/quaternion tracks is an analytic linkage.
    for (let frame = 0; frame < 60; frame++) {
      mixer.setTime(frame / 60 * clip.duration); gltf.scene.updateMatrixWorld(true);
      for (let pair = 1; pair <= 3; pair++) for (const side of ['L', 'R']) for (const facing of ['f', 'b']) {
        const leg = `leg_${side}_${pair}${facing}`;
        maximumGap = Math.max(maximumGap,
          origin(`${leg}_h`).distanceTo(tip(`${leg}_f`, JANSEN.f)),
          origin(`${leg}_i`).distanceTo(tip(`${leg}_c`, JANSEN.c)),
          tip(`${leg}_h`, JANSEN.h).distanceTo(origin(`${leg}_foot`)),
          tip(`${leg}_i`, JANSEN.i).distanceTo(origin(`${leg}_foot`)));
      }
    }
    expect(maximumGap).toBeLessThan(2e-6);
  });

  it('takes crank offset patterns and staggers low-foot coverage within each facing cohort', () => {
    const project = createStrandbeest({ pairs: 5, patterns: { together: [0, 0, 0, 0, 0], turn: [0, 0.2, 0.4, 0.6, 0.8], teams: [0, 0.5, 0, 0.5, 0] } });
    expect(project.clips.map(c => c.name)).toEqual(['together', 'turn', 'teams']);
    expect(project.bones.filter(b => /_foot$/.test(b.name))).toHaveLength(20);
    const fewest = (clipName: string, facing?: 'f' | 'b') => {
      const built = buildScene(project);
      try {
        const clip = built.clips.find(c => c.name === clipName)!;
        const mixer = new AnimationMixer(built.root); mixer.clipAction(clip).play();
        const feet = [...built.bones.values()].filter(b => (facing ? new RegExp(`${facing}_foot$`) : /_foot$/).test(b.name));
        let ground = Infinity; const heights: number[][] = [];
        for (let frame = 0; frame < 96; frame++) { mixer.setTime(clip.duration * frame / 96); built.root.updateMatrixWorld(true); const ys = feet.map(f => f.getWorldPosition(new Vector3()).y); heights.push(ys); ground = Math.min(ground, ...ys); }
        return Math.min(...heights.map(ys => ys.filter(y => y < ground + 0.09).length));
      } finally { built.dispose(); }
    };
    // Front/back legs mirror around one crank pin and already alternate their
    // low phases. Together does NOT imply every foot leaves the low band.
    expect(fewest('together')).toBeGreaterThan(0);
    for (const facing of ['f', 'b'] as const) {
      expect(fewest('together', facing)).toBe(0);
      expect(fewest('turn', facing)).toBeGreaterThanOrEqual(4);
      expect(fewest('teams', facing)).toBeGreaterThanOrEqual(4);
    }
    expect(fewest('turn')).toBeGreaterThanOrEqual(4);
    expect(fewest('teams')).toBeGreaterThanOrEqual(4);
    expect(() => createStrandbeest({ pairs: 3, patterns: { bad: [0, 0] } })).toThrow(/3 crank offsets/);
    // Four legs of twelve bones per position: six positions would pass the project's 256-bone limit.
    expect(() => createStrandbeest({ pairs: 6 })).toThrow(/at most 5 crank positions/);
  });

  it('builds a walking beast with mirrored leg pairs on one crankshaft and exports it', async () => {
    const project = createStrandbeest({ pairs: 3 });
    expect(project.bones.filter(b => /^leg_[LR]_\d+[fb]_m$/.test(b.name))).toHaveLength(12);
    expect(project.clips.map(c => c.name)).toEqual(['walk']);
    // Rods are parts bound to their own bones; every rod bone has a position and a rotation track.
    const tracks = project.clips[0].tracks;
    for (const rod of ['leg_L_1f_b', 'leg_L_1b_h', 'leg_R_3f_j']) {
      expect(tracks.some(t => t.bone === rod && t.property === 'rotation')).toBe(true);
      expect(tracks.some(t => t.bone === rod && t.property === 'position')).toBe(true);
    }
    const built = buildScene(project);
    try {
      const clip = built.clips[0];
      const mixer = new AnimationMixer(built.root); mixer.clipAction(clip).play();
      const feet = [...built.bones.values()].filter(b => /_foot$/.test(b.name));
      expect(feet).toHaveLength(12);
      const facing = (letter: string) => feet.map((f, i) => [f, i] as const).filter(([f]) => new RegExp(`\\d${letter}_foot$`).test(f.name)).map(([, i]) => i);
      let fewest = 12, fewestFront = 12, fewestBack = 12, ground = Infinity;
      const heights: number[][] = [];
      for (let frame = 0; frame < 120; frame++) {
        mixer.setTime(clip.duration * frame / 120); built.root.updateMatrixWorld(true);
        const ys = feet.map(f => f.getWorldPosition(new Vector3()).y); heights.push(ys); ground = Math.min(ground, ...ys);
      }
      for (const ys of heights) {
        fewest = Math.min(fewest, ys.filter(y => y < ground + 0.09).length);
        fewestFront = Math.min(fewestFront, facing('f').filter(i => ys[i] < ground + 0.09).length);
        fewestBack = Math.min(fewestBack, facing('b').filter(i => ys[i] < ground + 0.09).length);
      }
      // Three crank positions at 120 degrees keep at least two feet of each facing down at all times.
      expect(fewest).toBeGreaterThanOrEqual(4);
      expect(fewestFront).toBeGreaterThanOrEqual(2);
      expect(fewestBack).toBeGreaterThanOrEqual(2);
      // Opposite legs of a pair mirror across the body: same height, opposite x.
      const l = built.bones.get('leg_L_1f_foot')!.getWorldPosition(new Vector3()), r = built.bones.get('leg_R_1f_foot')!.getWorldPosition(new Vector3());
      expect(l.y).toBeCloseTo(r.y, 5); expect(l.x).toBeCloseTo(-r.x, 5);
    } finally { built.dispose(); }
    expect((await verifyGLB(await exportGLB(project))).errors).toBe(0);
    const gltf = await new GLTFLoader().parseAsync((await exportGLB(project)).slice().buffer, '');
    expect(gltf.animations[0].name).toBe('walk');
  });
});
