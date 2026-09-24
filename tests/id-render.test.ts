import { describe, expect, it } from 'vitest';
import { BackSide, BoxGeometry, Color, DoubleSide, Group, LinearSRGBColorSpace, Mesh, MeshBasicMaterial, MeshStandardMaterial } from 'three';
import { applyIdMaterials, collectIdTargets, countColors, parseIdColor, resolveIdColors } from '../src/render/id-render.ts';

function model() {
  const skin = new MeshStandardMaterial({ name: 'skin', color: '#e0b090', side: DoubleSide });
  const iris = new MeshStandardMaterial({ name: 'iris', color: '#3070c0' });
  const white = new MeshStandardMaterial({ name: 'eyeWhite' });
  const root = new Group();
  const head = new Mesh(new BoxGeometry(), skin); head.name = 'head';
  const eye = new Mesh(new BoxGeometry(), [white, iris]); eye.name = 'eye_L';
  const hat = new Mesh(new BoxGeometry(), new MeshStandardMaterial({ name: 'felt' })); hat.name = 'hat';
  const hull = new Mesh(new BoxGeometry(), new MeshBasicMaterial({ side: BackSide })); hull.name = 'head_outline'; hull.userData.outline = true;
  root.add(head, eye, hat, hull);
  return { root, head, eye, hat, hull, skin, iris, white };
}
const linear = (hex: string) => { const c = new Color(); c.setRGB(parseInt(hex.slice(1, 3), 16) / 255, parseInt(hex.slice(3, 5), 16) / 255, parseInt(hex.slice(5, 7), 16) / 255, LinearSRGBColorSpace); return c; };

describe('ID colors', () => {
  it('accepts only exact #rrggbb colors', () => {
    expect(parseIdColor('#FF0080', 'x')).toEqual([255, 0, 128]);
    for (const bad of ['red', '#f00', '#ff008', 'ff0080', '#gg0000', 12]) expect(() => parseIdColor(bad, 'iris')).toThrow(/iris must be a #rrggbb color/);
  });

  it('resolves part#slot, part, then material, with model-scoped keys first', () => {
    const a = model(), b = model();
    const targets = collectIdTargets([{ model: 'pip', root: a.root }, { model: 'bolt', root: b.root }]);
    expect(targets.filter(t => t.model === 'pip').map(t => `${t.part}#${t.slot}:${t.material}`)).toEqual(['head#0:skin', 'eye_L#0:eyeWhite', 'eye_L#1:iris', 'hat#0:felt']);
    const colors = resolveIdColors(targets, {
      materials: { skin: '#010101', iris: '#020202', 'bolt/iris': '#030303' },
      parts: { 'eye_L#0': '#040404', 'pip/hat': '#050505' },
    });
    const at = (m: string, part: string, slot: number) => colors.get(targets.find(t => t.model === m && t.part === part && t.slot === slot)!);
    expect(at('pip', 'head', 0)).toBe('#010101');
    expect(at('pip', 'eye_L', 0)).toBe('#040404');
    expect(at('pip', 'eye_L', 1)).toBe('#020202');
    expect(at('bolt', 'eye_L', 1)).toBe('#030303');
    expect(at('pip', 'hat', 0)).toBe('#050505');
    expect(at('bolt', 'hat', 0)).toBe('#000000');
    expect(resolveIdColors(targets, { other: null }).get(targets[0])).toBeNull();
  });

  it('rejects keys that match nothing, listing what exists', () => {
    const { root } = model(), targets = collectIdTargets([{ model: null, root }]);
    expect(() => resolveIdColors(targets, { materials: { irs: '#ff0000' } })).toThrow(/Unknown material "irs" in idRender; materials: eyeWhite, felt, iris, skin/);
    expect(() => resolveIdColors(targets, { parts: { 'eye_L#2': '#ff0000' } })).toThrow(/Unknown part "eye_L#2" in idRender; parts: eye_L, eye_L#0, eye_L#1, hat, hat#0, head, head#0/);
    expect(() => resolveIdColors(targets, { parts: { 'pip/head': '#ff0000' } })).toThrow(/Unknown part "pip\/head"/);
    expect(() => resolveIdColors(targets, { materials: { skin: 'tan' } })).toThrow(/materials.skin must be a #rrggbb color/);
    expect(() => resolveIdColors(targets, { background: 'black' } as never)).toThrow(/background must be a #rrggbb color/);
    expect(() => resolveIdColors(targets, { colour: {} } as never)).toThrow(/Unknown idRender option "colour"/);
  });
});

describe('ID material swap', () => {
  it('swaps every slot to an exact unlit color, hides outline hulls and unmatched parts when asked, then restores everything', () => {
    const { root, head, eye, hat, hull, skin, iris, white } = model();
    const targets = collectIdTargets([{ model: null, root }]);
    const colors = resolveIdColors(targets, { materials: { skin: '#ff0000', iris: '#00ff00' }, parts: { 'eye_L#0': '#0000ff' }, other: null });
    const restore = applyIdMaterials(targets, colors, [hull]);
    const headMaterial = head.material as unknown as MeshBasicMaterial;
    expect(headMaterial).toBeInstanceOf(MeshBasicMaterial);
    expect(headMaterial.color.equals(linear('#ff0000'))).toBe(true);
    expect(headMaterial.side).toBe(DoubleSide);
    expect(headMaterial.toneMapped).toBe(false); expect(headMaterial.fog).toBe(false); expect(headMaterial.transparent).toBe(false);
    expect(headMaterial.vertexColors).toBe(false); expect(headMaterial.map).toBeNull();
    const slots = eye.material as unknown as MeshBasicMaterial[];
    expect(slots.map(m => `#${m.color.getHexString(LinearSRGBColorSpace)}`)).toEqual(['#0000ff', '#00ff00']);
    expect(hat.visible).toBe(false); expect(hull.visible).toBe(false);
    restore();
    expect(head.material).toBe(skin); expect(eye.material).toEqual([white, iris]); expect((eye.material as unknown[])[1]).toBe(iris);
    expect(hat.visible).toBe(true); expect(hull.visible).toBe(true);
    // Restoring twice is harmless.
    restore(); expect(head.material).toBe(skin);
  });

  it('keeps meshes that were already hidden hidden', () => {
    const { root, hat } = model(); hat.visible = false;
    const targets = collectIdTargets([{ model: null, root }]);
    const restore = applyIdMaterials(targets, resolveIdColors(targets, {}), []);
    expect(hat.visible).toBe(false); restore(); expect(hat.visible).toBe(false);
  });
});

describe('countColors', () => {
  it('counts RGBA pixels by #rrggbb, ignoring alpha', () => {
    const data = new Uint8ClampedArray([255, 0, 0, 255, 255, 0, 0, 255, 0, 0, 0, 255, 16, 32, 48, 0]);
    expect(countColors({ width: 2, height: 2, data })).toEqual({ '#ff0000': 2, '#000000': 1, '#102030': 1 });
  });
});
