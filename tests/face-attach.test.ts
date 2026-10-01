import { describe, expect, it } from 'vitest';
import { attachedParts, attachedTriangles, type AttachSurface } from '../src/face-attach.ts';
import { verifyFaceContract } from '../src/face-contract.ts';
import { combinedBody, encodeHead, mesh, nostril, passingHead, type Vec3 } from './helpers/face-glb.ts';

const surface = (label: string, points: number[][], triangles: number[], delta = 0): AttachSurface => ({
  label, names: [label], count: points.length, rest: Float64Array.from(points.flat()), triangles: Uint32Array.from(triangles),
  targets: new Map([['noseSneerLeft', Float64Array.from(points.flatMap(() => [0, 0, delta]))]]),
});

function fixture({ split = false, gap = 0, follow = true } = {}): AttachSurface[] {
  const points = [[-.03, -.03, 0], [.03, -.03, 0], [.03, .03, 0], [-.03, .03, 0]];
  // The small central material island is below SKIN_SHARE by itself. Only a
  // position weld to the surrounding ring makes it skin rather than a part.
  const island = [[-.013, .001, 0], [-.003, .001, 0], [-.003, .011, 0], [-.013, .011, 0]];
  const ring = [0, 1, 2, 3].flatMap(i => { const j = (i + 1) % 4; return [i, j, 4 + j, i, 4 + j, 4 + i]; });
  const skin = split
    ? [surface('skin-a', [...points, ...island], ring, .002), surface('skin-b', island, [0, 1, 2, 0, 2, 3], .002)]
    : [surface('skin', [...points, [-.006, .006, 0]], [0, 1, 4, 1, 2, 4, 2, 3, 4, 3, 0, 4], .002)];
  // A second large piece keeps the ornament classified as an attachment even
  // when a faulty seam weld excludes the entire first skin from contact tests.
  const skull = surface('skull', points.map(([x, y, z]) => [x - .10, y, z]), [0, 1, 2, 0, 2, 3]);
  const lining = surface('mouth_cavity', [points[1], points[2], [.02, .03, -.01], [.02, -.03, -.01]], [0, 1, 2, 0, 2, 3], .002);
  const x = -.008, y = .006, z = .001 + gap, r = .001;
  const ornament = surface('nostril', [[x, y, z + r], [x, y, z - r], [x + r, y, z], [x, y + r, z], [x - r, y, z], [x, y - r, z]],
    [0, 2, 3, 0, 3, 4, 0, 4, 5, 0, 5, 2, 1, 3, 2, 1, 4, 3, 1, 5, 4, 1, 2, 5], follow ? .002 : 0);
  return [...skin, skull, lining, ornament];
}

describe('attachments beside a mouth lining joined to skin', () => {
  it.each([false, true])('keeps valid contact when skin material splits are %s', split => {
    const report = attachedParts(fixture({ split }), [], ['noseSneerLeft']);
    expect(report.problems).toEqual([]);
    expect(report.parts).toHaveLength(1);
    expect(report.parts[0].restGap).toBe(0);
  });

  it('still reports the real gap of an ornament floating above the skin', () => {
    const report = attachedParts(fixture({ gap: .003 }), [], ['noseSneerLeft']);
    expect(report.parts).toHaveLength(1);
    expect(report.parts[0].restGap).toBeCloseTo(.003, 6);
    expect(report.problems.some(p => p.includes('floats 3.00 mm'))).toBe(true);
  });

  it('still rejects an ornament that stays behind when the skin morphs', () => {
    const report = attachedParts(fixture({ follow: false }), [], ['noseSneerLeft']);
    expect(report.parts[0].restGap).toBe(0);
    expect(report.problems.some(p => /buries|slides/.test(p))).toBe(true);
  });

  it('marks only ornament triangles as attachments, including across skin material seams', () => {
    const surfaces = fixture({ split: true }), masks = attachedTriangles(surfaces, []);
    masks.forEach((mask, i) => expect(Array.from(mask)).toEqual(Array(mask.length).fill(surfaces[i].label === 'nostril' ? 1 : 0)));
  });
});

describe('attached lining in the exported face contract', { timeout: 30_000 }, () => {
  it.each([false, true])('passes the complete contract with a following nostril (combined body: %s)', async body => {
    const result = await linedContract(body, false);
    expect(result.failures).toEqual([]);
    expect(result.ok).toBe(true);
    expect(result.measurements.attached).toHaveLength(1);
    expect(result.measurements.attached[0].restGap).toBe(0);
  });

  it.each([false, true])('rejects a genuinely floating nostril (combined body: %s)', async body => {
    const result = await linedContract(body, true);
    expect(result.checks.filter(c => !c.ok).map(c => c.id)).toEqual(['attached-parts']);
    expect(result.measurements.attached[0].restGap).toBeCloseTo(.003, 6);
  });
});

async function linedContract(body: boolean, floating: boolean) {
  const head = passingHead(); nostril(head, true);
  if (floating) {
    const n = mesh(head, 'nostril_L'), shifted = (p: Vec3): Vec3 => [p[0], p[1], p[2] + .006];
    n.positions = n.positions.map(shifted);
    for (const target of n.targets) target.positions = target.positions.map(shifted);
  }
  const skin = mesh(head, 'face');
  const index = [...new Set(skin.indices)].sort((a, b) => Math.hypot(skin.positions[a][0], skin.positions[a][1] + .03) - Math.hypot(skin.positions[b][0], skin.positions[b][1] + .03))[0];
  const offsets = [[0, 0, 0], [.002, 0, -.005], [0, -.002, -.005]];
  const translated = (anchor: Vec3): Vec3[] => offsets.map(q => q.map((v, k) => v + anchor[k]) as Vec3);
  head.meshes.push({ name: 'lip_lining', material: 'mouth_cavity', positions: translated(skin.positions[index]), indices: [0, 1, 2], bones: ['head', 'head', 'head'], faceRegion: [1, 1, 1],
    targets: skin.targets.map(t => ({ name: t.name, positions: translated(t.positions[index]) })) });
  head.groups!.face.push('lip_lining');
  if (body) combinedBody(head);
  return verifyFaceContract(encodeHead(head));
}
