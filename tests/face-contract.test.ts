import { describe, expect, it } from 'vitest';
import { verifyFaceContract } from '../src/face-contract.ts';
import { ballNose, browBar, tube, domeRidge, ear, horn, encodeHead, extras, fringe, mesh, nostril, passingHead, pinhole, relid, shutterEye, socketGap, terracedSocket, REQUIRED, sphere, upperSeam, EYES, JAW_DROP, LID_SWEEPS, MOUTH_Y, type SynthHead, type Vec3 } from './helpers/face-glb.ts';

async function report(mutate?: (head: SynthHead) => void) {
  const head = passingHead(); mutate?.(head);
  return verifyFaceContract(encodeHead(head));
}
const failed = (result: Awaited<ReturnType<typeof report>>) => result.checks.filter(c => !c.ok).map(c => c.id);

// The machine may be busy (Blender builds, CI): each verification runs the whole contract, so allow 30 s.
describe('arkit-face/1 verifier', { timeout: 30_000 }, () => {
  it('passes a head that meets every computable clause and reports its measurements', async () => {
    const result = await report();
    expect(result.failures).toEqual([]);
    expect(result.ok).toBe(true);
    expect(result.contract).toBe('arkit-face/1');
    expect(result.checks.map(c => c.id)).toEqual(['validator', 'skeleton', 'skinning', 'eyes', 'orientation', 'morph-names', 'rest-weights', 'morph-motion', 'inversion', 'lid-clearance', 'eye-coverage', 'eye-oblique', 'lid-follow', 'materials', 'attached-parts', 'eye-crease', 'extras', 'exposed-teeth', 'head-binding', 'teeth', 'mouth-parts', 'puppet-jaw', 'upper-lip', 'mouth-open']);
    expect(result.measurements.eyes.L!.radius).toBeCloseTo(0.012, 5);
    expect(result.measurements.eyes.L!.center[0]).toBeCloseTo(0.03, 5);
    expect(result.measurements.eyes.L!.minLidClearance).toBeGreaterThan(0.0005);
    // Front rays across each eyeball: the neutral opening shows part of it, every closed state none of it.
    const coverage = result.measurements.eyes.L!.coverage!;
    expect(coverage.samples).toBeGreaterThan(1000);
    expect(coverage.neutral).toBeGreaterThan(coverage.samples / 4);
    for (const label of ['eyeBlinkLeft=1', 'eyeBlinkLeft=1 + eyeSquintLeft=1', 'eyeBlinkLeft=1 + eyeWideLeft=1', 'eyeBlinkLeft=1 + eyeSquintLeft=1 + eyeWideLeft=1']) expect(coverage.visible[label], label).toBe(0);
    expect(coverage.visible['eyeBlinkLeft=0.5']).toBeLessThan(coverage.neutral);
    expect(coverage.visible['eyeWideLeft=1']).toBeGreaterThanOrEqual(coverage.neutral);
    // Oblique rays (front, 3/4 at 35-45 degrees of yaw, 20 degrees above and below) never find the socket or the inside of the head.
    const oblique = result.measurements.eyes.L!.oblique!;
    expect(oblique.views).toBe(15);
    expect(oblique.rays).toBeGreaterThan(10000);
    expect(oblique.leaks).toBe(0);
    // Lid follow moves the upper lid's edge measurably: 2 mm up at eyeLookUp = 1, more down at eyeLookDown = 1.
    expect(result.measurements.eyes.L!.lidFollow!.up).toBeGreaterThan(0.0015);
    expect(result.measurements.eyes.L!.lidFollow!.down).toBeGreaterThan(0.0015);
    expect(result.measurements.restTeeth).toMatchObject({ visible: 0 });
    expect(result.measurements.restTeeth!.samples).toBeGreaterThan(100);
    expect(result.measurements.morphMotion.jawOpen).toBeGreaterThan(0.01);
    expect(result.measurements.teeth.lowerDrop).toBeGreaterThan(0.001);
    // The chin (the face's lowest point) drops by the whole jaw drop: 30 mm of a 0.22 m face.
    expect(result.measurements.chinDrop).toBeCloseTo(JAW_DROP, 5);
    expect(result.measurements.faceHeight).toBeCloseTo(0.22, 5);
    expect(result.measurements.chinDropRatio).toBeCloseTo(JAW_DROP / 0.22, 4);
    expect(result.measurements.upperLipMove).toBe(0);
    expect(result.measurements.mouthOpen).toMatchObject({ hits: ['face[mouth_cavity]', 'face[mouth_cavity]', 'face[mouth_cavity]'] });
    expect(result.measurements.inversionCombos).toBeGreaterThan(REQUIRED.length * 2);
    expect(result.measurements.height).toBeCloseTo(0.22, 3);
    expect(result.warnings.filter(w => /height/.test(w))).toEqual([]);
    expect(JSON.parse(JSON.stringify(result)).ok).toBe(true);
  });

  const negatives: [string, string, (head: SynthHead) => void][] = [
    ['validator', 'glTF validator errors', head => { head.dropBounds = true; }],
    ['skeleton', 'a missing eye bone', head => { head.joints[0].children = ['eye_L', 'eyeR']; head.joints[2].name = 'eyeR'; mesh(head, 'eyeball_R').bones = mesh(head, 'eyeball_R').bones!.map(() => 'eyeR'); }],
    ['skeleton', 'eye_L on the character right', head => { head.joints[1].translation = EYES.R; head.joints[2].translation = EYES.L; }],
    ['skeleton', 'more than one skin', head => { head.extraSkin = true; }],
    ['skinning', 'an unskinned mesh', head => { mesh(head, 'eyeball_R').unskinnedNode = true; }],
    ['eyes', 'an eyeball bound to head', head => { const m = mesh(head, 'eyeball_L'); m.bones = m.bones!.map(() => 'head'); }],
    ['eyes', 'an eye bone away from its eyeball center', head => { const m = mesh(head, 'eyeball_L'); Object.assign(m, sphere([EYES.L[0] + 0.004, EYES.L[1], EYES.L[2]], 0.012)); m.bones = m.positions.map(() => 'eye_L'); mesh(head, 'lids_L').positions = mesh(head, 'lids_L').positions.map(p => [p[0] + 0.004, p[1], p[2]] as Vec3); }],
    ['orientation', 'a face looking down -Z', head => {
      const flip = (p: Vec3): Vec3 => [p[0], p[1], -p[2]];
      for (const m of head.meshes) { m.positions = m.positions.map(flip); for (const t of m.targets) t.positions = t.positions.map(flip); }
      for (const j of head.joints) j.translation = flip(j.translation);
    }],
    ['morph-names', 'a missing required morph', head => { const face = mesh(head, 'face'); face.targets = face.targets.filter(t => t.name !== 'cheekSquintRight'); (head.rootExtras!.arkitFace as { morphs: string[] }).morphs = REQUIRED.filter(n => n !== 'cheekSquintRight'); }],
    ['morph-names', 'a near-miss morph name', head => { mesh(head, 'lids_L').targets[0].name = 'EyeBlinkLeft'; }],
    ['morph-names', 'a morph name repeated across glTF meshes (Unreal then drops every name)', head => { head.groups!.face = head.groups!.face.filter(n => n !== 'teeth_lower'); }],
    ['rest-weights', 'a nonzero rest weight', head => { const face = mesh(head, 'face'); face.weights = REQUIRED.map((_, i) => i === 3 ? 0.2 : 0); }],
    ['morph-motion', 'a dead morph', head => { const face = mesh(head, 'face'); const t = face.targets.find(x => x.name === 'browInnerUp')!; t.positions = face.positions.map(p => [p[0], p[1], p[2] + 0.0004] as Vec3); }],
    ['inversion', 'a morph that flips triangles', head => { const face = mesh(head, 'face'); const t = face.targets.find(x => x.name === 'mouthFunnel')!; t.positions = face.positions.map(p => Math.hypot(p[0], p[1] + 0.045) < 0.02 ? [-p[0], p[1], p[2]] as Vec3 : p); }],
    ['lid-clearance', 'lids that cut the eyeball mid-blink', head => { const lid = mesh(head, 'lids_L'); const c = EYES.L; const scale = (p: Vec3): Vec3 => [c[0] + (p[0] - c[0]) * 0.84, c[1] + (p[1] - c[1]) * 0.84, c[2] + (p[2] - c[2]) * 0.84]; lid.positions = lid.positions.map(scale); for (const t of lid.targets) t.positions = t.positions.map(scale); }],
    ['eye-coverage', 'shutter blades too short for blink 1 + squint 1 (the round-2 sliver under the lower blade)', head => shutterEye(head, 'L', 1.3, 0.08)],
    ['eye-coverage', 'lids that do not meet at blink 1 (a slit of eyeball stays open)', head => relid(head, 'R', { ...LID_SWEEPS, upper: { ...LID_SWEEPS.upper, blink: -30 } })],
    ['eye-coverage', 'a blink that drops the lower lid (eyeball shows over the lid mid-blink)', head => relid(head, 'L', { ...LID_SWEEPS, lower: { ...LID_SWEEPS.lower, blink: -20 } })],
    ['eye-coverage', 'lids that part at blink 1 + wide 1 (surprised plus an idle blink)', head => relid(head, 'L', { upper: { ...LID_SWEEPS.upper, blink: -42, wide: 12 }, lower: { ...LID_SWEEPS.lower, blink: 24 } })],
    ['eye-oblique', "lids that stop short of the skin's eye hole over a dark socket (the round-3 black hole beside the eye)", head => socketGap(head, 'L')],
    ['lid-follow', 'lid follow up too small to see (the round-3 defaults: eyeWide .25 of a small lift)', head => { head.rootExtras = { arkitFace: { ...extras(), lidFollow: { down: 0.35, up: 0.25 } } }; }],
    ['lid-follow', 'lid follow down too small to see', head => { head.rootExtras = { arkitFace: { ...extras(), lidFollow: { down: 0.02, up: 1 } } }; }],
    ['materials', 'lids with an alpha-blended material (they render see-through while the verifier counts them closed)', head => { head.materialProps = { lid: { alphaMode: 'BLEND' } }; }],
    ['materials', 'skin with an alpha-masked material', head => { head.materialProps = { skin: { alphaMode: 'MASK', alphaCutoff: 0.5 } }; }],
    ['materials', 'transmissive teeth', head => { head.materialProps = { teeth_upper: { extensions: { KHR_materials_transmission: { transmissionFactor: 1 } } } }; }],
    ['eye-coverage', 'transparent lids at blink 1 (they occlude nothing)', head => { head.materialProps = { lid: { alphaMode: 'BLEND', pbrMetallicRoughness: { baseColorFactor: [1, 1, 1, 0] } } }; }],
    ['attached-parts', 'a brow bar standing 3 mm off the skin (the round-4 floating brow ridge)', head => browBar(head, 0.003)],
    ['attached-parts', 'a brow that browInnerUp lifts off the skin', head => browBar(head, -0.0002, 0.003)],
    ['attached-parts', 'a nostril that noseSneer buries as the skin swells over it (a part that does not carry the skin shape)', head => nostril(head, false)],
    ['attached-parts', 'an ear hovering 2 mm off the side of the head', head => ear(head, 0.004)],
    ['extras', 'missing extras', head => { head.rootExtras = undefined; }],
    ['extras', 'a wrong contract version', head => { head.rootExtras = { arkitFace: { ...extras(), contract: 'arkit-face/2' } }; }],
    ['extras', 'a morph list that does not match the file', head => { head.rootExtras = { arkitFace: extras([...REQUIRED, 'tongueOut']) }; }],
    ['extras', 'an emotion curve that is not ARKit', head => { const e = extras(); (e.emotions as Record<string, Record<string, number>>).happy.grin = 1; head.rootExtras = { arkitFace: e }; }],
    ['exposed-teeth', 'upper teeth pushed through a closed face at rest with exposedTeeth []', head => { const upper = mesh(head, 'teeth_upper'); upper.positions = upper.positions.map(p => [p[0], p[1], p[2] + 0.02] as Vec3); }],
    ['exposed-teeth', 'undeclared exposed teeth', head => { const e = extras(); delete e.exposedTeeth; head.rootExtras = { arkitFace: e }; }],
    ['exposed-teeth', 'the whole upper row poking through the lips while exposedTeeth names teeth_upper (round 3 could not tell it from buck teeth)', head => {
      const upper = mesh(head, 'teeth_upper'); upper.positions = upper.positions.map(p => [p[0], p[1], p[2] + 0.02] as Vec3);
      head.rootExtras = { arkitFace: { ...extras(), exposedTeeth: ['teeth_upper'] } };
    }],
    ['exposed-teeth', 'exposedTeeth naming a part the file does not have', head => { head.rootExtras = { arkitFace: { ...extras(), exposedTeeth: ['fangs'] } }; }],
    ['teeth', 'upper teeth moved by jawOpen', head => { const upper = mesh(head, 'teeth_upper'); upper.targets = [{ name: 'jawOpen', positions: upper.positions.map(p => [p[0], p[1] - 0.01, p[2]] as Vec3) }]; }],
    ['teeth', 'lower teeth that stay put', head => { const lower = mesh(head, 'teeth_lower'); lower.targets = []; }],
    ['teeth', 'no teeth named by the convention', head => { mesh(head, 'teeth_upper').material = 'enamel'; }],
    ['mouth-parts', 'a tongue left behind by the jaw', head => { mesh(head, 'tongue').targets = []; }],
    ['head-binding', 'a skull bound to an eye bone', head => { const m = mesh(head, 'skull'); m.bones = m.bones!.map(() => 'eye_L'); }],
    ['head-binding', 'upper teeth bound to an eye bone', head => { const m = mesh(head, 'teeth_upper'); m.bones = m.bones!.map(() => 'eye_R'); }],
    ['puppet-jaw', 'a hole opening in a fixed face (only a lip band drops; the chin stays)', head => { const face = mesh(head, 'face'); const jaw = face.targets.find(t => t.name === 'jawOpen')!; jaw.positions = face.positions.map((p, i) => jaw.positions[i][1] < p[1] && p[1] > MOUTH_Y - 0.0151 ? [p[0], p[1] - 0.01, p[2]] as Vec3 : p); }],
    ['upper-lip', 'skin above the mouth line dropping with the jaw', head => { const face = mesh(head, 'face'); const jaw = face.targets.find(t => t.name === 'jawOpen')!; jaw.positions = face.positions.map((p, i) => p[1] >= MOUTH_Y && p[1] <= MOUTH_Y + 0.0151 && Math.abs(p[0]) <= 0.03 ? [p[0], p[1] - 0.006, p[2]] as Vec3 : jaw.positions[i]); }],
    ['mouth-open', 'an upper-lip seam carried by the jaw (the lip hangs like a curtain over the open mouth)', head => { const face = mesh(head, 'face'); const jaw = face.targets.find(t => t.name === 'jawOpen')!; for (const i of upperSeam()) jaw.positions[i] = [face.positions[i][0], face.positions[i][1] - JAW_DROP, face.positions[i][2]]; }],
    ['mouth-open', 'an open mouth that sees through the head (no teeth, tongue or cavity behind the lips)', head => { head.groups!.face = head.groups!.face.filter(n => n !== 'mouth_cavity'); head.meshes = head.meshes.filter(m => m.name !== 'mouth_cavity' && m.name !== 'skull'); }],
    ['puppet-jaw', 'a fixed face with only the teeth dropping', head => { const face = mesh(head, 'face'); face.targets = face.targets.map(t => t.name === 'jawOpen' ? { name: 'jawOpen', positions: face.positions.map((p, i) => i === 0 ? [p[0], p[1] + 0.002, p[2]] as Vec3 : p) } : t); }],
  ];
  for (const [id, label, mutate] of negatives) {
    it(`fails ${id} for ${label}`, async () => {
      const result = await report(mutate);
      expect(result.ok).toBe(false);
      expect(failed(result)).toContain(id);
      expect(result.failures.some(f => f.startsWith(`${id}: `))).toBe(true);
    });
  }

  it('says where triangles flip: their rest centroids in mm and the face region, with the spots in the measurements', async () => {
    // mouthFunnel mirrors the skin within 20 mm of (0, -45) mm across x: the triangles there flip (and collapse at 0.5).
    const result = await report(head => { const face = mesh(head, 'face'); const t = face.targets.find(x => x.name === 'mouthFunnel')!; t.positions = face.positions.map(p => Math.hypot(p[0], p[1] + 0.045) < 0.02 ? [-p[0], p[1], p[2]] as Vec3 : p); });
    const failure = result.failures.find(f => f.startsWith('inversion: mouthFunnel=1 '))!;
    expect(failure).toMatch(/^inversion: mouthFunnel=1 flips \d+ triangle\(s\) on face\[skin\] at \(-?\d+\.\d, -?\d+\.\d, -?\d+\.\d\) mm \([a-z ]+\)/);
    const spots = [...failure.matchAll(/\((-?\d+\.\d), (-?\d+\.\d), (-?\d+\.\d)\) mm/g)].map(m => m.slice(1).map(Number));
    expect(spots.length).toBeGreaterThan(0);
    expect(spots.length).toBeLessThanOrEqual(4);
    for (const [x, y, z] of spots) expect(Math.hypot(x, y + 45, z - 60)).toBeLessThan(25);
    const entry = result.measurements.inversions.find(i => i.combo === 'mouthFunnel=1')!;
    expect(entry).toMatchObject({ part: 'face[skin]' });
    expect(entry.count).toBeGreaterThan(0);
    for (const [x, y] of entry.at) expect(Math.hypot(x, y + 0.045)).toBeLessThan(0.025);
    expect(result.measurements.inversions.length).toBeLessThanOrEqual(20);
  });

  it('counts at most one fold above and below a plain lid eye, and fails a terraced socket of stacked bands', async () => {
    const plain = await report();
    const crease = plain.measurements.eyes.L!.crease!;
    expect(crease.above).toBeLessThanOrEqual(1);
    expect(crease.below).toBeLessThanOrEqual(1);
    expect(plain.failures.filter(f => f.startsWith('eye-crease'))).toEqual([]);
    // The P1a round 6-7 critics: 3-4 stacked bands round every shell-lid eye. Two 1.5 mm terraces above and below fold
    // the median line three times on each side of the eye (onto each terrace, and onto the mask from the lid).
    const terraced = await report(head => terracedSocket(head, 'L'));
    const left = terraced.measurements.eyes.L!.crease!;
    expect(left.above).toBeGreaterThanOrEqual(2);
    expect(left.below).toBeGreaterThanOrEqual(2);
    expect(Object.values(left.at!).flat().every(d => d > 0 && d <= 1.3)).toBe(true);
    const failures = terraced.failures.filter(f => f.startsWith('eye-crease'));
    expect(failures.some(f => /eye_L: the skin above the eye folds \d times/.test(f))).toBe(true);
    expect(failures.some(f => /eye_L: the skin below the eye folds \d times/.test(f))).toBe(true);
    expect(failures.some(f => /eye_R/.test(f))).toBe(false);
  });

  it('names the eye, the state and the uncovered heights when a closed blink leaves eyeball showing', async () => {
    const result = await report(head => shutterEye(head, 'L', 1.3, 0.08));
    const failure = result.failures.find(f => f.startsWith('eye-coverage: eyeBlinkLeft=1 + eyeSquintLeft=1:'))!;
    expect(failure).toMatch(/front rays reach eyeball_L/);
    // The bare crescent runs from the bottom of the eyeball up to where the short lower blade stops (-0.853 r).
    expect(failure).toMatch(/heights -0\.9\d to -0\.8\d eyeball radii/);
    expect(result.failures.filter(f => /eyeBlinkRight|eyeball_R/.test(f))).toEqual([]);
    expect(result.measurements.eyes.L!.coverage!.visible['eyeBlinkLeft=1 + eyeSquintLeft=1']).toBeGreaterThan(0);
    expect(result.measurements.eyes.R!.coverage!.visible['eyeBlinkRight=1 + eyeSquintRight=1']).toBe(0);
  });

  it('finds a closed eye that parts by a thin strip seen only from below, which front rays miss', async () => {
    // The blades overlap 0.24 mm at blink 1, but the upper one stands 3.2 mm in front of the lower: 15 degrees below sees between them.
    const result = await report(head => shutterEye(head, 'L', 2.1, 0.02, 0.004));
    const coverage = result.measurements.eyes.L!.coverage!;
    expect(coverage.visible['eyeBlinkLeft=1']).toBe(0);
    expect(coverage.pitched['-15']['eyeBlinkLeft=1']).toBeGreaterThan(0);
    expect(coverage.pitched['15']['eyeBlinkLeft=1']).toBe(0);
    const failure = result.failures.find(f => f.startsWith('eye-coverage: eyeBlinkLeft=1 seen from 15 degrees below:'))!;
    expect(failure).toMatch(/rays reach eyeball_L/);
    expect(result.measurements.eyes.R!.coverage!.pitched['-15']['eyeBlinkRight=1']).toBe(0);
  });

  it('finds a closed eye that parts only from 25 degrees below, as the round-6 kid did at blink 1 + wide 1', async () => {
    // The blades overlap 1.5 mm at blink 1 with the upper one 5.2 mm in front: 15 degrees below still sees them meet, 25 does not.
    const result = await report(head => shutterEye(head, 'L', 2.1, 0.125, 0.006));
    const pitched = result.measurements.eyes.L!.coverage!.pitched;
    expect(result.measurements.eyes.L!.coverage!.visible['eyeBlinkLeft=1']).toBe(0);
    expect(pitched['-15']['eyeBlinkLeft=1']).toBe(0);
    expect(pitched['-25']['eyeBlinkLeft=1']).toBeGreaterThan(0);
    expect(result.failures.some(f => f.startsWith('eye-coverage: eyeBlinkLeft=1 seen from 25 degrees below:'))).toBe(true);
  });

  it('passes shutter blades sized for every blink, squint and wide combination', async () => {
    // From 15 and 25 degrees above and below, the eyeball's rim shows past these flat blades' far ends (0.9 eyeball radii
    // from its center, round the housing of the robot's shutter eyes): that belongs to eye-oblique, not to closed lids parting.
    const result = await report(head => { shutterEye(head, 'L', 1.67); shutterEye(head, 'R', 1.67); });
    expect(result.failures).toEqual([]);
    expect(result.measurements.eyes.L!.coverage!.visible['eyeBlinkLeft=1 + eyeSquintLeft=1']).toBe(0);
  });

  it('accepts buck teeth showing at rest in their own teeth_exposed material when exposedTeeth declares it', async () => {
    const result = await report(head => {
      const buck = { ...mesh(head, 'teeth_upper'), name: 'buck_teeth', material: 'teeth_exposed' };
      buck.positions = buck.positions.map(p => [p[0] * 0.3, p[1], p[2] + 0.02] as Vec3); buck.bones = buck.positions.map(() => 'head');
      head.meshes.push(buck); head.groups!.face.push('buck_teeth');
      head.rootExtras = { arkitFace: { ...extras(), exposedTeeth: ['teeth_exposed'] } };
    });
    expect(result.failures).toEqual([]);
    expect(result.measurements.restTeeth!.visible).toBeGreaterThan(0);
    // Exposed teeth ride the skull like the upper row: jawOpen must not move them.
    expect(result.measurements.teeth.upperMove).toBe(0);
  });

  it('names the teeth that show at rest but are not declared exposed', async () => {
    const result = await report(head => {
      const upper = mesh(head, 'teeth_upper'); upper.positions = upper.positions.map(p => [p[0], p[1], p[2] + 0.02] as Vec3);
      head.rootExtras = { arkitFace: { ...extras(), exposedTeeth: ['teeth_upper'] } };
    });
    const failure = result.failures.find(f => f.startsWith('exposed-teeth: '))!;
    expect(failure).toMatch(/face\[teeth_upper\]/);
    expect(failure).toMatch(/teeth_exposed/);
  });

  it('finds the socket beside the eye in 3/4 view that the front rays miss, and names the fix', async () => {
    const result = await report(head => socketGap(head, 'L'));
    expect(failed(result)).not.toContain('eye-coverage');
    const failure = result.failures.find(f => f.startsWith('eye-oblique: '))!;
    expect(failure).toMatch(/eye_socket/);
    expect(failure).toMatch(/yaw [+-]\d+/);
    expect(failure).toMatch(/eye_hole/);
    expect(result.measurements.eyes.L!.oblique!.leaks).toBeGreaterThan(0);
    expect(result.measurements.eyes.R!.oblique!.leaks).toBe(0);
    expect(result.failures.filter(f => /eyeball_R/.test(f))).toEqual([]);
  });

  it('reports how far lid follow moves the upper lid and fails a lift under 1.5 mm', async () => {
    const result = await report(head => { head.rootExtras = { arkitFace: { ...extras(), lidFollow: { down: 0.35, up: 0.25 } } }; });
    const failure = result.failures.find(f => f.startsWith('lid-follow: '))!;
    expect(failure).toMatch(/eyeLookUpLeft=1/);
    expect(failure).toMatch(/lidFollow\.up/);
    expect(result.measurements.eyes.L!.lidFollow!.up).toBeLessThan(0.0015);
    expect(result.measurements.eyes.L!.lidFollow!.up).toBeGreaterThan(0);
  });

  it('calls a mouth without a cavity see-through even when the ray finds the back of the skull', async () => {
    const result = await report(head => { head.groups!.face = head.groups!.face.filter(n => n !== 'mouth_cavity'); head.meshes = head.meshes.filter(m => m.name !== 'mouth_cavity'); });
    const failures = result.failures.filter(f => f.startsWith('mouth-open: '));
    expect(failures.length).toBeGreaterThan(0);
    for (const failure of failures) { expect(failure).toMatch(/see-through/); expect(failure).not.toMatch(/covers the opening/); }
  });

  it('fails lid clearance only for the eye whose lids cut in, and names it', async () => {
    const result = await report(head => {
      const lid = mesh(head, 'lids_R'), c = EYES.R;
      const scale = (p: Vec3): Vec3 => [c[0] + (p[0] - c[0]) * 0.84, c[1] + (p[1] - c[1]) * 0.84, c[2] + (p[2] - c[2]) * 0.84];
      lid.positions = lid.positions.map(scale); for (const t of lid.targets) t.positions = t.positions.map(scale);
    });
    const failure = result.failures.find(f => f.startsWith('lid-clearance'))!;
    expect(failure).toMatch(/eyeBlinkRight/);
    expect(failure).not.toMatch(/eyeBlinkLeft/);
    expect(result.measurements.eyes.L!.minLidClearance).toBeGreaterThan(0.0005);
  });

  it('names the bone a skull is bound to instead of calling it a misplaced eyeball', async () => {
    const result = await report(head => { const m = mesh(head, 'skull'); m.bones = m.bones!.map(() => 'eye_L'); });
    expect(result.failures).toContain("head-binding: skull is bound to eye_L, not head: the skull, gums, upper teeth and every morph-bearing part must be bound 100% to head (bind_rigid(obj, rig, 'head'))");
    expect(result.failures.filter(f => f.startsWith('eyes: '))).toEqual(["eyes: skull is bound 100% to eye_L but reaches 203.92 mm from the eye center, too far for an eyeball: only the eyeball belongs to eye_L; bind the skull to head"]);
    expect(result.measurements.eyes.L!.eyeballs).toEqual(['eyeball_L']);
  });

  it('measures the puppet jaw at the lowest face point and reports the lower lip separately', async () => {
    const result = await report(head => { const face = mesh(head, 'face'); const jaw = face.targets.find(t => t.name === 'jawOpen')!; jaw.positions = face.positions.map((p, i) => jaw.positions[i][1] < p[1] && p[1] > MOUTH_Y - 0.0151 ? [p[0], p[1] - 0.01, p[2]] as Vec3 : p); });
    expect(result.measurements.chinDrop).toBe(0);
    expect(result.failures).toContain("puppet-jaw: jawOpen=1 drops the face's lowest point (the chin) by only 0.00 mm, 0.0% of the 220.00 mm face height (needs a drop of >= 10%, 22.00 mm): the chin and lower face outline must drop with the jaw, not only the lips; hinge the jaw by the ears (JawHinge.ear)");
  });

  it('explains why a morph name may not repeat across glTF meshes', async () => {
    const result = await report(head => { head.groups!.face = head.groups!.face.filter(n => n !== 'tongue'); });
    const failure = result.failures.find(f => f.startsWith('morph-names: '))!;
    expect(failure).toMatch(/"jawOpen" \(mesh \d+ "face", mesh \d+ "tongue"\)/);
    expect(failure).toMatch(/discards every morph target name in the file/);
    expect(failure).toMatch(/join_face_parts/);
  });

  it('finds teeth and mouth parts as material primitives of the one face mesh', async () => {
    const result = await report();
    expect(result.checks.find(c => c.id === 'mouth-parts')!.message).toBe('jawOpen carries face[tongue], face[mouth_cavity]');
    expect(result.measurements.eyes.L!.eyeballs).toEqual(['eyeball_L']);
  });

  it('passes brows and nostrils that sit on the skin and ride its morphs, and measures them', async () => {
    const result = await report(head => { browBar(head); nostril(head, true); });
    expect(result.failures).toEqual([]);
    const parts = result.measurements.attached;
    expect(parts.map(p => p.part)).toEqual([expect.stringMatching(/^face\[brow\]/), expect.stringMatching(/^face\[nostril\]/)]);
    for (const part of parts) {
      expect(part.gap).toBeLessThanOrEqual(0.0005);
      expect(part.poses).toBeGreaterThan(1);
    }
    expect(parts[0].morphs).toEqual(['browDownLeft', 'browInnerUp']);
    expect(parts[1].morphs).toEqual(['noseSneerLeft']);
  });

  it('judges nostrils seated on a nose ball against the ball they sit on, not only the skin', async () => {
    const result = await report(head => ballNose(head));
    expect(result.failures).toEqual([]);
    const parts = result.measurements.attached;
    expect(parts).toHaveLength(3);
    const beads = parts.filter(p => /nostril/.test(p.part));
    expect(beads).toHaveLength(2);
    const ball = parts.find(p => !/nostril/.test(p.part))!;
    for (const bead of beads) {
      expect(ball.part.startsWith(bead.host!)).toBe(true);
      expect(bead.gap).toBeLessThanOrEqual(0.0005);
    }
    expect(ball.host).toBeUndefined();
  });

  it('still fails a nostril floating off the nose ball, measured against the ball', async () => {
    const result = await report(head => ballNose(head, 0.003));
    const failures = result.failures.filter(f => f.startsWith('attached-parts: '));
    expect(failures.length).toBeGreaterThanOrEqual(2);
    expect(failures[0]).toMatch(/nostril/);
    expect(failures[0]).toMatch(/[1-3]\.\d\d mm off the skin or face\[skin\] part at/);
  });

  it('slices a thick ridge curved round a dome along its own length, so its ends are not judged by their tops', async () => {
    const result = await report(head => domeRidge(head));
    expect(result.failures).toEqual([]);
    const ridge = result.measurements.attached.find(p => /ridge/.test(p.part))!;
    expect(ridge.contact).toBe('lies');
    expect(ridge.gap).toBeLessThanOrEqual(0.0005);
    // A ridge that really floats is still caught.
    const floating = await report(head => domeRidge(head, 0.006, 0.002));
    expect(floating.failures.some(f => /attached-parts: .*ridge.* floats/.test(f))).toBe(true);
  });

  it('judges a heavy ridge taller than 3 mm along its contact with the dome, not as an appendage by its height', async () => {
    // A 12 mm ridge on a 40 degree arc (about 20 mm long) stands out more than half its own size, as the round-6 frog's do.
    for (const keel of [0, 0.003]) {
      const result = await report(head => domeRidge(head, 0.012, 0, { arc: 40, keel }));
      expect(result.failures, `keel ${keel}`).toEqual([]);
      const ridge = result.measurements.attached.find(p => /ridge/.test(p.part))!;
      expect(ridge.contact).toBe('lies');
      expect(ridge.overhang).toBeLessThanOrEqual(0.0005);
    }
    // Pushed 2 mm off the dome, or touching at one end and leaning 3 mm off at the other: it floats along its length.
    for (const [gap, lean] of [[0.002, 0], [0, 0.003]]) {
      const floating = await report(head => domeRidge(head, 0.012, gap, { arc: 40, lean }));
      expect(floating.measurements.attached.find(p => /ridge/.test(p.part))).toMatchObject({ contact: 'lies' });
      expect(floating.failures.some(f => /^attached-parts: .*ridge.* floats \d\.\d\d mm off the skin at rest along \d+ of its \d+ slices/.test(f)), `gap ${gap} lean ${lean}`).toBe(true);
    }
    // Pushed 2 mm out with a 3 mm keel (the round-6 frog attack): every slice still dips into the dome, but the ridge's
    // underside stands out of it at the edges along its length.
    const pushed = await report(head => domeRidge(head, 0.012, 0.002, { arc: 40, keel: 0.003 }));
    const ridge = pushed.measurements.attached.find(p => /ridge/.test(p.part))!;
    expect(ridge.restGap).toBe(0);
    expect(ridge.overhang).toBeGreaterThan(0.001);
    expect(pushed.failures.some(f => /^attached-parts: ridge part at .* hangs \d\.\d\d mm off the skin at rest along \d+ of its \d+ slices .*attach_to_skin/.test(f))).toBe(true);
  });

  it('passes a round tube resting 0.3 mm in front of the skin (a robot rubber mouth edge), whose underside curves away by its shape', async () => {
    const result = await report(head => tube(head, 0.0003));
    expect(result.failures).toEqual([]);
    expect(result.measurements.attached.find(p => /rubber/.test(p.part))).toMatchObject({ contact: 'lies', overhang: 0 });
    // Standing 1 mm off, it floats.
    expect((await report(head => tube(head, 0.001))).failures.some(f => /^attached-parts: .*rubber.* floats/.test(f))).toBe(true);
  });

  it('fails a static part the skin slides under while a morph plays, and passes one that carries the skin', async () => {
    // noseSneerLeft slides the face 2.5 mm up under the nostril without lifting or burying it.
    const stripped = await report(head => nostril(head, false, 0, [0, 0.0025]));
    const failure = stripped.failures.find(f => f.startsWith('attached-parts: '))!;
    expect(failure).toMatch(/^attached-parts: noseSneerLeft=1 slides the skin 2\.\d\d mm under face\[nostril\] part at .* while the part stays \(allowed 0\.50 mm\): carry the skin's noseSneerLeft deltas on it with attach_to_skin\(part, skin\)/);
    expect(stripped.measurements.attached[0].slide).toBeGreaterThan(0.002);
    const carried = await report(head => nostril(head, true, 0, [0, 0.0025]));
    expect(carried.failures).toEqual([]);
    expect(carried.measurements.attached[0].slide).toBeLessThan(0.0001);
  });

  it('judges a horn at the brow corner as an appendage rooted in the skin, not a part lying on it', async () => {
    const result = await report(head => horn(head));
    expect(result.failures).toEqual([]);
    expect(result.measurements.attached.find(p => /horn/.test(p.part))).toMatchObject({ contact: 'root' });
    const loose = await report(head => horn(head, 0.006));
    expect(loose.failures.some(f => /attached-parts: .*horn.* off the head/.test(f))).toBe(true);
  });

  it('lets an ear stand out from the head as long as its root touches it', async () => {
    const result = await report(head => ear(head));
    expect(result.failures).toEqual([]);
    expect(result.measurements.attached).toMatchObject([{ part: expect.stringMatching(/^ear_L/), contact: 'root', gap: 0 }]);
  });

  it('names the floating part, where it floats and by how much', async () => {
    const result = await report(head => browBar(head, 0.003));
    const failure = result.failures.find(f => f.startsWith('attached-parts: '))!;
    expect(failure).toMatch(/face\[brow\]/);
    expect(failure).toMatch(/at rest/);
    expect(failure).toMatch(/3\.\d\d mm/);
    expect(failure).toMatch(/attach_to_skin/);
    expect(result.measurements.attached[0].gap).toBeGreaterThan(0.0029);
  });

  it('names the morph that lifts a part off the skin or buries it', async () => {
    const lifted = (await report(head => browBar(head, -0.0002, 0.003))).failures.find(f => f.startsWith('attached-parts: '))!;
    expect(lifted).toMatch(/browInnerUp=1/);
    expect(lifted).not.toMatch(/at rest/);
    const buried = (await report(head => nostril(head, false))).failures.find(f => f.startsWith('attached-parts: '))!;
    expect(buried).toMatch(/noseSneerLeft=1/);
    expect(buried).toMatch(/sinks|buries/);
  });

  it('names the part that hides the lid edge when lid follow cannot show', async () => {
    const result = await report(head => fringe(head, 0.0075));
    const failure = result.failures.find(f => f.startsWith('lid-follow: eyeLookUpLeft'))!;
    expect(failure).toMatch(/hair/);
    expect(failure).not.toMatch(/raise lidFollow\.up/);
  });

  it('calls a pinhole beside the eye a hole in the skin, not a gap at the lids', async () => {
    const result = await report(head => pinhole(head));
    const failures = result.failures.filter(f => f.startsWith('eye-oblique: ') && /eyeball_L/.test(f));
    expect(failures.length).toBeGreaterThan(0);
    for (const failure of failures) {
      expect(failure).toMatch(/hole in/);
      expect(failure).not.toMatch(/between the lids and the skin's eye hole/);
    }
  });

  it('rejects bytes that are not a GLB', async () => {
    await expect(verifyFaceContract(new Uint8Array([1, 2, 3, 4]))).rejects.toThrow(/GLB/);
  });
});
