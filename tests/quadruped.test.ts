import { expect, it } from 'vitest';
import { AnimationMixer, Quaternion, SkinnedMesh, Vector3, type Object3D } from 'three';
import { createCreature } from '../src/recipes/index.ts';
import { buildScene } from '../src/render/scene.ts';

it('keeps quadruped as a compatibility alias for vulpine', () => {
  expect(createCreature('quadruped')).toEqual(createCreature('vulpine'));
});

it('equine gallop is opt-in and has a suspension phase with all four hooves off the ground', () => {
  expect(createCreature('equine').clips.map(c => c.name)).toEqual(['walk', 'trot']);
  const project = createCreature('equine', { gaits: ['walk', 'trot', 'gallop'] });
  expect(project.clips.map(c => c.name)).toEqual(['walk', 'trot', 'gallop']);
  const built = buildScene(project);
  try {
    const clip = built.clips.find(c => c.name === 'gallop')!;
    const mixer = new AnimationMixer(built.root); mixer.clipAction(clip).play();
    const feet = [...built.bones.values()].filter(b => /_hoof$/.test(b.name));
    const rest = new Map(feet.map(b => [b.name, b.getWorldPosition(new Vector3())]));
    const seek = (phase: number) => { mixer.setTime(phase * clip.duration); built.root.updateMatrixWorld(true); };
    let airborne = 0; const touchdowns: string[] = []; let previousContact = new Set<string>();
    for (let frame = 0; frame <= 240; frame++) {
      seek(frame / 240);
      const planted = new Set<string>();
      for (const foot of feet) {
        const p = foot.getWorldPosition(new Vector3()), base = rest.get(foot.name)!;
        expect(p.y).toBeGreaterThanOrEqual(base.y - 0.0005);
        if (p.y < base.y + 0.0001) planted.add(foot.name);
      }
      if (planted.size === 0) airborne++;
      if (frame > 0) for (const name of planted) if (!previousContact.has(name)) touchdowns.push(name);
      previousContact = planted;
    }
    // Muybridge's finding: a galloping horse leaves the ground for part of every stride.
    expect(airborne).toBeGreaterThan(240 * 0.12);
    expect(airborne).toBeLessThan(240 * 0.4);
    // Transverse gallop, right lead: hind legs strike first, then the fore legs.
    const order = touchdowns.slice(0, 4).map(name => name.replace(/^leg_|_hoof$/g, ''));
    const first = order.indexOf('L_rear');
    expect([...order.slice(first), ...order.slice(0, first)]).toEqual(['L_rear', 'R_rear', 'L_front', 'R_front']);
    seek(0); const start = feet.map(f => f.getWorldPosition(new Vector3()));
    seek(1 - 1e-6); feet.forEach((f, i) => expect(f.getWorldPosition(new Vector3()).distanceTo(start[i])).toBeLessThan(0.002));
  } finally { built.dispose(); }
});

/** Hoof heights above rest for every sampled frame of a clip, in leg order. */
function hoofHeights(species: 'equine' | 'vulpine', gait: string, frames = 240): number[][] {
  const built = buildScene(createCreature(species, { gaits: [gait] }));
  try {
    const clip = built.clips.find(c => c.name === gait)!;
    const mixer = new AnimationMixer(built.root); mixer.clipAction(clip).play();
    const feet = [...built.bones.values()].filter(b => /_(hoof|paw)$/.test(b.name));
    const rest = feet.map(b => b.getWorldPosition(new Vector3()).y);
    const rows: number[][] = [];
    for (let frame = 0; frame < frames; frame++) {
      mixer.setTime(frame / frames * clip.duration); built.root.updateMatrixWorld(true);
      rows.push(feet.map((b, i) => b.getWorldPosition(new Vector3()).y - rest[i]));
    }
    return rows;
  } finally { built.dispose(); }
}

