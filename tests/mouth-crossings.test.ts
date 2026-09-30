import { describe, expect, it } from 'vitest';
import { verifyFaceContract } from '../src/face-contract.ts';
import { encodeHead, onBody, passingHead, type SynthHead, type Vec3 } from './helpers/face-glb.ts';

function gum(head: SynthHead, points: Vec3[], delta?: Vec3, name = 'gums_lower') {
  head.meshes.push({ name, material: name, positions: points, indices: [0, 1, 2],
    targets: delta ? [{ name: 'jawOpen', positions: points.map(p => p.map((v, k) => v + delta[k]) as Vec3) }] : [],
    bones: points.map(() => 'head') });
  head.groups!.face.push(name);
}
const cheek: Vec3[] = [[.047, -.012, .05], [.053, -.012, .07], [.05, -.006, .05]];
const check = async (head: SynthHead) => (await verifyFaceContract(encodeHead(head))).checks.find(c => c.id === 'mouth-skin-intersection');

describe('mouth interiors versus the animated skin', { timeout: 30_000 }, () => {
  it('allows teeth and tongue visible through the actual mouth opening', async () => {
    expect(await check(passingHead())).toMatchObject({ ok: true });
  });
  it('rejects a gum crossing the cheek outside the front mouth window', async () => {
    const head = passingHead(); gum(head, cheek);
    const result = await check(head);
    expect(result).toMatchObject({ ok: false });
    expect(result!.problems.join(' ')).toMatch(/gums_lower.*skin/);
  });
  it('catches a crossing that happens only at a partial jaw opening', async () => {
    const head = passingHead();
    // Entirely behind at rest, entirely in front at jaw=1; crosses at .5.
    gum(head, cheek.map(p => [p[0], p[1], p[2] - .015]), [0, 0, .03]);
    const result = await check(head);
    expect(result).toMatchObject({ ok: false });
    expect(result!.problems.join(' ')).toMatch(/jawOpen=0\.5/);
  });
  it('allows a cavity lining to end exactly at the lip seam', async () => {
    const head = passingHead();
    gum(head, [[.047, -.012, .06], [.053, -.012, .06], [.05, -.006, .05]], undefined, 'mouth_interior_lining');
    expect(await check(head)).toMatchObject({ ok: true });
  });
  it('checks tongue and cavity surfaces as well as teeth and gums', async () => {
    for (const name of ['tongue_tip', 'mouth_interior_side', 'teeth_upper_extra']) {
      const head = passingHead(); gum(head, cheek, undefined, name);
      expect(await check(head), name).toMatchObject({ ok: false });
    }
  });
  it('checks separate static anatomical skin on a body rig', async () => {
    const head = passingHead(); onBody(head);
    const points: Vec3[] = [[.08, -.02, .05], [.1, -.02, .05], [.09, .02, .05]];
    head.meshes.push({ name: 'static_cheek', material: 'skin', positions: points,
      indices: [0, 1, 2], targets: [], bones: points.map(() => 'head'), faceRegion: [1, 1, 1] });
    gum(head, [[.088, -.01, .04], [.092, -.01, .06], [.09, .01, .04]], undefined, 'gums_lower_probe');
    const separate = await check(head);
    // Grouping changes morph-buffer membership, not the anatomical surface.
    head.groups!.face.push('static_cheek');
    const grouped = await check(head);
    expect(grouped).toMatchObject({ ok: false });
    expect(separate).toMatchObject({ ok: false });
    expect(separate!.problems.join(' ')).toMatch(/gums_lower_probe.*static_cheek/);
  });
});
