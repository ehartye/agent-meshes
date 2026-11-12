/** @lane merge
 * @subject src/sprite-bake.ts
 */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { exportGLB } from '../src/export.ts';
import { readAccessor, readGLB } from '../src/gltf-read.ts';
import { decodePng } from '../src/png.ts';
import { createRecipe } from '../src/recipes/regenerate.ts';
import { anchorPivot, bakeSprites } from '../src/sprite-bake.ts';

// An oblique bake of a skinned, animated character: the biped recipe (one skin of 13 joints, two limbs blended between
// two bones) through its walk clip. The other bake tests use a figure of rigid boxes; this file is the owner of the
// oblique view on deforming skin, and of the oblique view under the room lighting of `look: 'lit'`.
const CELL = 64, PHASES = 6, DIRECTIONS = 4, SCALE = 18;
const OPTIONS = { clip: 'walk', directions: DIRECTIONS, phases: PHASES, cell: CELL, pixelsPerMetre: SCALE } as const;

let root: string, glbPath: string, runs = 0;
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'sprite-bake-skinned-'));
  glbPath = join(root, 'walker.glb');
  await writeFile(glbPath, Buffer.from(await exportGLB(createRecipe('biped'))));
});
afterAll(async () => { await rm(root, { recursive: true, force: true }); });