for (const species of ['equine', 'vulpine'] as const) it(`${species} gallop never has four feet down, keeps every stance short and gathers the legs in suspension`, () => {
  const rows = hoofHeights(species, 'gallop');
  // A hoof within 2 cm of the floor reads as planted in a render.
  const down = (h: number) => h < 0.02;
  for (const row of rows) expect(row.filter(down).length).toBeLessThan(4);
  for (let foot = 0; foot < 4; foot++) expect(rows.filter(row => down(row[foot])).length / rows.length).toBeLessThanOrEqual(0.4);
  // Muybridge's gathered suspension: at some moment every hoof is tucked well up toward the belly.
  expect(Math.max(...rows.map(row => Math.min(...row)))).toBeGreaterThan(species === 'equine' ? 0.12 : 0.09);
});

/** Per-frame leg samples of a clip: hoof rise, hoof reach past its shoulder or hip (+ forward), the distal joint fold, and the trunk. */
function legSamples(species: 'equine' | 'vulpine', gait: string, frames = 240) {
  const built = buildScene(createCreature(species, { gaits: [gait] }));
  try {
    const clip = built.clips.find(c => c.name === gait)!;
    const mixer = new AnimationMixer(built.root); mixer.clipAction(clip).play();
    const legs = (['L_front', 'R_front', 'L_rear', 'R_rear'] as const).map(leg => {
      const front = leg.endsWith('front');
      const joints = front ? ['shoulder', 'elbow', species === 'equine' ? 'carpus' : 'wrist'] : ['hip', 'stifle', 'hock'];
      joints.push(species === 'equine' ? 'fetlock' : 'paw');
      return { front, bones: joints.map(j => built.bones.get(`leg_${leg}_${j}`)!), foot: built.bones.get(`leg_${leg}_${species === 'equine' ? 'hoof' : 'paw'}`)! };
    });
    const world = (b: Object3D) => b.getWorldPosition(new Vector3());
    const rest = legs.map(leg => world(leg.foot).y);
    const bend = (a: Vector3, b: Vector3) => Math.atan2(a.y * b.z - a.z * b.y, a.dot(b));
    const trunkRest = world(legs[0].bones[0]).add(world(legs[2].bones[0])).multiplyScalar(0.5);
    const rows: { phase: number; rise: number[]; reach: number[]; fold: number[]; pitch: number; trunkShift: number }[] = [];
    for (let frame = 0; frame < frames; frame++) {
      mixer.setTime(frame / frames * clip.duration); built.root.updateMatrixWorld(true);
      const q = built.bones.get('root')!.getWorldQuaternion(new Quaternion());
      rows.push({
        phase: frame / frames,
        rise: legs.map((leg, i) => world(leg.foot).y - rest[i]),
        reach: legs.map(leg => world(leg.foot).z - world(leg.bones[0]).z),
        fold: legs.map(leg => { const p = leg.bones.map(world); return bend(p[2].clone().sub(p[1]), p[3].clone().sub(p[2])); }),
        pitch: 2 * Math.atan2(q.x, q.w),
        trunkShift: world(legs[0].bones[0]).add(world(legs[2].bones[0])).multiplyScalar(0.5).distanceTo(trunkRest),
      });
    }
    return rows;
  } finally { built.dispose(); }
}

for (const species of ['equine', 'vulpine'] as const) it(`${species} gallop folds every leg under the belly at the gathered moment`, () => {
  // Vulpine numbers scale with its shoulder height (1.00 m against the equine's 1.43 m).
  const scale = species === 'equine' ? 1 : 0.7;
  const rows = legSamples(species, 'gallop');
  const gathered = rows.reduce((best, row) => Math.min(...row.rise) > Math.min(...best.rise) ? row : best);
  // Muybridge's suspension: hooves high, fore hooves swung back behind the shoulders and hind hooves forward of the hips,
  // carpus and hock folded well past 60 degrees.
  for (const rise of gathered.rise) expect(rise).toBeGreaterThanOrEqual(0.35 * scale);
  for (const [i, reach] of gathered.reach.entries()) expect(i < 2 ? -reach : reach).toBeGreaterThanOrEqual(0.2 * scale);
  for (const [i, fold] of gathered.fold.entries()) expect(i < 2 ? fold : -fold).toBeGreaterThan(1.2);
});

