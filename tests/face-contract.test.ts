import { describe, expect, it } from 'vitest';
import { verifyFaceContract } from '../src/face-contract.ts';
import { encodeHead, extras, mesh, passingHead, REQUIRED, sphere, upperSeam, EYES, JAW_DROP, MOUTH_Y, type SynthHead, type Vec3 } from './helpers/face-glb.ts';

async function report(mutate?: (head: SynthHead) => void) {
  const head = passingHead(); mutate?.(head);
  return verifyFaceContract(encodeHead(head));
}
const failed = (result: Awaited<ReturnType<typeof report>>) => result.checks.filter(c => !c.ok).map(c => c.id);

describe('arkit-face/1 verifier', () => {
  it('passes a head that meets every computable clause and reports its measurements', async () => {
    const result = await report();
    expect(result.failures).toEqual([]);
    expect(result.ok).toBe(true);
    expect(result.contract).toBe('arkit-face/1');
    expect(result.checks.map(c => c.id)).toEqual(['validator', 'skeleton', 'skinning', 'eyes', 'orientation', 'morph-names', 'rest-weights', 'morph-motion', 'inversion', 'lid-clearance', 'extras', 'exposed-teeth', 'head-binding', 'teeth', 'mouth-parts', 'puppet-jaw', 'upper-lip', 'mouth-open']);
    expect(result.measurements.eyes.L!.radius).toBeCloseTo(0.012, 5);
    expect(result.measurements.eyes.L!.center[0]).toBeCloseTo(0.03, 5);
    expect(result.measurements.eyes.L!.minLidClearance).toBeGreaterThan(0.0005);
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
    ['extras', 'missing extras', head => { head.rootExtras = undefined; }],
    ['extras', 'a wrong contract version', head => { head.rootExtras = { arkitFace: { ...extras(), contract: 'arkit-face/2' } }; }],
    ['extras', 'a morph list that does not match the file', head => { head.rootExtras = { arkitFace: extras([...REQUIRED, 'tongueOut']) }; }],
    ['extras', 'an emotion curve that is not ARKit', head => { const e = extras(); (e.emotions as Record<string, Record<string, number>>).happy.grin = 1; head.rootExtras = { arkitFace: e }; }],
    ['exposed-teeth', 'undeclared exposed teeth', head => { const e = extras(); delete e.exposedTeeth; head.rootExtras = { arkitFace: e }; }],
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
    expect(result.failures).toContain('morph-names: jawOpen is on 2 glTF meshes (face, tongue); Unreal discards all morph names when a name repeats across meshes: put every morph-bearing part in one mesh (join_face_parts)');
  });

  it('finds teeth and mouth parts as material primitives of the one face mesh', async () => {
    const result = await report();
    expect(result.checks.find(c => c.id === 'mouth-parts')!.message).toBe('jawOpen carries face[tongue], face[mouth_cavity]');
    expect(result.measurements.eyes.L!.eyeballs).toEqual(['eyeball_L']);
  });

  it('rejects bytes that are not a GLB', async () => {
    await expect(verifyFaceContract(new Uint8Array([1, 2, 3, 4]))).rejects.toThrow(/GLB/);
  });
});