interface Baked { sheet: ReturnType<typeof decodePng>; manifest: any; atlas: any }
async function bake(extra: Record<string, unknown>): Promise<Baked> {
  const out = join(root, `out-${runs++}`);
  await bakeSprites(glbPath, { ...OPTIONS, ...extra, out });
  return { sheet: decodePng(await readFile(join(out, 'sheet.png'))), manifest: JSON.parse(await readFile(join(out, 'manifest.json'), 'utf8')), atlas: JSON.parse(await readFile(join(out, 'atlas.json'), 'utf8')) };
}
const alphaAt = (baked: Baked, direction: number, phase: number, x: number, y: number) => baked.sheet.rgba[((direction * CELL + y) * baked.sheet.width + phase * CELL + x) * 4 + 3];
/** The opaque pixels of one cell as a string of 0 and 1, and their extent. */
function mask(baked: Baked, direction: number, phase: number) {
  let bits = '', x0 = CELL, x1 = -1, y0 = CELL, y1 = -1, count = 0;
  for (let y = 0; y < CELL; y++) for (let x = 0; x < CELL; x++) {
    const on = alphaAt(baked, direction, phase, x, y) === 255;
    bits += on ? '1' : '0';
    if (on) { count++; x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
  }
  return { bits, x0, x1, y0, y1, count };
}
/** The distinct opaque colours of a whole sheet. */
function colours(baked: Baked): Set<number> {
  const seen = new Set<number>(), { rgba } = baked.sheet;
  for (let i = 0; i < rgba.length; i += 4) if (rgba[i + 3] === 255) seen.add(rgba[i] << 16 | rgba[i + 1] << 8 | rgba[i + 2]);
  return seen;
}

let shared: Promise<{ level: Baked; banded: Baked; lit: Baked; unlit: Baked; plain: Baked }> | undefined;
const bakes = () => shared ??= (async () => ({
  level: await bake({ elevation: 0, look: 'banded' }),
  banded: await bake({ oblique: '45,0.5', look: 'banded', anchor: 'feet' }),
  lit: await bake({ oblique: '45,0.5', look: 'lit' }),
  unlit: await bake({ oblique: '45,0.5', look: 'unlit' }),
  plain: await bake({ oblique: '45,0.5' }),
}))();

describe('the skinned fixture', () => {
  it('is one skin whose vertices follow joints, some of them two joints at once', async () => {
    const doc = readGLB(await readFile(glbPath)), json = doc.json as { skins?: { joints: number[] }[]; meshes: { primitives: { attributes: Record<string, number> }[] }[]; animations: { name: string }[] };
    expect(json.skins).toHaveLength(1);
    expect(json.skins![0].joints.length).toBeGreaterThan(8);
    expect(json.animations.map(animation => animation.name)).toContain('walk');
    let blended = 0;
    for (const mesh of json.meshes) for (const primitive of mesh.primitives) {
      expect(primitive.attributes.JOINTS_0).toBeDefined();
      const weights = readAccessor(doc, primitive.attributes.WEIGHTS_0).data;
      for (let i = 0; i < weights.length; i += 4) if (weights[i] > 0.05 && weights[i + 1] > 0.05) blended++;
    }
    expect(blended).toBeGreaterThan(10);
  });
});

describe('an oblique bake of a skinned character through a walk cycle', () => {
  it('draws every phase of every direction whole, inside the frame, with the limbs moving', async () => {
    const { banded } = await bakes();
    expect([banded.sheet.width, banded.sheet.height]).toEqual([PHASES * CELL, DIRECTIONS * CELL]);
    for (let d = 0; d < DIRECTIONS; d++) {
      const masks = Array.from({ length: PHASES }, (_, p) => mask(banded, d, p));
      for (const [p, m] of masks.entries()) {
        // The figure is about 2.9 m tall, so about 52 pixels at this scale: a cell that lost the skin would be far smaller.
        expect(m.count, `direction ${d} phase ${p}`).toBeGreaterThan(250);
        expect(m.y1 - m.y0, `direction ${d} phase ${p}`).toBeGreaterThan(30);
        expect(m.x0 > 0 && m.y0 > 0 && m.x1 < CELL - 1 && m.y1 < CELL - 1, `direction ${d} phase ${p}`).toBe(true);
      }
      // The walk moves the skin: no two phases of a direction are the same silhouette.
      expect(new Set(masks.map(m => m.bits)).size, `direction ${d}`).toBe(PHASES);
    }
    const alphas = new Set<number>();
    for (let i = 3; i < banded.sheet.rgba.length; i += 4) alphas.add(banded.sheet.rgba[i]);
    expect([...alphas].sort((a, b) => a - b)).toEqual([0, 255]);
  }, 180_000);

  it('shears the deformed skin with the rest of the picture: the poses of the level bake, each moved by no more than its depth', async () => {
    const { level, banded } = await bakes();
    expect(banded.manifest.camera).toMatchObject({ projection: 'oblique', elevationDeg: 0, obliqueAngleDeg: 45, obliqueRatio: 0.5, pixelsPerMetre: SCALE });
    expect(banded.manifest.camera.frameCentreM).toHaveLength(DIRECTIONS * 2);
    for (let d = 0; d < DIRECTIONS; d++) for (let p = 0; p < PHASES; p++) {
      const flat = mask(level, d, p), sheared = mask(banded, d, p);
      // The shear moves a point by its depth, drawn at half length along 45 degrees. The figure in mid stride is under 1.5 m deep,
      // so the picture is the level one changed by that much at most; a limb in front can narrow it as well as widen it.
      const shift = Math.ceil(1.5 * 0.5 * Math.SQRT1_2 * SCALE) + 2;
      for (const [name, a, b] of [['width', flat.x1 - flat.x0, sheared.x1 - sheared.x0], ['height', flat.y1 - flat.y0, sheared.y1 - sheared.y0]] as const)
        expect(Math.abs(b - a), `${name} of direction ${d} phase ${p}: ${a} level, ${b} oblique`).toBeLessThanOrEqual(shift);
      expect(sheared.count / flat.count, `direction ${d} phase ${p}`).toBeGreaterThan(0.7);
      expect(sheared.count / flat.count, `direction ${d} phase ${p}`).toBeLessThan(1.6);
      expect(sheared.bits, `direction ${d} phase ${p}`).not.toBe(flat.bits);
    }
  }, 180_000);

  it('puts the feet pivot of each direction under the walking feet, where an independent projection puts the ground point', async () => {
    const { banded } = await bakes();
    const { halfExtentM, centreM, groundYM, frameCentreM } = banded.manifest.camera;
    const pivots: number[][] = banded.manifest.anchor.byDirection ?? Array.from({ length: DIRECTIONS }, () => [banded.manifest.anchor.x, banded.manifest.anchor.y]);
    for (let d = 0; d < DIRECTIONS; d++) {
      const expected = anchorPivot({ cell: CELL, halfExtentM, elevationDeg: 0, azimuthDeg: d * 90, oblique: { angleDeg: 45, ratio: 0.5 }, centreM, pointM: [centreM[0], groundYM, centreM[2]], frameCentreM: frameCentreM.slice(d * 2, d * 2 + 2) });
      expect(pivots[d], `direction ${d}`).toEqual([expected.x, expected.y]);
      // A foot that is forward or back in the stride is drawn above or below the ground point by its depth; the lowest pixel of the cycle stays within that.
      const lowest = Math.max(...Array.from({ length: PHASES }, (_, p) => mask(banded, d, p).y1));
      expect(Math.abs(lowest - pivots[d][1]), `direction ${d}: lowest row ${lowest}, pivot row ${pivots[d][1]}`).toBeLessThanOrEqual(6);
      const columns = Array.from({ length: PHASES }, (_, p) => mask(banded, d, p));
      expect(pivots[d][0], `direction ${d}`).toBeGreaterThan(Math.min(...columns.map(m => m.x0)));
      expect(pivots[d][0], `direction ${d}`).toBeLessThan(Math.max(...columns.map(m => m.x1)));
    }
  }, 180_000);
});

describe('an oblique bake under the room lighting', () => {
  it('draws the same silhouettes as the unlit oblique bake, shaded: the look changes the colours and not the shape', async () => {
    const { lit, unlit } = await bakes();
    for (let d = 0; d < DIRECTIONS; d++) for (let p = 0; p < PHASES; p++) expect(mask(lit, d, p).bits, `direction ${d} phase ${p}`).toBe(mask(unlit, d, p).bits);
    // Unlit draws each material as one flat colour; the room lighting grades it across every surface.
    const flat = colours(unlit).size, shaded = colours(lit).size;
    expect(flat).toBeLessThan(40);
    expect(shaded).toBeGreaterThan(flat * 5);
    expect(lit.manifest).toMatchObject({ look: 'lit', camera: { projection: 'oblique' } });
  }, 180_000);

  it('gives the default look when lit is asked for by name: the same sheet as an oblique bake with no look', async () => {
    const { lit, plain } = await bakes();
    expect(Buffer.from(lit.sheet.rgba).equals(Buffer.from(plain.sheet.rgba))).toBe(true);
    expect(Object.keys(plain.manifest)).not.toContain('look');
  }, 180_000);

  it('keeps a full range of light and dark in every direction', async () => {
    // Directions 1 and 3 look from +X and -X. The room light is fixed to the scene, the figure is close to mirror
    // symmetric, and the shear moves pixels without turning normals, so both views keep a full range of light and dark.
    const { lit } = await bakes();
    const brightness = (direction: number) => {
      const values: number[] = [], { rgba, width } = lit.sheet;
      for (let y = 0; y < CELL; y++) for (let x = 0; x < CELL; x++) { const i = ((direction * CELL + y) * width + x) * 4; if (rgba[i + 3] === 255) values.push(rgba[i] + rgba[i + 1] + rgba[i + 2]); }
      values.sort((a, b) => a - b);
      return { low: values[Math.floor(values.length * 0.05)], high: values[Math.floor(values.length * 0.95)] };
    };
    for (const direction of [0, 1, 2, 3]) {
      const { low, high } = brightness(direction);
      expect(high - low, `direction ${direction}`).toBeGreaterThan(150);
    }
  }, 180_000);
});