for (const species of ['equine', 'vulpine'] as const) it(`${species} gallop pitches the trunk nose-down at the top of the leap and level at touchdown`, () => {
  const rows = legSamples(species, 'gallop');
  const gathered = rows.reduce((best, row) => Math.min(...row.rise) > Math.min(...best.rise) ? row : best);
  // About six degrees nose-down at the top of the leap; positive pitch about +X dips the nose.
  expect(gathered.pitch).toBeGreaterThan(0.08);
  expect(gathered.pitch).toBeLessThan(0.13);
  expect(Math.abs(rows[0].pitch)).toBeLessThan(0.005);
  // The pitch turns the trunk about its own centre, not the ground origin, so the body does not lurch.
  for (const row of rows) expect(row.trunkShift).toBeLessThan(0.06);
  // Walk and trot keep a level trunk.
  const project = createCreature(species, { gaits: ['walk', 'trot', 'gallop'] });
  for (const gait of ['walk', 'trot']) expect(project.clips.find(c => c.name === gait)!.tracks.some(t => t.bone === 'root' && t.property === 'rotation')).toBe(false);
  for (const gait of ['walk', 'trot']) for (const row of legSamples(species, gait, 60)) expect(row.pitch).toBe(0);
});

it('equine shell option wraps the whole horse in one smooth skin with lathe hooves', () => {
  const project = createCreature('equine', { gaits: ['walk', 'gallop'], shell: true });
  expect(project.shells).toHaveLength(1);
  // Eyes and nostrils stay separate so they read crisply on the smooth skin.
  expect(project.shells![0].parts.sort()).toEqual(project.parts.map(p => p.name).filter(n => !/eye|glint|nostril/.test(n)).sort());
  expect(project.parts.every(p => p.binding?.type === 'rigid')).toBe(true);
  expect(project.parts.filter(p => p.name.endsWith('_foot')).every(p => p.geometry.type === 'lathe')).toBe(true);
  expect(createCreature('equine').shells ?? []).toEqual([]);
  const built = buildScene(project);
  try {
    const meshes: string[] = []; built.root.traverse(o => { if (o instanceof SkinnedMesh) meshes.push(o.name); });
    expect(meshes).toContain('skin');
    expect(meshes.filter(m => m !== 'skin').every(m => /eye|glint|nostril/.test(m))).toBe(true);
    // The skin still follows the gallop: a hoof-owned vertex moves with its hoof bone.
    const clip = built.clips.find(c => c.name === 'gallop')!;
    const mixer = new AnimationMixer(built.root); mixer.clipAction(clip).play();
    const skin = built.root.getObjectByName('skin') as SkinnedMesh;
    const hoof = built.bones.get('leg_L_front_hoof')!;
    const nearest = () => { const pos = skin.geometry.getAttribute('position'); let best = 0, bestD = Infinity; const h = hoof.getWorldPosition(new Vector3()); for (let i = 0; i < pos.count; i++) { const d = new Vector3().fromBufferAttribute(pos, i).distanceTo(h); if (d < bestD) { bestD = d; best = i; } } return best; };
    mixer.setTime(0); built.root.updateMatrixWorld(true);
    const index = nearest();
    const vertex = () => skin.applyBoneTransform(index, new Vector3().fromBufferAttribute(skin.geometry.getAttribute('position'), index)).applyMatrix4(skin.matrixWorld);
    const before = vertex();
    mixer.setTime(clip.duration * 0.5); built.root.updateMatrixWorld(true); skin.skeleton.update();
    expect(vertex().distanceTo(before)).toBeGreaterThan(0.05);
  } finally { built.dispose(); }
});

it('shelled equine back is one continuous surface: no differently coloured trunk part rides inside the barrel', () => {
  const project = createCreature('equine', { shell: true });
  const body = project.parts.find(p => p.name === 'body')!;
  const [, height, length] = body.geometry.size, [, cy, cz] = body.position;
  // A part nested in the barrel with its own colour shows through the skin as a patch with an occlusion rim.
  const inBarrel = (p: { position: readonly number[] }) => ((p.position[1] - cy) / (height / 2)) ** 2 + ((p.position[2] - cz) / (length / 2)) ** 2 <= 1;
  const trunk = project.parts.filter(p => p.binding?.type === 'rigid' && p.binding.bone === 'root' && inBarrel(p));
  expect(trunk.map(p => p.name)).toContain('chest');
  for (const part of trunk) expect(part.color).toBe(body.color);
  expect(project.parts.map(p => p.name)).not.toContain('back_highlight');
  // The unshelled horse keeps its highlight stripe on top of the primitives.
  expect(createCreature('equine').parts.map(p => p.name)).toContain('back_highlight');
});

it('rejects an unknown gait name', () => {
  expect(() => createCreature('vulpine', { gaits: ['walk', 'canter'] })).toThrow(/Unknown vulpine gait: canter/);
});

for (const species of ['equine', 'vulpine'] as const) {
  it(`${species} has anatomical fore and hind chains and both walk and trot`, () => {
    const project = createCreature(species);
    expect(project.clips.map(c => c.name)).toEqual(['walk', 'trot']);
    for (const side of ['L', 'R']) for (const front of [true, false]) {
      const prefix = `leg_${side}_${front ? 'front' : 'rear'}`;
      const joints = front ? ['shoulder', 'elbow', species === 'equine' ? 'carpus' : 'wrist'] : ['hip', 'stifle', 'hock'];
      if (species === 'equine') joints.push('fetlock');
      joints.push(species === 'equine' ? 'hoof' : 'paw');
      let parent = 'root';
      for (const joint of joints) {
        const name = `${prefix}_${joint}`;
        expect(project.bones.find(b => b.name === name)?.parent).toBe(parent);
        parent = name;
      }
    }
  });

  for (const gait of ['walk', 'trot']) it(`${species}/${gait} preserves contact, segment lengths, hinge planes and a smooth loop`, () => {
    const project = createCreature(species), built = buildScene(project);
    try {
      const clip = built.clips.find(c => c.name === gait)!;
      const mixer = new AnimationMixer(built.root); mixer.clipAction(clip).play();
      const feet = [...built.bones.values()].filter(b => /_(hoof|paw)$/.test(b.name));
      const segments = [...built.bones.values()].filter(b => b.parent?.name.startsWith('leg_'));
      const lengths = segments.map(b => b.position.length());
      const rest = new Map(feet.map(b => [b.name, b.getWorldPosition(new Vector3())]));
      const seek = (phase: number) => { mixer.setTime(phase * clip.duration); built.root.updateMatrixWorld(true); };
      const peaks = new Map(feet.map(b => [b.name, 0]));
      const contacts: string[][] = [];
      const touchdowns: string[] = [];
      const previous = new Map<string, Vector3>();
      let previousContact = new Set<string>();
      for (let frame = 0; frame <= 240; frame++) {
        seek(frame / 240);
        const planted = new Set<string>();
        const velocities: number[] = [];
        for (const foot of feet) {
          const p = foot.getWorldPosition(new Vector3()), base = rest.get(foot.name)!;
          expect(p.y).toBeGreaterThanOrEqual(base.y - 0.0005);
          expect(p.x).toBeCloseTo(base.x, 5);
          expect(foot.getWorldQuaternion(new Quaternion()).angleTo(new Quaternion())).toBeLessThan(0.002);
          peaks.set(foot.name, Math.max(peaks.get(foot.name)!, p.y - base.y));
          if (p.y < base.y + 0.0001) planted.add(foot.name);
          if (planted.has(foot.name) && previousContact.has(foot.name)) velocities.push((p.z - previous.get(foot.name)!.z) * 240 / clip.duration);
          previous.set(foot.name, p);
        }
        expect(planted.size).toBeGreaterThanOrEqual(2);
        // A translating character can cancel the same backward velocity for all stance feet.
        if (velocities.length > 1) expect(Math.max(...velocities) - Math.min(...velocities)).toBeLessThan(0.025);
        if (frame > 0) for (const name of planted) if (!previousContact.has(name)) touchdowns.push(name);
        contacts.push([...planted]); previousContact = planted;
        segments.forEach((b, i) => expect(b.getWorldPosition(new Vector3()).distanceTo(b.parent!.getWorldPosition(new Vector3()))).toBeCloseTo(lengths[i], 6));
        for (const bone of [...built.bones.values()].filter(b => b.name.startsWith('leg_'))) {
          expect(Math.abs(bone.quaternion.y) + Math.abs(bone.quaternion.z)).toBeLessThan(1e-6);
        }
        for (const side of ['L', 'R']) for (const front of [true, false]) {
          const joints = front ? ['shoulder', 'elbow', species === 'equine' ? 'carpus' : 'wrist'] : ['hip', 'stifle', 'hock'];
          joints.push(species === 'equine' ? 'fetlock' : 'paw');
          const points = joints.map(joint => built.bones.get(`leg_${side}_${front ? 'front' : 'rear'}_${joint}`)!.getWorldPosition(new Vector3()));
          const vectors = points.slice(1).map((point, index) => point.clone().sub(points[index]));
          const bend = (a: Vector3, b: Vector3) => Math.atan2(a.y * b.z - a.z * b.y, a.dot(b));
          // Elbows point back, stifles forward and hocks back throughout the cycle.
          expect(bend(vectors[0], vectors[1]) * (front ? -1 : 1)).toBeGreaterThan(0.3);
          const distalBend = bend(vectors[1], vectors[2]);
          if (!front) expect(distalBend).toBeLessThan(-0.3);
          else expect(distalBend).toBeGreaterThan(species === 'equine' ? -0.04 : -0.20);
        }
        for (const mesh of [...built.objects.values()].filter(m => /_foot$/.test(m.name)) as SkinnedMesh[]) {
          const attribute = mesh.geometry.getAttribute('position');
          for (let i = 0; i < attribute.count; i++) {
            const vertex = mesh.applyBoneTransform(i, new Vector3().fromBufferAttribute(attribute, i)).applyMatrix4(mesh.matrixWorld);
            expect(vertex.y).toBeGreaterThanOrEqual(-0.001);
          }
        }
      }
      for (const peak of peaks.values()) expect(peak).toBeGreaterThan(0.06);
      if (gait === 'walk') {
        expect(contacts.some(c => c.length === 3)).toBe(true);
        const suffix = species === 'equine' ? 'hoof' : 'paw';
        // The cycle starts at LH touchdown, so the next landings are LF, RH, RF, LH.
        expect(touchdowns).toEqual(['L_front', 'R_rear', 'R_front', 'L_rear'].map(leg => `leg_${leg}_${suffix}`));
      }
      else for (const contact of contacts) {
        expect(contact.includes(`leg_L_front_${species === 'equine' ? 'hoof' : 'paw'}`)).toBe(contact.includes(`leg_R_rear_${species === 'equine' ? 'hoof' : 'paw'}`));
      }
      seek(0); const start = feet.map(b => b.getWorldPosition(new Vector3()));
      seek(1 - 1e-7); feet.forEach((b, i) => expect(b.getWorldPosition(new Vector3()).distanceTo(start[i])).toBeLessThan(1e-5));
    } finally { built.dispose(); }
  });
}
